"""The agent's long-term memory: short notes on the owner's machine, private unless public."""

from __future__ import annotations

import json
import logging
import os
import re
import secrets
import tempfile
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from pathlib import Path

try:
    import fcntl
except ImportError:  # Windows: no cross-process lock; one writer at a time is up to you
    fcntl = None  # type: ignore[assignment]

from rapidfuzz import fuzz

log = logging.getLogger(__name__)

MAX_NOTE_CHARS = 20_000
# Notes an agent saved from meetings (as opposed to facts its owner told it).
MEETING_NOTES_TAG = "meeting-notes"
# Results of background research tasks the owner asked for.
TASK_RESULT_TAG = "task-result"
_WORD = re.compile(r"[A-Za-z0-9']+")
_STOP = frozenset(
    "the and for are was were what when where who why how does did can could would should "
    "you your our we us they them this that with from have has had about into just tell me "
    "any there their remember recall know".split()
)
WORD_MATCH = 75


@dataclass(frozen=True)
class Note:
    id: str
    text: str
    public: bool
    created_at: float
    tags: list[str] = field(default_factory=list)


def _words(text: str) -> list[str]:
    return [w.lower() for w in _WORD.findall(text)]


class MemoryStore:
    """Notes in a JSONL file that a running agent and the CLI can both change safely.

    Every read picks up changes made by another process, and every write happens under a
    file lock on the latest contents, so neither side can undo the other's changes.
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()  # tool calls run in worker threads
        self._stamp: tuple[int, int, int] | None = None
        self._notes: list[Note] = []
        self._refresh()

    def _current_stamp(self) -> tuple[int, int, int] | None:
        try:
            st = self.path.stat()
        except FileNotFoundError:
            return None
        return (st.st_mtime_ns, st.st_size, st.st_ino)

    def _refresh(self) -> None:
        """Reload if the file changed since we last read or wrote it."""
        stamp = self._current_stamp()
        if stamp != self._stamp:
            self._notes = self._load()
            self._stamp = stamp

    @contextmanager
    def _writing(self) -> Iterator[None]:
        """Hold the thread and file locks, with the latest notes loaded."""
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with self._lock:
            fd = os.open(self.path.with_suffix(".lock"), os.O_RDWR | os.O_CREAT, 0o600)
            try:
                if fcntl is not None:
                    fcntl.flock(fd, fcntl.LOCK_EX)
                self._notes = self._load()
                yield
            finally:
                os.close(fd)  # closing releases the lock

    def _load(self) -> list[Note]:
        if not self.path.exists():
            return []
        notes = []
        for number, line in enumerate(self.path.read_text().splitlines(), 1):
            if not line.strip():
                continue
            try:
                data = json.loads(line)
                notes.append(
                    Note(
                        id=str(data["id"]),
                        text=str(data["text"]),
                        public=bool(data.get("public", False)),
                        created_at=float(data.get("created_at", 0)),
                        tags=[str(t) for t in data.get("tags", [])],
                    )
                )
            except (ValueError, KeyError, TypeError):
                log.warning("skipping unreadable memory line %d in %s", number, self.path.name)
        return notes

    def _save(self) -> None:
        # A unique temp file (mkstemp creates it 0600), renamed over the real one atomically.
        fd, tmp = tempfile.mkstemp(dir=self.path.parent, prefix=".memory-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as f:
                for note in self._notes:
                    f.write(json.dumps(asdict(note)) + "\n")
            os.replace(tmp, self.path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise
        self._stamp = self._current_stamp()

    def all(self, *, owner: bool) -> list[Note]:
        with self._lock:
            self._refresh()
            notes = list(self._notes)
        return [n for n in notes if owner or n.public]

    def get(self, note_id: str) -> Note | None:
        return next((n for n in self.all(owner=True) if n.id == note_id), None)

    def remember(self, text: str, *, public: bool, tags: list[str] | None = None) -> Note:
        text = text.strip()
        if not text:
            raise ValueError("Nothing to remember")
        if len(text) > MAX_NOTE_CHARS:
            raise ValueError("That note is too long to remember")
        note = Note(
            id=f"m_{secrets.token_hex(4)}",
            text=text,
            public=public,
            created_at=time.time(),
            tags=list(tags or []),
        )
        with self._writing():
            self._notes.append(note)
            self._save()
        return note

    def forget(self, note_id: str) -> bool:
        with self._writing():
            before = len(self._notes)
            self._notes = [n for n in self._notes if n.id != note_id]
            if len(self._notes) == before:
                return False
            self._save()
        return True

    def recall(self, query: str, *, owner: bool, limit: int = 8) -> list[Note]:
        wanted = [w for w in _words(query) if len(w) >= 3 and w not in _STOP]
        if not wanted:
            return []
        scored = []
        for note in self.all(owner=owner):
            words = set(_words(note.text))
            score = sum(1 for q in wanted if any(fuzz.ratio(q, w) >= WORD_MATCH for w in words))
            if score:
                scored.append((score, note.created_at, note))
        scored.sort(key=lambda s: (s[0], s[1]), reverse=True)
        return [note for _, _, note in scored[:limit]]

    def context_block(
        self, *, owner: bool, budget_chars: int = 6000, exclude_tags: tuple[str, ...] = ()
    ) -> str:
        """The newest in-scope notes that fit the budget, oldest first.

        A note too big for what's left is skipped, so one long note can't crowd out the rest.
        """
        lines: list[str] = []
        size = 0
        for note in reversed(self.all(owner=owner)):
            if any(tag in note.tags for tag in exclude_tags):
                continue
            line = f"- [{note.id}] {note.text}"
            if size + len(line) + 1 > budget_chars:
                continue
            lines.append(line)
            size += len(line) + 1
        return "\n".join(reversed(lines))
