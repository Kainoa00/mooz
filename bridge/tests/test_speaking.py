import asyncio
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import pytest
from livekit import rtc

from mooz_agent.providers.base import Answer
from mooz_agent.providers.fakes import FakeTTS
from mooz_agent.speaking import Mouth, _take
from mooz_agent.turns import Answering, Granted

pytestmark = pytest.mark.unit


class Recorder:
    def __init__(self) -> None:
        self.events: list[str] = []

    async def send_chat(
        self, text: str, reply_to: str | None = None, sources: frozenset[str] = frozenset()
    ) -> None:
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


async def test_it_can_give_up_its_turn_once_it_has_the_floor() -> None:
    rec = Recorder()
    tts = FakeTTS()
    mouth = Mouth(send_chat=rec.send_chat, capture_frame=rec.capture_frame, tts=tts)

    assert await mouth.say(Answer("Not now."), only_if=lambda: False) is False
    assert rec.events == [] and tts.spoken == []
    assert await mouth.say(Answer("Now."), only_if=lambda: True) is True


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

    async def chat(
        _: str, reply_to: str | None = None, sources: frozenset[str] = frozenset()
    ) -> None:
        return None

    await Mouth(send_chat=chat, capture_frame=capture, tts=Tts24k()).say(Answer("hi", ""))

    assert frames and all(f.sample_rate == 48_000 for f in frames)


# -- taking turns, people first ----------------------------------------------------------


GO = Granted()


class FakeTurns:
    def __init__(self, rec: Recorder, grant: Granted | None = GO) -> None:
        self.rec = rec
        self.grant = grant
        self.calls: list[tuple[str, bool, float | None]] = []
        self.gates: dict[str, asyncio.Event] = {}

    @asynccontextmanager
    async def turn(
        self, *, answering: Answering, speak: bool, max_wait: float | None = None
    ) -> AsyncIterator[Granted | None]:
        self.calls.append((answering, speak, max_wait))
        if answering in self.gates:
            await self.gates[answering].wait()
        self.rec.events.append(f"turn:{answering}")
        try:
            yield self.grant
        finally:
            self.rec.events.append("released")


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def mouth_with(rec: Recorder, turns: FakeTurns, **kw: object) -> Mouth:
    mouth = Mouth(
        send_chat=rec.send_chat, capture_frame=rec.capture_frame, tts=FakeTTS(), turns=turns, **kw
    )  # type: ignore[arg-type]
    mouth.poll_seconds = 0.001
    return mouth


async def test_takes_a_turn_before_posting_and_gives_it_back_after_speaking() -> None:
    rec = Recorder()
    turns = FakeTurns(rec)
    assert await mouth_with(rec, turns).say(Answer("Hi there."), answering="agent", max_wait=0)
    assert rec.events == ["turn:agent", "chat:Hi there.", "audio", "audio", "released"]
    assert turns.calls == [("agent", True, 0)]


async def test_says_nothing_without_a_turn() -> None:
    rec = Recorder()
    assert await mouth_with(rec, FakeTurns(rec, grant=None)).say(Answer("Hi.")) is False
    assert rec.events == ["turn:person", "released"]


async def test_a_held_reply_to_an_agent_does_not_hold_up_an_answer_to_a_person() -> None:
    rec = Recorder()
    turns = FakeTurns(rec)
    turns.gates["agent"] = asyncio.Event()
    mouth = mouth_with(rec, turns)
    reply = asyncio.ensure_future(mouth.say(Answer("to the agent"), answering="agent"))
    await asyncio.sleep(0)
    assert await mouth.say(Answer("to the person"))
    assert "chat:to the person" in rec.events and "chat:to the agent" not in rec.events
    turns.gates["agent"].set()
    assert await reply


async def test_waits_for_people_to_finish_before_speaking() -> None:
    rec = Recorder()
    talking = [True, True, True]
    mouth = mouth_with(rec, FakeTurns(rec), people_talking=lambda: bool(talking and talking.pop()))
    await mouth.say(Answer("Go ahead."))
    assert rec.events == ["turn:person", "chat:Go ahead.", "audio", "audio", "released"]


async def test_leaves_the_answer_in_chat_when_people_keep_talking() -> None:
    rec = Recorder()
    clock = Clock()

    def talking() -> bool:
        clock.now += 1
        return True

    mouth = mouth_with(rec, FakeTurns(rec), people_talking=talking, clock=clock)
    assert await mouth.say(Answer("Later then."))
    assert rec.events == ["turn:person", "chat:Later then.", "released"]


async def test_stops_when_a_person_talks_over_it_and_drops_what_is_queued() -> None:
    rec = Recorder()
    clock = Clock()
    cleared: list[bool] = []
    frames = 0

    async def capture(frame: rtc.AudioFrame) -> None:
        nonlocal frames
        frames += 1
        clock.now += 0.4  # each frame plays for a while

    mouth = Mouth(
        send_chat=rec.send_chat,
        capture_frame=capture,
        tts=FakeTTS(),
        turns=FakeTurns(rec),
        people_talking=lambda: frames >= 2,
        clear_audio=lambda: cleared.append(True),
        clock=clock,
    )
    await mouth.say(Answer("one two three four five six seven eight"))
    assert 2 <= frames < 8
    assert cleared == [True]
    assert rec.events[:2] == ["turn:person", "chat:one two three four five six seven eight"]


async def test_a_short_noise_does_not_stop_it() -> None:
    rec = Recorder()
    clock = Clock()
    frames = 0

    async def capture(frame: rtc.AudioFrame) -> None:
        nonlocal frames
        frames += 1
        clock.now += 0.4

    mouth = Mouth(
        send_chat=rec.send_chat,
        capture_frame=capture,
        tts=FakeTTS(),
        turns=FakeTurns(rec),
        people_talking=lambda: frames in (2, 3),  # under a second
        clock=clock,
    )
    await mouth.say(Answer("one two three four five six"))
    assert frames == 6


async def test_stops_when_its_turn_runs_out() -> None:
    rec = Recorder()
    clock = Clock()
    frames = 0

    async def capture(frame: rtc.AudioFrame) -> None:
        nonlocal frames
        frames += 1
        clock.now += 1

    mouth = Mouth(
        send_chat=rec.send_chat,
        capture_frame=capture,
        tts=FakeTTS(),
        turns=FakeTurns(rec, grant=Granted(deadline=3)),
        clock=clock,
    )
    await mouth.say(Answer("one two three four five six"))
    assert frames == 3


async def test_stops_at_the_end_of_its_turn_while_the_voice_is_still_making_a_sentence() -> None:
    rec = Recorder()
    frames = 0

    class Stuck:
        async def synthesize(self, text: str):  # type: ignore[no-untyped-def]
            yield rtc.AudioFrame(b"\0\0" * 480, 48_000, 1, 480)
            await asyncio.Event().wait()  # the next sentence never comes
            yield rtc.AudioFrame(b"\0\0" * 480, 48_000, 1, 480)

    async def capture(frame: rtc.AudioFrame) -> None:
        nonlocal frames
        frames += 1

    mouth = Mouth(
        send_chat=rec.send_chat,
        capture_frame=capture,
        tts=Stuck(),
        turns=FakeTurns(rec, grant=Granted(deadline=time.monotonic() + 0.1)),
    )
    await asyncio.wait_for(mouth.say(Answer("First sentence here. Then a stuck one.")), 2)
    assert frames == 1
    assert rec.events[-1] == "released"


async def test_lets_its_last_words_play_out_and_arrive_before_giving_the_turn_back() -> None:
    rec = Recorder()
    queued = [0.5, 0.3, 0.1]
    mouth = mouth_with(
        rec,
        FakeTurns(rec),
        queued_audio=lambda: queued.pop(0) if queued else 0.0,
        playout_tail=0.05,
    )
    started = asyncio.get_running_loop().time()
    await mouth.say(Answer("Bye."))
    assert queued == [] and rec.events[-1] == "released"
    assert asyncio.get_running_loop().time() - started >= 0.05


async def test_the_wait_behind_its_own_earlier_answer_counts_against_max_wait() -> None:
    rec = Recorder()
    floor = FakeTurns(rec)
    floor.gates["person"] = asyncio.Event()  # the earlier answer to a person waits for the floor
    mouth = mouth_with(rec, floor)
    first = asyncio.create_task(mouth.say(Answer("The earlier answer.")))
    await asyncio.sleep(0.01)

    started = asyncio.get_running_loop().time()
    went_out = await mouth.say(Answer("Yes?"), max_wait=0.1)
    assert went_out is False
    assert asyncio.get_running_loop().time() - started < 1
    assert "chat:Yes?" not in rec.events
    assert [kind for kind, _, _ in floor.calls] == ["person"]  # "Yes?" never asked for a turn
    first.cancel()


async def test_stops_queued_audio_when_the_voice_fails_partway() -> None:
    rec = Recorder()
    cleared: list[bool] = []

    class Breaks:
        async def synthesize(self, text: str) -> AsyncIterator[rtc.AudioFrame]:
            yield rtc.AudioFrame.create(48_000, 1, 480)
            raise RuntimeError("the connection dropped")

    mouth = Mouth(
        send_chat=rec.send_chat,
        capture_frame=rec.capture_frame,
        tts=Breaks(),  # type: ignore[arg-type]
        clear_audio=lambda: cleared.append(True),
    )
    with pytest.raises(RuntimeError):
        await mouth.say(Answer("This goes wrong halfway."))
    assert cleared == [True]


async def test_a_short_wait_doesnt_queue_behind_an_answer_the_lock_was_just_handed_to() -> None:
    lock = asyncio.Lock()
    await lock.acquire()
    queued = asyncio.ensure_future(lock.acquire())  # the next answer, waiting its turn
    await asyncio.sleep(0)
    lock.release()  # handed to it, but it hasn't run yet: the lock looks free
    assert not await asyncio.wait_for(_take(lock, 0.05), 1)
    await queued
    lock.release()


async def test_a_free_lock_is_taken_even_with_no_time_to_wait() -> None:
    lock = asyncio.Lock()
    assert await _take(lock, 0)
    assert not await _take(lock, 0)
    lock.release()
    assert await _take(lock, None)
