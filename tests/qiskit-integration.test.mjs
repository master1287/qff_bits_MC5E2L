/** Genuine Qiskit-to-Worker bridge check. Only HTTP transport is adapted. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import { encryptMessage, decryptMessage, decodeKey, encodeKey } from '../lib/bb84.mjs';
import { planDetectionConfidence } from '../lib/security-plan.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const python = process.env.QISKIT_PYTHON || [
  path.join(root, '.sites-runtime', 'qiskit-venv', 'Scripts', 'python.exe'),
  path.join(root, '.sites-runtime', 'qiskit-venv', 'bin', 'python'),
].find(existsSync);
const pythonOptions = {
  cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000,
  env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
};
const probe = python && spawnSync(python, ['-c', 'import qiskit; import cryptography'], pythonOptions);
const skipReason = !python
  ? 'Qiskit Python is unavailable. Install qiskit_service/requirements.txt and set QISKIT_PYTHON to that interpreter.'
  : probe.error || probe.status !== 0
    ? 'The selected Python cannot import Qiskit and cryptography. Install qiskit_service/requirements.txt into it.'
    : false;

test('real Qiskit measurements cross the Python/JavaScript bridge and encrypt messages', { skip: skipReason, timeout: 90000 }, async () => {
  const source = await readFile(path.join(root, 'lib', 'qiskit-client.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
    .replace(/import\s*\{\s*env\s*\}\s*from\s*["']cloudflare:workers["'];?/, 'const env = globalThis.__qubitQiskitIntegrationEnv;')
    .replace(/from\s*["']\.\/bb84\.mjs["']/, `from ${JSON.stringify(pathToFileURL(path.join(root, 'lib', 'bb84.mjs')).href)}`);
  const scratch = path.join(root, 'work', 'qiskit-integration');
  await mkdir(scratch, { recursive: true });
  const compiledPath = path.join(scratch, 'qiskit-client.mjs');
  await writeFile(compiledPath, compiled);
  globalThis.__qubitQiskitIntegrationEnv = { QISKIT_SERVICE_URL: 'http://127.0.0.1:8001' };
  const client = await import(pathToFileURL(compiledPath).href);
  const originalFetch = globalThis.fetch;
  let exchanges = 0;
  const pythonProgram = [
    'import json, sys',
    'from qiskit_service.simulator import simulate_exchange',
    'request = json.load(sys.stdin)',
    'result = simulate_exchange(room_id=request["roomId"], exchange_id=request["exchangeId"], intercept=request["intercept"], qubits=request["qubits"], sample_bits=request.get("sampleBits"), abort_on_any_error=request.get("abortOnAnyError", False))',
    'sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")))',
  ].join('\n');
  globalThis.fetch = async (input, init) => {
    assert.equal(input, 'http://127.0.0.1:8001/exchange');
    assert.equal(init.method, 'POST');
    const request = JSON.parse(init.body);
    assert.equal(request.qubits, request.sampleBits === undefined ? 4096 : 1187);
    const result = spawnSync(python, ['-c', pythonProgram], { ...pythonOptions, input: JSON.stringify(request), maxBuffer: 1024 * 1024 });
    // Avoid including key-bearing process output in an assertion failure.
    assert.equal(Boolean(result.error), false, 'The Qiskit subprocess must start successfully.');
    assert.equal(result.status, 0, 'The Qiskit subprocess must complete successfully.');
    exchanges++;
    return new Response(result.stdout, { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const honest = await client.runKeyExchange({ roomId: 'real-qiskit-room', exchangeId: 'real-qiskit-honest', intercept: false });
    assert.equal(honest.accepted, true);
    assert.equal(honest.key.length, 32);
    assert.equal(honest.transcript.engine, 'qiskit-statevector');
    assert.match(honest.transcript.qiskitVersion, /^\d+\.\d+/);
    assert.equal(honest.transcript.qber, 0);
    assert.equal(honest.transcript.keyBits, 256);
    const context = JSON.stringify(['real-qiskit-room', honest.transcript.exchangeId, 'message-1', 'alice']);
    const plaintext = 'A real Qiskit-derived key encrypts this message. 🔐';
    const envelope = await encryptMessage(honest.key, plaintext, context);
    assert.equal(await decryptMessage(honest.key, envelope, context), plaintext);
    const altered = decodeKey(envelope.ciphertext);
    altered[0] ^= 1;
    await assert.rejects(decryptMessage(honest.key, { ...envelope, ciphertext: encodeKey(altered) }, context));
    await assert.rejects(decryptMessage(honest.key, envelope, context + '/different-message'));
    for (const row of honest.transcript.trace) {
      assert.ok(['Z', 'X'].includes(row.aliceBasis));
      assert.ok(['Z', 'X'].includes(row.bobBasis));
      if (row.status === 'retained') assert.deepEqual(Object.keys(row).sort(), ['aliceBasis', 'bobBasis', 'index', 'status']);
    }
    assert.equal(Object.hasOwn(honest.transcript, 'key'), false);
    honest.key.fill(0);

    const intercepted = await client.runKeyExchange({ roomId: 'real-qiskit-room', exchangeId: 'real-qiskit-intercept', intercept: true });
    assert.equal(intercepted.accepted, false);
    assert.equal(intercepted.key, null);
    assert.equal(intercepted.transcript.engine, 'qiskit-statevector');
    assert.equal(intercepted.transcript.status, 'aborted');
    assert.ok(intercepted.transcript.qber > intercepted.transcript.threshold);
    assert.equal(intercepted.transcript.keyBits, 0);
    assert.equal(intercepted.transcript.fingerprint, null);
    assert.equal(exchanges, 2);

    const plan = planDetectionConfidence(99);
    let planned;
    for (let attempt = 0; attempt < 3; attempt++) {
      planned = await client.runKeyExchange({ roomId: 'real-planned-room', exchangeId: `planned-${attempt}`, qubits: plan.qubits, sampleBits: plan.sampleBits, abortOnAnyError: true });
      if (planned.accepted) break;
      assert.match(planned.transcript.reason, /complete requested sample/);
      assert.equal(planned.key, null);
    }
    assert.equal(planned.accepted, true);
    assert.equal(planned.key.length, 32);
    assert.equal(planned.transcript.engine, 'qiskit-statevector');
    assert.equal(planned.transcript.qubits, plan.qubits);
    assert.equal(planned.transcript.sampledBits, plan.sampleBits);
    assert.equal(planned.transcript.requestedSampleBits, plan.sampleBits);
    assert.equal(planned.transcript.abortOnAnyError, true);
    assert.equal(planned.transcript.threshold, 0);
    assert.ok(planned.transcript.remainingBits >= plan.retainedBits);
    const plannedContext = JSON.stringify(['real-planned-room', planned.transcript.exchangeId, 'planned-message', 'alice']);
    const plannedEnvelope = await encryptMessage(planned.key, plaintext, plannedContext);
    assert.equal(await decryptMessage(planned.key, plannedEnvelope, plannedContext), plaintext);
    planned.key.fill(0);
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.__qubitQiskitIntegrationEnv;
  }
});
