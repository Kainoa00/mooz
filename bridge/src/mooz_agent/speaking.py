"""The agent's mouth: take a turn, post to chat (instant, exact), then speak the short part."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable

from livekit import rtc

from .providers.base import Answer, TextToSpeech
from .room import NUM_CHANNELS, SAMPLE_RATE
from .turns import Answering, NoFloor, TurnTaker

log = logging.getLogger(__name__)

# People first: wait this long for them to stop talking before speaking (the chat is there).
PEOPLE_FIRST_SECONDS = 5.0
# Stop speaking when a person talks over the agent for longer than this.
BARGE_IN_SECONDS = 1.0
POLL_SECONDS = 0.05
# Audio that has left our queue is still being encoded, sent and buffered on its way to people:
# hold the turn this much longer, so the next voice never starts over our last words.
PLAYOUT_TAIL_SECONDS = 0.25


class Mouth:
    def __init__(
        self,
        *,
        send_chat: Callable[[str, str | None, frozenset[str]], Awaitable[None]],
        capture_frame: Callable[[rtc.AudioFrame], Awaitable[None]],
        tts: TextToSpeech,
        turns: TurnTaker | None = None,
        people_talking: Callable[[], bool] = lambda: False,
        queued_audio: Callable[[], float] = lambda: 0.0,
        clear_audio: Callable[[], None] = lambda: None,
        clock: Callable[[], float] = time.monotonic,
        playout_tail: float = 0.0,
    ) -> None:
        self._send_chat = send_chat
        self._capture_frame = capture_frame
        self._tts = tts
        self.turns: TurnTaker = turns or NoFloor()
        self._people_talking = people_talking
        self._queued_audio = queued_audio
        self._clear_audio = clear_audio
        self._clock = clock
        self.people_first_seconds = PEOPLE_FIRST_SECONDS
        self.barge_in_seconds = BARGE_IN_SECONDS
        self.poll_seconds = POLL_SECONDS
        self.playout_tail = playout_tail
        # Our answers of each kind go one at a time (a held reply to an agent doesn't stop an
        # answer to a person), and we never talk over ourselves.
        self._queues: dict[Answering, asyncio.Lock] = {
            "person": asyncio.Lock(),
            "agent": asyncio.Lock(),
        }
        self._voice = asyncio.Lock()

    async def say(
        self,
        answer: Answer,
        on_first_frame: Callable[[], None] | None = None,
        *,
        chat: bool = True,
        reply_to: str | None = None,
        sources: frozenset[str] = frozenset(),
        only_if: Callable[[], bool] | None = None,
        answering: Answering = "person",
        max_wait: float | None = None,
    ) -> bool:
        """In a turn from the meeting's floor, post the answer to chat (unless `chat` is False),
        then speak its spoken part.

        `answering`: whether this answers a person or another agent (replies to agents may be
        held). `max_wait`: how long to wait for the turn (0: only if the floor is free now).
        `only_if` is checked once it's our turn; if it says no, nothing is sent. Returns
        whether the answer went out. Speech waits a little for people to stop talking, and
        stops if a person talks over it or the turn runs out; the chat answer stays.
        """
        speak = bool(answer.spoken.strip())
        started = self._clock()
        queue = self._queues[answering]
        # Our earlier answer of this kind goes first; that wait counts against `max_wait` too.
        if not await _take(queue, max_wait):
            return False
        try:
            left = None if max_wait is None else max(0.0, max_wait - (self._clock() - started))
            return await self._say_in_turn(
                answer, on_first_frame, chat, reply_to, sources, only_if, answering, speak, left
            )
        finally:
            queue.release()

    async def _say_in_turn(
        self,
        answer: Answer,
        on_first_frame: Callable[[], None] | None,
        chat: bool,
        reply_to: str | None,
        sources: frozenset[str],
        only_if: Callable[[], bool] | None,
        answering: Answering,
        speak: bool,
        max_wait: float | None,
    ) -> bool:
        async with self.turns.turn(answering=answering, speak=speak, max_wait=max_wait) as granted:
            if granted is None:
                return False
            async with self._voice:
                if only_if is not None and not only_if():
                    return False
                if chat:
                    text = (
                        answer.spoken
                        if not answer.details
                        else f"{answer.spoken}\n\n{answer.details}"
                    )
                    await self._send_chat(text, reply_to, sources)
                if speak:
                    await self._speak(answer.spoken, granted.deadline, on_first_frame)
        return True

    async def _speak(
        self, text: str, deadline: float | None, on_first_frame: Callable[[], None] | None
    ) -> None:
        if not await self._people_done(deadline):
            log.info("people kept talking, so the answer is only in the chat")
            return
        stop = _Interruptions(self, deadline)
        first = True
        frames = self._tts.synthesize(text)
        resampler: rtc.AudioResampler | None = None

        async def emit(frame: rtc.AudioFrame) -> None:
            nonlocal first
            if first and on_first_frame:
                on_first_frame()
            first = False
            await self._capture_frame(frame)

        try:
            async for frame in frames:
                if stop():
                    break
                if frame.sample_rate != SAMPLE_RATE:
                    resampler = resampler or rtc.AudioResampler(
                        frame.sample_rate, SAMPLE_RATE, num_channels=NUM_CHANNELS
                    )
                    for out in resampler.push(frame):
                        await emit(out)
                else:
                    await emit(frame)
            else:
                if resampler:
                    for out in resampler.flush():
                        await emit(out)
        except Exception:
            # The voice failed partway: what's queued would go on playing after the turn ends,
            # under whoever speaks next.
            self._clear_audio()
            raise
        finally:
            aclose = getattr(frames, "aclose", None)
            if aclose is not None:
                await aclose()
        # What's still queued plays out before the turn ends, unless someone talks over it.
        while not stop.stopped and self._queued_audio() > 0:
            if stop():
                break
            await asyncio.sleep(self.poll_seconds)
        if stop.stopped:
            self._clear_audio()
        elif not first:
            await asyncio.sleep(self.playout_tail)

    async def _people_done(self, deadline: float | None) -> bool:
        give_up = self._clock() + self.people_first_seconds
        if deadline is not None:
            give_up = min(give_up, deadline)
        while self._people_talking():
            if self._clock() >= give_up:
                return False
            await asyncio.sleep(self.poll_seconds)
        return True


class _Interruptions:
    """Whether to stop speaking now: the turn ran out, or a person is talking over us."""

    def __init__(self, mouth: Mouth, deadline: float | None) -> None:
        self._mouth = mouth
        self._deadline = deadline
        self._talking_since: float | None = None
        self.stopped = False

    def __call__(self) -> bool:
        if self.stopped:
            return True
        now = self._mouth._clock()
        if self._deadline is not None and now >= self._deadline:
            log.info("the turn ran out mid-answer")
            self.stopped = True
        elif self._mouth._people_talking():
            if self._talking_since is None:
                self._talking_since = now
            elif now - self._talking_since > self._mouth.barge_in_seconds:
                log.info("someone started talking, so the agent stopped")
                self.stopped = True
        else:
            self._talking_since = None
        return self.stopped


async def _take(lock: asyncio.Lock, at_most: float | None) -> bool:
    """Take `lock`, waiting at most `at_most` seconds (None: as long as it takes). A free lock is
    taken at once even with no time to wait; one just handed to a queued waiter isn't free."""
    if at_most is None:
        await lock.acquire()
        return True
    try:
        async with asyncio.timeout(at_most):
            await lock.acquire()
    except TimeoutError:
        return False
    return True
