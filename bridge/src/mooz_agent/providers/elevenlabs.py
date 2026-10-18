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
VAD_SILENCE_SECONDS = 0.6


class ElevenLabsSTT:
    """One realtime stream per speaker. Runs in zero-retention mode: ElevenLabs keeps no audio."""

    def __init__(
        self,
        *,
        api_key: str,
        http: aiohttp.ClientSession,
        keyterms: Sequence[str] = (),
        language: str = "en",
    ) -> None:
        self._stt = elevenlabs.STT(
            api_key=api_key,
            model="scribe_v2_realtime",
            sample_rate=STT_SAMPLE_RATE,
            http_session=http,
            enable_logging=False,
            # Commit a transcript after each pause in speech. Without server VAD the
            # plugin commits only when the track ends, i.e. never mid-meeting.
            server_vad={"vad_silence_threshold_secs": VAD_SILENCE_SECONDS},
            # A fixed language makes the first commit final instead of waiting for the
            # delayed copy that carries language detection.
            language_code=language,
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


TTS_SAMPLE_RATE = 48_000


class ElevenLabsTTS:
    """Flash v2.5 for the lowest time-to-first-audio, at 48 kHz to match the agent's track."""

    def __init__(self, *, api_key: str, voice_id: str | None, http: aiohttp.ClientSession) -> None:
        self._tts = elevenlabs.TTS(
            api_key=api_key,
            voice_id=voice_id or elevenlabs.tts.DEFAULT_VOICE_ID,
            model="eleven_flash_v2_5",
            encoding="pcm_48000",
            http_session=http,
            enable_logging=False,
        )

    async def synthesize(self, text: str) -> AsyncIterator[rtc.AudioFrame]:
        async with self._tts.synthesize(text) as stream:
            async for audio in stream:
                yield audio.frame
