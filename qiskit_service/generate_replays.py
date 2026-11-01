"""Generate the hosted educational fixtures with the installed IBM Qiskit."""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from .simulator import QISKIT_VERSION, create_lesson


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent.parent / "public" / "qiskit-replays.json")
    args = parser.parse_args()
    payload = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "qiskitVersion": QISKIT_VERSION,
        "scenarios": {
            "clean": create_lesson(False, seed=84),
            "intercept": create_lesson(True, seed=84),
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Generated two educational Qiskit {QISKIT_VERSION} replays: {args.output}")


if __name__ == "__main__":
    main()
