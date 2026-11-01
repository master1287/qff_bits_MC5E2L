import test from 'node:test';
import assert from 'node:assert/strict';
import { planDetectionConfidence } from '../lib/security-plan.mjs';

test('confidence presets budget the complete public sample and undisclosed material', () => {
  const examples = [[95, 11, 1174], [99, 17, 1187], [99.9, 25, 1203], [99.99, 33, 1220], [99.9999, 49, 1254]];
  for (const [percent, sampleBits, qubits] of examples) {
    const plan = planDetectionConfidence(percent);
    assert.equal(plan.sampleBits, sampleBits);
    assert.equal(plan.qubits, qubits);
    assert.equal(plan.retainedBits, 512);
    assert.equal(plan.requiredMatchingBits, sampleBits + 512);
    assert.equal(plan.siftingConfidencePercent, 99.9);
    assert.equal(plan.model, 'full-intercept-resend-ideal');
    assert.equal(plan.samplingPolicy, 'reject-any-sampled-error');
    assert.ok(plan.achievedPercent >= percent);
    assert.ok((1 - 0.75 ** (sampleBits - 1)) * 100 < percent);
  }
  assert.deepEqual(planDetectionConfidence(), planDetectionConfidence(99));
});

test('the transmission budget meets the Hoeffding target and is minimal for that bound', () => {
  const delta = 0.001;
  const lower = n => n / 2 - Math.sqrt(n * Math.log(1 / delta) / 2);
  let previous = null;
  for (const requested of [50, 75, 90, 95, 99, 99.9, 99.99, 99.9999]) {
    const plan = planDetectionConfidence(requested);
    assert.ok(Number.isInteger(plan.qubits));
    assert.ok(lower(plan.qubits) >= plan.requiredMatchingBits);
    assert.ok(lower(plan.qubits - 1) < plan.requiredMatchingBits);
    assert.ok(plan.conservativeMatchingBits >= plan.requiredMatchingBits);
    const deviation = plan.qubits / 2 - plan.requiredMatchingBits;
    assert.ok(Math.exp(-2 * deviation ** 2 / plan.qubits) <= delta);
    if (previous) {
      assert.ok(plan.sampleBits >= previous.sampleBits);
      assert.ok(plan.qubits >= previous.qubits);
    }
    previous = plan;
  }
});

test('confidence rejects a 100% guarantee and invalid or unsupported input', () => {
  for (const invalid of [100, 0, 49.99, 99.99999, -1, NaN, Infinity, -Infinity, '99', null, {}, []]) {
    assert.throws(() => planDetectionConfidence(invalid), RangeError);
  }
  const plan = planDetectionConfidence(99);
  assert.match(plan.notice, /not the probability that messages are safe/);
  assert.ok(plan.assumptions.some(value => value.includes('ideal')));
  assert.ok(plan.assumptions.some(value => value.includes('conditional')));
});
