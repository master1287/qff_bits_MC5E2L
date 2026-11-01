"""Real Qiskit state preparation and measurement for a BB84 simulation.

This is classical simulation on a trusted server, not physical QKD or a
finite-key security proof. Five-qubit lessons never supply messaging keys.
"""
from __future__ import annotations

import base64
import hashlib
import json
import random
import secrets
import uuid
from typing import Any

import qiskit
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from qiskit import QuantumCircuit
from qiskit.quantum_info import Statevector

QISKIT_VERSION = qiskit.__version__
THRESHOLD = 0.11
STATES = {"Z": ("|0⟩", "|1⟩"), "X": ("|+⟩", "|−⟩")}
ALICE_BITS = (0, 1, 1, 0, 1)
ALICE_BASES = ("Z", "X", "Z", "X", "Z")
BOB_BASES = ("Z", "Z", "Z", "X", "X")
EVE_BASES = ("X", "Z", "Z", "Z", "X")
SAMPLED_POSITIONS = frozenset((0, 3))
SYSTEM_RANDOM = random.SystemRandom()


def encode_state(bit: int, basis: str) -> str:
    if type(bit) is not int or bit not in (0, 1) or basis not in STATES:
        raise ValueError("A bit (0 or 1) and a Z or X basis are required.")
    return STATES[basis][bit]


def preparation_circuit(bit: int, basis: str) -> QuantumCircuit:
    encode_state(bit, basis)
    circuit = QuantumCircuit(1)
    if bit:
        circuit.x(0)
    if basis == "X":
        circuit.h(0)
    return circuit


# These four small Qiskit circuits prepare the four states. Every transmitted
# qubit is an independent Statevector copy, so no 2**4096 allocation occurs.
_PREPARED = {
    (bit, basis): Statevector.from_instruction(preparation_circuit(bit, basis))
    for bit in (0, 1) for basis in STATES
}
_H_CIRCUIT = QuantumCircuit(1)
_H_CIRCUIT.h(0)
_H = _H_CIRCUIT.to_instruction()


def prepare(bit: int, basis: str) -> Statevector:
    encode_state(bit, basis)
    return _PREPARED[(bit, basis)].copy()


def measure(state: Statevector, basis: str, seed: int | None = None) -> tuple[int, Statevector]:
    """Measure with Qiskit, returning the collapsed state in the original frame.

    X measurement is H -> computational measurement -> H. The final H matters:
    Eve resends |+⟩ or |−⟩, not the computational |0⟩ or |1⟩ used internally.
    """
    if basis not in STATES:
        raise ValueError("Measurement basis must be Z or X.")
    measured = state.evolve(_H) if basis == "X" else state.copy()
    measured.seed(secrets.randbits(128) if seed is None else seed)
    outcome, collapsed = measured.measure([0])
    if basis == "X":
        collapsed = collapsed.evolve(_H)
    return int(outcome), collapsed


def _lesson_circuit(intercept: bool) -> str:
    circuit = QuantumCircuit(5, 10 if intercept else 5)
    for index, (bit, basis) in enumerate(zip(ALICE_BITS, ALICE_BASES)):
        if bit:
            circuit.x(index)
        if basis == "X":
            circuit.h(index)
    circuit.barrier(label="Alice prepares")
    if intercept:
        for index, basis in enumerate(EVE_BASES):
            if basis == "X":
                circuit.h(index)
            circuit.measure(index, index + 5)
            if basis == "X":
                circuit.h(index)
        circuit.barrier(label="Eve resends")
    for index, basis in enumerate(BOB_BASES):
        if basis == "X":
            circuit.h(index)
        circuit.measure(index, index)
    return str(circuit.draw(output="text", fold=-1, cregbundle=False))


def _lesson_once(intercept: bool, seed: int) -> dict[str, Any]:
    # A seeded RNG is appropriate only for the replay lesson. Messaging uses
    # secrets/SystemRandom and never these example bits, bases or seeds.
    rng = random.Random(seed)
    rows = []
    for index, (bit, alice_basis, bob_basis) in enumerate(zip(ALICE_BITS, ALICE_BASES, BOB_BASES)):
        state = prepare(bit, alice_basis)
        eve_basis = EVE_BASES[index] if intercept else None
        eve_bit = None
        if intercept:
            eve_bit, state = measure(state, eve_basis, rng.getrandbits(128))
        bob_bit, _ = measure(state, bob_basis, rng.getrandbits(128))
        basis_matches = alice_basis == bob_basis
        rows.append({
            "index": index + 1,
            "aliceBit": bit, "aliceBasis": alice_basis,
            "aliceState": encode_state(bit, alice_basis),
            "aliceGates": (["X"] if bit else []) + (["H"] if alice_basis == "X" else []),
            "eveBasis": eve_basis, "eveBit": eve_bit,
            "eveState": encode_state(eve_bit, eve_basis) if intercept else None,
            "bobBasis": bob_basis, "bobBit": bob_bit,
            "bobState": encode_state(bob_bit, bob_basis),
            "basisMatches": basis_matches, "bitMatches": bit == bob_bit,
            "sampled": basis_matches and index in SAMPLED_POSITIONS,
        })
    sampled = [row for row in rows if row["sampled"]]
    errors = sum(not row["bitMatches"] for row in sampled)
    qber = errors / len(sampled)
    return {
        "id": f"qiskit-{'intercept' if intercept else 'clean'}-{seed}",
        "engine": "qiskit-statevector", "qiskitVersion": QISKIT_VERSION,
        "educational": True, "intercept": intercept, "curated": True,
        "selection": "A teaching example selected to show a disclosed disturbance; other small samples can miss Eve." if intercept else "A reproducible five-qubit teaching example.",
        "securityNotice": "Teaching bits only, unrelated to chat keys. Five qubits cannot establish a secure key or guarantee detecting Eve.",
        "rows": rows,
        "statistics": {
            "sent": len(rows), "sifted": sum(row["basisMatches"] for row in rows),
            "sampled": len(sampled), "errors": errors, "qber": qber,
            "detected": qber > THRESHOLD,
            "remainingBits": [row["aliceBit"] for row in rows if row["basisMatches"] and not row["sampled"]],
        },
        "circuit": _lesson_circuit(intercept),
    }


def create_lesson(intercept: bool = False, seed: int | None = None) -> dict[str, Any]:
    if type(intercept) is not bool:
        raise ValueError("Choose whether to simulate interception.")
    chosen = secrets.randbits(63) if seed is None else seed
    for offset in range(128):
        lesson = _lesson_once(intercept, chosen + offset)
        if not intercept or lesson["statistics"]["detected"]:
            return lesson
    raise RuntimeError("Could not generate the teaching example.")


def pack_bits(bits: list[int]) -> bytes:
    packed = bytearray((len(bits) + 7) // 8)
    for index, bit in enumerate(bits):
        packed[index >> 3] |= bit << (7 - (index & 7))
    return bytes(packed)


def derive_key(bits: list[int], room_id: str, exchange_id: str) -> bytes:
    context = json.dumps(["qubit-chat/bb84-simulator/v1", room_id, exchange_id, len(bits)], separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=hashlib.sha256(context).digest(), info=context).derive(pack_bits(bits))


def encode_key(key: bytes) -> str:
    return base64.urlsafe_b64encode(key).decode("ascii").rstrip("=")


def simulate_exchange(room_id: str, exchange_id: str | None = None, intercept: bool = False, qubits: int = 4096, sample_bits: int | None = None, abort_on_any_error: bool = False) -> dict[str, Any]:
    if not isinstance(room_id, str) or not room_id or len(room_id) > 200:
        raise ValueError("Invalid room context.")
    exchange_id = str(uuid.uuid4()) if exchange_id is None else exchange_id
    if not isinstance(exchange_id, str) or not exchange_id or len(exchange_id) > 200:
        raise ValueError("Invalid exchange context.")
    if type(intercept) is not bool:
        raise ValueError("Choose whether to simulate interception.")
    planned = sample_bits is not None or bool(abort_on_any_error)
    minimum_qubits = 1024 if planned else 4096
    if type(qubits) is not int or not minimum_qubits <= qubits <= 8192:
        raise ValueError(f"Qubit count must be an integer from {minimum_qubits} to 8192.")
    if type(abort_on_any_error) is not bool:
        raise ValueError("Invalid sample rejection policy.")
    if sample_bits is not None and (type(sample_bits) is not int or not 1 <= sample_bits <= 1024):
        raise ValueError("Sample size must be an integer from 1 to 1024.")
    alice_bits = [secrets.randbits(1) for _ in range(qubits)]
    alice_bases = ["X" if secrets.randbits(1) else "Z" for _ in range(qubits)]
    bob_bases = ["X" if secrets.randbits(1) else "Z" for _ in range(qubits)]
    bob_bits = []
    for bit, alice_basis, bob_basis in zip(alice_bits, alice_bases, bob_bases):
        state = prepare(bit, alice_basis)
        if intercept:
            _, state = measure(state, "X" if secrets.randbits(1) else "Z")
        bob_bit, _ = measure(state, bob_basis)
        bob_bits.append(bob_bit)
    sifted = [i for i in range(qubits) if alice_bases[i] == bob_bases[i]]
    shuffled = sifted.copy()
    SYSTEM_RANDOM.shuffle(shuffled)
    insufficient_sifted = sample_bits is not None and len(shuffled) < sample_bits + 512
    sample_count = 0 if insufficient_sifted else sample_bits if sample_bits is not None else min(1024, len(shuffled) // 2)
    sampled = frozenset(shuffled[:sample_count])
    retained = sorted(shuffled[sample_count:])
    errors = sum(alice_bits[i] != bob_bits[i] for i in sampled)
    qber = errors / sample_count if sample_count else 0
    residual_errors = any(alice_bits[i] != bob_bits[i] for i in retained)
    threshold = 0 if abort_on_any_error else THRESHOLD
    accepted = not insufficient_sifted and qber <= threshold and len(retained) >= 512 and not residual_errors
    reason = None
    if insufficient_sifted:
        reason = "Basis sifting did not provide the complete requested sample plus 512 undisclosed bits. No key was derived; retry the exchange."
    elif abort_on_any_error and errors:
        reason = "The public sample revealed a disturbance. The planned ideal-channel exchange rejects any sampled error."
    elif qber > threshold:
        reason = "Sample error rate exceeded the 11% demonstration threshold. The candidate key was discarded."
    elif len(retained) < 512:
        reason = "Insufficient undisclosed bits. The candidate key was discarded."
    elif residual_errors:
        reason = "Key confirmation failed. This simulator does not implement noisy-channel reconciliation."
    trace = []
    for index in range(24):
        status = "discarded" if alice_bases[index] != bob_bases[index] else "sampled" if index in sampled else "retained"
        row = {"index": index + 1, "aliceBasis": alice_bases[index], "bobBasis": bob_bases[index], "status": status}
        if status == "sampled":
            row.update(sampleAlice=alice_bits[index], sampleBob=bob_bits[index])
        trace.append(row)
    key = None
    fingerprint = None
    if accepted:
        alice_key = derive_key([alice_bits[i] for i in retained], room_id, exchange_id)
        bob_key = derive_key([bob_bits[i] for i in retained], room_id, exchange_id)
        if not secrets.compare_digest(alice_key, bob_key):
            raise RuntimeError("Key confirmation failed.")
        key = encode_key(alice_key)
        fingerprint = ":".join(f"{value:02x}" for value in hashlib.sha256(alice_key).digest()[:8])
    return {"accepted": accepted, "key": key, "transcript": {
        "exchangeId": exchange_id, "status": "accepted" if accepted else "aborted", "qubits": qubits,
        "siftedBits": len(sifted), "sampledBits": sample_count, "remainingBits": len(retained),
        "sampleErrors": errors, "qber": qber, "threshold": threshold, "keyBits": 256 if accepted else 0,
        "fingerprint": fingerprint, "interceptSimulated": intercept, "trace": trace, "reason": reason,
        "mode": "trusted-server-simulation", "engine": "qiskit-statevector", "qiskitVersion": QISKIT_VERSION,
        **({"requestedSampleBits": sample_bits, "abortOnAnyError": abort_on_any_error} if sample_bits is not None else {}),
    }}
