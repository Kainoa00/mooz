from dataclasses import dataclass, field

import pytest

from mooz_agent.room import Speaker, speaker_from_participant

pytestmark = pytest.mark.unit


@dataclass
class P:
    identity: str
    name: str
    attributes: dict[str, str] = field(default_factory=dict)


def test_humans_are_humans() -> None:
    assert speaker_from_participant(P("p_1", "Zach", {"kind": "human"})) == Speaker(
        identity="p_1", name="Zach", kind="human"
    )


def test_agents_carry_their_owner() -> None:
    assert speaker_from_participant(
        P("a_1", "Grok", {"kind": "agent", "owner_id": "p_1", "owner_name": "Zach"})
    ) == Speaker(identity="a_1", name="Grok", kind="agent", owner_identity="p_1", owner_name="Zach")


def test_missing_attributes_default_to_human_and_identity_as_name() -> None:
    assert speaker_from_participant(P("p_2", "", {})) == Speaker(
        identity="p_2", name="p_2", kind="human"
    )
