import test, { after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const environment = {};
globalThis.__qubitTestEnv = environment;
const source = await readFile(path.join(root, 'lib', 'qiskit-client.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText
  .replace(/import\s*\{\s*env\s*\}\s*from\s*["']cloudflare:workers["'];?/, 'const env = globalThis.__qubitTestEnv;')
  .replace(/from\s*["']\.\/bb84\.mjs["']/, `from ${JSON.stringify(pathToFileURL(path.join(root, 'lib', 'bb84.mjs')).href)}`);
const scratch = path.join(root, 'work', 'qiskit-client-tests');
await mkdir(scratch, { recursive: true });
const compiledPath = path.join(scratch, 'qiskit-client.mjs');
await writeFile(compiledPath, compiled);
const client = await import(pathToFileURL(compiledPath).href);
const originalFetch = globalThis.fetch;

beforeEach(() => {
  for (const key of Object.keys(environment)) delete environment[key];
  globalThis.fetch = async () => { throw new Error('Unexpected network access in Qiskit client test'); };
});
afterEach(() => { globalThis.fetch = originalFetch; });
after(() => { delete globalThis.__qubitTestEnv; });

function exchangeResult(exchangeId, { accepted = true } = {}) {
  const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
  const fingerprint = [...createHash('sha256').update(key).digest().subarray(0, 8)]
    .map(value => value.toString(16).padStart(2, '0')).join(':');
  return {
    accepted,
    key: accepted ? key.toString('base64url') : null,
    privateServiceData: 'never expose this field',
    transcript: {
      exchangeId, status: accepted ? 'accepted' : 'aborted', qubits: 4096,
      siftedBits: 2048, sampledBits: 1024, remainingBits: 1024,
      sampleErrors: accepted ? 0 : 256, qber: accepted ? 0 : 0.25,
      threshold: 0.11, keyBits: accepted ? 256 : 0,
      fingerprint: accepted ? fingerprint : null,
      interceptSimulated: !accepted, reason: accepted ? null : 'Sample errors exceeded the demonstration threshold.',
      mode: 'trusted-server-simulation', engine: 'qiskit-statevector', qiskitVersion: '2.4.2',
      rawKey: 'secret transcript field',
      trace: [
        { index: 1, aliceBasis: 'Z', bobBasis: 'Z', status: 'retained', sampleAlice: 1, sampleBob: 1, aliceBit: 1, state: '|1⟩' },
        { index: 2, aliceBasis: 'X', bobBasis: 'Z', status: 'discarded', privateData: 'secret discarded field' },
        { index: 3, aliceBasis: 'X', bobBasis: 'X', status: 'sampled', sampleAlice: 0, sampleBob: 0, rawKey: 'secret sampled field' },
        ...Array.from({ length: 21 }, (_, index) => ({ index: index + 4, aliceBasis: index % 2 ? 'X' : 'Z', bobBasis: index % 2 ? 'X' : 'Z', status: 'retained' })),
      ],
    },
  };
}

test('no Qiskit URL selects the existing classical simulator explicitly', async () => {
  assert.equal(client.hasLiveQiskit(), false);
  const result = await client.runKeyExchange({ roomId: 'classic-room', exchangeId: 'classic-exchange' });
  assert.equal(result.accepted, true);
  assert.equal(result.key.length, 32);
  assert.equal(result.transcript.engine, 'classical-bb84-simulator');
  assert.equal(result.transcript.exchangeId, 'classic-exchange');
  assert.equal(result.transcript.qber, 0);
});

test('authenticated Qiskit exchange uses /exchange and exposes only public transcript fields', async () => {
  environment.QISKIT_SERVICE_URL = 'https://qiskit.example.test/';
  environment.QISKIT_SERVICE_TOKEN = 'test-service-token';
  const payload = exchangeResult('qiskit-exchange');
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls++;
    assert.equal(input, 'https://qiskit.example.test/exchange');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.Authorization, 'Bearer test-service-token');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(init.body), { roomId: 'qiskit-room', exchangeId: 'qiskit-exchange', qubits: 4096, intercept: false });
    return Response.json(payload);
  };
  assert.equal(client.hasLiveQiskit(), true);
  const result = await client.runKeyExchange({ roomId: 'qiskit-room', exchangeId: 'qiskit-exchange' });
  assert.equal(calls, 1);
  assert.equal(result.accepted, true);
  assert.deepEqual(result.key, new Uint8Array(Buffer.from(payload.key, 'base64url')));
  assert.equal(result.transcript.engine, 'qiskit-statevector');
  assert.deepEqual(result.transcript.trace[0], { index: 1, aliceBasis: 'Z', bobBasis: 'Z', status: 'retained' });
  assert.deepEqual(result.transcript.trace[1], { index: 2, aliceBasis: 'X', bobBasis: 'Z', status: 'discarded' });
  assert.deepEqual(result.transcript.trace[2], { index: 3, aliceBasis: 'X', bobBasis: 'X', status: 'sampled', sampleAlice: 0, sampleBob: 0 });
  const publicJson = JSON.stringify(result.transcript);
  for (const secret of [payload.key, 'test-service-token', 'privateServiceData', 'rawKey', 'aliceBit', 'secret']) assert.equal(publicJson.includes(secret), false);
});

test('configured Qiskit network or HTTP failure rejects instead of falling back to classical', async () => {
  environment.QISKIT_SERVICE_URL = 'https://qiskit.example.test';
  environment.QISKIT_SERVICE_TOKEN = 'test-service-token';
  globalThis.fetch = async () => { throw new Error('Service is offline'); };
  await assert.rejects(client.runKeyExchange({ roomId: 'room' }), /offline/);
  globalThis.fetch = async () => Response.json({ error: 'not available' }, { status: 503 });
  await assert.rejects(client.runKeyExchange({ roomId: 'room' }), /could not complete/);
});

test('remote Qiskit URL must use HTTPS and a server-side authentication token', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('Should not fetch'); };
  environment.QISKIT_SERVICE_URL = 'http://qiskit.example.test';
  environment.QISKIT_SERVICE_TOKEN = 'test-service-token';
  await assert.rejects(client.runKeyExchange({ roomId: 'room' }), /HTTPS/);
  environment.QISKIT_SERVICE_URL = 'https://qiskit.example.test';
  delete environment.QISKIT_SERVICE_TOKEN;
  await assert.rejects(client.runKeyExchange({ roomId: 'room' }), /authentication token/);
  assert.equal(calls, 0);
});

test('local Qiskit service accepts loopback HTTP without a cloud credential', async () => {
  environment.QISKIT_SERVICE_URL = 'http://127.0.0.1:8001';
  globalThis.fetch = async (input, init) => {
    assert.equal(input, 'http://127.0.0.1:8001/exchange');
    assert.equal(init.headers.Authorization, undefined);
    return Response.json(exchangeResult('local-exchange'));
  };
  const result = await client.runKeyExchange({ roomId: 'local-room', exchangeId: 'local-exchange' });
  assert.equal(result.accepted, true);
  assert.equal(result.transcript.engine, 'qiskit-statevector');
});

test('a rejected Qiskit exchange never returns candidate key material', async () => {
  environment.QISKIT_SERVICE_URL = 'http://localhost:8001';
  const payload = exchangeResult('rejected-exchange', { accepted: false });
  payload.key = Buffer.alloc(32, 2).toString('base64url');
  globalThis.fetch = async () => Response.json(payload);
  const result = await client.runKeyExchange({ roomId: 'room', exchangeId: 'rejected-exchange', intercept: true });
  assert.equal(result.accepted, false);
  assert.equal(result.key, null);
  assert.equal(result.transcript.status, 'aborted');
  assert.equal(JSON.stringify(result.transcript).includes(payload.key), false);
});

test('malformed Qiskit statistics, traces and key confirmation are rejected', async () => {
  environment.QISKIT_SERVICE_URL = 'http://localhost:8001';
  const mutations = [
    payload => { delete payload.transcript.threshold; },
    payload => { payload.transcript.threshold = 1; },
    payload => { payload.transcript.siftedBits = 1234; },
    payload => { payload.transcript.sampleErrors = 3; },
    payload => { payload.transcript.sampledBits = -1; },
    payload => { payload.transcript.qiskitVersion = { key: 'secret' }; },
    payload => { payload.transcript.reason = { key: 'secret' }; },
    payload => { payload.transcript.fingerprint = { key: 'secret' }; },
    payload => { payload.transcript.trace[3].index = 1; },
    payload => { payload.transcript.trace[0].aliceBasis = '+'; },
    payload => { payload.transcript.trace[2].sampleAlice = { bit: 0, key: 'secret' }; },
    payload => { payload.transcript.trace.pop(); },
    payload => { payload.key = Buffer.alloc(32, 7).toString('base64url'); },
  ];
  for (const mutate of mutations) {
    const payload = exchangeResult('malformed-exchange');
    mutate(payload);
    globalThis.fetch = async () => Response.json(payload);
    await assert.rejects(client.runKeyExchange({ roomId: 'room', exchangeId: 'malformed-exchange' }), /Invalid Qiskit|confirmation failed/);
  }
});

function plannedResult(exchangeId, { qubits = 1187, sampleBits = 17, insufficient = false } = {}) {
  const payload = exchangeResult(exchangeId, { accepted: !insufficient });
  Object.assign(payload.transcript, {
    qubits, siftedBits: insufficient ? 500 : 600,
    sampledBits: insufficient ? 0 : sampleBits,
    remainingBits: insufficient ? 500 : 600 - sampleBits,
    sampleErrors: 0, qber: 0, threshold: 0,
    requestedSampleBits: sampleBits, abortOnAnyError: true,
    interceptSimulated: false,
    reason: insufficient ? 'Basis sifting did not provide the complete requested sample plus 512 undisclosed bits.' : null,
  });
  if (insufficient) {
    for (const row of payload.transcript.trace) {
      if (row.status === 'sampled') { row.status = 'retained'; delete row.sampleAlice; delete row.sampleBob; }
    }
  }
  return payload;
}

test('planned Qiskit exchanges transmit and validate the calculated qubit and exact sample budgets', async () => {
  environment.QISKIT_SERVICE_URL = 'http://127.0.0.1:8001';
  const options = { roomId: 'planned-room', exchangeId: 'planned-exchange', qubits: 1187, sampleBits: 17, abortOnAnyError: true };
  globalThis.fetch = async (input, init) => {
    assert.equal(input, 'http://127.0.0.1:8001/exchange');
    assert.deepEqual(JSON.parse(init.body), { ...options, intercept: false });
    return Response.json(plannedResult(options.exchangeId));
  };
  const result = await client.runKeyExchange(options);
  assert.equal(result.accepted, true);
  assert.equal(result.key.length, 32);
  assert.equal(result.transcript.qubits, 1187);
  assert.equal(result.transcript.sampledBits, 17);
  assert.equal(result.transcript.remainingBits, 583);
  assert.equal(result.transcript.threshold, 0);
  assert.equal(result.transcript.requestedSampleBits, 17);
  assert.equal(result.transcript.abortOnAnyError, true);
  for (const mutate of [
    payload => { payload.transcript.qubits = 4096; },
    payload => { payload.transcript.threshold = 0.11; },
    payload => { payload.transcript.sampledBits = 16; payload.transcript.remainingBits = 584; },
    payload => { payload.transcript.requestedSampleBits = 16; },
    payload => { payload.transcript.abortOnAnyError = false; },
  ]) {
    const payload = plannedResult(options.exchangeId);
    mutate(payload);
    globalThis.fetch = async () => Response.json(payload);
    await assert.rejects(client.runKeyExchange(options), /Invalid Qiskit/);
  }
});

test('an insufficient live Qiskit pool returns a clean rejection without shrinking the requested sample', async () => {
  environment.QISKIT_SERVICE_URL = 'http://localhost:8001';
  globalThis.fetch = async () => Response.json(plannedResult('insufficient-live', { qubits: 1024, sampleBits: 1024, insufficient: true }));
  const result = await client.runKeyExchange({ roomId: 'room', exchangeId: 'insufficient-live', qubits: 1024, sampleBits: 1024, abortOnAnyError: true });
  assert.equal(result.accepted, false);
  assert.equal(result.key, null);
  assert.equal(result.transcript.sampledBits, 0);
  assert.equal(result.transcript.requestedSampleBits, 1024);
  assert.equal(result.transcript.qber, 0);
  assert.match(result.transcript.reason, /complete requested sample/);
});

test('planned live exchange options reject invalid budgets before a network request', async () => {
  environment.QISKIT_SERVICE_URL = 'http://localhost:8001';
  for (const options of [
    { qubits: 1023, sampleBits: 17, abortOnAnyError: true },
    { qubits: 1187, sampleBits: 0, abortOnAnyError: true },
    { qubits: 1187, sampleBits: 17, abortOnAnyError: 'yes' },
    { qubits: 8193, sampleBits: 17, abortOnAnyError: true },
    { qubits: 1187 },
  ]) await assert.rejects(client.runKeyExchange({ roomId: 'room', ...options }), /Invalid Qiskit exchange options/);
});
