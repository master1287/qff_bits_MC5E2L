/**
 * Trusted-server educational BB84 simulation, not quantum key distribution.
 * Both endpoints and the simulated channel run in this process. HKDF below is
 * conventional key derivation, not a finite-key QKD privacy-amplification proof.
 * Reference: Shor & Preskill, https://arxiv.org/abs/quant-ph/0003004.
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const THRESHOLD = 0.11;

// The tuple index is the classical bit: Z = {|0⟩, |1⟩}, X = {|+⟩, |−⟩}.
export const BB84_BASES = Object.freeze({
  Z: Object.freeze(['|0⟩', '|1⟩']),
  X: Object.freeze(['|+⟩', '|−⟩']),
});

export function encodeQubit(bit, basis) {
  if ((bit !== 0 && bit !== 1) || (basis !== 'Z' && basis !== 'X')) throw new Error('A bit (0 or 1) and a Z or X basis are required');
  return BB84_BASES[basis][bit];
}

function randomBits(length) {
  return crypto.getRandomValues(new Uint8Array(length)).map((value) => value & 1);
}

function randomInt(max) {
  const limit = Math.floor(0x100000000 / max) * max;
  const value = new Uint32Array(1);
  do { crypto.getRandomValues(value); } while (value[0] >= limit);
  return value[0] % max;
}

function shuffle(values) {
  for (let i = values.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}

function packBits(bits) {
  const packed = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((bit, index) => { packed[index >> 3] |= bit << (7 - (index & 7)); });
  return packed;
}

export function encodeKey(value) {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function decodeKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid key encoding');
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
}

async function deriveKey(bits, roomId, exchangeId) {
  const context = encoder.encode(JSON.stringify(['qubit-chat/bb84-simulator/v1', roomId, exchangeId, bits.length]));
  const material = await crypto.subtle.importKey('raw', packBits(bits), 'HKDF', false, ['deriveBits']);
  const salt = await crypto.subtle.digest('SHA-256', context);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: context }, material, 256));
}

export async function simulateBB84({ roomId, exchangeId = crypto.randomUUID(), intercept = false, qubits = 4096, sampleBits, abortOnAnyError = false }) {
  if (typeof roomId !== 'string' || !roomId.length || roomId.length > 200 || typeof exchangeId !== 'string' || !exchangeId.length || exchangeId.length > 200) throw new Error('Invalid exchange context');
  const planned = sampleBits !== undefined || abortOnAnyError;
  const minimumQubits = planned ? 1024 : 4096;
  if (!Number.isInteger(qubits) || qubits < minimumQubits || qubits > 32768) throw new Error(`Qubit count must be an integer from ${minimumQubits} to 32768`);
  if (typeof intercept !== 'boolean') throw new Error('Invalid intercept option');
  if (typeof abortOnAnyError !== 'boolean') throw new Error('Invalid sample rejection policy');
  if (sampleBits !== undefined && (!Number.isInteger(sampleBits) || sampleBits < 1 || sampleBits > 1024)) throw new Error('Sample size must be an integer from 1 to 1024');

  const aliceBits = randomBits(qubits);
  // Internally, basis 0 denotes Z and basis 1 denotes X. A classical bit 0/1
  // therefore encodes |0⟩/|1⟩ in Z, or |+⟩/|−⟩ in X, respectively.
  const aliceBases = randomBits(qubits);
  const bobBases = randomBits(qubits);
  const bobRandom = randomBits(qubits);
  const eveBases = intercept ? randomBits(qubits) : null;
  const eveRandom = intercept ? randomBits(qubits) : null;
  const bobBits = new Uint8Array(qubits);
  const sifted = [];
  for (let i = 0; i < qubits; i++) {
    let bit = aliceBits[i];
    let basis = aliceBases[i];
    if (intercept) {
      bit = basis === eveBases[i] ? bit : eveRandom[i];
      basis = eveBases[i];
    }
    bobBits[i] = basis === bobBases[i] ? bit : bobRandom[i];
    if (aliceBases[i] === bobBases[i]) sifted.push(i);
  }

  // A uniformly selected public sample is removed permanently from key material.
  const shuffled = shuffle([...sifted]);
  // A planned exchange must disclose the exact requested sample. If basis
  // sifting yields too few bits, reject rather than reducing the confidence.
  const insufficientSifted = sampleBits !== undefined && shuffled.length < sampleBits + 512;
  const sampleCount = insufficientSifted ? 0 : sampleBits ?? Math.min(1024, Math.floor(shuffled.length / 2));
  const sampled = new Set(shuffled.slice(0, sampleCount));
  const retained = shuffled.slice(sampleCount).sort((a, b) => a - b);
  const errors = shuffled.slice(0, sampleCount).filter((i) => aliceBits[i] !== bobBits[i]).length;
  const qber = sampleCount ? errors / sampleCount : 0;
  const residualErrors = retained.some((i) => aliceBits[i] !== bobBits[i]);
  // No reconciliation is implemented: a key-confirmation mismatch also aborts.
  // The simulator can compare internally; it never repairs with a hidden oracle.
  const threshold = abortOnAnyError ? 0 : THRESHOLD;
  const accepted = !insufficientSifted && qber <= threshold && retained.length >= 512 && !residualErrors;
  let reason = null;
  if (insufficientSifted) reason = 'Basis sifting did not provide the complete requested sample plus 512 undisclosed bits. No key was derived; retry the exchange.';
  else if (abortOnAnyError && errors) reason = 'The public sample revealed a disturbance. The planned ideal-channel exchange rejects any sampled error.';
  else if (qber > threshold) reason = 'Sample error rate exceeded the 11% demonstration threshold. The candidate key was discarded.';
  else if (retained.length < 512) reason = 'Insufficient undisclosed bits. The candidate key was discarded.';
  else if (residualErrors) reason = 'Key confirmation failed. This simulator does not implement noisy-channel reconciliation.';
  const trace = Array.from({ length: 24 }, (_, i) => {
    const status = aliceBases[i] !== bobBases[i] ? 'discarded' : sampled.has(i) ? 'sampled' : 'retained';
    return { index: i + 1, aliceBasis: aliceBases[i] ? 'X' : 'Z', bobBasis: bobBases[i] ? 'X' : 'Z', status,
      ...(status === 'sampled' ? { sampleAlice: aliceBits[i], sampleBob: bobBits[i] } : {}) };
  });
  const transcript = {
    exchangeId, status: accepted ? 'accepted' : 'aborted', qubits,
    siftedBits: sifted.length, sampledBits: sampleCount, remainingBits: retained.length,
    sampleErrors: errors, qber, threshold, keyBits: accepted ? 256 : 0,
    fingerprint: null, interceptSimulated: intercept, trace, reason,
    mode: 'trusted-server-simulation',
    ...(sampleBits !== undefined ? { requestedSampleBits: sampleBits, abortOnAnyError } : {}),
  };
  if (!accepted) return { accepted, key: null, transcript };
  const aliceKey = await deriveKey(retained.map((i) => aliceBits[i]), roomId, exchangeId);
  const bobKey = await deriveKey(retained.map((i) => bobBits[i]), roomId, exchangeId);
  if (!aliceKey.every((value, i) => value === bobKey[i])) throw new Error('Key confirmation failed');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', aliceKey));
  transcript.fingerprint = [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join(':');
  bobKey.fill(0);
  aliceBits.fill(0);
  bobBits.fill(0);
  return { accepted, key: aliceKey, transcript };
}

async function aesKey(rawKey, usage) {
  if (!(rawKey instanceof Uint8Array) || rawKey.length !== 32) throw new Error('A 256-bit key is required');
  return crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, [usage]);
}

export async function encryptMessage(rawKey, plaintext, context) {
  if (typeof plaintext !== 'string' || typeof context !== 'string' || !context.length) throw new Error('Invalid message context');
  const key = await aesKey(rawKey, 'encrypt');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(context), tagLength: 128 }, key, encoder.encode(plaintext));
  return { ciphertext: encodeKey(new Uint8Array(ciphertext)), iv: encodeKey(iv) };
}

export async function decryptMessage(rawKey, envelope, context) {
  if (!envelope || typeof context !== 'string' || !context.length) throw new Error('Invalid message context');
  const key = await aesKey(rawKey, 'decrypt');
  const iv = decodeKey(envelope.iv);
  if (iv.length !== 12) throw new Error('Invalid message nonce');
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(context), tagLength: 128 }, key, decodeKey(envelope.ciphertext));
  return decoder.decode(plaintext);
}

export async function wrapKey(rawKey, masterKey, context) {
  return encryptMessage(masterKey, encodeKey(rawKey), 'qubit-chat/key-wrap/v1/' + context);
}

export async function unwrapKey(envelope, masterKey, context) {
  const key = decodeKey(await decryptMessage(masterKey, envelope, 'qubit-chat/key-wrap/v1/' + context));
  if (key.length !== 32) throw new Error('Invalid wrapped key');
  return key;
}
