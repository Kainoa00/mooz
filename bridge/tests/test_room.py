import json
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
        text.encode("utf-8")  # as LiveKit's protobuf does, which refuses half a character pair
        self.sent.append({"text": text, **kw})


class _Room:
    def __init__(self, metadata: str = "") -> None:
        self.local_participant = _Sender()
        self.metadata = metadata


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


async def test_task_updates_go_as_written_not_escaped() -> None:
    fake = _Room()
    room = MeetingRoom(cast(rtc.Room, fake))
    await room.send_task_event({"type": "task", "details": "Привет " * 3000}, to=["p_1"])
    (sent,) = fake.local_participant.sent
    assert "Привет" in sent["text"] and len(sent["text"]) < 22_000
    assert json.loads(sent["text"])["details"] == "Привет " * 3000


async def test_half_a_character_pair_from_a_model_doesnt_stop_the_message() -> None:
    fake = _Room()
    room = MeetingRoom(cast(rtc.Room, fake))
    await room.send_task_event({"type": "task", "summary": "Up \ud83d 5%", "details": "📈"})
    await room.send_chat("Up \ud83d 5%")
    await room.send_chat("Up \ud83d" + "\udcc8 5%")  # both halves, apart
    event, chat, joined = fake.local_participant.sent
    assert json.loads(event["text"])["summary"] == "Up \ufffd 5%"
    assert json.loads(event["text"])["details"] == "📈"
    assert chat["text"] == "Up \ufffd 5%"
    assert joined["text"] == "Up 📈 5%"


@pytest.mark.parametrize(
    ("metadata", "continued"),
    [
        ('{"floor": {"paused": false, "continued": 1792000000000}}', 1792000000000),
        ('{"floor": {"paused": true, "continued": 0}}', 0),
        ('{"floor": {"paused": true}}', 0),  # a server from before it said
        ('{"floor": {"continued": "1792000000000"}}', 0),
        ('{"floor": {"continued": true}}', 0),
        ('{"floor": {"continued": -5}}', 0),
        ("not json", 0),
        ("", 0),
    ],
)
async def test_reads_when_a_person_last_let_agents_continue(metadata: str, continued: int) -> None:
    assert MeetingRoom(cast(rtc.Room, _Room(metadata))).floor_continued() == continued


class _Wiring(_Room):
    """A room that records what MeetingRoom listens for, then refuses to connect."""

    def __init__(self) -> None:
        super().__init__()
        self.handlers: dict[str, Any] = {}

    def on(self, event: str, handler: Any) -> None:
        self.handlers[event] = handler

    def register_text_stream_handler(self, *_: Any) -> None:
        pass

    async def connect(self, *_: Any, **__: Any) -> None:
        raise ConnectionError("not in this test")


async def test_a_metadata_change_tells_the_agent_about_notes_and_the_floor() -> None:
    fake = _Wiring()
    room = MeetingRoom(cast(rtc.Room, fake))
    calls: list[str] = []
    room.on_notes_policy_changed = lambda: calls.append("notes")
    room.on_floor_changed = lambda: calls.append("floor")
    with pytest.raises(ConnectionError):
        await room.connect("ws://localhost:7880", "token")
    fake.handlers["room_metadata_changed"]("{}", '{"floor": {"continued": 1792000000000}}')
    assert calls == ["notes", "floor"]
