import test from 'node:test';
import assert from 'node:assert/strict';
import { BB84_BASES, encodeQubit, simulateBB84, encryptMessage, decryptMessage, wrapKey, unwrapKey, encodeKey, decodeKey } from '../lib/bb84.mjs';
import { planDetectionConfidence } from '../lib/security-plan.mjs';

test('Z and X bases encode the four BB84 states with the requested bit mapping', () => {
  assert.deepEqual(BB84_BASES, { Z: ['|0⟩', '|1⟩'], X: ['|+⟩', '|−⟩'] });
  assert.equal(encodeQubit(0, 'Z'), '|0⟩');
  assert.equal(encodeQubit(1, 'Z'), '|1⟩');
  assert.equal(encodeQubit(0, 'X'), '|+⟩');
  assert.equal(encodeQubit(1, 'X'), '|−⟩');
  assert.throws(() => encodeQubit(2, 'Z'));
  assert.throws(() => encodeQubit(0, '+'));
  assert.throws(() => { BB84_BASES.X[0] = '|−⟩'; }, TypeError);
});

test('honest BB84 simulation agrees on a 256-bit key and discloses only discarded sample bits', async () => {
  const { accepted, key, transcript } = await simulateBB84({ roomId: 'test-room', exchangeId: 'honest' });
  assert.equal(accepted, true);
  assert.equal(key.length, 32);
  assert.equal(transcript.qber, 0);
  assert.equal(transcript.sampleErrors, 0);
  assert.equal(transcript.siftedBits, transcript.sampledBits + transcript.remainingBits);
  assert.ok(transcript.remainingBits >= 512);
  assert.equal(transcript.keyBits, 256);
  assert.match(transcript.fingerprint, /^([\da-f]{2}:){7}[\da-f]{2}$/);
  assert.ok(!Object.hasOwn(transcript, 'key'));
  for (const entry of transcript.trace) {
    assert.ok(entry.aliceBasis === 'Z' || entry.aliceBasis === 'X');
    assert.ok(entry.bobBasis === 'Z' || entry.bobBasis === 'X');
    assert.equal(entry.aliceBasis === entry.bobBasis, entry.status !== 'discarded');
    assert.equal(Object.hasOwn(entry, 'sampleAlice'), entry.status === 'sampled');
    assert.equal(Object.hasOwn(entry, 'sampleBob'), entry.status === 'sampled');
    if (entry.status === 'sampled') assert.equal(entry.sampleAlice, entry.sampleBob);
    if (entry.status === 'retained') assert.deepEqual(Object.keys(entry).sort(), ['aliceBasis', 'bobBasis', 'index', 'status']);
  }
  const message = 'Hello, Bob! 🔐 नमस्ते';
  const context = JSON.stringify(['test-room', transcript.exchangeId, 'message-id', 'alice']);
  const first = await encryptMessage(key, message, context);
  const second = await encryptMessage(key, message, context);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.equal(await decryptMessage(key, first, context), message);
  assert.ok(!JSON.stringify(first).includes(message));
});

test('AES-GCM rejects ciphertext alteration, swapped context, wrong keys, and invalid nonce', async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const envelope = await encryptMessage(key, 'Secret', 'room:exchange:message:alice');
  const corrupted = decodeKey(envelope.ciphertext);
  corrupted[0] ^= 1;
  await assert.rejects(decryptMessage(key, { ...envelope, ciphertext: encodeKey(corrupted) }, 'room:exchange:message:alice'));
  await assert.rejects(decryptMessage(key, envelope, 'room:exchange:different:alice'));
  await assert.rejects(decryptMessage(crypto.getRandomValues(new Uint8Array(32)), envelope, 'room:exchange:message:alice'));
  await assert.rejects(decryptMessage(key, { ...envelope, iv: 'AQ' }, 'room:exchange:message:alice'));
});

test('full intercept-resend attack is detected; aborted exchanges never return a key', async () => {
  // Several independently sampled runs exercise random basis measurement.
  // With >=~1000 sampled bits the probability of false acceptance is negligible.
  for (let i = 0; i < 5; i++) {
    const { accepted, key, transcript } = await simulateBB84({ roomId: 'attack-demo', intercept: true });
    assert.equal(accepted, false);
    assert.equal(key, null);
    assert.equal(transcript.status, 'aborted');
    assert.ok(transcript.qber > 0.11);
    assert.ok(transcript.qber < 0.4);
    assert.equal(transcript.keyBits, 0);
    assert.equal(transcript.fingerprint, null);
  }
});

test('stored keys can be wrapped with a master key and are bound to room/exchange context', async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const master = crypto.getRandomValues(new Uint8Array(32));
  const wrapped = await wrapKey(key, master, 'room-a/exchange-1');
  assert.deepEqual(await unwrapKey(wrapped, master, 'room-a/exchange-1'), key);
  await assert.rejects(unwrapKey(wrapped, master, 'room-b/exchange-1'));
  await assert.rejects(unwrapKey(wrapped, crypto.getRandomValues(new Uint8Array(32)), 'room-a/exchange-1'));
  assert.ok(!JSON.stringify(wrapped).includes(encodeKey(key)));
});

test('exchange and encryption input validation rejects unsafe sizes and malformed keys', async () => {
  await assert.rejects(simulateBB84({ roomId: 'room', qubits: 10 }));
  await assert.rejects(simulateBB84({ roomId: 'room', qubits: 1000000 }));
  await assert.rejects(simulateBB84({ roomId: '', qubits: 4096 }));
  await assert.rejects(encryptMessage(new Uint8Array(16), 'Hi', 'context'));
  assert.throws(() => decodeKey('invalid!'));
});

test('planned exchanges disclose the exact requested sample and keep it out of the key material', async () => {
  const plan = planDetectionConfidence(99);
  let result;
  // The conservative budget may require a retry; a retry never shrinks m.
  for (let attempt = 0; attempt < 3; attempt++) {
    result = await simulateBB84({ roomId: 'planned-honest', qubits: plan.qubits, sampleBits: plan.sampleBits, abortOnAnyError: true });
    if (result.accepted) break;
    assert.match(result.transcript.reason, /complete requested sample/);
    assert.equal(result.key, null);
    assert.equal(result.transcript.requestedSampleBits, plan.sampleBits);
  }
  assert.equal(result.accepted, true);
  assert.equal(result.key.length, 32);
  assert.equal(result.transcript.qubits, plan.qubits);
  assert.equal(result.transcript.sampledBits, plan.sampleBits);
  assert.equal(result.transcript.requestedSampleBits, plan.sampleBits);
  assert.equal(result.transcript.abortOnAnyError, true);
  assert.equal(result.transcript.threshold, 0);
  assert.equal(result.transcript.sampleErrors, 0);
  assert.ok(result.transcript.remainingBits >= 512);
  assert.equal(result.transcript.siftedBits, result.transcript.sampledBits + result.transcript.remainingBits);
  for (const row of result.transcript.trace) {
    if (row.status !== 'sampled') {
      assert.equal(row.sampleAlice, undefined);
      assert.equal(row.sampleBob, undefined);
    }
  }
  result.key.fill(0);
});

test('planned intercept-resend exchanges reject disturbance without producing a key', async () => {
  const plan = planDetectionConfidence(99.9);
  const result = await simulateBB84({ roomId: 'planned-attack', qubits: plan.qubits, sampleBits: plan.sampleBits, abortOnAnyError: true, intercept: true });
  assert.equal(result.accepted, false);
  assert.equal(result.key, null);
  assert.equal(result.transcript.threshold, 0);
  assert.equal(result.transcript.requestedSampleBits, plan.sampleBits);
  assert.equal(result.transcript.keyBits, 0);
  assert.ok(result.transcript.sampleErrors > 0 || /confirmation|sifting/.test(result.transcript.reason));
});

test('an insufficient sifted pool aborts instead of shrinking the requested sample', async () => {
  // Even all matching bases cannot provide 1024 public and 512 undisclosed bits.
  const result = await simulateBB84({ roomId: 'insufficient-plan', qubits: 1024, sampleBits: 1024, abortOnAnyError: true });
  assert.equal(result.accepted, false);
  assert.equal(result.key, null);
  assert.equal(result.transcript.sampledBits, 0);
  assert.equal(result.transcript.requestedSampleBits, 1024);
  assert.equal(result.transcript.siftedBits, result.transcript.sampledBits + result.transcript.remainingBits);
  assert.match(result.transcript.reason, /complete requested sample/);
  assert.equal(result.transcript.fingerprint, null);
});

test('planned sample policy validates its parameters', async () => {
  for (const sampleBits of [0, -1, 1.5, 1025, NaN, '17']) {
    await assert.rejects(simulateBB84({ roomId: 'invalid-plan', qubits: 1187, sampleBits, abortOnAnyError: true }));
  }
  await assert.rejects(simulateBB84({ roomId: 'invalid-policy', sampleBits: 17, abortOnAnyError: 'yes' }));
  await assert.rejects(simulateBB84({ roomId: 'invalid-qubits', qubits: 1023, sampleBits: 17, abortOnAnyError: true }));
});
