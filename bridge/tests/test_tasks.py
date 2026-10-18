import asyncio

import pytest

from mooz_agent.providers.base import Answer, BrainError
from mooz_agent.tasks import (
    MAX_PROGRESS,
    Task,
    TaskCommand,
    TaskRefused,
    TaskRunner,
    describe_tasks,
    task_command,
)

pytestmark = pytest.mark.unit


@pytest.mark.parametrize(
    ("text", "command"),
    [
        (
            "look into why CI is failing on main",
            TaskCommand("start", "Look into why CI is failing on main"),
        ),
        ("Can you research the launch plan?", TaskCommand("start", "Research the launch plan")),
        ("please dig into the flaky tests", TaskCommand("start", "Dig into the flaky tests")),
        (
            "investigate the memory leak privately",
            TaskCommand("start", "Investigate the memory leak", private=True),
        ),
        (
            "find out who owns billing, just for me",
            TaskCommand("start", "Find out who owns billing", private=True),
        ),
        ("figure out the deploy steps", TaskCommand("start", "Figure out the deploy steps")),
        ("research", None),
        ("how's it going?", TaskCommand("status")),
        ("what are you working on", TaskCommand("status")),
        ("Any progress?", TaskCommand("status")),
        ("stop that", TaskCommand("cancel")),
        ("cancel the research", TaskCommand("cancel")),
        ("never mind", TaskCommand("cancel")),
        ("what is 2+2", None),
        ("keep notes", None),
        ("forget m_1234abcd", None),
    ],
)
def test_recognizes_task_commands(text: str, command: TaskCommand | None) -> None:
    assert task_command(text) == command


def test_titles_are_short() -> None:
    command = task_command("look into " + "the very long thing " * 30)
    assert command is not None and len(command.topic) <= 120


class Work:
    """Scripted research: each task waits for its own event, then answers or fails."""

    def __init__(self) -> None:
        self.release: dict[str, asyncio.Event] = {}
        self.started: list[str] = []
        self.fail: set[str] = set()

    async def __call__(self, task: Task, progress) -> Answer:  # type: ignore[no-untyped-def]
        self.started.append(task.title)
        progress(f"Reading notes for {task.title}")
        event = self.release.setdefault(task.title, asyncio.Event())
        await event.wait()
        if task.title in self.fail:
            raise BrainError("model unavailable")
        return Answer(f"Found it: {task.title}", details=f"details for {task.title}")

    def finish(self, title: str) -> None:
        self.release.setdefault(title, asyncio.Event()).set()


def make(**kw: object) -> tuple[TaskRunner, Work, list[tuple[str, str]], list[Task]]:
    work = Work()
    events: list[tuple[str, str]] = []
    finished: list[Task] = []
    runner = TaskRunner(
        work,
        on_event=lambda t: events.append((t.title, t.state)),
        on_finished=finished.append,
        **kw,  # type: ignore[arg-type]
    )
    return runner, work, events, finished


async def settle() -> None:
    for _ in range(5):
        await asyncio.sleep(0)


async def test_a_task_runs_to_done_with_progress() -> None:
    runner, work, events, finished = make()
    task = runner.start(title="Look into CI", owner="p_k")
    await settle()
    assert task.state == "working" and task.progress == ["Reading notes for Look into CI"]

    work.finish("Look into CI")
    await runner.idle()

    assert task.state == "done" and task.result == Answer(
        "Found it: Look into CI", "details for Look into CI"
    )
    assert finished == [task]
    assert events[0] == ("Look into CI", "queued") and events[-1] == ("Look into CI", "done")


async def test_at_most_two_run_at_once_and_the_rest_wait() -> None:
    runner, work, _, _ = make()
    a = runner.start(title="A", owner="p_k")
    b = runner.start(title="B", owner="p_k")
    c = runner.start(title="C", owner="p_k")
    await settle()
    assert (a.state, b.state, c.state) == ("working", "working", "queued")

    work.finish("A")
    await settle()
    assert c.state == "working" and work.started == ["A", "B", "C"]
    work.finish("B")
    work.finish("C")
    await runner.idle()


async def test_a_meeting_has_a_task_limit() -> None:
    runner, work, _, _ = make(max_per_meeting=2)
    runner.start(title="A", owner="p_k")
    runner.start(title="B", owner="p_k")
    with pytest.raises(TaskRefused, match="2 tasks"):
        runner.start(title="C", owner="p_k")
    work.finish("A")
    work.finish("B")
    await runner.idle()


async def test_running_out_of_time_or_failing_is_reported_plainly() -> None:
    runner, work, _, finished = make(time_budget=0.05)
    slow = runner.start(title="Slow", owner="p_k")
    work.fail.add("Broken")
    broken = runner.start(title="Broken", owner="p_k")
    work.finish("Broken")
    await runner.idle()

    assert slow.state == "failed" and slow.error is not None and "out of time" in slow.error
    assert (
        broken.state == "failed" and broken.error is not None and "couldn't finish" in broken.error
    )
    assert {t.title for t in finished} == {"Slow", "Broken"}


async def test_cancelling_a_working_or_queued_task() -> None:
    runner, work, _, finished = make(max_running=1)
    working = runner.start(title="A", owner="p_k")
    queued = runner.start(title="B", owner="p_k")
    await settle()

    assert runner.cancel(queued.id) is queued
    assert runner.cancel(working.id) is working
    await runner.idle()

    assert working.state == "cancelled" and queued.state == "cancelled"
    assert work.started == ["A"]
    assert runner.cancel("t_unknown") is None
    assert {t.title for t in finished} == {"A", "B"}


async def test_latest_active_task_and_progress_is_capped() -> None:
    runner, work, _, _ = make()
    first = runner.start(title="A", owner="p_k")
    second = runner.start(title="B", owner="p_k")
    await settle()
    assert runner.latest_active() is second
    for i in range(MAX_PROGRESS + 3):
        runner.progress(first, f"step {i}")
    assert len(first.progress) == MAX_PROGRESS and first.progress[-1] == f"step {MAX_PROGRESS + 2}"
    work.finish("A")
    work.finish("B")
    await runner.idle()
    assert runner.latest_active() is None


async def test_shutdown_finishes_working_tasks_and_drops_queued_ones() -> None:
    runner, work, _, _ = make(max_running=1)
    working = runner.start(title="A", owner="p_k")
    queued = runner.start(title="B", owner="p_k")
    await settle()

    async def finish_soon() -> None:
        await asyncio.sleep(0.02)
        work.finish("A")

    finisher = asyncio.ensure_future(finish_soon())
    await runner.finish_up()
    await finisher

    assert working.state == "done" and queued.state == "cancelled"


async def test_aclose_cancels_everything() -> None:
    runner, _, _, _ = make()
    task = runner.start(title="A", owner="p_k")
    await settle()
    await runner.aclose()
    assert task.state == "cancelled"


def test_events_hide_private_tasks_from_everyone_but_the_owner() -> None:
    task = Task(id="t_1", title="Investigate the leak", owner="p_k", private=True, created_at=1.0)
    task.state = "done"
    task.result = Answer("It's the cache.", details="cache.py line 40")
    task.progress = ["Reading cache.py in app"]

    mine = task.event(for_owner=True)
    theirs = task.event(for_owner=False)

    assert mine["title"] == "Investigate the leak" and mine["summary"] == "It's the cache."
    assert theirs == {
        "type": "task",
        "id": "t_1",
        "state": "done",
        "title": "Private task",
        "owner": "p_k",
        "private": True,
        "progress": [],
        "summary": "",
        "details": "",
        "error": "",
        "created_at": 1.0,
        "updated_at": theirs["updated_at"],
    }


def test_describe_tasks_for_a_status_question() -> None:
    working = Task(id="t_1", title="Look into CI", owner="p_k", private=False, created_at=0.0)
    working.state, working.started_at, working.progress = "working", 0.0, ["Checking CI on main"]
    queued = Task(id="t_2", title="Research pricing", owner="p_k", private=False, created_at=1.0)

    assert describe_tasks([], now=0.0) == "I'm not working on anything right now."
    text = describe_tasks([working, queued], now=150.0)
    assert "Look into CI" in text and "2 minutes" in text and "Checking CI on main" in text
    assert "Research pricing" in text and "next" in text
