"""Name detection corpus. Every case documents a behavior; xfails are known limitations.

The cases live in addressing_cases.json, which the web app's detector (for connector
agents) runs too, so the two never drift.
"""

import json
from pathlib import Path
from typing import Literal

import pytest

from mooz_agent.addressing import AddressDetector, phonetic_key

pytestmark = pytest.mark.unit

ATLAS = AddressDetector("Atlas")
CASES: list[dict[str, str | None]] = json.loads(
    (Path(__file__).parent / "addressing_cases.json").read_text()
)["cases"]


@pytest.mark.parametrize("case", CASES, ids=lambda c: f"{c['name']}|{c['via']}|{c['text']}")
def test_addressing(case: dict[str, str | None]) -> None:
    via: Literal["voice", "chat"] = "chat" if case["via"] == "chat" else "voice"
    result = AddressDetector(str(case["name"])).check(str(case["text"]), via=via)
    assert (result.question if result else None) == case["question"]


@pytest.mark.xfail(strict=True, reason="known limitation: vocative in the middle of a sentence")
def test_mid_sentence_vocative() -> None:
    assert ATLAS.check("So what I want to know, Atlas, is why CI fails", via="voice") is not None


@pytest.mark.xfail(strict=True, reason="known limitation: only the first of several names is heard")
def test_two_names_in_one_vocative() -> None:
    # "@Atlas @Nova" or "@everyone" reach both; spoken, only Atlas answers.
    assert AddressDetector("Nova").check("Atlas and Nova, any thoughts?", via="voice") is not None


def test_phonetic_key_groups_spellings_that_sound_alike() -> None:
    assert phonetic_key("Atlas") == phonetic_key("Atlis") == phonetic_key("Atlus")
    assert phonetic_key("Atlas") != phonetic_key("Alice")


def test_corpus_size_meets_the_plan() -> None:
    assert len(CASES) >= 40
