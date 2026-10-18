from pathlib import Path

import pytest

from mooz_agent.memory import MemoryStore
from mooz_agent.notes import MAX_LOG_CHARS, NOTES_TAG, NotesKeeper, notes_command
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
    assert keeper.hear(said(KAI, "x" * MAX_LOG_CHARS)) is True


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
