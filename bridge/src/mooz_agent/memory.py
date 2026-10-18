"""The agent's long-term memory: short notes on the owner's machine, private unless public."""

from __future__ import annotations

import json
import logging
import os
import re
import secrets
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

from rapidfuzz import fuzz

log = logging.getLogger(__name__)

MAX_NOTE_CHARS = 20_000
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
    def __init__(self, path: Path) -> None:
        self.path = path
        self._notes: list[Note] = self._load()

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
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            for note in self._notes:
                f.write(json.dumps(asdict(note)) + "\n")
        os.chmod(tmp, 0o600)
        tmp.replace(self.path)

    def all(self, *, owner: bool) -> list[Note]:
        return [n for n in self._notes if owner or n.public]

    def get(self, note_id: str) -> Note | None:
        return next((n for n in self._notes if n.id == note_id), None)

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
        self._notes.append(note)
        self._save()
        return note

    def forget(self, note_id: str) -> bool:
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

    def context_block(self, *, owner: bool, budget_chars: int = 6000) -> str:
        """The newest in-scope notes that fit the budget, oldest first."""
        lines: list[str] = []
        size = 0
        for note in reversed(self.all(owner=owner)):
            line = f"- [{note.id}] {note.text}"
            if size + len(line) + 1 > budget_chars:
                break
            lines.append(line)
            size += len(line) + 1
        return "\n".join(reversed(lines))
