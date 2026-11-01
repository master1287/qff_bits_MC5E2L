export interface DetectionPlan {
  requestedPercent: number;
  achievedPercent: number;
  sampleBits: number;
  qubits: number;
  retainedBits: 512;
  requiredMatchingBits: number;
  expectedMatchingBits: number;
  conservativeMatchingBits: number;
  siftingConfidencePercent: 99.9;
  siftingFailureProbability: number;
  model: 'full-intercept-resend-ideal';
  samplingPolicy: 'reject-any-sampled-error';
  formula: string;
  assumptions: string[];
  notice: string;
}
export function planDetectionConfidence(percent?: number): DetectionPlan;
