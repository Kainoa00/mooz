"""One transcription stream per person: speaker identity comes from the track, not a guess."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncIterator, Callable
from typing import Any

from livekit import rtc

from .providers.base import SpeechToText
from .room import Speaker
from .transcript import Utterance

log = logging.getLogger(__name__)


class Listener:
    def __init__(
        self,
        stt: SpeechToText,
        on_utterance: Callable[[Utterance], None],
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._stt = stt
        self._on_utterance = on_utterance
        self._clock = clock
        self._tasks: dict[str, asyncio.Task[None]] = {}

    @property
    def active(self) -> set[str]:
        return {identity for identity, task in self._tasks.items() if not task.done()}

    def attach(self, speaker: Speaker, frames: AsyncIterator[Any]) -> None:
        self.detach(speaker.identity)
        task = asyncio.ensure_future(self._run(speaker, frames))
        self._tasks[speaker.identity] = task

    def detach(self, identity: str) -> None:
        task = self._tasks.pop(identity, None)
        if task:
            task.cancel()

    async def aclose(self) -> None:
        tasks = list(self._tasks.values())
        self._tasks.clear()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def _run(self, speaker: Speaker, frames: AsyncIterator[Any]) -> None:
        try:
            async for text in self._stt.transcribe(speaker, frames):
                text = text.strip()
                if text:
                    self._on_utterance(Utterance(speaker, text, self._clock(), "voice"))
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("transcription failed for %s", speaker.name)


async def track_frames(
    track: rtc.Track, sample_rate: int = 16_000
) -> AsyncIterator[rtc.AudioFrame]:
    """A participant's audio as mono frames at the rate speech-to-text wants."""
    stream = rtc.AudioStream(track, sample_rate=sample_rate, num_channels=1)
    try:
        async for event in stream:
            yield event.frame
    finally:
        await stream.aclose()
