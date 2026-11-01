"""Small, bounded HTTP adapter for the trusted local Qiskit simulator."""
from __future__ import annotations

import argparse
import ipaddress
import json
import os
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from .simulator import QISKIT_VERSION, create_lesson, simulate_exchange

MAX_BODY = 65536
SLOTS = threading.BoundedSemaphore(2)


def is_loopback(host: str) -> bool:
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


class QiskitHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "QubitQiskit/1"

    def log_message(self, format: str, *args: Any) -> None:
        # Headers, request bodies, key material and invocation data stay out of logs.
        pass

    def _send(self, status: int, value: dict[str, Any]) -> None:
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(encoded)
        self.close_connection = True

    def do_GET(self) -> None:
        if self.path != "/health":
            self._send(404, {"error": "Not found."})
            return
        self._send(200, {"ok": True, "engine": "qiskit-statevector", "qiskitVersion": QISKIT_VERSION, "simulation": True})

    def do_OPTIONS(self) -> None:
        self._send(405, {"error": "Browser cross-origin requests are not supported. Use the app backend."})

    def do_POST(self) -> None:
        token = self.server.auth_token
        supplied = self.headers.get("Authorization", "")
        if token and not secrets.compare_digest(supplied, f"Bearer {token}"):
            self._send(401, {"error": "Service authorization is required."})
            return
        # The web app calls this server-to-server; direct browser requests are unnecessary.
        if self.headers.get("Origin"):
            self._send(403, {"error": "Use the app backend for simulator requests."})
            return
        if self.path not in ("/lesson", "/exchange"):
            self._send(404, {"error": "Not found."})
            return
        if not self.headers.get("Content-Type", "").lower().startswith("application/json"):
            self._send(415, {"error": "Send a JSON request."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send(400, {"error": "Invalid request size."})
            return
        if not 0 < length <= MAX_BODY:
            self._send(413, {"error": "The request must contain at most 64 KiB."})
            return
        if not SLOTS.acquire(blocking=False):
            self._send(429, {"error": "The simulator is busy. Try again shortly."})
            return
        try:
            self.connection.settimeout(10)
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError("Incomplete request body.")
            value = json.loads(raw)
            if not isinstance(value, dict):
                raise ValueError("Send a JSON object.")
            if self.path == "/lesson":
                if set(value) - {"intercept"}:
                    raise ValueError("Only the interception option is supported.")
                result = create_lesson(intercept=value.get("intercept", False))
            else:
                if set(value) - {"roomId", "exchangeId", "intercept", "qubits", "sampleBits", "abortOnAnyError"}:
                    raise ValueError("Unsupported exchange option.")
                result = simulate_exchange(
                    room_id=value.get("roomId"), exchange_id=value.get("exchangeId"),
                    intercept=value.get("intercept", False), qubits=value.get("qubits", 4096),
                    sample_bits=value.get("sampleBits"), abort_on_any_error=value.get("abortOnAnyError", False),
                )
            self._send(200, result)
        except (ValueError, UnicodeError):
            self._send(400, {"error": "The simulator input is invalid."})
        except Exception:
            self._send(500, {"error": "The simulator could not complete this request."})
        finally:
            SLOTS.release()


def make_server(host: str = "127.0.0.1", port: int = 8001, token: str | None = None) -> ThreadingHTTPServer:
    token = os.environ.get("QISKIT_SERVICE_TOKEN", "") if token is None else token
    if not is_loopback(host) and (not token or len(token) < 32):
        raise ValueError("Non-loopback hosting requires QISKIT_SERVICE_TOKEN with at least 32 characters.")
    server = ThreadingHTTPServer((host, port), QiskitHandler)
    server.daemon_threads = True
    server.auth_token = token
    return server


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Qubit IBM Qiskit simulator service.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8001)
    args = parser.parse_args()
    server = make_server(args.host, args.port)
    print(f"Qiskit {QISKIT_VERSION} simulator listening at http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
