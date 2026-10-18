"""The swappable parts of an agent. Each has a real implementation and a fake for tests."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Protocol

from livekit import rtc

from ..room import Speaker


class SpeechToText(Protocol):
    def transcribe(
        self, speaker: Speaker, frames: AsyncIterator[rtc.AudioFrame]
    ) -> AsyncIterator[str]:
        """Yield final transcript segments for one speaker's audio."""
        ...


class TextToSpeech(Protocol):
    def synthesize(self, text: str) -> AsyncIterator[rtc.AudioFrame]:
        """Yield audio frames (48 kHz mono) speaking `text`."""
        ...


class Brain(Protocol):
    async def answer(self, *, question: str, asker: Speaker, transcript: str) -> str:
        """Answer a question addressed to the agent, given the recent meeting transcript."""
        ...
