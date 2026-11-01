/**
 * Educational BB84 planning, conditional on a full intercept-resend attack in
 * an ideal channel. A matching-basis sample bit has a 1/4 error probability.
 * These estimates are not a privacy guarantee or a finite-key QKD proof.
 * The transmission budget uses Hoeffding's inequality for independent random
 * basis matches, with probability 1/2 per transmitted qubit.
 */
const RETAINED_BITS = 512;
const SIFTING_FAILURE_PROBABILITY = 0.001;
const LOG_NO_ERROR = Math.log(0.75);
const LOG_SIFTING_FAILURE = Math.log(1 / SIFTING_FAILURE_PROBABILITY);

function detectionProbability(sampleBits) {
  return -Math.expm1(sampleBits * LOG_NO_ERROR);
}

function matchingBitsLowerBound(qubits) {
  return qubits / 2 - Math.sqrt(qubits * LOG_SIFTING_FAILURE / 2);
}

export function planDetectionConfidence(percent = 99) {
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 50 || percent > 99.9999) {
    throw new RangeError('Choose a detection confidence from 50% to 99.9999%. A finite sample cannot guarantee 100%.');
  }
  const requestedProbability = percent / 100;
  let sampleBits = Math.ceil(Math.log1p(-requestedProbability) / LOG_NO_ERROR);
  // Preserve the smallest sufficient integer even near a floating-point edge.
  while (detectionProbability(sampleBits) < requestedProbability) sampleBits++;
  while (sampleBits > 1 && detectionProbability(sampleBits - 1) >= requestedProbability) sampleBits--;

  const requiredMatchingBits = sampleBits + RETAINED_BITS;
  const a = Math.sqrt(LOG_SIFTING_FAILURE / 2);
  let qubits = Math.ceil((a + Math.sqrt(a * a + 2 * requiredMatchingBits)) ** 2);
  while (matchingBitsLowerBound(qubits) < requiredMatchingBits) qubits++;
  while (qubits > 1 && matchingBitsLowerBound(qubits - 1) >= requiredMatchingBits) qubits--;

  return {
    requestedPercent: percent,
    achievedPercent: detectionProbability(sampleBits) * 100,
    sampleBits,
    qubits,
    retainedBits: RETAINED_BITS,
    requiredMatchingBits,
    expectedMatchingBits: qubits / 2,
    conservativeMatchingBits: Math.floor(matchingBitsLowerBound(qubits)),
    siftingConfidencePercent: 99.9,
    siftingFailureProbability: SIFTING_FAILURE_PROBABILITY,
    model: 'full-intercept-resend-ideal',
    samplingPolicy: 'reject-any-sampled-error',
    formula: 'P(detect at least one error) = 1 - (3/4)^m',
    assumptions: [
      'Eve intercepts and resends every independently prepared qubit.',
      'Alice, Bob, and Eve choose Z or X independently and uniformly.',
      'The channel is ideal: hardware noise and loss are excluded.',
      'All public sample bits are discarded; any sampled error rejects the planned exchange.',
      'The detection estimate is conditional on obtaining the complete matching-basis sample.',
    ],
    notice: 'This is a conditional disturbance-detection estimate, not the probability that messages are safe. The five-qubit illustration is separate from the undisclosed key material.',
  };
}
