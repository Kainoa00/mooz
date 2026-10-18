import json
import stat
from pathlib import Path

import pytest

from mooz_agent.memory import MemoryStore

pytestmark = pytest.mark.unit


@pytest.fixture
def store(tmp_path: Path) -> MemoryStore:
    return MemoryStore(tmp_path / "memory.jsonl")


def test_remembers_and_recalls_across_instances(store: MemoryStore, tmp_path: Path) -> None:
    note = store.remember("The deploy freeze starts Friday", public=False)

    again = MemoryStore(tmp_path / "memory.jsonl")

    assert [n.text for n in again.recall("deploy freeze", owner=True)] == [
        "The deploy freeze starts Friday"
    ]
    assert again.get(note.id) == note


def test_file_is_private_to_the_owner(store: MemoryStore, tmp_path: Path) -> None:
    store.remember("x", public=False)

    assert stat.S_IMODE((tmp_path / "memory.jsonl").stat().st_mode) == 0o600


def test_non_owners_only_ever_see_public_notes(store: MemoryStore) -> None:
    store.remember("Kainoa's salary is private", public=False)
    store.remember("The team standup is at 9am", public=True)

    assert [n.text for n in store.recall("standup salary", owner=False)] == [
        "The team standup is at 9am"
    ]
    assert "salary" not in store.context_block(owner=False)
    assert "salary" in store.context_block(owner=True)


def test_recall_ranks_by_relevance_and_tolerates_typos(store: MemoryStore) -> None:
    store.remember("Lunch order: tacos on Tuesdays", public=False)
    store.remember("The staging database password rotates monthly", public=False)
    store.remember("Deploys go out on Thursdays after 2pm", public=False)

    results = store.recall("when do we deplyo", owner=True)

    assert results[0].text.startswith("Deploys go out")


def test_recall_with_no_match_is_empty(store: MemoryStore) -> None:
    store.remember("Deploys go out on Thursdays", public=False)

    assert store.recall("quantum chromodynamics", owner=True) == []


def test_forget_removes_a_note(store: MemoryStore, tmp_path: Path) -> None:
    note = store.remember("temporary", public=False)

    assert store.forget(note.id) is True
    assert store.forget(note.id) is False
    assert MemoryStore(tmp_path / "memory.jsonl").all(owner=True) == []


def test_context_block_keeps_the_newest_notes_within_budget(store: MemoryStore) -> None:
    for i in range(50):
        store.remember(f"note number {i:02d} " + "x" * 40, public=False)

    block = store.context_block(owner=True, budget_chars=300)

    assert "note number 49" in block
    assert "note number 00" not in block
    assert len(block) <= 300


def test_empty_memory_has_an_empty_context_block(store: MemoryStore) -> None:
    assert store.context_block(owner=True) == ""


def test_corrupt_lines_are_skipped(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    path = tmp_path / "memory.jsonl"
    good = {"id": "m_1", "text": "kept", "public": False, "created_at": 1.0, "tags": []}
    path.write_text("{not json\n" + json.dumps(good) + "\n")

    store = MemoryStore(path)

    assert [n.text for n in store.all(owner=True)] == ["kept"]
    assert "skipping" in caplog.text


def test_notes_can_carry_tags(store: MemoryStore) -> None:
    note = store.remember("Meeting notes: ...", public=False, tags=["meeting-notes"])

    assert note.tags == ["meeting-notes"]


def test_rejects_empty_or_huge_notes(store: MemoryStore) -> None:
    with pytest.raises(ValueError):
        store.remember("   ", public=False)
    with pytest.raises(ValueError):
        store.remember("x" * 20_001, public=False)
