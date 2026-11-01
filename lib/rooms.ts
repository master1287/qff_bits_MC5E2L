import { env } from "cloudflare:workers";
import {
  decodeKey, decryptMessage, encodeKey, encryptMessage, unwrapKey, wrapKey,
  type Envelope, type Transcript,
} from "./bb84.mjs";
import { hasLiveQiskit, runKeyExchange } from "./qiskit-client";
import { planDetectionConfidence } from "./security-plan.mjs";

type Role = "alice" | "bob";
type Room = {
  id: string; name: string; alice_hash: string; bob_hash: string | null;
  invite_hash: string | null; alice_name: string; bob_name: string | null;
  created_at: string; active_exchange: string | null; latest_attempt: string | null;
  security_plan: string | null;
};
type Exchange = { id: string; room_id: string; wrapped_key: string | null; transcript: string };
type StoredMessage = {
  id: string; room_id: string; exchange_id: string; role: Role;
  ciphertext: string; iv: string; created_at: string; wrapped_key: string;
};

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function infrastructure() {
  if (!env.DB) throw new HttpError(503, "Message storage is not configured yet.");
  if (!env.CHAT_MASTER_KEY || !/^[A-Za-z0-9_-]{43}$/.test(env.CHAT_MASTER_KEY)) {
    throw new HttpError(503, "Message encryption is not configured yet.");
  }
  const master = decodeKey(env.CHAT_MASTER_KEY);
  if (master.length !== 32) throw new HttpError(503, "Message encryption is not configured yet.");
  return { db: env.DB, master };
}

const responseHeaders = {
  "Cache-Control": "no-store, private", "Pragma": "no-cache",
  "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
};

export async function respond(operation: () => Promise<unknown>) {
  try {
    return Response.json(await operation(), { headers: responseHeaders });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof HttpError ? error.message : "The request could not be completed. Please try again.";
    return Response.json({ error: message }, { status, headers: responseHeaders });
  }
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new HttpError(403, "This request must come from this website.");
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new HttpError(415, "Send a JSON request.");
  if (Number(request.headers.get("content-length") ?? 0) > 16384) throw new HttpError(413, "The request is too large.");
  const value = await request.text();
  if (value.length > 16384) throw new HttpError(413, "The request is too large.");
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new HttpError(400, "The request is not valid JSON."); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new HttpError(400, "Send a JSON object.");
  return parsed;
}

function text(value: unknown, name: string, maximum: number) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) throw new HttpError(400, `${name} must contain 1–${maximum} characters.`);
  return value.trim();
}
function token() { return encodeKey(crypto.getRandomValues(new Uint8Array(32))); }
async function hash(value: string) { return encodeKey(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))); }
function context(roomId: string, exchangeId: string, messageId: string, role: Role) {
  return JSON.stringify(["qubit-message-v1", roomId, exchangeId, messageId, role]);
}
function parseTranscript(value: string | null): Transcript | null {
  if (!value) return null;
  const transcript = JSON.parse(value) as Transcript;
  // Existing exchanges used the geometric basis labels + and ×. Translate only
  // their public notation; persisted keys and message contexts remain intact.
  const basis = (label: string): "Z" | "X" => {
    if (label === "Z" || label === "+") return "Z";
    if (label === "X" || label === "×") return "X";
    throw new Error("Unrecognized BB84 basis");
  };
  return { ...transcript, trace: transcript.trace.map(row => ({
    ...row, aliceBasis: basis(row.aliceBasis), bobBasis: basis(row.bobBasis),
  })) };
}

async function authorize(request: Request, id: string) {
  const { db, master } = infrastructure();
  const supplied = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if (!supplied || !/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, "This conversation is unavailable on this device.");
  const digest = await hash(supplied);
  const room = await db.prepare("SELECT * FROM rooms WHERE id = ? AND (alice_hash = ? OR bob_hash = ?)").bind(id, digest, digest).first<Room>();
  if (!room) throw new HttpError(404, "This conversation is unavailable on this device.");
  const role: Role = room.alice_hash === digest ? "alice" : "bob";
  return { db, master, room, role };
}

export async function health() {
  const { db } = infrastructure();
  await db.prepare("SELECT id FROM rooms LIMIT 1").first();
  return { ok: true, simulation: true, exchangeEngine: hasLiveQiskit() ? "qiskit-statevector" : "classical-bb84-simulator" };
}

export async function createRoom(request: Request) {
  const input = await body(request);
  const name = text(input.name, "Conversation name", 60);
  const displayName = text(input.displayName, "Your name", 40);
  let plan: ReturnType<typeof planDetectionConfidence> | null = null;
  if (input.detectionConfidence !== undefined) {
    try { plan = planDetectionConfidence(input.detectionConfidence as number); }
    catch { throw new HttpError(400, "Choose a detection confidence from 50% to 99.9999%."); }
  }
  const { db, master } = infrastructure();
  const roomId = crypto.randomUUID();
  const session = token();
  const invitation = token();
  const now = new Date().toISOString();
  const result = await runKeyExchange({ roomId, ...(plan ? { qubits: plan.qubits, sampleBits: plan.sampleBits, abortOnAnyError: true } : {}) });
  if (!result.accepted || !result.key) throw new HttpError(503, "The initial key exchange did not complete. Please retry.");
  const wrapped = await wrapKey(result.key, master, `${roomId}/${result.transcript.exchangeId}`);
  const transcript = JSON.stringify(result.transcript);
  await db.batch([
    db.prepare("INSERT INTO rooms (id,name,alice_hash,invite_hash,alice_name,created_at,active_exchange,latest_attempt,security_plan) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(roomId, name, await hash(session), await hash(invitation), displayName, now, result.transcript.exchangeId, transcript, plan ? JSON.stringify(plan) : null),
    db.prepare("INSERT INTO exchanges (id,room_id,wrapped_key,transcript,created_at) VALUES (?,?,?,?,?)")
      .bind(result.transcript.exchangeId, roomId, JSON.stringify(wrapped), transcript, now),
  ]);
  result.key.fill(0);
  return { roomId, token: session, inviteToken: invitation, role: "alice", securityPlan: plan };
}

export async function joinRoom(request: Request) {
  const input = await body(request);
  const invitation = text(input.inviteToken, "Invitation", 43);
  if (!/^[A-Za-z0-9_-]{43}$/.test(invitation)) throw new HttpError(404, "This invitation has expired or was already used.");
  const displayName = text(input.displayName, "Your name", 40);
  const { db } = infrastructure();
  const session = token();
  const room = await db.prepare("UPDATE rooms SET bob_hash = ?, bob_name = ?, invite_hash = NULL WHERE invite_hash = ? AND bob_hash IS NULL RETURNING id")
    .bind(await hash(session), displayName, await hash(invitation)).first<{ id: string }>();
  if (!room) throw new HttpError(404, "This invitation has expired or was already used.");
  return { roomId: room.id, token: session, role: "bob" };
}

export async function getRoom(request: Request, id: string) {
  const { db, master, room, role } = await authorize(request, id);
  const active = room.active_exchange
    ? await db.prepare("SELECT transcript FROM exchanges WHERE id = ? AND room_id = ?").bind(room.active_exchange, id).first<{ transcript: string }>() : null;
  const result = await db.prepare("SELECT m.*, e.wrapped_key FROM messages m JOIN exchanges e ON e.id = m.exchange_id AND e.room_id = m.room_id WHERE m.room_id = ? ORDER BY m.created_at DESC, m.rowid DESC LIMIT 200")
    .bind(id).all<StoredMessage>();
  const keys = new Map<string, Uint8Array>();
  try {
    const messages = [];
    for (const stored of [...result.results].reverse()) {
      let key = keys.get(stored.exchange_id);
      if (!key) {
        key = await unwrapKey(JSON.parse(stored.wrapped_key) as Envelope, master, `${id}/${stored.exchange_id}`);
        keys.set(stored.exchange_id, key);
      }
      const plain = await decryptMessage(key, { ciphertext: stored.ciphertext, iv: stored.iv }, context(id, stored.exchange_id, stored.id, stored.role));
      messages.push({
        id: stored.id, role: stored.role, displayName: stored.role === "alice" ? room.alice_name : room.bob_name,
        text: plain, createdAt: stored.created_at, ciphertext: stored.ciphertext, iv: stored.iv, exchangeId: stored.exchange_id,
      });
    }
    return {
      id: room.id, name: room.name, role, aliceName: room.alice_name, bobName: room.bob_name, createdAt: room.created_at,
      activeExchange: active ? parseTranscript(active.transcript) : null, latestAttempt: parseTranscript(room.latest_attempt), messages,
      securityPlan: room.security_plan ? JSON.parse(room.security_plan) : null,
    };
  } finally { for (const key of keys.values()) key.fill(0); }
}

export async function sendMessage(request: Request, id: string) {
  const input = await body(request);
  const plain = text(input.text, "Message", 4000);
  const { db, master, room, role } = await authorize(request, id);
  if (!room.active_exchange || input.exchangeId !== room.active_exchange) throw new HttpError(409, "The channel key changed. Refresh and send again.");
  const exchange = await db.prepare("SELECT * FROM exchanges WHERE id = ? AND room_id = ?").bind(room.active_exchange, id).first<Exchange>();
  if (!exchange?.wrapped_key) throw new HttpError(409, "Establish a channel key before sending.");
  const key = await unwrapKey(JSON.parse(exchange.wrapped_key) as Envelope, master, `${id}/${exchange.id}`);
  const messageId = crypto.randomUUID();
  try {
    const encrypted = await encryptMessage(key, plain, context(id, exchange.id, messageId, role));
    const now = Date.now();
    const claimed = await db.prepare("UPDATE rooms SET last_send = ? WHERE id = ? AND active_exchange = ? AND last_send < ? RETURNING id")
      .bind(now, id, exchange.id, now - 200).first();
    if (!claimed) throw new HttpError(409, "The channel changed or messages are arriving too quickly. Please retry.");
    const inserted = await db.prepare("INSERT INTO messages (id,room_id,exchange_id,role,ciphertext,iv,created_at) SELECT ?,?,?,?,?,?,? FROM rooms WHERE id = ? AND active_exchange = ?")
      .bind(messageId, id, exchange.id, role, encrypted.ciphertext, encrypted.iv, new Date(now).toISOString(), id, exchange.id).run();
    if (!inserted.meta.changes) throw new HttpError(409, "The channel key changed. Refresh and send again.");
    return { ok: true };
  } finally { key.fill(0); }
}

export async function exchangeKey(request: Request, id: string) {
  const input = await body(request);
  if (typeof input.intercept !== "boolean") throw new HttpError(400, "Choose whether to simulate eavesdropping.");
  const { db, master, room } = await authorize(request, id);
  const now = Date.now();
  const claimed = await db.prepare("UPDATE rooms SET last_exchange = ? WHERE id = ? AND last_exchange < ? RETURNING id")
    .bind(now, id, now - 1500).first();
  if (!claimed) throw new HttpError(429, "Wait a moment before another key exchange.");
  const plan = room.security_plan ? JSON.parse(room.security_plan) as ReturnType<typeof planDetectionConfidence> : null;
  const result = await runKeyExchange({ roomId: id, intercept: input.intercept, ...(plan ? { qubits: plan.qubits, sampleBits: plan.sampleBits, abortOnAnyError: true } : {}) });
  const serialized = JSON.stringify(result.transcript);
  if (!result.accepted || !result.key) {
    await db.prepare("UPDATE rooms SET latest_attempt = ? WHERE id = ? AND last_exchange = ?").bind(serialized, id, now).run();
    return { accepted: false, transcript: result.transcript };
  }
  try {
    const wrapped = await wrapKey(result.key, master, `${id}/${result.transcript.exchangeId}`);
    const batch = await db.batch([
      db.prepare("INSERT INTO exchanges (id,room_id,wrapped_key,transcript,created_at) SELECT ?,?,?,?,? FROM rooms WHERE id = ? AND last_exchange = ? AND active_exchange IS ?")
        .bind(result.transcript.exchangeId, id, JSON.stringify(wrapped), serialized, new Date(now).toISOString(), id, now, room.active_exchange),
      db.prepare("UPDATE rooms SET active_exchange = ?, latest_attempt = ? WHERE id = ? AND last_exchange = ? AND active_exchange IS ?")
        .bind(result.transcript.exchangeId, serialized, id, now, room.active_exchange),
    ]);
    if (!batch[1].meta.changes) throw new HttpError(409, "Another exchange completed first. Refresh the conversation.");
    return { accepted: true, transcript: result.transcript };
  } finally { result.key.fill(0); }
}

export async function createInvite(request: Request, id: string) {
  await body(request);
  const { db, room, role } = await authorize(request, id);
  if (role !== "alice") throw new HttpError(403, "Only the conversation creator can create an invitation.");
  if (room.bob_hash) throw new HttpError(409, "Both places in this conversation are already taken.");
  const invitation = token();
  const now = Date.now();
  const updated = await db.prepare("UPDATE rooms SET invite_hash = ?, last_invite = ? WHERE id = ? AND bob_hash IS NULL AND last_invite < ? RETURNING id")
    .bind(await hash(invitation), now, id, now - 1500).first();
  if (!updated) throw new HttpError(409, "The invitation changed. Wait a moment and try again.");
  return { inviteToken: invitation };
}
