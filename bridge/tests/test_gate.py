"""The speech gate. The cases live in gate_cases.json, which the web app's gate runs too."""

import json
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from mooz_agent.gate import LOCAL_GATE, SAMPLE_RATE, SpeechGate

pytestmark = pytest.mark.unit

SHARED: dict[str, Any] = json.loads((Path(__file__).parent / "gate_cases.json").read_text())


@pytest.mark.parametrize("case", SHARED["cases"], ids=lambda c: c["name"])
def test_shared_gate_cases(case: dict[str, Any]) -> None:
    gate = SpeechGate(**LOCAL_GATE) if case["gate"] == "local" else SpeechGate()
    size = SHARED["frame_ms"] * SAMPLE_RATE // 1000
    expected: dict[int, dict[str, Any]] = {}
    for event in case["events"]:
        start, end = event["at"] if isinstance(event["at"], list) else (event["at"], event["at"])
        for i in range(start, end + 1):
            want = {"sent": event["sent"], "commit": event.get("commit", False)}
            if want["commit"]:
                want["keep"] = event["keep"]
            expected[i] = want
    i = 0
    for level, count in case["input"]:
        for _ in range(count):
            out = gate.push(np.full(size, 3000 if level == "l" else 20, dtype=np.int16))
            got = {"sent": len(out.frames), "commit": out.commit}
            if out.commit:
                got["keep"] = out.keep
            assert (i, got) == (i, expected.get(i, {"sent": 0, "commit": False}))
            i += 1


def test_measures_loudness_as_rms_of_full_scale() -> None:
    from mooz_agent.gate import rms

    assert rms(np.zeros(160, dtype=np.int16)) == 0
    assert rms(np.full(160, 16384, dtype=np.int16)) == pytest.approx(0.5)
    assert rms(np.zeros(0, dtype=np.int16)) == 0
