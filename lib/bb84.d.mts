export interface Envelope { ciphertext: string; iv: string; }
export type Basis = 'Z' | 'X';
export type QubitState = '|0⟩' | '|1⟩' | '|+⟩' | '|−⟩';
export const BB84_BASES: Readonly<{ Z: readonly ['|0⟩', '|1⟩']; X: readonly ['|+⟩', '|−⟩'] }>;
export function encodeQubit(bit: 0 | 1, basis: Basis): QubitState;
export interface TraceEntry { index: number; aliceBasis: Basis; bobBasis: Basis; status: 'discarded' | 'sampled' | 'retained'; sampleAlice?: number; sampleBob?: number; }
export interface Transcript { exchangeId: string; status: 'accepted' | 'aborted'; qubits: number; siftedBits: number; sampledBits: number; remainingBits: number; sampleErrors: number; qber: number; threshold: number; keyBits: number; fingerprint: string | null; interceptSimulated: boolean; trace: TraceEntry[]; reason: string | null; mode: string; requestedSampleBits?: number; abortOnAnyError?: boolean; }
export function simulateBB84(options: {roomId: string; exchangeId?: string; intercept?: boolean; qubits?: number; sampleBits?: number; abortOnAnyError?: boolean}): Promise<{accepted: boolean; key: Uint8Array | null; transcript: Transcript}>;
export function encodeKey(value: Uint8Array): string;
export function decodeKey(value: string): Uint8Array;
export function encryptMessage(key: Uint8Array, plaintext: string, context: string): Promise<Envelope>;
export function decryptMessage(key: Uint8Array, envelope: Envelope, context: string): Promise<string>;
export function wrapKey(key: Uint8Array, masterKey: Uint8Array, context: string): Promise<Envelope>;
export function unwrapKey(envelope: Envelope, masterKey: Uint8Array, context: string): Promise<Uint8Array>;
