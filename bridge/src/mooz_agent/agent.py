"""The agent loop: hear the meeting, notice when it is addressed, think, and answer."""

from __future__ import annotations

import asyncio
import contextvars
import logging
import re
import time
from collections.abc import Awaitable, Callable
from typing import Any, Protocol

from .addressing import AddressDetector
from .brain import ToolLoopBrain
from .claim import AgentGrant, ClaimError
from .config import AgentConfig
from .listening import Listener, track_frames
from .memory import MAX_NOTE_CHARS, TASK_RESULT_TAG
from .notes import NOTES_INTERVAL_SECONDS, NotesKeeper, notes_command
from .providers.base import Answer, Brain, BrainError, SpeechToText, TextToSpeech
from .room import (
    ChatHandler,
    ChatMessage,
    JoinHandler,
    SignalHandler,
    Speaker,
    TrackEndedHandler,
    TrackHandler,
)
from .speaking import PLAYOUT_TAIL_SECONDS, Mouth
from .tasks import (
    Task,
    TaskCommand,
    TaskRefused,
    TaskRunner,
    describe_tasks,
    is_private,
    task_command,
    without_private,
)
from .transcript import TranscriptBuffer, Utterance, render_line
from .turns import Answering, Turns, TurnTaker

log = logging.getLogger(__name__)

# After "Hey Atlas." on its own, the same person's next sentence is the question.
FOLLOW_UP_SECONDS = 8.0
# Think about other agents' questions at most this many times in a row (each costs the owner),
# until a person speaks or lets the agents continue. The meeting's floor also holds the reply
# that would go past it; on an older server without one, this is the only limit.
MAX_AGENT_STREAK = 3
APOLOGY = Answer("Sorry, I couldn't think that through just now. Please try again.")
# Said out loud (not posted to chat) when an answer needs tools, so the room isn't left in silence.
FILLER = Answer("One sec, checking.")
NOTES_ON: dict[str, object] = {"type": "notes", "state": "on"}
NOTES_OFF: dict[str, object] = {"type": "notes", "state": "off"}
# Give someone who just joined a moment to start listening before telling them about notes.
LATE_JOINER_DELAY = 1.0
# Longer chat messages are cut here, before anything parses them.
MAX_CHAT_CHARS = 4000
# However often someone asks (or rejoins), they get the full task list at most this often.
TASK_LIST_INTERVAL = 2.0
# A finished task is reported by voice once nobody has spoken for this long, waiting at most
# REPORT_WAIT_SECONDS (the chat already has the result, so after that the voice is skipped).
QUIET_SECONDS = 2.5
REPORT_WAIT_SECONDS = 90.0
# Between tries at speaking a report when someone started talking just as its turn came.
REPORT_RETRY_SECONDS = 3.0
# "Yes?" waits only this long for the floor: later, it would only get in the way.
ACK_WAIT_SECONDS = 2.0
OVERFLOWED = "This needs more digging. I'll keep at it and report back."
_TASK_VERB = re.compile(
    r"^(?:look into|research|dig into|investigate|find out|figure out)\s+", re.I
)
# Who the answer being worked out (in this task) is for: the filler only plays for people.
_ASKER: contextvars.ContextVar[Speaker | None] = contextvars.ContextVar("asker", default=None)


class AgentRoom(Protocol):
    """The parts of MeetingRoom the agent uses (a fake stands in for tests)."""

    @property
    def me(self) -> Speaker: ...
    @property
    def voice(self) -> Any:  # rtc.AudioSource: anything with async capture_frame(frame)
        ...

    on_chat: ChatHandler | None
    on_human_track: TrackHandler | None
    on_human_track_ended: TrackEndedHandler | None
    on_participant_joined: JoinHandler | None
    on_notes_policy_changed: Callable[[], None] | None
    on_floor_changed: Callable[[], None] | None
    on_signal: SignalHandler | None

    def participants(self) -> list[Speaker]: ...
    def humans_speaking(self) -> bool: ...
    def send_chat(
        self,
        text: str,
        reply_to: str | None = None,
        sources: frozenset[str] = frozenset(),
        to: list[str] | None = None,
    ) -> Awaitable[None]: ...
    def send_task_event(
        self, message: dict[str, object], to: list[str] | None = None
    ) -> Awaitable[None]: ...
    def replay_tracks(self) -> None: ...
    def notes_allowed(self) -> bool: ...
    def floor_continued(self) -> int: ...
    def is_opted_out(self, identity: str) -> bool: ...
    def send_signal(
        self, message: dict[str, object], to: list[str] | None = None
    ) -> Awaitable[None]: ...


class Agent:
    def __init__(
        self,
        *,
        room: AgentRoom,
        stt: SpeechToText,
        tts: TextToSpeech,
        brain: Brain,
        clock: Callable[[], float] = time.monotonic,
        turns: TurnTaker | None = None,
    ) -> None:
        self.room = room
        self.me = room.me
        self.transcript = TranscriptBuffer()
        self.detector = AddressDetector(self.me.name)
        self.listener = Listener(stt, self.on_utterance)
        self.brain = brain
        if isinstance(brain, ToolLoopBrain):
            brain.on_working = lambda: self._spawn(self._filler())
            brain.agents_here = self._other_agents
        voice = room.voice
        self.mouth = Mouth(
            send_chat=room.send_chat,
            capture_frame=voice.capture_frame,
            tts=tts,
            turns=turns,
            people_talking=room.humans_speaking,
            queued_audio=lambda: float(getattr(voice, "queued_duration", 0.0)),
            clear_audio=getattr(voice, "clear_queue", lambda: None),
            # A real audio source sends what it plays over the network: let it arrive.
            playout_tail=PLAYOUT_TAIL_SECONDS if hasattr(voice, "queued_duration") else 0.0,
        )
        self._clock = clock
        self._voice = type(tts).__name__
        self._latencies: list[float] = []  # heard → first audio, ms
        self._follow_up: dict[str, float] = {}
        self._agent_streak = 0
        self._continued = 0  # when a person last let the meeting's agents continue
        self._tasks: set[asyncio.Task[None]] = set()
        # Meeting notes need a brain that can summarize and a memory to keep them in.
        self.notes: NotesKeeper | None = None
        if isinstance(brain, ToolLoopBrain) and brain.memory is not None:
            self.notes = NotesKeeper(
                summarizer=brain,
                memory=brain.memory,
                opted_out=self._opted_out,
                admitted=lambda identity: identity in self._told,
                render=lambda u: render_line(u, self._role),
            )
        # Who has been told notes are on (a newcomer's words count only after that).
        self._told: set[str] = set()
        # Between "keep notes" and notes starting, and while the last notes are being saved.
        self._announcing = False
        self._stopping = False
        self.notes_interval = NOTES_INTERVAL_SECONDS
        self.late_joiner_delay = LATE_JOINER_DELAY
        self._notes_timer: asyncio.Task[None] | None = None
        owner = self.me.owner_name
        self._display_name = f"{owner}'s {self.me.name}" if owner else self.me.name
        # Background research: owner-only tasks, run by the brain's research loop.
        self.tasks: TaskRunner | None = None
        if isinstance(brain, ToolLoopBrain):
            self.tasks = TaskRunner(
                self._do_task, on_event=self._task_event, on_finished=self._task_finished
            )
            brain.on_overflow = self._overflow_to_task
        self.quiet_seconds = QUIET_SECONDS
        self.report_wait_seconds = REPORT_WAIT_SECONDS
        self.report_retry_seconds = REPORT_RETRY_SECONDS
        self._last_voice = float("-inf")
        self.task_list_interval = TASK_LIST_INTERVAL
        self._task_list_due: dict[str, float] = {}  # identity -> when they may get it again
        self._task_list_pending: set[str] = set()
        self._closing = False

    def wire(self) -> None:
        self.room.on_human_track = lambda speaker, track: self.listener.attach(
            speaker, lambda: track_frames(track)
        )
        self.room.on_human_track_ended = self.listener.detach
        self.room.on_chat = self.on_chat
        self.room.on_participant_joined = self._on_joined
        self.room.on_notes_policy_changed = self._on_notes_policy_changed
        self.room.on_floor_changed = self._on_floor_changed
        self._continued = self.room.floor_continued()
        self.room.on_signal = self._on_signal
        # People already in the room published before these handlers existed.
        self.room.replay_tracks()

    def on_chat(self, msg: ChatMessage) -> None:
        text = msg.text[:MAX_CHAT_CHARS]
        self.on_utterance(
            Utterance(
                msg.speaker, text, msg.timestamp, "chat", about=msg.about, sources=msg.sources
            )
        )

    def on_utterance(self, u: Utterance) -> None:
        if self._closing:
            return
        heard_at = self._clock()
        if u.speaker.kind == "human" and u.via == "voice":
            self._last_voice = heard_at
        self.transcript.add(u)
        self._note(u)
        if u.speaker.kind == "human":
            self._agent_streak = 0

        # Anything this person says closes their follow-up window.
        deadline = self._follow_up.pop(u.speaker.identity, None)
        addressed = self.detector.check(u.text, u.via)
        if addressed is None:
            if deadline is None or heard_at > deadline:
                return
            question = u.text
        elif not addressed.question:
            if self._allowed(u.speaker):
                self._spawn(self._acknowledge(u.speaker, heard_at))
            return
        else:
            question = addressed.question

        if self._allowed(u.speaker):
            self._spawn(self._respond(u.speaker, question, heard_at))

    def _role(self, speaker: Speaker) -> str:
        """Who a speaker is to this agent, from server-assigned identities (never names)."""
        if speaker.identity == self.me.identity:
            return "you"
        if self.me.owner_identity is not None and speaker.identity == self.me.owner_identity:
            return "owner"
        return "agent" if speaker.kind == "agent" else "guest"

    def _allowed(self, asker: Speaker) -> bool:
        if asker.kind != "agent":
            return True
        if self._agent_streak >= MAX_AGENT_STREAK:
            log.info("not answering %s: %d agent turns in a row", asker.name, MAX_AGENT_STREAK)
            return False
        self._agent_streak += 1
        return True

    def _on_floor_changed(self) -> None:
        # Only a person's Continue moves this on. The floor's "paused" also clears when a held
        # reply just goes away, so it can't be trusted to start the count over.
        continued = self.room.floor_continued()
        if continued > self._continued:
            self._agent_streak = 0  # a person let the agents continue
            self._continued = continued

    def _other_agents(self) -> list[str]:
        return [
            p.name
            for p in self.room.participants()
            if p.kind == "agent" and p.identity != self.me.identity
        ]

    async def _acknowledge(self, asker: Speaker, heard_at: float) -> None:
        # Open the window now (a question asked while "Yes?" plays still counts), and start its
        # countdown once "Yes?" has been said, or skipped because the floor was busy.
        self._follow_up[asker.identity] = float("inf")
        await self._say(Answer("Yes?"), heard_at, asker, max_wait=ACK_WAIT_SECONDS)
        if asker.identity in self._follow_up:
            self._follow_up[asker.identity] = self._clock() + FOLLOW_UP_SECONDS

    async def _respond(self, asker: Speaker, question: str, heard_at: float) -> None:
        # What people say stays out of the log file; it may be someone who opted out of notes.
        log.info("%s asked a question", asker.name)
        log.debug("question: %s", question)
        command = notes_command(question)
        if command is not None:
            await self._say(await self._notes_command(asker, command), heard_at, asker)
            return
        # "…privately", "just for me", "DM me": the owner's answer goes only to them.
        private = self._is_owner(asker) and is_private(question)
        task = task_command(question)
        sources: frozenset[str] = frozenset()
        if task is not None:
            reply = self._task_command(asker, task, private=private)
        else:
            transcript, sources = self._snapshot()
            _ASKER.set(asker)
            try:
                reply = await self.brain.answer(
                    question=question, asker=asker, transcript=transcript
                )
            except BrainError:
                reply = APOLOGY
        if private:
            await self._say_privately(reply, asker)
        else:
            await self._say(reply, heard_at, asker, sources)

    async def _filler(self) -> None:
        asker = _ASKER.get()
        if asker is not None and asker.kind == "agent":
            return  # another agent doesn't need to be told to hold on
        try:
            # Only if the floor is free right now: it's a courtesy, not an answer.
            await self.mouth.say(FILLER, chat=False, max_wait=0)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("could not say the filler")

    def _snapshot(self) -> tuple[str, frozenset[str]]:
        """The transcript the brain sees, and whose words are in it.

        While notes are on, it leaves out people who opted out, so a reply to someone else
        can't carry their words into the notes; and whoever is in it is recorded on the reply,
        so if one of them opts out later, the reply leaves the notes too.
        """
        notes_on = self.notes is not None and self.notes.active
        included: list[Utterance] = []
        transcript = self.transcript.render(
            roles=self._role,
            exclude=self.notes.excluded if notes_on and self.notes else None,
            included=included,
        )
        return transcript, frozenset(p for u in included for p in NotesKeeper.people(u))

    @staticmethod
    def _person(speaker: Speaker | None) -> str | None:
        """The person behind a speaker: an agent stands for its owner."""
        if speaker is None:
            return None
        return speaker.owner_identity if speaker.kind == "agent" else speaker.identity

    async def _say(
        self,
        answer: Answer,
        heard_at: float,
        asker: Speaker | None = None,
        sources: frozenset[str] = frozenset(),
        *,
        max_wait: float | None = None,
    ) -> None:
        def first_frame() -> None:
            latency_ms = (self._clock() - heard_at) * 1000
            self._latencies.append(latency_ms)
            log.info("latency heard→voice %.0f ms", latency_ms)

        about = self._person(asker)
        answering: Answering = "agent" if asker is not None and asker.kind == "agent" else "person"
        went_out = True
        try:
            went_out = await self.mouth.say(
                answer,
                on_first_frame=first_frame,
                reply_to=about,
                sources=sources,
                answering=answering,
                max_wait=max_wait,
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("could not say the answer (it may have reached chat only)")
        finally:
            if went_out:
                said = Utterance(
                    self.me, answer.spoken, time.time(), "chat", about=about, sources=sources
                )
                self.transcript.add(said)
                self._note(said)

    async def _say_privately(self, answer: Answer, asker: Speaker) -> None:
        """A direct chat message to the asker: never spoken, never in the transcript or notes."""
        text = answer.spoken if not answer.details else f"{answer.spoken}\n\n{answer.details}"
        try:
            await self.room.send_chat(f"🔒 {text}", reply_to=asker.identity, to=[asker.identity])
        except Exception:
            log.exception("could not send a private answer")

    # -- meeting notes -------------------------------------------------------------

    def _opted_out(self, identity: str) -> bool:
        return self.room.is_opted_out(identity)

    def _note(self, u: Utterance) -> None:
        if self.notes is not None and self.notes.hear(u):
            self._spawn(self._flush_notes())  # the log is full: summarize this chunk now

    async def _flush_notes(self) -> None:
        assert self.notes is not None
        try:
            await self.notes.flush()
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("could not save meeting notes (will try again)")

    async def _notes_loop(self) -> None:
        while self.notes is not None and self.notes.active:
            await asyncio.sleep(self.notes_interval)
            if self.notes.active:
                # Shielded: stopping notes must not cut a summary off halfway.
                await asyncio.shield(self._flush_notes())

    async def _notes_command(self, asker: Speaker, command: str) -> Answer:
        owner = self.me.owner_name or "my owner"
        if self.me.owner_identity is None or asker.identity != self.me.owner_identity:
            return Answer(f"Only {owner} can ask me to keep notes.")
        if self.notes is None:
            return Answer("I can't keep notes with this setup.")
        if command == "off":
            if not self.notes.active:
                return Answer("I'm not keeping notes.")
            await self._stop_notes()
            return Answer("Okay, I've stopped keeping notes and saved them.")
        if self.notes.active or self._announcing:
            return Answer("I'm already keeping notes.")
        if self._stopping:
            return Answer("I'm still saving the last notes. Ask me again in a moment.")
        if not self.room.notes_allowed():
            return Answer("The host hasn't allowed agent notes in this meeting.")
        # Everyone is told before the first line is kept, or notes don't start at all. While
        # announcing, a join or a "notes?" query is answered "on" and counts as told.
        present = {asker.identity} | {  # the owner asked, so they know
            p.identity for p in self.room.participants() if p.kind == "human"
        }
        self._told = set()
        self._announcing = True
        try:
            await self.room.send_signal(NOTES_ON)
            self._told |= present
            await self.room.send_chat(
                f"📝 {self._display_name} is keeping notes. "
                'Anyone can choose "Leave me out" to stay out of them.'
            )
        except Exception:
            log.exception("could not announce meeting notes")
            self._announcing = False
            await self._send_off_quietly()
            return Answer("I couldn't let everyone know, so I'm not keeping notes.")
        self._announcing = False
        if not self.room.notes_allowed():
            # The host turned notes off while we were announcing them.
            await self._send_off_quietly()
            return Answer("The host just turned off agent notes, so I'm not keeping them.")
        self.notes.start()
        self._notes_timer = asyncio.ensure_future(self._notes_loop())
        return Answer("Okay, I'm keeping notes. Anyone can choose Leave me out.")

    async def _send_off_quietly(self) -> None:
        try:
            await self.room.send_signal(NOTES_OFF)
        except Exception:
            log.exception("could not take back the notes announcement")

    async def _stop_notes(self, chat: str | None = None) -> None:
        if self.notes is None or not self.notes.active:
            return
        self.notes.active = False  # stop logging right away
        self._stopping = True  # and don't restart until these are saved
        if self._notes_timer:
            self._notes_timer.cancel()
            self._notes_timer = None
        try:
            try:
                await self.room.send_signal(NOTES_OFF)
                await self.room.send_chat(chat or f"📝 {self._display_name} stopped keeping notes.")
            except Exception:
                log.exception("could not announce that notes stopped")
            try:
                await self.notes.flush()
            except Exception:
                log.exception("could not save meeting notes")
        finally:
            self._stopping = False

    def _notes_on(self) -> bool:
        """On, or being announced: either way people must hear about it."""
        return self.notes is not None and (self.notes.active or self._announcing)

    def _on_joined(self, speaker: Speaker) -> None:
        if speaker.kind != "human":
            return
        if self._notes_on():
            self._spawn(self._tell_late_joiner(speaker.identity))
        # Their own tasks? query may have come before we saw them join, and been dropped.
        self._offer_task_list(speaker.identity, delay=self.late_joiner_delay)

    def _offer_task_list(self, identity: str, delay: float = 0.0) -> None:
        """Send someone every task: at most once per interval however often they ask."""
        if self.tasks is None or not self.tasks.tasks or identity in self._task_list_pending:
            return
        self._task_list_pending.add(identity)
        self._spawn(self._send_task_list(identity, delay))

    async def _send_task_list(self, identity: str, delay: float) -> None:
        assert self.tasks is not None
        try:
            wait = max(delay, self._task_list_due.get(identity, float("-inf")) - self._clock())
            if wait > 0:
                await asyncio.sleep(wait)
            for task in list(self.tasks.tasks):
                await self._send_task_event(task, identity)
        finally:
            self._task_list_pending.discard(identity)
            self._task_list_due[identity] = self._clock() + self.task_list_interval

    async def _tell_late_joiner(self, identity: str) -> None:
        await asyncio.sleep(self.late_joiner_delay)
        if self._notes_on():
            try:
                await self.room.send_signal(NOTES_ON, to=[identity])
            except Exception:
                log.exception("could not tell a late joiner about notes")
                return
            self._told.add(identity)

    def _on_signal(self, speaker: Speaker, message: dict[str, object]) -> None:
        if speaker.kind != "human" or self._closing:
            return
        kind = message.get("type")
        # A browser that (re)connected asks every agent whether it is keeping notes,
        # and what it is working on.
        if kind == "notes?":
            self._spawn(self._answer_notes_query(speaker.identity))
        elif kind == "tasks?":
            self._offer_task_list(speaker.identity)
        elif kind == "task.cancel" and self.tasks is not None and self._is_owner(speaker):
            task_id = message.get("id")
            if isinstance(task_id, str):
                self.tasks.cancel(task_id)

    async def _answer_notes_query(self, identity: str) -> None:
        on = self._notes_on()
        try:
            await self.room.send_signal(NOTES_ON if on else NOTES_OFF, to=[identity])
        except Exception:
            log.exception("could not answer a notes query")
            return
        if on:
            self._told.add(identity)

    def _on_notes_policy_changed(self) -> None:
        if self.notes is not None and self.notes.active and not self.room.notes_allowed():
            self._spawn(
                self._stop_notes(
                    f"📝 The host turned off agent notes, so {self._display_name} stopped "
                    "keeping them."
                )
            )

    # -- background research ------------------------------------------------------------

    def _is_owner(self, speaker: Speaker) -> bool:
        return self.me.owner_identity is not None and speaker.identity == self.me.owner_identity

    def _task_command(self, asker: Speaker, command: TaskCommand, *, private: bool) -> Answer:
        """`private`: the reply goes only to the owner, so it may name their private tasks."""
        owner = self.me.owner_name or "my owner"
        if self.tasks is None:
            return Answer("I can't do background research with this setup.")
        if command.kind == "status":
            text = describe_tasks(self.tasks.tasks, now=time.time(), show_private=private)
            if (
                not private
                and self._is_owner(asker)
                and any(t.private and t.active for t in self.tasks.tasks)
            ):
                text += " Ask me privately to hear about your private tasks."
            return Answer(text)
        if command.kind == "cancel":
            if not self._is_owner(asker):
                return Answer(f"Only {owner} can stop my tasks.")
            task = self.tasks.latest_active()
            if task is None:
                return Answer("I'm not working on anything right now.")
            self.tasks.cancel(task.id)
            return Answer(
                "Okay, I've stopped that."
                if task.private
                else f"Okay, I've stopped '{task.title}'."
            )
        if not self._is_owner(asker):
            return Answer(f"Only {owner} can ask me to research things in the background.")
        transcript, sources = self._snapshot()
        try:
            self.tasks.start(
                title=command.topic,
                owner=asker.identity,
                private=command.private,
                transcript=transcript,
                sources=sources,
            )
        except TaskRefused as err:
            return Answer(str(err))
        if command.private:
            return Answer("On it. I'll tell you privately when I'm done.")
        return Answer("On it. I'll report back.")

    def _overflow_to_task(self, question: str, asker: Speaker, found: str) -> str:
        """The owner's question ran out of the spoken budget: keep going in the background."""
        if self.tasks is None:
            return "That needs more time than I have right now."
        title = without_private(question).rstrip(",;: ").strip() or question.strip()
        transcript, sources = self._snapshot()
        try:
            self.tasks.start(
                title=(title[:1].upper() + title[1:])[:120],
                owner=asker.identity,
                private=is_private(question),  # only the owner's questions overflow
                context=found,
                transcript=transcript,
                sources=sources,
            )
        except TaskRefused as err:
            return str(err)
        return OVERFLOWED

    async def _do_task(self, task: Task, progress: Callable[[str], None]) -> Answer:
        assert isinstance(self.brain, ToolLoopBrain)
        return await self.brain.research(
            title=task.title,
            context=task.context,
            transcript=task.transcript,
            progress=progress,
            private=task.private,
        )

    def _task_event(self, task: Task) -> None:
        # Built now: by the time it's sent the task may have moved on.
        events = (task.event(for_owner=True), task.event(for_owner=False))
        self._spawn(self._send_task_event(task, events=events))

    async def _send_task_event(
        self,
        task: Task,
        to: str | None = None,
        *,
        events: tuple[dict[str, object], dict[str, object]] | None = None,
    ) -> None:
        """Everyone sees what agents are working on; a private task's details only its owner."""
        full, redacted = events or (task.event(for_owner=True), task.event(for_owner=False))
        try:
            if to is not None:
                await self.room.send_task_event(full if to == task.owner else redacted, [to])
            elif not task.private:
                await self.room.send_task_event(full)
            else:
                await self.room.send_task_event(full, [task.owner])
                others = [
                    p.identity
                    for p in self.room.participants()
                    if p.kind == "human" and p.identity != task.owner
                ]
                if others:
                    await self.room.send_task_event(redacted, others)
        except Exception:
            log.exception("could not send a task update")

    def _task_finished(self, task: Task) -> None:
        if task.state == "done" and task.result is not None:
            self._save_task(task)
            self._spawn(self._report(task))
        elif task.state == "failed":
            self._spawn(self._report(task))

    def _save_task(self, task: Task) -> None:
        assert task.result is not None
        memory = self.brain.memory if isinstance(self.brain, ToolLoopBrain) else None
        if memory is None:
            return
        text = f"Research: {task.title}\n{task.result.spoken}\n\n{task.result.details}".strip()
        try:
            memory.remember(text[:MAX_NOTE_CHARS], public=False, tags=[TASK_RESULT_TAG])
        except Exception:
            log.exception("could not save task %s to memory", task.id)

    async def _report(self, task: Task) -> None:
        """Chat right away; the voice waits for a pause. Private results go only to the owner."""
        owner_name = self.me.owner_name or "Hey"
        about = _TASK_VERB.sub("", task.title).rstrip("?.!") or task.title
        if task.state == "done" and task.result is not None:
            details = f"\n\n{task.result.details}" if task.result.details else ""
            chat = f"📋 {task.title}\n\n{task.result.spoken}{details}"
            spoken = f"{owner_name}, about {about}: {task.result.spoken}"
        else:
            chat = f"⚠️ {task.title}\n\n{task.error or 'I could not finish it.'}"
            spoken = f"{owner_name}, I couldn't finish {about}. Details are in the chat."
        try:
            if task.private:
                await self.room.send_chat(chat, reply_to=task.owner, to=[task.owner])
                return
            await self.room.send_chat(chat, reply_to=task.owner, sources=task.sources)
        except Exception:
            log.exception("could not post task %s to chat", task.id)
            return
        line = Utterance(
            self.me, spoken, time.time(), "chat", about=task.owner, sources=task.sources
        )
        self.transcript.add(line)
        self._note(line)
        deadline = self._clock() + self.report_wait_seconds
        while self._clock() < deadline and await self._wait_for_quiet(deadline):
            talking = False

            def still_quiet() -> bool:
                nonlocal talking
                talking = not self._quiet()
                return not talking

            try:
                # Quiet again by the time it's our turn (we may have been answering someone)?
                if await self.mouth.say(
                    Answer(spoken),
                    chat=False,
                    only_if=still_quiet,
                    max_wait=max(0.0, deadline - self._clock()),
                ):
                    return
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("could not say the task result")
                return
            if not talking:
                return  # no turn came (the floor stayed busy, or the server said no)
            await asyncio.sleep(self.report_retry_seconds)

    def _quiet(self) -> bool:
        """Nobody is talking: no one mid-sentence, and no one has finished one just now."""
        recently = self._clock() - self._last_voice < self.quiet_seconds
        return not recently and not self.room.humans_speaking()

    async def _wait_for_quiet(self, deadline: float) -> bool:
        step = max(0.01, min(0.25, self.quiet_seconds / 2))
        while not self._quiet():
            if self._clock() >= deadline:
                return False
            await asyncio.sleep(step)
        return True

    def _spawn(self, coro: Awaitable[None]) -> None:
        task: asyncio.Task[None] = asyncio.ensure_future(coro)
        self._tasks.add(task)
        task.add_done_callback(self._finished)

    def _finished(self, task: asyncio.Task[None]) -> None:
        self._tasks.discard(task)
        if not task.cancelled() and (err := task.exception()) is not None:
            log.error("answer task failed", exc_info=err)

    async def idle(self) -> None:
        """Wait until every answer in flight has been said (used by tests)."""
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)
            # Awaiting finished tasks doesn't yield, so let their done callbacks run.
            await asyncio.sleep(0)

    async def aclose(self, *, finish_tasks: bool = False) -> None:
        """Leave: stop listening and answering, save the notes, then end the tasks.

        `finish_tasks`: the meeting ended, so working tasks finish (within their own budget)
        and are saved to memory first. Otherwise (Ctrl-C) they stop at once.
        """
        self._closing = True
        self._log_latency()
        await self.listener.aclose()
        await self._cancel_spawned()
        if self._notes_timer:
            self._notes_timer.cancel()
        if self.notes is not None and (self.notes.active or self.notes.unsaved):
            # Save what's left, including a stop that was cut short (the room may be gone).
            try:
                await self.notes.stop()
            except Exception:
                log.exception("could not save meeting notes at the end of the meeting")
        if self.tasks is None:
            return
        try:
            working = [t for t in self.tasks.tasks if t.state == "working"]
            if finish_tasks and working:
                log.warning(
                    "finishing %d research task(s) before leaving (Ctrl-C to stop now)",
                    len(working),
                )
                await self.tasks.finish_up()
        finally:
            await self.tasks.aclose()  # anything left (or a second Ctrl-C): stop now
            await self._cancel_spawned()  # reports of what just finished: it's in memory

    def _log_latency(self) -> None:
        """How quickly it answered in this meeting (what the PRD's latency target is about)."""
        if not self._latencies:
            return
        ordered = sorted(self._latencies)
        p50 = ordered[len(ordered) // 2]
        p95 = ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))]
        log.info(
            "heard→voice over %d answers: p50 %.0f ms, p95 %.0f ms (%s)",
            len(ordered),
            p50,
            p95,
            self._voice,
        )

    async def _cancel_spawned(self) -> None:
        for task in list(self._tasks):
            task.cancel()
        await asyncio.gather(*list(self._tasks), return_exceptions=True)


async def run(grant: AgentGrant, config: AgentConfig) -> None:
    """Join the meeting from an approved grant and run until the meeting ends for us."""
    import aiohttp
    import httpx

    from .providers import build_providers
    from .room import MeetingRoom

    room = MeetingRoom()
    agent: Agent | None = None
    ended = False
    async with (
        aiohttp.ClientSession() as http,
        httpx.AsyncClient() as mooz,
        httpx.AsyncClient() as speech,
    ):
        turns = (
            Turns(
                mooz,
                grant.server,
                request_id=grant.ticket.request_id,
                claim_secret=grant.ticket.claim_secret,
            )
            if grant.server and grant.ticket
            else None
        )
        try:
            try:
                await room.connect(grant.url, grant.token)
            except Exception as err:
                raise ClaimError(
                    "connect_failed", f"Could not join the meeting's media server: {err}"
                ) from err
            stt, tts, brain = build_providers(
                http=http, me=room.me, config=config, speech_http=speech
            )
            agent = Agent(room=room, stt=stt, tts=tts, brain=brain, turns=turns)
            agent.wire()
            warm = getattr(tts, "warm", None)
            if warm is not None:
                # Said often: prepared once (on a local server this also wakes the model).
                agent._spawn(warm(["Yes?", FILLER.spoken]))
            await room.wait_closed()
            log.info("left the meeting")
            ended = True
        finally:
            if agent:
                # The meeting ending lets research finish; Ctrl-C (cancelled) stops it now.
                await agent.aclose(finish_tasks=ended)
            await room.disconnect()
