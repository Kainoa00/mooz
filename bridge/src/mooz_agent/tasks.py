"""Background research: the owner asks, the agent says "on it", works, and reports back.

Tasks live only in the bridge (the mooz server keeps nothing). The runner owns the queue,
the time budget and cancelling; the brain does the work (its own turn and tool budgets).
"""

from __future__ import annotations

import asyncio
import logging
import re
import secrets
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Literal

from .providers.base import Answer, BrainError

log = logging.getLogger(__name__)

MAX_RUNNING = 2
MAX_PER_MEETING = 20
TASK_SECONDS = 600.0
MAX_PROGRESS = 5
MAX_TITLE_CHARS = 120
MAX_DETAILS_CHARS = 20_000

TaskState = Literal["queued", "working", "done", "failed", "cancelled"]
ACTIVE: frozenset[str] = frozenset({"queued", "working"})


# -- what people say -------------------------------------------------------------------


@dataclass(frozen=True)
class TaskCommand:
    kind: Literal["start", "status", "cancel"]
    topic: str = ""
    private: bool = False


_POLITE = re.compile(r"^(?:(?:please|can you|could you|would you|will you)\s+)+", re.I)
_START = re.compile(r"^(look into|research|dig into|investigate|find out|figure out)\s+\S", re.I)
_PRIVATE = re.compile(
    r"[,\s]*\b(?:and tell me privately|privately|in private|just for me|only for me)\b", re.I
)
_STATUS = re.compile(
    r"^(?:how(?:'s| is) (?:it|that|the research|the task) going|what are you working on|"
    r"status|any progress|are you done(?: yet)?)$"
)
_CANCEL = re.compile(
    r"^(?:stop that|cancel that|cancel it|never ?mind|forget it|"
    r"(?:stop|cancel) (?:the )?(?:task|research|researching))$"
)


def _normalized(text: str) -> str:
    return " ".join(re.sub(r"[^\w\s']", " ", text.lower()).split())


def task_command(text: str) -> TaskCommand | None:
    """Start, status or cancel, from what the owner said to the agent (or None)."""
    phrase = _normalized(text)
    if _STATUS.match(phrase):
        return TaskCommand("status")
    if _CANCEL.match(phrase):
        return TaskCommand("cancel")
    request = _POLITE.sub("", text.strip())
    if not _START.match(request):
        return None
    private = bool(_PRIVATE.search(request))
    topic = _PRIVATE.sub("", request).strip().rstrip("?.!,;: ").strip()
    topic = topic[:1].upper() + topic[1:]
    return TaskCommand("start", topic[:MAX_TITLE_CHARS].rstrip(), private)


# -- tasks -----------------------------------------------------------------------------


@dataclass
class Task:
    id: str
    title: str
    owner: str  # the owner's participant identity: only they started it, only they may stop it
    private: bool
    created_at: float
    context: str = ""  # what a quick answer had already found, when it overflowed into a task
    transcript: str = ""  # the meeting when it was asked
    sources: frozenset[str] = frozenset()  # whose words that transcript holds (notes opt-outs)
    seq: int = 0  # increases with every update, so the panel can ignore stale ones
    state: TaskState = "queued"
    progress: list[str] = field(default_factory=list)
    result: Answer | None = None
    error: str | None = None
    started_at: float | None = None
    finished_at: float | None = None
    updated_at: float = 0.0

    @property
    def active(self) -> bool:
        return self.state in ACTIVE

    def event(self, *, for_owner: bool) -> dict[str, object]:
        """The task as the panel sees it. Others see a private task's state, nothing more."""
        hidden = self.private and not for_owner
        result = self.result or Answer("")
        return {
            "type": "task",
            "id": self.id,
            "state": self.state,
            "title": "Private task" if hidden else self.title,
            "owner": self.owner,
            "private": self.private,
            "progress": [] if hidden else list(self.progress),
            "summary": "" if hidden else result.spoken,
            "details": "" if hidden else result.details[:MAX_DETAILS_CHARS],
            "error": "" if hidden else (self.error or ""),
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "seq": self.seq,
        }


class TaskRefused(Exception):
    """A task can't start (the meeting's limit); the message is safe to say out loud."""


Progress = Callable[[str], None]
Work = Callable[[Task, Progress], Awaitable[Answer]]


class TaskRunner:
    def __init__(
        self,
        work: Work,
        *,
        on_event: Callable[[Task], None],
        on_finished: Callable[[Task], None],
        max_running: int = MAX_RUNNING,
        max_per_meeting: int = MAX_PER_MEETING,
        time_budget: float = TASK_SECONDS,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._work = work
        self._on_event = on_event
        self._on_finished = on_finished
        self.max_running = max_running
        self.max_per_meeting = max_per_meeting
        self.time_budget = time_budget
        self._clock = clock
        self.tasks: list[Task] = []
        self._queue: list[Task] = []
        self._running: dict[str, asyncio.Task[None]] = {}

    # -- starting and stopping -------------------------------------------------------

    def start(
        self,
        *,
        title: str,
        owner: str,
        private: bool = False,
        context: str = "",
        transcript: str = "",
        sources: frozenset[str] = frozenset(),
    ) -> Task:
        if len(self.tasks) >= self.max_per_meeting:
            raise TaskRefused(
                f"I've already taken on {self.max_per_meeting} tasks in this meeting, "
                "which is my limit."
            )
        now = self._clock()
        task = Task(
            id=f"t_{secrets.token_hex(4)}",
            title=title,
            owner=owner,
            private=private,
            created_at=now,
            context=context,
            transcript=transcript,
            sources=sources,
            updated_at=now,
        )
        self.tasks.append(task)
        self._queue.append(task)
        self._emit(task)
        self._pump()
        return task

    def cancel(self, task_id: str) -> Task | None:
        task = next((t for t in self.tasks if t.id == task_id and t.active), None)
        if task is None:
            return None
        if task in self._queue:
            self._queue.remove(task)
            self._end(task, "cancelled")
        else:
            task.state = "cancelled"  # so the worker knows this cancel was on purpose
            self._running[task.id].cancel()
        return task

    def latest_active(self) -> Task | None:
        return next((t for t in reversed(self.tasks) if t.active), None)

    def active(self) -> list[Task]:
        return [t for t in self.tasks if t.active]

    def progress(self, task: Task, line: str) -> None:
        if not task.active:
            return
        task.progress = [*task.progress, line][-MAX_PROGRESS:]
        self._emit(task)

    # -- running ---------------------------------------------------------------------

    def _pump(self) -> None:
        while self._queue and len(self._running) < self.max_running:
            task = self._queue.pop(0)
            self._running[task.id] = asyncio.ensure_future(self._run(task))

    async def _run(self, task: Task) -> None:
        task.state, task.started_at = "working", self._clock()
        self._emit(task)
        try:
            async with asyncio.timeout(self.time_budget):
                task.result = await self._work(task, lambda line: self.progress(task, line))
            self._end(task, "done")
        except asyncio.CancelledError:
            # Cancelled by the owner (state already says so), or by shutdown.
            self._end(task, "cancelled")
        except TimeoutError:
            minutes = round(self.time_budget / 60)
            self._end(task, "failed", f"I ran out of time ({minutes} minutes) before finishing.")
        except BrainError:
            self._end(task, "failed", "I couldn't finish that one: my AI provider had a problem.")
        except Exception:
            log.exception("task %s failed", task.id)
            self._end(task, "failed", "I couldn't finish that one because something went wrong.")
        finally:
            self._running.pop(task.id, None)
            self._pump()

    def _end(self, task: Task, state: TaskState, error: str | None = None) -> None:
        task.state, task.error, task.finished_at = state, error, self._clock()
        self._emit(task)
        try:
            self._on_finished(task)
        except Exception:
            log.exception("could not report task %s", task.id)

    def _emit(self, task: Task) -> None:
        task.updated_at = self._clock()
        task.seq += 1
        try:
            self._on_event(task)
        except Exception:
            log.exception("could not send an update for task %s", task.id)

    # -- waiting -------------------------------------------------------------------------

    async def idle(self) -> None:
        """Wait until nothing is queued or working (used by tests)."""
        while self._running or self._queue:
            await asyncio.gather(*list(self._running.values()), return_exceptions=True)
            await asyncio.sleep(0)

    async def finish_up(self) -> None:
        """The meeting ended: let working tasks finish (within their budget), drop queued ones."""
        for task in list(self._queue):
            self._queue.remove(task)
            self._end(task, "cancelled", "The meeting ended before I got to it.")
        await asyncio.gather(*list(self._running.values()), return_exceptions=True)

    async def aclose(self) -> None:
        for task in list(self._queue):
            self._queue.remove(task)
            self._end(task, "cancelled")
        for task in [t for t in self.tasks if t.state == "working"]:
            task.state = "cancelled"
        for running in list(self._running.values()):
            running.cancel()
        await asyncio.gather(*list(self._running.values()), return_exceptions=True)


def _minutes(seconds: float) -> str:
    minutes = round(seconds / 60)
    if minutes < 1:
        return "under a minute"
    return f"{minutes} minute{'s' if minutes != 1 else ''}"


def describe_tasks(tasks: list[Task], *, now: float, for_owner: bool = True) -> str:
    """A spoken status report from task state (no model call). Others hear "a private task"."""
    working = [t for t in tasks if t.state == "working"]
    queued = [t for t in tasks if t.state == "queued"]
    if not working and not queued:
        return "I'm not working on anything right now."

    def name(t: Task) -> str:
        return "a private task" if t.private and not for_owner else f"'{t.title}'"

    parts = []
    for t in working:
        started = t.started_at if t.started_at is not None else now
        line = f"I'm on {name(t)}, {_minutes(now - started)} in"
        if t.progress and (for_owner or not t.private):
            line += f"; last step: {t.progress[-1]}"
        parts.append(line + ".")
    if queued:
        names = ", ".join(name(t) for t in queued)
        parts.append(f"{names} {'is' if len(queued) == 1 else 'are'} next.")
    return " ".join(parts)
