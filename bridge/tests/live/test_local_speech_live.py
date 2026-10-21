"""A real local speech server (VoiceStudio or another OpenAI-compatible one).

Run with MOOZ_LIVE_TESTS=1 and MOOZ_LOCAL_SPEECH_URL=http://127.0.0.1:3900/v1 (plus the
MOOZ_STT_* / MOOZ_TTS_* settings your server needs). It prints how long each part took.
"""

import asyncio
import os
import time
from collections.abc import AsyncIterator

import httpx
import pytest
from livekit import rtc

from mooz_agent.providers.local import LocalSpeech, LocalSTT, LocalTTS, check_speech_server
from mooz_agent.room import Speaker

URL = os.environ.get("MOOZ_LOCAL_SPEECH_URL")
pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(os.environ.get("MOOZ_LIVE_TESTS") != "1", reason="set MOOZ_LIVE_TESTS=1"),
    pytest.mark.skipif(not URL, reason="set MOOZ_LOCAL_SPEECH_URL"),
]


async def test_says_and_hears_hello() -> None:
    env = {**os.environ, "MOOZ_SPEECH_URL": URL or ""}
    settings = LocalSpeech.from_env(env)
    async with httpx.AsyncClient() as http:
        await check_speech_server(http, settings)
        started = time.monotonic()
        first: float | None = None
        spoken: list[rtc.AudioFrame] = []
        async for frame in LocalTTS(settings, http).synthesize("Hello from mooz."):
            first = first or time.monotonic() - started
            spoken.append(frame)
        assert spoken, "the server said nothing"
        print(f"speech: first audio after {first:.2f} s, {time.monotonic() - started:.2f} s in all")

        # Hear it back, as a person's 16 kHz track would arrive, then a pause.
        audio = rtc.combine_audio_frames(spoken)
        resampler = rtc.AudioResampler(audio.sample_rate, 16_000, num_channels=1)
        track = [*resampler.push(audio), *resampler.flush()]
        silence = rtc.AudioFrame(b"\x00\x00" * 1600, 16_000, 1, 1600)

        async def frames() -> AsyncIterator[rtc.AudioFrame]:
            for f in track:
                yield f
            for _ in range(15):
                yield silence
                await asyncio.sleep(0)

        started = time.monotonic()
        heard = [
            t
            async for t in LocalSTT(settings, http).transcribe(Speaker("p", "P", "human"), frames())
        ]
        print(f"transcription: {time.monotonic() - started:.2f} s, heard {heard!r}")
    assert "hello" in " ".join(heard).lower()
