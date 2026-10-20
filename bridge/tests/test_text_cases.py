"""The shared escaping cases: the web app's lib/text.ts runs the same file."""

import json
from pathlib import Path

import pytest

from mooz_agent.transcript import flatten

pytestmark = pytest.mark.unit

CASES: list[dict[str, object]] = json.loads(
    (Path(__file__).parent / "text_cases.json").read_text()
)["cases"]


@pytest.mark.parametrize("case", CASES, ids=lambda c: str(c["name"]))
def test_flatten(case: dict[str, object]) -> None:
    assert flatten(str(case["text"]), markup=case.get("markup", True) is not False) == case["flat"]
