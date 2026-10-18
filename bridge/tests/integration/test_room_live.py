import asyncio

import pytest
from livekit import rtc

from mooz_agent.room import CHAT_TOPIC, ChatMessage, MeetingRoom

from .conftest import LIVEKIT_URL, mint

pytestmark = pytest.mark.integration


async def wait_for(predicate, timeout: float = 10.0) -> None:  # type: ignore[no-untyped-def]
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(0.05)


async def test_agent_and_human_exchange_chat(room_name: str) -> None:
    agent = MeetingRoom()
    received: list[ChatMessage] = []
    agent.on_chat = received.append
    await agent.connect(
        LIVEKIT_URL,
        mint(
            room_name, "a_it", "Atlas", {"kind": "agent", "owner_id": "p_it", "owner_name": "Kai"}
        ),
    )

    human = rtc.Room()
    human_inbox: list[tuple[str, str]] = []

    async def read(reader: rtc.TextStreamReader, identity: str) -> None:
        human_inbox.append((identity, await reader.read_all()))

    human.register_text_stream_handler(CHAT_TOPIC, lambda r, i: asyncio.ensure_future(read(r, i)))
    await human.connect(LIVEKIT_URL, mint(room_name, "p_it", "Kai", {"kind": "human"}))
    try:
        await wait_for(lambda: len(agent.participants()) == 1)
        assert agent.participants()[0].kind == "human"
        assert agent.me.kind == "agent"

        await human.local_participant.send_text("hello @Atlas", topic=CHAT_TOPIC)
        await wait_for(lambda: len(received) == 1)
        assert received[0].text == "hello @Atlas"
        assert received[0].speaker.name == "Kai"
        assert received[0].speaker.kind == "human"

        await agent.send_chat("hi Kai")
        await wait_for(lambda: len(human_inbox) == 1)
        assert human_inbox[0] == ("a_it", "hi Kai")
    finally:
        await human.disconnect()
        await agent.disconnect()


async def test_agent_is_offered_human_audio_only(room_name: str) -> None:
    agent = MeetingRoom()
    offered: list[str] = []
    agent.on_human_track = lambda speaker, _track: offered.append(speaker.identity)
    await agent.connect(LIVEKIT_URL, mint(room_name, "a_it", "Atlas", {"kind": "agent"}))

    human = rtc.Room()
    other_agent = MeetingRoom()
    await human.connect(LIVEKIT_URL, mint(room_name, "p_it", "Kai", {"kind": "human"}))
    await other_agent.connect(LIVEKIT_URL, mint(room_name, "a_other", "Grok", {"kind": "agent"}))
    source = rtc.AudioSource(48_000, 1)
    track = rtc.LocalAudioTrack.create_audio_track("mic", source)
    await human.local_participant.publish_track(
        track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
    )
    try:
        await wait_for(lambda: "p_it" in offered)
        await asyncio.sleep(0.5)
        assert offered == ["p_it"]  # the other agent's voice track is ignored
    finally:
        await human.disconnect()
        await other_agent.disconnect()
        await agent.disconnect()
