import { env } from "cloudflare:workers";
import { decodeKey, simulateBB84, type Transcript, type TraceEntry } from "./bb84.mjs";

export function hasLiveQiskit() { return Boolean(env.QISKIT_SERVICE_URL); }

export async function callQiskit(path: "/lesson" | "/exchange", input: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!env.QISKIT_SERVICE_URL) throw new Error("A live Qiskit service is not configured.");
  const base = new URL(env.QISKIT_SERVICE_URL);
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
  if ((base.protocol !== "https:" && !(local && base.protocol === "http:")) || base.username || base.password || base.search || base.hash) {
    throw new Error("The Qiskit service needs an HTTPS address, or a local HTTP address.");
  }
  if (!local && !env.QISKIT_SERVICE_TOKEN) throw new Error("The remote Qiskit service needs an authentication token.");
  const response = await fetch(base.href.replace(/\/$/, "") + path, {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(30000),
    headers: { "Content-Type": "application/json", ...(env.QISKIT_SERVICE_TOKEN ? { Authorization: `Bearer ${env.QISKIT_SERVICE_TOKEN}` } : {}) },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error("The Qiskit service could not complete the simulation.");
  const source = await response.text();
  if (source.length > 262144) throw new Error("The Qiskit result was too large.");
  const result: unknown = JSON.parse(source);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid Qiskit result.");
  return result as Record<string, unknown>;
}

export async function runKeyExchange(options: { roomId: string; exchangeId?: string; intercept?: boolean; qubits?: number; sampleBits?: number; abortOnAnyError?: boolean }) {
  if (!hasLiveQiskit()) {
    const result = await simulateBB84(options);
    return { ...result, transcript: { ...result.transcript, engine: "classical-bb84-simulator" } };
  }
  const exchangeId = options.exchangeId ?? crypto.randomUUID();
  const qubits = options.qubits ?? 4096;
  const planned = options.sampleBits !== undefined || Boolean(options.abortOnAnyError);
  if (!Number.isSafeInteger(qubits) || qubits < (planned ? 1024 : 4096) || qubits > 8192
    || (options.abortOnAnyError !== undefined && typeof options.abortOnAnyError !== "boolean")
    || (options.sampleBits !== undefined && (!Number.isSafeInteger(options.sampleBits) || options.sampleBits < 1 || options.sampleBits > 1024))) {
    throw new Error("Invalid Qiskit exchange options.");
  }
  const threshold = options.abortOnAnyError ? 0 : 0.11;
  const data = await callQiskit("/exchange", { ...options, exchangeId, qubits, intercept: options.intercept ?? false });
  const raw = data.transcript as Partial<Transcript> & { engine?: string; qiskitVersion?: string } | undefined;
  if (typeof data.accepted !== "boolean" || !raw || raw.engine !== "qiskit-statevector" || raw.exchangeId !== exchangeId
      || raw.status !== (data.accepted ? "accepted" : "aborted") || raw.qubits !== qubits
      || typeof raw.qber !== "number" || !Number.isFinite(raw.qber) || raw.qber < 0 || raw.qber > 1
      || !Array.isArray(raw.trace) || raw.trace.length !== 24) throw new Error("Invalid Qiskit exchange result.");
  const counts = [raw.siftedBits, raw.sampledBits, raw.remainingBits, raw.sampleErrors];
  const insufficientPool = options.sampleBits !== undefined && typeof raw.siftedBits === "number" && raw.siftedBits < options.sampleBits + 512;
  const expectedSampleBits = insufficientPool ? 0 : options.sampleBits ?? Math.min(1024, Math.floor(raw.siftedBits! / 2));
  const expectedQber = raw.sampledBits ? raw.sampleErrors! / raw.sampledBits : 0;
  if (!counts.every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= qubits)
    || raw.sampledBits !== expectedSampleBits || raw.sampledBits! > 1024 || raw.sampleErrors! > raw.sampledBits!
    || raw.siftedBits !== raw.sampledBits! + raw.remainingBits!
    || Math.abs(raw.qber - expectedQber) > 1e-12 || raw.threshold !== threshold
    || raw.keyBits !== (data.accepted ? 256 : 0) || (data.accepted && (insufficientPool || raw.sampledBits! < 1 || raw.remainingBits! < 512))
    || (options.sampleBits !== undefined && (raw.requestedSampleBits !== options.sampleBits || raw.abortOnAnyError !== (options.abortOnAnyError ?? false)))
    || raw.interceptSimulated !== (options.intercept ?? false)
    || typeof raw.qiskitVersion !== "string" || !raw.qiskitVersion.length || raw.qiskitVersion.length > 50
    || (raw.reason !== null && (typeof raw.reason !== "string" || raw.reason.length > 500))
    || (data.accepted ? typeof raw.fingerprint !== "string" || !/^([a-f0-9]{2}:){7}[a-f0-9]{2}$/.test(raw.fingerprint) : raw.fingerprint !== null)) {
    throw new Error("Invalid Qiskit exchange statistics.");
  }
  const indices = new Set<number>();
  const trace: TraceEntry[] = raw.trace.map(row => {
    if (!row || typeof row !== "object" || !Number.isSafeInteger(row.index) || row.index < 1 || row.index > qubits || indices.has(row.index)
      || !["Z", "X"].includes(row.aliceBasis) || !["Z", "X"].includes(row.bobBasis)
      || !["discarded", "sampled", "retained"].includes(row.status)
      || (row.status === "discarded") !== (row.aliceBasis !== row.bobBasis)
      || (row.status === "sampled" && (![0, 1].includes(row.sampleAlice!) || ![0, 1].includes(row.sampleBob!)))) throw new Error("Invalid Qiskit trace.");
    indices.add(row.index);
    return { index: row.index, aliceBasis: row.aliceBasis, bobBasis: row.bobBasis, status: row.status,
      ...(row.status === "sampled" ? { sampleAlice: row.sampleAlice, sampleBob: row.sampleBob } : {}) };
  });
  // Only public transcript fields cross the browser boundary. The service key
  // travels server-to-server, is wrapped for storage, and is never in a response.
  const transcript: Transcript & { engine: string; qiskitVersion?: string } = {
    exchangeId, status: raw.status, qubits: raw.qubits, siftedBits: raw.siftedBits!, sampledBits: raw.sampledBits!,
    remainingBits: raw.remainingBits!, sampleErrors: raw.sampleErrors!, qber: raw.qber,
    threshold: raw.threshold!, keyBits: raw.keyBits!, fingerprint: raw.fingerprint ?? null,
    interceptSimulated: options.intercept ?? false, trace, reason: raw.reason ?? null,
    mode: "trusted-server-simulation", engine: "qiskit-statevector", qiskitVersion: raw.qiskitVersion,
    ...(options.sampleBits !== undefined ? { requestedSampleBits: options.sampleBits, abortOnAnyError: options.abortOnAnyError ?? false } : {}),
  };
  if (!data.accepted) return { accepted: false, key: null, transcript };
  if (typeof data.key !== "string") throw new Error("The Qiskit exchange returned no key.");
  const key = decodeKey(data.key);
  if (key.length !== 32 || transcript.keyBits !== 256 || transcript.qber > transcript.threshold) throw new Error("Invalid Qiskit key.");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(key)));
  const fingerprint = [...digest.slice(0, 8)].map(n => n.toString(16).padStart(2, "0")).join(":");
  if (fingerprint !== transcript.fingerprint) { key.fill(0); throw new Error("Qiskit key confirmation failed."); }
  return { accepted: true, key, transcript };
}
