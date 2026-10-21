from dataclasses import dataclass, field
from typing import Any, cast

import pytest
from livekit import rtc

from mooz_agent.room import MeetingRoom, Speaker, speaker_from_participant

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


class _Sender:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_text(self, text: str, **kw: Any) -> None:
        self.sent.append({"text": text, **kw})


class _Room:
    def __init__(self) -> None:
        self.local_participant = _Sender()


async def test_chat_to_some_people_is_marked_private() -> None:
    fake = _Room()
    room = MeetingRoom(cast(rtc.Room, fake))
    await room.send_chat("March 30th.", reply_to="p_1", sources=frozenset({"p_2", "p_1"}))
    await room.send_chat("Your result.", reply_to="p_1", to=["p_1"])
    await room.send_chat("Hello.")

    first, second, third = fake.local_participant.sent
    assert first["attributes"] == {"reply_to": "p_1", "sources": "p_1,p_2"}
    assert first["destination_identities"] is None
    assert second["attributes"] == {"reply_to": "p_1", "private": "1"}
    assert second["destination_identities"] == ["p_1"]
    assert third["attributes"] is None
