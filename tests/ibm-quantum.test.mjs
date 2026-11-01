import test, { afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = path.join(root, 'work', 'ibm-quantum-tests');
await mkdir(scratch, { recursive: true });
const compiledPath = path.join(scratch, 'ibm-quantum.mjs');
const source = await readFile(path.join(root, 'lib', 'ibm-quantum.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  .replace(/import\s*\{\s*env\s*\}\s*from\s*["']cloudflare:workers["'];?/, 'const env = globalThis.__ibmQuantumTestEnv;');
globalThis.__ibmQuantumTestEnv = {};
await writeFile(compiledPath, compiled);
const backend = await import(pathToFileURL(compiledPath).href);
const originalFetch = globalThis.fetch;
let sqlite;
let sequence = 0;

function request(pathname = '/api/quantum/jobs', { user = 'owner-a', data, origin } = {}) {
  return new Request('https://qubit.test' + pathname, { method: data === undefined ? 'GET' : 'POST',
    headers: { ...(user ? { 'oai-authenticated-user-id': user } : {}), ...(data === undefined ? {} : { 'content-type': 'application/json' }), ...(origin ? { origin } : {}) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
}
function fixture({ free = true, state = 'Completed', submitError = false, submitStatus = 200, malformedResults = false } = {}) {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE quantum_jobs (id TEXT PRIMARY KEY, backend TEXT NOT NULL, intercept INTEGER NOT NULL, created_at TEXT NOT NULL, owner_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT \'queued\', result TEXT)');
  class Statement {
    constructor(sql, values = []) { this.sql = sql; this.values = values; }
    bind(...values) { return new Statement(this.sql, values); }
    first() { return Promise.resolve(sqlite.prepare(this.sql).get(...this.values) || null); }
    run() { const r = sqlite.prepare(this.sql).run(...this.values); return Promise.resolve({ meta: { changes: Number(r.changes) } }); }
  }
  Object.keys(globalThis.__ibmQuantumTestEnv).forEach(key => delete globalThis.__ibmQuantumTestEnv[key]);
  Object.assign(globalThis.__ibmQuantumTestEnv, {
    DB: { prepare: sql => new Statement(sql) }, IBM_QUANTUM_API_KEY: `fake-unit-key-${++sequence}`,
    IBM_QUANTUM_CRN: 'crn:v1:bluemix:public:quantum-computing:us-east:a/test:instance::',
    ...(free ? { IBM_QUANTUM_PLAN_MODE: 'free', IBM_QUANTUM_FREE_PLAN_ID: 'plan-test' } : {}),
  });
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    // Workers rejects redirect:"error" before making a request; Node does not.
    // Keep this transport mock faithful to the production runtime.
    assert.notEqual(init.redirect, 'error', 'Cloudflare Workers does not support redirect:error');
    calls.push({ url, init });
    const json = value => Response.json(value);
    if (url === 'https://iam.cloud.ibm.com/identity/token') return json({ access_token: 'fake-iam-token', expires_in: 3600 });
    if (url.startsWith('https://globalcatalog.cloud.ibm.com/')) return json({ name: 'pay-as-you-go', display_name: 'Paid plan' });
    const endpoint = new URL(url).pathname;
    if (endpoint === '/api/v1/instance') return json({ plan_id: 'plan-test', usage_allocation_seconds: '600' });
    if (endpoint === '/api/v1/instances/usage') return json({ usage_consumed_seconds: 0, usage_limit_seconds: 600, usage_limit_reached: false });
    if (endpoint === '/api/v1/backends') return json({ devices: [{ name: 'ibm_test', status: { name: 'online' }, qubits: 5, queue_length: 0, is_simulator: false }] });
    if (endpoint === '/api/v1/backends/ibm_test/configuration') return json({ basis_gates: ['x', 'sx', 'rz'], supported_instructions: ['x', 'sx', 'rz', 'measure'] });
    if (endpoint === '/api/v1/backends/ibm_test/properties') return json({ qubits: Array.from({ length: 5 }, () => [{ name: 'operational', value: 1 }]) });
    if (endpoint === '/api/v1/jobs' && init.method === 'POST') {
      if (submitError) throw new Error('test transport interruption');
      if (submitStatus !== 200) return Response.json({ error: 'test rejection' }, { status: submitStatus });
      return json({ id: 'hardware-job-001', backend: 'ibm_test' });
    }
    if (endpoint === '/api/v1/jobs/hardware-job-001') return json({ state: { status: state } });
    if (endpoint === '/api/v1/jobs/hardware-job-001/results') {
      if (malformedResults) return json({ results: [{ data: { bob: { samples: ['0xff'] } } }] });
      return json({ results: [{ data: { bob: { samples: Array(128).fill('0x1d') }, eve: { samples: Array(128).fill('0x05') } } }] });
    }
    throw new Error('Unexpected mock endpoint');
  };
  return calls;
}
afterEach(() => { globalThis.fetch = originalFetch; sqlite?.close(); sqlite = undefined; });
after(() => { delete globalThis.__ibmQuantumTestEnv; });

test('status never exposes API keys or tokens and blocks unknown paid spending', async () => {
  const calls = fixture({ free: false });
  const status = await backend.quantumStatus(request('/api/quantum/status'));
  assert.equal(status.configured, true);
  assert.equal(status.canSubmit, false);
  assert.match(status.reason, /approved spending limit/);
  assert.equal(calls.some(call => call.init.method === 'POST' && call.url.endsWith('/jobs')), false);
  assert.equal(JSON.stringify(status).includes('fake-unit-key'), false);
  assert.equal(JSON.stringify(status).includes('fake-iam-token'), false);
});

test('authenticated hardware submission is bounded, native-gated and owner-scoped', async () => {
  const calls = fixture();
  const result = await backend.startHardwareJob(request(undefined, { data: { intercept: true } }));
  assert.equal(result.id, 'hardware-job-001');
  assert.equal(result.status, 'queued');
  assert.equal(result.shots, 128);
  assert.equal(result.hardware, true);
  const submit = calls.find(call => call.init.method === 'POST' && call.url.endsWith('/jobs'));
  const payload = JSON.parse(submit.init.body);
  assert.equal(payload.cost, 60);
  assert.equal(payload.params.shots, 128);
  assert.equal(payload.params.support_qiskit, false);
  assert.equal(payload.params.version, 2);
  assert.deepEqual(payload.params.pubs[0].slice(1), [[], 128]);
  assert.match(payload.params.pubs[0][0], /eve\[0\] = measure \$0;/);
  assert.match(payload.params.pubs[0][0], /sx \$4;/);
  assert.doesNotMatch(payload.params.pubs[0][0], /\bh \$/);
  assert.equal(submit.init.headers['Service-CRN'], globalThis.__ibmQuantumTestEnv.IBM_QUANTUM_CRN);
  assert.equal(submit.init.headers['IBM-API-Version'], '2026-04-15');
  assert.equal(submit.init.headers.Authorization, 'Bearer fake-iam-token');
  assert.equal(submit.init.body.includes('fake-unit-key'), false);
  const countBefore = calls.length;
  await assert.rejects(backend.hardwareJob(request('/api/quantum/jobs/hardware-job-001', { user: 'other' }), result.id), /unavailable/);
  assert.equal(calls.length, countBefore, 'Unknown owner must not trigger an IBM job query');
  await assert.rejects(backend.startHardwareJob(request(undefined, { data: { intercept: false } })), /pending/);
  assert.equal(calls.filter(call => call.init.method === 'POST' && call.url.endsWith('/jobs')).length, 1);
});

test('hardware results retain first-shot bit ordering and cache teaching-only output', async () => {
  const calls = fixture();
  const created = await backend.startHardwareJob(request(undefined, { data: { intercept: true } }));
  const result = await backend.hardwareJob(request(), created.id);
  assert.equal(result.status, 'completed');
  assert.equal(result.lesson.engine, 'ibm-quantum-hardware');
  assert.equal(result.lesson.execution, 'hardware');
  assert.equal(result.lesson.curated, false);
  assert.equal(result.lesson.rows.length, 5);
  assert.deepEqual(result.lesson.rows.map(row => row.bobBit), [1, 0, 1, 1, 1]);
  assert.deepEqual(result.lesson.rows.map(row => row.eveBit), [1, 0, 1, 0, 0]);
  assert.equal(result.lesson.statistics.errors, 2);
  assert.equal(result.lesson.statistics.qber, 1);
  assert.equal(result.lesson.statistics.detected, true);
  assert.equal(result.lesson.hardwareStatistics.displayedShot, 1);
  assert.equal(result.lesson.hardwareStatistics.shots, 128);
  assert.match(result.lesson.securityNotice, /Noise can also/);
  assert.equal(Object.hasOwn(result.lesson, 'key'), false);
  const queries = calls.length;
  const cached = await backend.hardwareJob(request(), created.id);
  assert.deepEqual(cached, result);
  assert.equal(calls.length, queries, 'Completed results should be returned from the site cache');
});

test('missing identity, cross-origin writes and malformed requests cannot submit', async () => {
  const calls = fixture();
  await assert.rejects(backend.startHardwareJob(request(undefined, { user: '', data: { intercept: false } })), /Sign in/);
  await assert.rejects(backend.startHardwareJob(request(undefined, { data: { intercept: true }, origin: 'https://unrelated.test' })), /this website/);
  await assert.rejects(backend.startHardwareJob(request(undefined, { data: { intercept: 'yes' } })), /whether/);
  await assert.rejects(backend.startHardwareJob(request(undefined, { data: { intercept: false, shots: 1000000 } })), /whether/);
  assert.equal(calls.length, 0);
});

test('unconfirmed submissions block automatic retries and never substitute simulation', async () => {
  const calls = fixture({ submitError: true });
  await assert.rejects(backend.startHardwareJob(request(undefined, { data: { intercept: false } })), /could not be confirmed/);
  assert.equal(sqlite.prepare('SELECT status FROM quantum_jobs').get().status, 'uncertain');
  await assert.rejects(backend.startHardwareJob(request(undefined, { data: { intercept: false } })), /pending/);
  assert.equal(calls.filter(call => call.init.method === 'POST' && call.url.endsWith('/jobs')).length, 1);
});

test('hardware failure and malformed measurement data are explicit', async () => {
  fixture({ state: 'Failed' });
  const created = await backend.startHardwareJob(request(undefined, { data: { intercept: false } }));
  const result = await backend.hardwareJob(request(), created.id);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /No simulation/);
  assert.equal(result.lesson, undefined);
  assert.throws(() => backend.hardwareLesson({ results: [{ data: { bob: { samples: ['0xff'] } } }] }, { id: 'x', backend: 'ibm_test', intercept: 0 }), /format/);
});

test('faulty and nonoperational physical qubits are excluded and their mapping is retained', async () => {
  const calls = fixture();
  const baseFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (url.endsWith('/configuration')) return Response.json({ n_qubits: 8, basis_gates: ['x', 'sx', 'rz'], supported_instructions: ['measure'], faulty_qubits: [0] });
    if (url.endsWith('/properties')) return Response.json({ qubits: Array.from({ length: 8 }, (_, i) => [{ name: 'operational', value: i === 2 ? 0 : 1 }]) });
    return baseFetch(url, init);
  };
  const created = await backend.startHardwareJob(request(undefined, { data: { intercept: true } }));
  const submitted = calls.find(call => call.url.endsWith('/jobs') && call.init.method === 'POST');
  const qasm = JSON.parse(submitted.init.body).params.pubs[0][0];
  assert.match(qasm, /eve\[0\] = measure \$1;/);
  assert.doesNotMatch(qasm, /\$0\b|\$2\b/);
  const result = await backend.hardwareJob(request(), created.id);
  assert.deepEqual(result.lesson.physicalQubits, [1, 3, 4, 5, 6]);
  assert.equal(result.lesson.circuit, qasm);
  assert.throws(() => backend.hardwareQasm(true, [0, 0, 1, 2, 3]), /mapping/);
});

test('unconfigured or unsigned status checks do not contact IBM', async () => {
  const calls = fixture();
  const unsigned = await backend.quantumStatus(request('/api/quantum/status', { user: '' }));
  assert.equal(unsigned.canSubmit, false);
  assert.match(unsigned.reason, /Sign in/);
  delete globalThis.__ibmQuantumTestEnv.IBM_QUANTUM_API_KEY;
  const unconfigured = await backend.quantumStatus(request('/api/quantum/status'));
  assert.equal(unconfigured.configured, false);
  assert.equal(unconfigured.canSubmit, false);
  assert.equal(calls.length, 0);
});

test('a changed instance plan cannot reuse an old free-plan assertion', async () => {
  fixture();
  globalThis.__ibmQuantumTestEnv.IBM_QUANTUM_FREE_PLAN_ID = 'previous-open-plan';
  const status = await backend.quantumStatus(request('/api/quantum/status'));
  assert.equal(status.canSubmit, false);
  assert.match(status.reason, /spending limit/);
});

test('an explicit IBM 4xx rejection releases the uncertain-submission block', async () => {
  fixture({ submitStatus: 400 });
  await assert.rejects(backend.startHardwareJob(request(undefined, { data: { intercept: false } })), /could not complete/);
  assert.equal(sqlite.prepare('SELECT status FROM quantum_jobs').get().status, 'failed');
});

test('IBM execution-time cancellation is normalized without a simulated fallback', async () => {
  fixture({ state: 'Cancelled - Ran too long' });
  const created = await backend.startHardwareJob(request(undefined, { data: { intercept: false } }));
  const result = await backend.hardwareJob(request(), created.id);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.lesson, undefined);
  assert.match(result.error, /No simulation/);
});

test('an existing hardware job remains resumable when IBM readiness is unavailable', async () => {
  const calls = fixture();
  const created = await backend.startHardwareJob(request(undefined, { data: { intercept: false } }));
  const callCount = calls.length;
  globalThis.fetch = async () => { throw new Error('IBM readiness is unreachable'); };
  const status = await backend.quantumStatus(request('/api/quantum/status'));
  assert.equal(status.activeJobId, created.id);
  assert.equal(status.backend, created.backend);
  assert.equal(status.canSubmit, false);
  assert.match(status.reason, /already pending/);
  assert.equal(calls.length, callCount, 'Resuming a stored job must not depend on new-submission readiness');
  const otherOwner = await backend.quantumStatus(request('/api/quantum/status', { user: 'other' }));
  assert.equal(otherOwner.activeJobId, undefined, 'Only the existing job owner may resume it');
});
