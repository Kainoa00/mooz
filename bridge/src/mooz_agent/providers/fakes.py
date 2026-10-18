"""Deterministic stand-ins for the model and voice providers, for tests and offline demos."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Any

from livekit import rtc

from ..room import Speaker
from .base import Answer


class FakeSTT:
    """Transcribes each speaker as a fixed script (or raises a scripted error)."""

    def __init__(
        self, scripts: Mapping[str, Sequence[str] | BaseException], delay: float = 0
    ) -> None:
        self._scripts = scripts
        self._delay = delay

    async def transcribe(self, speaker: Speaker, frames: AsyncIterator[Any]) -> AsyncIterator[str]:
        script = self._scripts.get(speaker.identity, [])
        if isinstance(script, BaseException):
            raise script
        lines = iter(script)
        async for _frame in frames:
            if self._delay:
                await asyncio.sleep(self._delay)
            line = next(lines, None)
            if line is None:
                continue
            yield line
        for line in lines:
            yield line


class FakeTTS:
    """Emits one 10 ms silent frame per word, and records what it was asked to say."""

    def __init__(self) -> None:
        self.spoken: list[str] = []

    async def synthesize(self, text: str) -> AsyncIterator[rtc.AudioFrame]:
        self.spoken.append(text)
        for _word in text.split():
            yield rtc.AudioFrame.create(48_000, 1, 480)
            await asyncio.sleep(0)


class FakeBrain:
    """Answers from a fixed reply, recording every question it was asked."""

    def __init__(self, reply: str = "Fake answer.", details: str = "") -> None:
        self.reply = Answer(reply, details)
        self.questions: list[tuple[str, Speaker, str]] = []

    async def answer(self, *, question: str, asker: Speaker, transcript: str) -> Answer:
        self.questions.append((question, asker, transcript))
        return self.reply
