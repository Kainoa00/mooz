import asyncio

import pytest
from livekit import rtc

from mooz_agent.providers.base import Answer
from mooz_agent.providers.fakes import FakeTTS
from mooz_agent.speaking import Mouth

pytestmark = pytest.mark.unit


class Recorder:
    def __init__(self) -> None:
        self.events: list[str] = []

    async def send_chat(self, text: str, reply_to: str | None = None) -> None:
        self.events.append(f"chat:{text}")

    async def capture_frame(self, frame: rtc.AudioFrame) -> None:
        self.events.append("audio")
        await asyncio.sleep(0)


async def test_posts_the_full_answer_to_chat_before_speaking_the_short_part() -> None:
    rec = Recorder()
    tts = FakeTTS()
    mouth = Mouth(send_chat=rec.send_chat, capture_frame=rec.capture_frame, tts=tts)

    await mouth.say(Answer("The migration.", "Details: `42.sql`"))

    assert rec.events[0] == "chat:The migration.\n\nDetails: `42.sql`"
    assert rec.events[1:] == ["audio", "audio"]
    assert tts.spoken == ["The migration."]


async def test_without_details_chat_gets_just_the_spoken_answer() -> None:
    rec = Recorder()
    mouth = Mouth(send_chat=rec.send_chat, capture_frame=rec.capture_frame, tts=FakeTTS())

    await mouth.say(Answer("Yes.", ""))

    assert rec.events[0] == "chat:Yes."


async def test_one_answer_at_a_time() -> None:
    rec = Recorder()
    mouth = Mouth(send_chat=rec.send_chat, capture_frame=rec.capture_frame, tts=FakeTTS())

    await asyncio.gather(mouth.say(Answer("one two", "")), mouth.say(Answer("three four", "")))

    assert rec.events == ["chat:one two", "audio", "audio", "chat:three four", "audio", "audio"]


async def test_resamples_frames_that_are_not_48k() -> None:
    frames: list[rtc.AudioFrame] = []

    class Tts24k:
        async def synthesize(self, text: str):  # type: ignore[no-untyped-def]
            for _ in range(10):
                yield rtc.AudioFrame.create(24_000, 1, 240)

    async def capture(frame: rtc.AudioFrame) -> None:
        frames.append(frame)

    async def chat(_: str, reply_to: str | None = None) -> None:
        return None

    await Mouth(send_chat=chat, capture_frame=capture, tts=Tts24k()).say(Answer("hi", ""))

    assert frames and all(f.sample_rate == 48_000 for f in frames)
