# Optional Python Qiskit simulator

This module uses IBM Qiskit's QuantumCircuit and Statevector classes for trusted-backend BB84 simulations. It is a classical simulator, distinct from the real IBM Quantum Runtime integration in lib/ibm-quantum.ts.

It provides a bounded server-to-server interface for five-qubit teaching lessons and complete simulated exchanges, supports the same exact public-sample planner as the TypeScript backend, and derives message keys with HKDF-SHA-256. Deterministic teaching replays are unrelated to secret conversation keys.

The service does not submit IBM hardware jobs. Its credentials, if configured, remain server-side. The repository's private local-running guide is distributed separately.
