"""The swappable parts of an agent. Each has a real implementation and a fake for tests."""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
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


@dataclass(frozen=True)
class Answer:
    """`spoken` is said out loud (short, plain words); `details` only goes to chat."""

    spoken: str
    details: str = ""


class BrainError(Exception):
    """The model could not be reached or returned an error."""


class Brain(Protocol):
    async def answer(self, *, question: str, asker: Speaker, transcript: str) -> Answer:
        """Answer a question addressed to the agent, given the recent meeting transcript."""
        ...
