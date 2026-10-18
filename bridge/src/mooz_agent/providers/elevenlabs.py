"""ElevenLabs speech-to-text (Scribe v2 Realtime) and voice, using the agent owner's own key."""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator, Sequence
from typing import Final, Literal

import aiohttp
from livekit import rtc
from livekit.agents import stt as lk_stt
from livekit.agents.types import NOT_GIVEN
from livekit.plugins import elevenlabs

from ..room import Speaker

STT_SAMPLE_RATE: Final[Literal[16000]] = 16000


class ElevenLabsSTT:
    """One realtime stream per speaker. Runs in zero-retention mode: ElevenLabs keeps no audio."""

    def __init__(
        self, *, api_key: str, http: aiohttp.ClientSession, keyterms: Sequence[str] = ()
    ) -> None:
        self._stt = elevenlabs.STT(
            api_key=api_key,
            model="scribe_v2_realtime",
            sample_rate=STT_SAMPLE_RATE,
            http_session=http,
            enable_logging=False,
            # Biasing toward the agent's name is what keeps wake-ups reliable.
            keyterms=list(keyterms) if keyterms else NOT_GIVEN,
        )

    async def transcribe(
        self, speaker: Speaker, frames: AsyncIterator[rtc.AudioFrame]
    ) -> AsyncIterator[str]:
        stream = self._stt.stream()

        async def pump() -> None:
            async for frame in frames:
                stream.push_frame(frame)
            stream.end_input()

        pumping = asyncio.ensure_future(pump())
        try:
            async for event in stream:
                if event.type == lk_stt.SpeechEventType.FINAL_TRANSCRIPT and event.alternatives:
                    yield event.alternatives[0].text
        finally:
            pumping.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await pumping
            await stream.aclose()
