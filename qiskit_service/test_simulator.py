from __future__ import annotations

import base64
import io
import json
import unittest
from email.message import Message
from types import SimpleNamespace

from .server import QiskitHandler, make_server
from .simulator import create_lesson, derive_key, encode_state, measure, pack_bits, prepare, simulate_exchange


class StatePreparationTests(unittest.TestCase):
    def test_four_state_encodings(self):
        self.assertEqual([encode_state(0, "Z"), encode_state(1, "Z"), encode_state(0, "X"), encode_state(1, "X")], ["|0⟩", "|1⟩", "|+⟩", "|−⟩"])
        self.assertTrue(prepare(0, "Z").equiv([1, 0]))
        self.assertTrue(prepare(1, "Z").equiv([0, 1]))
        self.assertTrue(prepare(0, "X").equiv([2 ** -0.5, 2 ** -0.5]))
        self.assertTrue(prepare(1, "X").equiv([2 ** -0.5, -(2 ** -0.5)]))

    def test_matching_basis_measurements_and_resend_states(self):
        for basis in ("Z", "X"):
            for bit in (0, 1):
                outcome, collapsed = measure(prepare(bit, basis), basis, seed=84)
                self.assertEqual(outcome, bit)
                self.assertTrue(collapsed.equiv(prepare(bit, basis)))

    def test_incompatible_measurement_is_random_and_x_collapse_is_unrotated(self):
        outcomes = set()
        for seed in range(20):
            outcome, collapsed = measure(prepare(0, "Z"), "X", seed)
            outcomes.add(outcome)
            self.assertTrue(collapsed.equiv(prepare(outcome, "X")))
        self.assertEqual(outcomes, {0, 1})

    def test_invalid_state_parameters(self):
        for bit, basis in ((2, "Z"), (True, "Z"), (0, "+"), (0, "Y")):
            with self.assertRaises(ValueError):
                encode_state(bit, basis)


class LessonTests(unittest.TestCase):
    def test_five_qubit_clean_lesson(self):
        lesson = create_lesson(False, seed=84)
        self.assertEqual(lesson["engine"], "qiskit-statevector")
        self.assertEqual(len(lesson["rows"]), 5)
        self.assertEqual([row["aliceBit"] for row in lesson["rows"]], [0, 1, 1, 0, 1])
        self.assertEqual(lesson["statistics"], {"sent": 5, "sifted": 3, "sampled": 2, "errors": 0, "qber": 0, "detected": False, "remainingBits": [1]})
        self.assertTrue(all(row["eveBasis"] is None and row["eveBit"] is None for row in lesson["rows"]))
        self.assertTrue(all(row["bitMatches"] for row in lesson["rows"] if row["basisMatches"]))
        self.assertIn("Alice prepares", lesson["circuit"])
        self.assertTrue(lesson["educational"])
        self.assertNotIn("key", lesson)

    def test_curated_intercept_lesson_is_reproducible_and_detected(self):
        lesson = create_lesson(True, seed=84)
        self.assertEqual(lesson, create_lesson(True, seed=84))
        self.assertTrue(lesson["curated"])
        self.assertTrue(lesson["statistics"]["detected"])
        self.assertGreater(lesson["statistics"]["qber"], 0.11)
        self.assertIn("other small samples can miss Eve", lesson["selection"])
        self.assertIn("Eve resends", lesson["circuit"])
        for row in lesson["rows"]:
            self.assertEqual(row["eveState"], encode_state(row["eveBit"], row["eveBasis"]))
            self.assertEqual(row["bobState"], encode_state(row["bobBit"], row["bobBasis"]))
            if row["sampled"]:
                self.assertTrue(row["basisMatches"])


class ExchangeTests(unittest.TestCase):
    def test_independent_statevector_exchange_produces_key_and_safe_trace(self):
        result = simulate_exchange("unit-room", "unit-exchange")
        self.assertTrue(result["accepted"])
        self.assertEqual(len(base64.urlsafe_b64decode(result["key"] + "=")), 32)
        transcript = result["transcript"]
        self.assertEqual(transcript["qber"], 0)
        self.assertEqual(transcript["engine"], "qiskit-statevector")
        self.assertEqual(transcript["siftedBits"], transcript["sampledBits"] + transcript["remainingBits"])
        self.assertGreaterEqual(transcript["remainingBits"], 512)
        self.assertEqual(transcript["keyBits"], 256)
        for row in transcript["trace"]:
            self.assertIn(row["aliceBasis"], ("Z", "X"))
            self.assertEqual("sampleAlice" in row, row["status"] == "sampled")
            self.assertEqual("sampleBob" in row, row["status"] == "sampled")
            self.assertNotIn("aliceState", row)

    def test_full_intercept_resend_is_rejected(self):
        result = simulate_exchange("unit-room", intercept=True)
        self.assertFalse(result["accepted"])
        self.assertIsNone(result["key"])
        self.assertGreater(result["transcript"]["qber"], 0.11)
        self.assertLess(result["transcript"]["qber"], 0.4)
        self.assertEqual(result["transcript"]["keyBits"], 0)

    def test_packing_and_hkdf_context(self):
        self.assertEqual(pack_bits([1, 0, 1, 0, 1, 0, 1, 0, 1]), bytes([170, 128]))
        bits = [0, 1, 1, 0, 1] * 130
        self.assertEqual(derive_key(bits, "room", "exchange"), derive_key(bits, "room", "exchange"))
        self.assertNotEqual(derive_key(bits, "room", "exchange"), derive_key(bits, "other", "exchange"))

    def test_invalid_exchange_inputs(self):
        for kwargs in ({"room_id": ""}, {"room_id": "room", "qubits": 10}, {"room_id": "room", "qubits": True}, {"room_id": "room", "intercept": 1}):
            with self.assertRaises(ValueError):
                simulate_exchange(**kwargs)

    def test_planned_exchange_uses_the_exact_public_sample(self):
        result = None
        for attempt in range(3):
            result = simulate_exchange("planned-room", "planned-exchange", qubits=1187, sample_bits=17, abort_on_any_error=True)
            if result["accepted"]:
                break
            self.assertIn("complete requested sample", result["transcript"]["reason"])
            self.assertIsNone(result["key"])
        self.assertTrue(result["accepted"])
        transcript = result["transcript"]
        self.assertEqual(transcript["qubits"], 1187)
        self.assertEqual(transcript["sampledBits"], 17)
        self.assertEqual(transcript["requestedSampleBits"], 17)
        self.assertTrue(transcript["abortOnAnyError"])
        self.assertEqual(transcript["threshold"], 0)
        self.assertEqual(transcript["sampleErrors"], 0)
        self.assertGreaterEqual(transcript["remainingBits"], 512)
        self.assertEqual(transcript["siftedBits"], transcript["sampledBits"] + transcript["remainingBits"])

    def test_planned_attack_and_insufficient_pool_fail_closed(self):
        attack = simulate_exchange("planned-attack", intercept=True, qubits=1203, sample_bits=25, abort_on_any_error=True)
        self.assertFalse(attack["accepted"])
        self.assertIsNone(attack["key"])
        self.assertEqual(attack["transcript"]["threshold"], 0)
        insufficient = simulate_exchange("insufficient-pool", qubits=1024, sample_bits=1024, abort_on_any_error=True)
        self.assertFalse(insufficient["accepted"])
        self.assertIsNone(insufficient["key"])
        self.assertEqual(insufficient["transcript"]["sampledBits"], 0)
        self.assertEqual(insufficient["transcript"]["requestedSampleBits"], 1024)
        self.assertIn("complete requested sample", insufficient["transcript"]["reason"])

    def test_planned_sample_input_validation(self):
        for sample_bits in (0, -1, 1.5, 1025, True, "17"):
            with self.assertRaises(ValueError):
                simulate_exchange("room", qubits=1187, sample_bits=sample_bits, abort_on_any_error=True)
        with self.assertRaises(ValueError):
            simulate_exchange("room", sample_bits=17, abort_on_any_error="yes")
        with self.assertRaises(ValueError):
            simulate_exchange("room", qubits=1023, sample_bits=17, abort_on_any_error=True)


class ServiceBoundaryTests(unittest.TestCase):
    def request(self, path, body, token="", authorization=None, origin=None):
        handler = object.__new__(QiskitHandler)
        handler.server = SimpleNamespace(auth_token=token)
        handler.path = path
        handler.headers = Message()
        raw = json.dumps(body).encode()
        handler.headers["Content-Type"] = "application/json"
        handler.headers["Content-Length"] = str(len(raw))
        if authorization:
            handler.headers["Authorization"] = authorization
        if origin:
            handler.headers["Origin"] = origin
        handler.rfile = io.BytesIO(raw)
        handler.connection = SimpleNamespace(settimeout=lambda timeout: None)
        captured = []
        handler._send = lambda status, result: captured.append((status, result))
        handler.do_POST()
        return captured[0]

    def test_auth_and_origin_guards(self):
        self.assertEqual(self.request("/lesson", {}, token="secret")[0], 401)
        self.assertEqual(self.request("/lesson", {}, token="secret", authorization="Bearer wrong")[0], 401)
        self.assertEqual(self.request("/lesson", {}, origin="https://other.example")[0], 403)
        with self.assertRaises(ValueError):
            make_server("0.0.0.0", 8001, token="")

    def test_lesson_http_adapter_and_input_limits(self):
        status, result = self.request("/lesson", {"intercept": False}, token="secret", authorization="Bearer secret")
        self.assertEqual(status, 200)
        self.assertEqual(result["engine"], "qiskit-statevector")
        self.assertEqual(self.request("/lesson", {"intercept": "yes"})[0], 400)
        self.assertEqual(self.request("/lesson", {"circuit": "arbitrary"})[0], 400)
        self.assertEqual(self.request("/unknown", {})[0], 404)

    def test_exchange_http_adapter_accepts_planned_budget(self):
        status, result = self.request("/exchange", {"roomId": "http-planned", "exchangeId": "http-planned-exchange", "qubits": 1187, "sampleBits": 17, "abortOnAnyError": True})
        self.assertEqual(status, 200)
        self.assertEqual(result["transcript"]["qubits"], 1187)
        self.assertEqual(result["transcript"]["requestedSampleBits"], 17)
        self.assertEqual(result["transcript"]["threshold"], 0)
        self.assertEqual(self.request("/exchange", {"roomId": "http-planned", "qubits": 1187, "sampleBits": "17"})[0], 400)


if __name__ == "__main__":
    unittest.main()
