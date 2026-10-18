from pathlib import Path

import pytest

from mooz_agent.memory import MemoryStore
from mooz_agent.notes import (
    MAX_LINE_CHARS,
    MAX_LOG_CHARS,
    MAX_LOG_CHARS_HARD,
    NOTES_TAG,
    RETRY_SECONDS,
    NotesKeeper,
    notes_command,
)
from mooz_agent.room import Speaker
from mooz_agent.transcript import Utterance

pytestmark = pytest.mark.unit

KAI = Speaker("p_k", "Kainoa", "human")
ZACH = Speaker("p_z", "Zach", "human")
GROK = Speaker("a_g", "Grok", "agent", owner_identity="p_z", owner_name="Zach")


class Summarizer:
    def __init__(self) -> None:
        self.transcripts: list[str] = []

    async def summarize(self, *, transcript: str) -> str:
        self.transcripts.append(transcript)
        return "- " + transcript.replace("\n", "\n- ")


def said(speaker: Speaker, text: str) -> Utterance:
    return Utterance(speaker, text, 1_760_000_000.0, "voice")


def fill(keeper: NotesKeeper) -> bool:
    """Talk until the log asks to be summarized early; True if it did."""
    for _ in range(MAX_LOG_CHARS // MAX_LINE_CHARS + 1):
        if keeper.hear(said(KAI, "x" * MAX_LINE_CHARS)):
            return True
    return False


@pytest.fixture
def setup(tmp_path: Path) -> tuple[NotesKeeper, Summarizer, MemoryStore, set[str]]:
    summarizer, memory, opted_out = Summarizer(), MemoryStore(tmp_path / "m.jsonl"), set[str]()
    keeper = NotesKeeper(summarizer=summarizer, memory=memory, opted_out=opted_out.__contains__)
    return keeper, summarizer, memory, opted_out


async def test_keeps_nothing_until_started(setup) -> None:  # type: ignore[no-untyped-def]
    keeper, summarizer, memory, _ = setup
    keeper.hear(said(KAI, "the budget is ten thousand"))
    assert await keeper.flush() is None
    assert summarizer.transcripts == [] and memory.all(owner=True) == []


async def test_saves_a_private_tagged_summary(setup) -> None:  # type: ignore[no-untyped-def]
    keeper, summarizer, memory, _ = setup
    keeper.start()
    keeper.hear(said(KAI, "we ship on Friday"))
    keeper.hear(said(ZACH, "I'll write the release notes"))

    note = await keeper.flush()

    assert note is not None
    assert summarizer.transcripts == [
        "Kainoa: we ship on Friday\nZach: I'll write the release notes"
    ]
    [saved] = memory.all(owner=True)
    assert saved == note and not saved.public and saved.tags == [NOTES_TAG]
    assert saved.text.startswith("Meeting notes") and "we ship on Friday" in saved.text
    assert memory.all(owner=False) == []


async def test_opted_out_people_never_reach_the_summary(setup) -> None:  # type: ignore[no-untyped-def]
    keeper, summarizer, _, opted_out = setup
    keeper.start()
    keeper.hear(said(ZACH, "my salary is 90k"))  # before opting out
    opted_out.add(ZACH.identity)
    keeper.hear(said(ZACH, "and my address is 1 Main St"))
    keeper.hear(said(GROK, "Zach asked me to note his salary"))  # their agent counts as them
    keeper.hear(said(KAI, "thanks everyone"))

    await keeper.flush()

    assert summarizer.transcripts == ["Kainoa: thanks everyone"]


async def test_stop_saves_and_stops(setup) -> None:  # type: ignore[no-untyped-def]
    keeper, summarizer, memory, _ = setup
    keeper.start()
    keeper.hear(said(KAI, "decision: blue logo"))
    await keeper.stop()
    keeper.hear(said(KAI, "this is after notes stopped"))
    assert not keeper.active
    assert await keeper.flush() is None
    assert len(memory.all(owner=True)) == 1 and len(summarizer.transcripts) == 1


async def test_nothing_said_means_nothing_saved(setup) -> None:  # type: ignore[no-untyped-def]
    keeper, summarizer, memory, opted_out = setup
    keeper.start()
    opted_out.add(ZACH.identity)
    keeper.hear(said(ZACH, "off the record"))
    assert await keeper.flush() is None
    assert summarizer.transcripts == [] and memory.all(owner=True) == []


async def test_reports_when_the_log_is_full(setup) -> None:  # type: ignore[no-untyped-def]
    keeper, _, _, _ = setup
    keeper.start()
    assert keeper.hear(said(KAI, "short")) is False
    assert fill(keeper) is True


@pytest.mark.parametrize(
    ("text", "command"),
    [
        ("keep notes", "on"),
        ("Keep notes, please.", "on"),
        ("can you take notes?", "on"),
        ("start taking meeting notes", "on"),
        ("stop keeping notes", "off"),
        ("Stop taking notes.", "off"),
        ("what are notes for?", None),
        ("keep notes of the budget", None),
    ],
)
def test_recognizes_notes_commands(text: str, command: str | None) -> None:
    assert notes_command(text) == command


class FailingSummarizer:
    def __init__(self) -> None:
        self.calls = 0

    async def summarize(self, *, transcript: str) -> str:
        self.calls += 1
        raise RuntimeError("provider down")


class Clock:
    def __init__(self) -> None:
        self.now = 1_760_000_000.0

    def __call__(self) -> float:
        return self.now


async def test_lines_answering_an_opted_out_person_are_left_out(setup) -> None:  # type: ignore[no-untyped-def]
    keeper, summarizer, _, opted_out = setup
    atlas = Speaker("a_me", "Atlas", "agent", owner_identity="p_k", owner_name="Kainoa")
    keeper.start()
    opted_out.add(ZACH.identity)
    keeper.hear(
        Utterance(atlas, "You asked: my hearing is Friday", 1.0, "chat", about=ZACH.identity)
    )
    keeper.hear(Utterance(GROK, "Zach told me about Friday", 1.0, "chat", about=KAI.identity))
    keeper.hear(Utterance(atlas, "Good morning", 1.0, "chat", about=KAI.identity))
    await keeper.flush()
    assert summarizer.transcripts == ["Atlas (agent): Good morning"]


async def test_people_are_only_kept_once_they_have_been_told(tmp_path: Path) -> None:
    told: set[str] = {KAI.identity}
    summarizer = Summarizer()
    keeper = NotesKeeper(
        summarizer=summarizer,
        memory=MemoryStore(tmp_path / "m.jsonl"),
        opted_out=lambda _: False,
        admitted=told.__contains__,
    )
    keeper.start()
    keeper.hear(said(ZACH, "I just joined"))
    told.add(ZACH.identity)
    keeper.hear(said(ZACH, "now I know"))
    keeper.hear(said(KAI, "welcome"))
    await keeper.flush()
    assert summarizer.transcripts == ["Zach: now I know\nKainoa: welcome"]


async def test_a_failing_summary_is_retried_once_in_a_while_not_on_every_line(
    tmp_path: Path,
) -> None:
    clock, summarizer = Clock(), FailingSummarizer()
    keeper = NotesKeeper(
        summarizer=summarizer,
        memory=MemoryStore(tmp_path / "m.jsonl"),
        opted_out=lambda _: False,
        clock=clock,
    )
    keeper.start()
    assert fill(keeper) is True
    assert keeper.hear(said(KAI, "more")) is False  # a flush is already on its way
    with pytest.raises(RuntimeError):
        await keeper.flush()
    assert keeper.unsaved
    assert keeper.hear(said(KAI, "still failing")) is False  # backing off
    clock.now += RETRY_SECONDS + 1
    assert keeper.hear(said(KAI, "try again")) is True
    assert summarizer.calls == 1


def test_long_lines_and_a_stuck_log_are_capped(setup) -> None:  # type: ignore[no-untyped-def]
    keeper, _, _, _ = setup
    keeper.start()
    keeper.hear(said(KAI, "y" * (MAX_LINE_CHARS * 3)))
    assert keeper.size <= MAX_LINE_CHARS + 2
    for _ in range(MAX_LOG_CHARS_HARD // MAX_LINE_CHARS + 10):
        keeper.hear(said(KAI, "z" * MAX_LINE_CHARS))
    assert keeper.size <= MAX_LOG_CHARS_HARD
