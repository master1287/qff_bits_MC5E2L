import { env } from "cloudflare:workers";

type Dict = Record<string, unknown>;
type IBMEnv = Cloudflare.Env & { IBM_QUANTUM_API_KEY?: string; IBM_QUANTUM_CRN?: string; IBM_QUANTUM_ALLOW_PAID?: string; IBM_QUANTUM_PLAN_MODE?: string; IBM_QUANTUM_FREE_PLAN_ID?: string };
type JobRow = { id: string; backend: string; intercept: number; created_at: string; owner_id: string; status: string; result: string | null };
type Basis = "Z" | "X";
const PROVIDER = "ibm-quantum";
const VERSION = "2026-04-15";
const SHOTS = 128;
const ALICE_BITS = [0, 1, 1, 0, 1];
const ALICE_BASES: Basis[] = ["Z", "X", "Z", "X", "Z"];
const BOB_BASES: Basis[] = ["Z", "Z", "Z", "X", "X"];
const EVE_BASES: Basis[] = ["X", "Z", "Z", "Z", "X"];
const jsonHeaders = { "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
let tokenCache: { apiKey: string; accessToken: string; expires: number } | null = null;

class QuantumError extends Error { constructor(public status: number, message: string, public submissionRejected = false) { super(message); } }
function object(value: unknown): Dict {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new QuantumError(502, "IBM returned an unexpected response.");
  return value as Dict;
}
function settings() {
  const current = env as IBMEnv;
  if (!current.IBM_QUANTUM_API_KEY || !current.IBM_QUANTUM_CRN) throw new QuantumError(503, "IBM Quantum is not configured on this server.");
  const crn = current.IBM_QUANTUM_CRN;
  if (!crn.startsWith("crn:") || !crn.includes(":quantum-computing:")) throw new QuantumError(503, "The IBM Quantum instance is not configured correctly.");
  const region = crn.split(":")[5];
  if (!["us-east", "eu-de"].includes(region)) throw new QuantumError(503, "This IBM Quantum instance region is unsupported.");
  return { current, apiKey: current.IBM_QUANTUM_API_KEY, crn, base: region === "eu-de" ? "https://eu-de.quantum.cloud.ibm.com/api/v1" : "https://quantum.cloud.ibm.com/api/v1" };
}
function owner(request: Request) {
  const id = request.headers.get("oai-authenticated-user-id");
  if (!id || id.length > 200) throw new QuantumError(401, "Sign in to this site before using IBM Quantum hardware.");
  return id;
}
function database() { if (!env.DB) throw new QuantumError(503, "Hardware job storage is unavailable."); return env.DB; }

async function readJson(response: Response): Promise<Dict> {
  if (Number(response.headers.get("content-length") || 0) > 1048576) throw new QuantumError(502, "IBM returned an oversized response.");
  const text = await response.text();
  if (text.length > 1048576) throw new QuantumError(502, "IBM returned an oversized response.");
  try { const parsed: unknown = JSON.parse(text); return object(typeof parsed === "string" ? JSON.parse(parsed) : parsed); }
  catch { throw new QuantumError(502, "IBM returned an unreadable response."); }
}
async function accessToken() {
  const { apiKey } = settings();
  if (tokenCache?.apiKey === apiKey && tokenCache.expires > Date.now()) return tokenCache.accessToken;
  let response: Response;
  try {
    response = await fetch("https://iam.cloud.ibm.com/identity/token", {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(15000),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "urn:ibm:params:oauth:grant-type:apikey", apikey: apiKey }).toString(),
    });
  } catch { throw new QuantumError(503, "IBM Quantum authentication is temporarily unavailable."); }
  if (!response.ok) throw new QuantumError(503, "IBM Quantum authorization failed. Check the server credentials and instance access.");
  const value = await readJson(response);
  if (typeof value.access_token !== "string" || !value.access_token) throw new QuantumError(502, "IBM did not return an access token.");
  tokenCache = { apiKey, accessToken: value.access_token, expires: Date.now() + Math.max(0, Math.min(Number(value.expires_in) || 0, 3600) - 60) * 1000 };
  return value.access_token;
}
async function ibm(path: string, method = "GET", body?: Dict): Promise<Dict> {
  const { base, crn } = settings();
  const token = await accessToken();
  let response: Response;
  try {
    response = await fetch(base + path, { method, redirect: "manual", signal: AbortSignal.timeout(20000),
      headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${token}`, "Service-CRN": crn, "IBM-API-Version": VERSION },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch { throw new QuantumError(502, method === "POST" ? "The IBM submission could not be confirmed. Check IBM Workloads before retrying." : "IBM Quantum is temporarily unreachable."); }
  if (!response.ok) {
    const message = response.status === 409 ? "The IBM instance usage limit has been reached." : response.status === 401 || response.status === 403 ? "IBM Quantum did not authorize this operation for the configured instance." : "IBM Quantum could not complete this operation.";
    throw new QuantumError(response.status === 409 ? 409 : 502, message, method === "POST" && response.status >= 400 && response.status < 500);
  }
  if (response.status === 204) throw new QuantumError(409, "The hardware result is not ready yet.");
  return readJson(response);
}

async function planInfo(instance: Dict) {
  const { current } = settings();
  const id = typeof instance.plan_id === "string" ? instance.plan_id : "unknown";
  let name = typeof instance.plan_name === "string" ? instance.plan_name : id;
  // A verified free-plan assertion is bound to the exact plan that was checked.
  // An instance plan change must be independently classified before new jobs.
  let free = current.IBM_QUANTUM_PLAN_MODE === "free" && current.IBM_QUANTUM_FREE_PLAN_ID === id;
  if (!free && /^[A-Za-z0-9-]{1,100}$/.test(id)) {
    try {
      const response = await fetch(`https://globalcatalog.cloud.ibm.com/api/v1/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10000), redirect: "manual", headers: { Accept: "application/json" } });
      if (response.ok) {
        const catalog = await readJson(response);
        name = typeof catalog.name === "string" ? catalog.name : name;
        const label = `${name} ${typeof catalog.display_name === "string" ? catalog.display_name : ""}`.toLowerCase();
        free = /(^|[\s_-])(open|free)([\s_-]|$)/.test(label);
      }
    } catch { /* Unknown plans remain blocked unless explicitly approved. */ }
  }
  return { name, allowed: free || current.IBM_QUANTUM_ALLOW_PAID === "true", free };
}
async function chooseBackend() {
  const response = await ibm("/backends");
  const devices = Array.isArray(response.devices) ? response.devices.map(object) : [];
  const available = devices.filter(device => typeof device.name === "string" && /^[A-Za-z0-9_]{1,64}$/.test(device.name) && object(device.status).name === "online" && Number(device.qubits) >= 5 && device.is_simulator !== true)
    .sort((a, b) => Number(a.queue_length || 0) - Number(b.queue_length || 0));
  for (const device of available.slice(0, 3)) {
    const name = String(device.name);
    const configuration = await ibm(`/backends/${encodeURIComponent(name)}/configuration`);
    const gates = Array.isArray(configuration.basis_gates) ? configuration.basis_gates : [];
    const instructions = Array.isArray(configuration.supported_instructions) ? configuration.supported_instructions : [];
    if (!["x", "sx", "rz"].every(gate => gates.includes(gate)) || (instructions.length && !instructions.includes("measure"))) continue;
    const properties = await ibm(`/backends/${encodeURIComponent(name)}/properties`);
    const unavailable = new Set<number>();
    for (const value of [configuration.faulty_qubits, configuration.disabled_qubits, properties.faulty_qubits]) {
      if (Array.isArray(value)) for (const index of value) if (Number.isSafeInteger(index)) unavailable.add(Number(index));
    }
    const qubitProperties = Array.isArray(properties.qubits) ? properties.qubits : [];
    const count = Number(configuration.n_qubits ?? device.qubits);
    const physicalQubits: number[] = [];
    for (let index = 0; index < count && physicalQubits.length < 5; index++) {
      const params = Array.isArray(qubitProperties[index]) ? qubitProperties[index] as unknown[] : [];
      const operational = params.find(value => value && typeof value === "object" && (value as Dict).name === "operational") as Dict | undefined;
      if (!unavailable.has(index) && operational?.value !== false && operational?.value !== 0) physicalQubits.push(index);
    }
    if (physicalQubits.length === 5) return { name, physicalQubits };
  }
  return null;
}
async function readiness() {
  const [instance, usage] = await Promise.all([ibm("/instance"), ibm("/instances/usage")]);
  const plan = await planInfo(instance);
  const limit = Number(usage.usage_limit_seconds);
  const consumed = Number(usage.usage_consumed_seconds);
  if (usage.usage_limit_reached === true || (Number.isFinite(limit) && limit > 0 && Number.isFinite(consumed) && consumed >= limit)) {
    return { plan: plan.name, backend: null, canSubmit: false, reason: "The IBM instance usage limit has been reached." };
  }
  if (!plan.allowed) return { plan: plan.name, backend: null, canSubmit: false, reason: "Hardware execution requires an approved spending limit for this instance." };
  const selected = await chooseBackend();
  return { plan: plan.name, backend: selected?.name ?? null, physicalQubits: selected?.physicalQubits, canSubmit: Boolean(selected), ...(selected ? {} : { reason: "No compatible online five-qubit IBM backend is available." }) };
}

export async function quantumStatus(request: Request) {
  const current = env as IBMEnv;
  const configured = Boolean(current.IBM_QUANTUM_API_KEY && current.IBM_QUANTUM_CRN);
  if (!configured) return { configured: false, provider: PROVIDER, canSubmit: false, reason: "IBM Quantum hardware has not been configured on the server." };
  if (!request.headers.get("oai-authenticated-user-id")) return { configured: true, provider: PROVIDER, canSubmit: false, reason: "Sign in to this site to run a hardware demonstration." };
  try {
    if (env.DB) {
      const pending = await env.DB.prepare("SELECT id,backend FROM quantum_jobs WHERE owner_id = ? AND status IN ('submitting','uncertain','queued','running') LIMIT 1").bind(owner(request)).first<{ id: string; backend: string }>();
      if (pending) return { configured, provider: PROVIDER, backend: pending.backend, canSubmit: false, activeJobId: pending.id, reason: "A hardware job is already pending for this account." };
    }
    const state = await readiness();
    return { configured, provider: PROVIDER, ...state };
  } catch (error) { return { configured, provider: PROVIDER, canSubmit: false, reason: error instanceof QuantumError ? error.message : "IBM Quantum is temporarily unavailable." }; }
}

export function hardwareQasm(intercept: boolean, physicalQubits: number[] = [0, 1, 2, 3, 4]) {
  if (physicalQubits.length !== 5 || new Set(physicalQubits).size !== 5 || physicalQubits.some(index => !Number.isSafeInteger(index) || index < 0 || index > 10000)) throw new QuantumError(502, "Invalid hardware qubit mapping.");
  const lines = ['OPENQASM 3.0;', 'include "stdgates.inc";', 'bit[5] bob;', ...(intercept ? ['bit[5] eve;'] : [])];
  const h = (index: number) => [`rz(pi/2) $${index};`, `sx $${index};`, `rz(pi/2) $${index};`];
  for (let i = 0; i < 5; i++) {
    const physical = physicalQubits[i];
    if (ALICE_BITS[i]) lines.push(`x $${physical};`);
    if (ALICE_BASES[i] === "X") lines.push(...h(physical));
    if (intercept) {
      if (EVE_BASES[i] === "X") lines.push(...h(physical));
      lines.push(`eve[${i}] = measure $${physical};`);
      if (EVE_BASES[i] === "X") lines.push(...h(physical));
    }
    if (BOB_BASES[i] === "X") lines.push(...h(physical));
    lines.push(`bob[${i}] = measure $${physical};`);
  }
  return lines.join("\n");
}
async function input(request: Request) {
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) throw new QuantumError(403, "The hardware request must come from this website.");
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) throw new QuantumError(415, "Send a JSON request.");
  if (Number(request.headers.get("Content-Length") || 0) > 1024) throw new QuantumError(413, "The hardware request is too large.");
  const text = await request.text();
  if (text.length > 1024) throw new QuantumError(413, "The hardware request is too large.");
  let value: Dict;
  try { value = object(JSON.parse(text)); } catch { throw new QuantumError(400, "Send a valid hardware request."); }
  if (typeof value.intercept !== "boolean" || Object.keys(value).some(key => key !== "intercept")) throw new QuantumError(400, "Choose whether to include Eve in the hardware demonstration.");
  return value.intercept;
}

export async function startHardwareJob(request: Request) {
  const user = owner(request);
  const intercept = await input(request);
  const db = database();
  const state = await readiness();
  if (!state.canSubmit || !state.backend) throw new QuantumError(409, state.reason || "IBM Quantum hardware is unavailable.");
  const claim = `pending-${crypto.randomUUID()}`;
  const now = new Date();
  const physicalQubits = state.physicalQubits ?? [0, 1, 2, 3, 4];
  const inserted = await db.prepare("INSERT INTO quantum_jobs (id,backend,intercept,created_at,owner_id,status,result) SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM quantum_jobs WHERE owner_id = ? AND (status IN ('submitting','uncertain','queued','running') OR created_at > ?))")
    .bind(claim, state.backend, intercept ? 1 : 0, now.toISOString(), user, "submitting", JSON.stringify({ physicalQubits }), user, new Date(now.getTime() - 30000).toISOString()).run();
  if (!inserted.meta.changes) throw new QuantumError(409, "A hardware job is pending, or a job was submitted very recently. Continue checking the existing job.");
  try {
    const result = await ibm("/jobs", "POST", { program_id: "sampler", backend: state.backend, cost: 60, tags: ["qubit-bb84-teaching"],
      params: { pubs: [[hardwareQasm(intercept, physicalQubits), [], SHOTS]], shots: SHOTS, version: 2, support_qiskit: false,
        options: { twirling: { enable_gates: false, enable_measure: false } } },
    });
    if (typeof result.id !== "string" || !/^[A-Za-z0-9_-]{5,100}$/.test(result.id)) throw new QuantumError(502, "The IBM submission could not be confirmed. Check IBM Workloads before retrying.");
    await db.prepare("UPDATE quantum_jobs SET id = ?, status = 'queued' WHERE id = ? AND owner_id = ?").bind(result.id, claim, user).run();
    return { id: result.id, status: "queued", backend: state.backend, shots: SHOTS, provider: PROVIDER, hardware: true };
  } catch (error) {
    // An interrupted POST may have reached IBM. Keep a blocking claim rather
    // than submit a potentially billable duplicate automatically.
    const status = error instanceof QuantumError && error.submissionRejected ? "failed" : "uncertain";
    await db.prepare("UPDATE quantum_jobs SET status = ? WHERE id = ? AND owner_id = ?").bind(status, claim, user).run();
    throw error;
  }
}

function samples(value: unknown) {
  const field = object(value);
  if (!Array.isArray(field.samples) || field.samples.length !== SHOTS || field.samples.some(sample => typeof sample !== "string" || !/^(0x)?[0-9a-fA-F]{1,2}$/.test(sample) || parseInt(sample, 16) > 31)) {
    throw new QuantumError(502, "IBM returned an unexpected measurement format.");
  }
  return field.samples.map(sample => parseInt(String(sample), 16));
}
function state(bit: number, basis: Basis) { return basis === "Z" ? bit ? "|1⟩" : "|0⟩" : bit ? "|−⟩" : "|+⟩"; }
export function hardwareLesson(raw: unknown, job: Pick<JobRow, "id" | "backend" | "intercept"> & { physicalQubits?: number[] }) {
  const root = object(raw);
  if (!Array.isArray(root.results) || root.results.length !== 1) throw new QuantumError(502, "IBM returned an unexpected hardware result.");
  const data = object(object(root.results[0]).data);
  const bob = samples(data.bob);
  const eve = job.intercept ? samples(data.eve) : null;
  // First shot is selected before inspecting values; no favorable outcome is chosen.
  const rows = ALICE_BITS.map((aliceBit, i) => {
    const bobBit = bob[0] >> i & 1;
    const eveBit = eve ? eve[0] >> i & 1 : null;
    return { index: i + 1, aliceBit, aliceBasis: ALICE_BASES[i], aliceState: state(aliceBit, ALICE_BASES[i]),
      aliceGates: [...(aliceBit ? ["X"] : []), ...(ALICE_BASES[i] === "X" ? ["H"] : [])],
      eveBasis: job.intercept ? EVE_BASES[i] : null, eveBit, eveState: eveBit === null ? null : state(eveBit, EVE_BASES[i]),
      bobBasis: BOB_BASES[i], bobBit, bobState: state(bobBit, BOB_BASES[i]),
      basisMatches: ALICE_BASES[i] === BOB_BASES[i], bitMatches: aliceBit === bobBit, sampled: i === 0 || i === 3 };
  });
  const publicRows = rows.filter(row => row.sampled);
  const errors = publicRows.filter(row => !row.bitMatches).length;
  let totalErrors = 0;
  for (const shot of bob) for (const i of [0, 3]) if ((shot >> i & 1) !== ALICE_BITS[i]) totalErrors++;
  return { id: job.id, jobId: job.id, backend: job.backend, engine: "ibm-quantum-hardware", execution: "hardware", sourceLabel: "IBM Quantum hardware",
    qiskitVersion: "IBM Runtime Sampler V2", educational: true, curated: false, intercept: Boolean(job.intercept), rows,
    statistics: { sent: 5, sifted: 3, sampled: 2, errors, qber: errors / 2, detected: errors / 2 > 0.11,
      remainingBits: rows.filter(row => row.basisMatches && !row.sampled).map(row => row.aliceBit) },
    hardwareStatistics: { shots: SHOTS, sampleComparisons: SHOTS * 2, sampleErrors: totalErrors, qber: totalErrors / (SHOTS * 2), displayedShot: 1 },
    securityNotice: "A real hardware demonstration on one processor, not a remote quantum key-distribution channel. Noise can also cause mismatches. These public teaching bits never become chat keys.",
    physicalQubits: job.physicalQubits ?? [0, 1, 2, 3, 4], circuit: hardwareQasm(Boolean(job.intercept), job.physicalQubits) };
}

export async function hardwareJob(request: Request, id: string) {
  const user = owner(request);
  if (!/^[A-Za-z0-9_-]{5,100}$/.test(id)) throw new QuantumError(404, "This hardware job is unavailable.");
  const db = database();
  const job = await db.prepare("SELECT * FROM quantum_jobs WHERE id = ? AND owner_id = ?").bind(id, user).first<JobRow>();
  if (!job) throw new QuantumError(404, "This hardware job is unavailable.");
  const summary = { id, backend: job.backend, shots: SHOTS, provider: PROVIDER, hardware: true };
  if (job.status === "completed" && job.result) return { ...summary, status: "completed", lesson: JSON.parse(job.result) };
  if (job.status === "uncertain" || job.status === "submitting") return { ...summary, status: "failed", error: "The submission could not be confirmed. Check IBM Workloads before another submission." };
  if (["failed", "cancelled"].includes(job.status)) return { ...summary, status: job.status, error: "The hardware job did not complete. No simulated result has been substituted." };
  const remote = await ibm(`/jobs/${encodeURIComponent(id)}`);
  const remoteState = typeof remote.state === "object" && remote.state ? object(remote.state).status : remote.status;
  const normalized: Record<string, string> = { Queued: "queued", Running: "running", Completed: "completed", Cancelled: "cancelled", "Cancelled - Ran too long": "cancelled", Failed: "failed", QUEUED: "queued", RUNNING: "running", DONE: "completed", CANCELLED: "cancelled", ERROR: "failed" };
  const status = normalized[String(remoteState)];
  if (!status) throw new QuantumError(502, "IBM returned an unknown hardware job status.");
  if (status === "completed") {
    const result = await ibm(`/jobs/${encodeURIComponent(id)}/results`);
    const mapping = job.result ? object(JSON.parse(job.result)).physicalQubits : undefined;
    const lesson = hardwareLesson(result, { ...job, physicalQubits: Array.isArray(mapping) ? mapping as number[] : undefined });
    await db.prepare("UPDATE quantum_jobs SET status = 'completed', result = ? WHERE id = ? AND owner_id = ?").bind(JSON.stringify(lesson), id, user).run();
    return { ...summary, status, lesson };
  }
  await db.prepare("UPDATE quantum_jobs SET status = ? WHERE id = ? AND owner_id = ?").bind(status, id, user).run();
  return { ...summary, status, ...(["failed", "cancelled"].includes(status) ? { error: "IBM hardware did not complete this job. No simulation was substituted." } : {}) };
}

export async function quantumResponse(operation: () => Promise<unknown>) {
  try { return Response.json(await operation(), { headers: jsonHeaders }); }
  catch (error) { return Response.json({ error: error instanceof QuantumError ? error.message : "The IBM Quantum request could not be completed." }, { status: error instanceof QuantumError ? error.status : 500, headers: jsonHeaders }); }
}
