import test from 'node:test';
import assert from 'node:assert/strict';

const origin = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:5173';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(path, { method = 'GET', token, data, headers = {} } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(data !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  });
  const json = await response.json();
  return { status: response.status, headers: response.headers, json };
}

test('BB84 messaging API: permissions, invitations, encrypted messages and key rotation', { timeout: 60000 }, async () => {
  let result = await api('/api/health');
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.simulation, true);
  assert.match(result.headers.get('cache-control'), /no-store/);

  result = await api('/api/rooms', { method: 'POST', data: { name: '', displayName: 'Alice' } });
  assert.equal(result.status, 400);

  const created = await api('/api/rooms', { method: 'POST', data: { name: 'Integration conversation', displayName: 'Alice' } });
  assert.equal(created.status, 200);
  const alice = created.json;
  assert.equal(alice.role, 'alice');
  assert.equal(typeof alice.roomId, 'string');
  const path = `/api/rooms/${alice.roomId}`;

  result = await api(path);
  assert.equal(result.status, 404);

  const other = await api('/api/rooms', { method: 'POST', data: { name: 'Separate conversation', displayName: 'Other' } });
  assert.equal(other.status, 200);
  result = await api(path, { token: other.json.token });
  assert.equal(result.status, 404);

  const fresh = await api(`${path}/invite`, { method: 'POST', token: alice.token, data: {} });
  assert.equal(fresh.status, 200);
  result = await api('/api/join', { method: 'POST', data: { inviteToken: alice.inviteToken, displayName: 'Old invitation' } });
  assert.equal(result.status, 404);
  const competingJoins = await Promise.all([
    api('/api/join', { method: 'POST', data: { inviteToken: fresh.json.inviteToken, displayName: 'Bob' } }),
    api('/api/join', { method: 'POST', data: { inviteToken: fresh.json.inviteToken, displayName: 'Bob' } }),
  ]);
  assert.deepEqual(competingJoins.map((entry) => entry.status).sort(), [200, 404]);
  const bob = competingJoins.find((entry) => entry.status === 200).json;
  assert.equal(bob.roomId, alice.roomId);
  assert.equal(bob.role, 'bob');

  result = await api(`${path}/invite`, { method: 'POST', token: bob.token, data: {} });
  assert.equal(result.status, 403);

  let snapshot = await api(path, { token: alice.token });
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.json.bobName, 'Bob');
  const firstExchange = snapshot.json.activeExchange.exchangeId;
  assert.equal(snapshot.json.activeExchange.status, 'accepted');
  assert.equal(snapshot.json.activeExchange.keyBits, 256);
  assert.equal(snapshot.json.activeExchange.qber, 0);
  for (const row of snapshot.json.activeExchange.trace) {
    if (row.status === 'retained') {
      assert.equal(row.sampleAlice, undefined);
      assert.equal(row.sampleBob, undefined);
    }
  }
  assert.equal(snapshot.json.key, undefined);
  assert.equal(snapshot.json.wrappedKey, undefined);

  const aliceText = 'Alice integration payload: privacy ✓';
  const bobText = 'Bob integration reply: received ✓';
  result = await api(`${path}/messages`, { method: 'POST', token: alice.token, data: { text: aliceText, exchangeId: firstExchange } });
  assert.equal(result.status, 200);
  await pause(250);
  result = await api(`${path}/messages`, { method: 'POST', token: bob.token, data: { text: bobText, exchangeId: firstExchange } });
  assert.equal(result.status, 200);
  snapshot = await api(path, { token: bob.token });
  assert.equal(snapshot.status, 200);
  assert.deepEqual(snapshot.json.messages.map((message) => message.text), [aliceText, bobText]);
  assert.deepEqual(snapshot.json.messages.map((message) => message.role), ['alice', 'bob']);
  assert.notEqual(snapshot.json.messages[0].iv, snapshot.json.messages[1].iv);
  for (const message of snapshot.json.messages) {
    assert.notEqual(message.ciphertext, message.text);
    assert.equal(message.ciphertext.includes(message.text), false);
    assert.equal(typeof message.iv, 'string');
    assert.equal(message.exchangeId, firstExchange);
  }

  const intercepted = await api(`${path}/exchange`, { method: 'POST', token: alice.token, data: { intercept: true } });
  assert.equal(intercepted.status, 200);
  assert.equal(intercepted.json.accepted, false);
  assert.equal(intercepted.json.transcript.status, 'aborted');
  assert.ok(intercepted.json.transcript.qber > intercepted.json.transcript.threshold);
  snapshot = await api(path, { token: bob.token });
  assert.equal(snapshot.json.activeExchange.exchangeId, firstExchange);
  assert.equal(snapshot.json.latestAttempt.status, 'aborted');

  await pause(1600);
  const rotated = await api(`${path}/exchange`, { method: 'POST', token: bob.token, data: { intercept: false } });
  assert.equal(rotated.status, 200);
  assert.equal(rotated.json.accepted, true);
  const nextExchange = rotated.json.transcript.exchangeId;
  assert.notEqual(nextExchange, firstExchange);

  result = await api(`${path}/messages`, { method: 'POST', token: alice.token, data: { text: 'Stale key message', exchangeId: firstExchange } });
  assert.equal(result.status, 409);
  snapshot = await api(path, { token: alice.token });
  assert.deepEqual(snapshot.json.messages.map((message) => message.text), [aliceText, bobText]);
  assert.equal(snapshot.json.activeExchange.exchangeId, nextExchange);

  const afterRotation = 'Message after rotation';
  result = await api(`${path}/messages`, { method: 'POST', token: alice.token, data: { text: afterRotation, exchangeId: nextExchange } });
  assert.equal(result.status, 200);
  const views = await Promise.all([api(path, { token: alice.token }), api(path, { token: bob.token })]);
  for (const view of views) {
    assert.equal(view.status, 200);
    assert.deepEqual(view.json.messages.map((message) => message.text), [aliceText, bobText, afterRotation]);
    assert.equal(view.json.messages[2].exchangeId, nextExchange);
  }

  result = await api(`${path}/messages`, {
    method: 'POST', token: alice.token, headers: { origin: 'https://unrelated.example' },
    data: { text: 'Cross-origin message', exchangeId: nextExchange },
  });
  assert.equal(result.status, 403);
});
