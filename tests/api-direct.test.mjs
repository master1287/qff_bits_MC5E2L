/**
 * Runs the same HTTP contract test against the production backend functions.
 * Only the transport and D1 binding are adapted; SQL, crypto, authorization,
 * request validation and response generation remain the application code.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const sqlite = new DatabaseSync(':memory:');
sqlite.exec('PRAGMA foreign_keys = ON');
const migrationFiles = (await readdir(path.join(root, 'drizzle'))).filter((name) => name.endsWith('.sql')).sort();
for (const name of migrationFiles) {
  sqlite.exec((await readFile(path.join(root, 'drizzle', name), 'utf8')).replaceAll('--> statement-breakpoint', ''));
}

class D1Statement {
  constructor(sql, values = []) { this.sql = sql; this.values = values; }
  bind(...values) { return new D1Statement(this.sql, values); }
  first(column) {
    const row = sqlite.prepare(this.sql).get(...this.values);
    return Promise.resolve(row ? (column ? row[column] : row) : null);
  }
  all() {
    const results = sqlite.prepare(this.sql).all(...this.values);
    return Promise.resolve({ success: true, results, meta: { changes: 0 } });
  }
  execute() {
    const result = sqlite.prepare(this.sql).run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
  run() { return Promise.resolve(this.execute()); }
}

globalThis.__qubitTestEnv = {
  CHAT_MASTER_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
  DB: {
    prepare(sql) { return new D1Statement(sql); },
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((statement) => statement.execute());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  },
};

const source = await readFile(path.join(root, 'lib', 'rooms.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText
  .replace(/import\s*\{\s*env\s*\}\s*from\s*["']cloudflare:workers["'];?/, 'const env = globalThis.__qubitTestEnv;')
  .replace(/from\s*["']\.\/bb84\.mjs["']/, `from ${JSON.stringify(pathToFileURL(path.join(root, 'lib', 'bb84.mjs')).href)}`)
  .replace(/from\s*["']\.\/security-plan\.mjs["']/, `from ${JSON.stringify(pathToFileURL(path.join(root, 'lib', 'security-plan.mjs')).href)}`)
  .replace(/from\s*["']\.\/qiskit-client["']/, 'from "./qiskit-client.mjs"');
const scratch = path.join(root, 'work', 'api-direct');
await mkdir(scratch, { recursive: true });
const qiskitSource = await readFile(path.join(root, 'lib', 'qiskit-client.ts'), 'utf8');
const qiskitCompiled = ts.transpileModule(qiskitSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText
  .replace(/import\s*\{\s*env\s*\}\s*from\s*["']cloudflare:workers["'];?/, 'const env = globalThis.__qubitTestEnv;')
  .replace(/from\s*["']\.\/bb84\.mjs["']/, `from ${JSON.stringify(pathToFileURL(path.join(root, 'lib', 'bb84.mjs')).href)}`);
await writeFile(path.join(scratch, 'qiskit-client.mjs'), qiskitCompiled);
const compiledPath = path.join(scratch, 'rooms.mjs');
await writeFile(compiledPath, compiled);
const backend = await import(pathToFileURL(compiledPath).href);

test('legacy geometric basis labels normalize to Z/X without changing encrypted history', async () => {
  const newRequest = (pathname, { token, data } = {}) => new Request(`http://127.0.0.1:5173${pathname}`, {
    method: data === undefined ? 'GET' : 'POST',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(data === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const created = await backend.respond(() => backend.createRoom(newRequest('/api/rooms', {
    data: { name: 'Legacy transcript compatibility', displayName: 'Alice' },
  })));
  assert.equal(created.status, 200);
  const session = await created.json();
  const roomPath = `/api/rooms/${session.roomId}`;
  const stored = sqlite.prepare('SELECT id, transcript, wrapped_key FROM exchanges WHERE room_id = ?').get(session.roomId);
  const original = JSON.parse(stored.transcript);
  const messageText = 'History remains readable after the basis notation update.';
  const sent = await backend.respond(() => backend.sendMessage(newRequest(`${roomPath}/messages`, {
    token: session.token, data: { text: messageText, exchangeId: original.exchangeId },
  }), session.roomId));
  assert.equal(sent.status, 200);

  const legacy = { ...original, trace: original.trace.map(row => ({
    ...row, aliceBasis: row.aliceBasis === 'Z' ? '+' : '×', bobBasis: row.bobBasis === 'Z' ? '+' : '×',
  })) };
  const serialized = JSON.stringify(legacy);
  sqlite.prepare('UPDATE exchanges SET transcript = ? WHERE id = ?').run(serialized, stored.id);
  sqlite.prepare('UPDATE rooms SET latest_attempt = ? WHERE id = ?').run(serialized, session.roomId);

  const read = await backend.respond(() => backend.getRoom(newRequest(roomPath, { token: session.token }), session.roomId));
  assert.equal(read.status, 200);
  const snapshot = await read.json();
  assert.deepEqual(snapshot.activeExchange, original);
  assert.deepEqual(snapshot.latestAttempt, original);
  for (const transcript of [snapshot.activeExchange, snapshot.latestAttempt]) {
    assert.equal(transcript.exchangeId, original.exchangeId);
    assert.equal(transcript.fingerprint, original.fingerprint);
    for (const row of transcript.trace) {
      assert.ok(['Z', 'X'].includes(row.aliceBasis));
      assert.ok(['Z', 'X'].includes(row.bobBasis));
      if (row.status === 'retained') assert.deepEqual(Object.keys(row).sort(), ['aliceBasis', 'bobBasis', 'index', 'status']);
    }
  }
  assert.equal(snapshot.messages.length, 1);
  assert.equal(snapshot.messages[0].text, messageText);
  assert.equal(snapshot.messages[0].exchangeId, original.exchangeId);
  assert.equal(snapshot.key, undefined);
  assert.equal(snapshot.wrappedKey, undefined);
  assert.equal(JSON.stringify(snapshot).includes(JSON.parse(stored.wrapped_key).ciphertext), false);
  assert.equal(sqlite.prepare('SELECT transcript FROM exchanges WHERE id = ?').get(stored.id).transcript, serialized);
});

test('planned rooms preserve the calculated sample budget through key rotation', { timeout: 20000 }, async () => {
  const request = (pathname, { token, data } = {}) => new Request(`http://127.0.0.1:5173${pathname}`, {
    method: data === undefined ? 'GET' : 'POST',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(data === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const invalid = await backend.respond(() => backend.createRoom(request('/api/rooms', {
    data: { name: 'Invalid confidence', displayName: 'Alice', detectionConfidence: 100 },
  })));
  assert.equal(invalid.status, 400);

  let created;
  for (let attempt = 0; attempt < 3; attempt++) {
    created = await backend.respond(() => backend.createRoom(request('/api/rooms', {
      data: { name: 'Planned confidence conversation', displayName: 'Alice', detectionConfidence: 99 },
    })));
    if (created.status === 200) break;
    assert.equal(created.status, 503, 'Only an explicitly rejected exchange can require a retry.');
  }
  assert.equal(created.status, 200);
  const session = await created.json();
  assert.equal(session.securityPlan.requestedPercent, 99);
  assert.equal(session.securityPlan.qubits, 1187);
  assert.equal(session.securityPlan.sampleBits, 17);
  assert.equal(session.securityPlan.retainedBits, 512);
  const roomPath = `/api/rooms/${session.roomId}`;
  const readRoom = async () => {
    const response = await backend.respond(() => backend.getRoom(request(roomPath, { token: session.token }), session.roomId));
    assert.equal(response.status, 200);
    return response.json();
  };
  const verifyPlannedSnapshot = snapshot => {
    assert.deepEqual(snapshot.securityPlan, session.securityPlan);
    assert.equal(snapshot.activeExchange.qubits, 1187);
    assert.equal(snapshot.activeExchange.sampledBits, 17);
    assert.equal(snapshot.activeExchange.requestedSampleBits, 17);
    assert.equal(snapshot.activeExchange.threshold, 0);
    assert.equal(snapshot.activeExchange.abortOnAnyError, true);
    assert.ok(snapshot.activeExchange.remainingBits >= 512);
    assert.equal(snapshot.key, undefined);
    assert.equal(snapshot.wrappedKey, undefined);
    for (const forbidden of ['key', 'wrapped_key', 'aliceBits', 'bobBits', 'retainedBitValues']) {
      assert.equal(Object.hasOwn(snapshot.activeExchange, forbidden), false);
    }
    for (const row of snapshot.activeExchange.trace) {
      if (row.status === 'retained') assert.deepEqual(Object.keys(row).sort(), ['aliceBasis', 'bobBasis', 'index', 'status']);
    }
    const stored = sqlite.prepare('SELECT wrapped_key FROM exchanges WHERE id = ?').get(snapshot.activeExchange.exchangeId);
    assert.equal(JSON.stringify(snapshot).includes(JSON.parse(stored.wrapped_key).ciphertext), false);
  };
  const initial = await readRoom();
  verifyPlannedSnapshot(initial);
  let rotated;
  for (let attempt = 0; attempt < 3; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1600));
    const response = await backend.respond(() => backend.exchangeKey(request(`${roomPath}/exchange`, {
      token: session.token, data: { intercept: false },
    }), session.roomId));
    assert.equal(response.status, 200);
    rotated = await response.json();
    if (rotated.accepted) break;
    assert.match(rotated.transcript.reason, /complete requested sample/);
  }
  assert.equal(rotated.accepted, true);
  assert.notEqual(rotated.transcript.exchangeId, initial.activeExchange.exchangeId);
  const afterRotation = await readRoom();
  verifyPlannedSnapshot(afterRotation);
  assert.equal(afterRotation.activeExchange.exchangeId, rotated.transcript.exchangeId);
});

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const pathname = new URL(request.url).pathname;
  const verb = request.method;
  if (pathname === '/api/health' && verb === 'GET') return backend.respond(backend.health);
  if (pathname === '/api/rooms' && verb === 'POST') return backend.respond(() => backend.createRoom(request));
  if (pathname === '/api/join' && verb === 'POST') return backend.respond(() => backend.joinRoom(request));
  const room = pathname.match(/^\/api\/rooms\/([^/]+)(?:\/(messages|exchange|invite))?$/);
  if (room) {
    const id = decodeURIComponent(room[1]);
    if (!room[2] && verb === 'GET') return backend.respond(() => backend.getRoom(request, id));
    if (room[2] === 'messages' && verb === 'POST') return backend.respond(() => backend.sendMessage(request, id));
    if (room[2] === 'exchange' && verb === 'POST') return backend.respond(() => backend.exchangeKey(request, id));
    if (room[2] === 'invite' && verb === 'POST') return backend.respond(() => backend.createInvite(request, id));
  }
  return Response.json({ error: 'Not found' }, { status: 404 });
};

after(() => {
  globalThis.fetch = originalFetch;
  delete globalThis.__qubitTestEnv;
  sqlite.close();
});

await import('./api.test.mjs');
