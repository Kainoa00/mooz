import asyncio

import pytest
from livekit import rtc

from mooz_agent.listening import Listener, track_frames
from mooz_agent.providers.fakes import FakeSTT
from mooz_agent.room import MeetingRoom
from mooz_agent.transcript import Utterance

from .conftest import LIVEKIT_URL, mint

pytestmark = pytest.mark.integration


async def test_human_audio_from_livekit_reaches_the_transcriber(room_name: str) -> None:
    heard: list[Utterance] = []
    listener = Listener(FakeSTT({"p_it": ["hey Atlas what time is it"]}), heard.append)
    agent = MeetingRoom()
    agent.on_human_track = lambda speaker, track: listener.attach(speaker, track_frames(track))
    await agent.connect(LIVEKIT_URL, mint(room_name, "a_it", "Atlas", {"kind": "agent"}))

    human = rtc.Room()
    await human.connect(LIVEKIT_URL, mint(room_name, "p_it", "Kai", {"kind": "human"}))
    source = rtc.AudioSource(48_000, 1)
    track = rtc.LocalAudioTrack.create_audio_track("mic", source)
    await human.local_participant.publish_track(
        track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
    )
    try:
        async with asyncio.timeout(10):
            while not heard:
                await source.capture_frame(rtc.AudioFrame.create(48_000, 1, 480))
        assert heard[0].speaker.name == "Kai"
        assert heard[0].text == "hey Atlas what time is it"
    finally:
        await listener.aclose()
        await human.disconnect()
        await agent.disconnect()
