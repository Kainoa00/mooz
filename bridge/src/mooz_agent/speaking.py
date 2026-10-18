"""The agent's mouth: chat first (instant, exact), then the spoken part as audio."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

from livekit import rtc

from .providers.base import Answer, TextToSpeech
from .room import NUM_CHANNELS, SAMPLE_RATE


class Mouth:
    def __init__(
        self,
        *,
        send_chat: Callable[[str], Awaitable[None]],
        capture_frame: Callable[[rtc.AudioFrame], Awaitable[None]],
        tts: TextToSpeech,
    ) -> None:
        self._send_chat = send_chat
        self._capture_frame = capture_frame
        self._tts = tts
        self._floor = asyncio.Lock()  # never talk over ourselves

    async def say(
        self,
        answer: Answer,
        on_first_frame: Callable[[], None] | None = None,
        *,
        chat: bool = True,
    ) -> None:
        """Post the answer to chat (unless `chat` is False), then speak its spoken part."""
        async with self._floor:
            first = True

            async def emit(frame: rtc.AudioFrame) -> None:
                nonlocal first
                if first and on_first_frame:
                    on_first_frame()
                first = False
                await self._capture_frame(frame)

            if chat:
                text = (
                    answer.spoken if not answer.details else f"{answer.spoken}\n\n{answer.details}"
                )
                await self._send_chat(text)
            resampler: rtc.AudioResampler | None = None
            async for frame in self._tts.synthesize(answer.spoken):
                if frame.sample_rate != SAMPLE_RATE:
                    resampler = resampler or rtc.AudioResampler(
                        frame.sample_rate, SAMPLE_RATE, num_channels=NUM_CHANNELS
                    )
                    for out in resampler.push(frame):
                        await emit(out)
                else:
                    await emit(frame)
            if resampler:
                for out in resampler.flush():
                    await emit(out)
