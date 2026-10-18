"""The agent loop: hear the meeting, notice when it is addressed, think, and answer."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from typing import Any, Protocol

from .addressing import AddressDetector
from .brain import ToolLoopBrain
from .claim import AgentGrant, ClaimError
from .config import AgentConfig
from .listening import Listener, track_frames
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
from .speaking import Mouth
from .transcript import TranscriptBuffer, Utterance, render_line

log = logging.getLogger(__name__)

# After "Hey Atlas." on its own, the same person's next sentence is the question.
FOLLOW_UP_SECONDS = 8.0
# Answer other agents at most this many times in a row before a person speaks again,
# so two agents cannot talk to each other forever (the host-facing pause comes in M5).
MAX_AGENT_STREAK = 3
APOLOGY = Answer("Sorry, I couldn't think that through just now. Please try again.")
# Said out loud (not posted to chat) when an answer needs tools, so the room isn't left in silence.
FILLER = Answer("One sec, checking.")
NOTES_ON: dict[str, object] = {"type": "notes", "state": "on"}
NOTES_OFF: dict[str, object] = {"type": "notes", "state": "off"}
# Give someone who just joined a moment to start listening before telling them about notes.
LATE_JOINER_DELAY = 1.0


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
    on_signal: SignalHandler | None

    def participants(self) -> list[Speaker]: ...
    def send_chat(
        self, text: str, reply_to: str | None = None, sources: frozenset[str] = frozenset()
    ) -> Awaitable[None]: ...
    def replay_tracks(self) -> None: ...
    def notes_allowed(self) -> bool: ...
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
    ) -> None:
        self.room = room
        self.me = room.me
        self.transcript = TranscriptBuffer()
        self.detector = AddressDetector(self.me.name)
        self.listener = Listener(stt, self.on_utterance)
        self.brain = brain
        if isinstance(brain, ToolLoopBrain):
            brain.on_working = lambda: self._spawn(self._filler())
        self.mouth = Mouth(
            send_chat=room.send_chat, capture_frame=room.voice.capture_frame, tts=tts
        )
        self._clock = clock
        self._follow_up: dict[str, float] = {}
        self._agent_streak = 0
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

    def wire(self) -> None:
        self.room.on_human_track = lambda speaker, track: self.listener.attach(
            speaker, lambda: track_frames(track)
        )
        self.room.on_human_track_ended = self.listener.detach
        self.room.on_chat = self.on_chat
        self.room.on_participant_joined = self._on_joined
        self.room.on_notes_policy_changed = self._on_notes_policy_changed
        self.room.on_signal = self._on_signal
        # People already in the room published before these handlers existed.
        self.room.replay_tracks()

    def on_chat(self, msg: ChatMessage) -> None:
        self.on_utterance(
            Utterance(
                msg.speaker, msg.text, msg.timestamp, "chat", about=msg.about, sources=msg.sources
            )
        )

    def on_utterance(self, u: Utterance) -> None:
        heard_at = self._clock()
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

    async def _acknowledge(self, asker: Speaker, heard_at: float) -> None:
        # Open the window now (a question asked while "Yes?" plays still counts), and
        # start its countdown once "Yes?" has actually been said.
        self._follow_up[asker.identity] = float("inf")
        await self._say(Answer("Yes?"), heard_at, asker)
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
        # While notes are on, answers don't draw on people who opted out, so a reply to
        # someone else can't carry their words into the notes.
        notes_on = self.notes is not None and self.notes.active
        included: list[Utterance] = []
        transcript = self.transcript.render(
            roles=self._role,
            exclude=self.notes.excluded if notes_on and self.notes else None,
            included=included,
        )
        # Whoever the answer could quote: if one of them opts out later, it leaves the notes too.
        sources = frozenset(p for u in included for p in NotesKeeper.people(u))
        try:
            answer = await self.brain.answer(question=question, asker=asker, transcript=transcript)
        except BrainError:
            answer = APOLOGY
        await self._say(answer, heard_at, asker, sources)

    async def _filler(self) -> None:
        try:
            await self.mouth.say(FILLER, chat=False)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("could not say the filler")

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
    ) -> None:
        def first_frame() -> None:
            latency_ms = (self._clock() - heard_at) * 1000
            log.info("latency heard→voice %.0f ms", latency_ms)

        about = self._person(asker)
        try:
            await self.mouth.say(
                answer, on_first_frame=first_frame, reply_to=about, sources=sources
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("could not say the answer (it may have reached chat only)")
        finally:
            said = Utterance(
                self.me, answer.spoken, time.time(), "chat", about=about, sources=sources
            )
            self.transcript.add(said)
            self._note(said)

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
        if self._notes_on() and speaker.kind == "human":
            self._spawn(self._tell_late_joiner(speaker.identity))

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
        # A browser that (re)connected asks every agent whether it is keeping notes.
        if message.get("type") == "notes?" and speaker.kind == "human":
            self._spawn(self._answer_notes_query(speaker.identity))

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

    async def aclose(self) -> None:
        for task in list(self._tasks):
            task.cancel()
        await asyncio.gather(*list(self._tasks), return_exceptions=True)
        if self._notes_timer:
            self._notes_timer.cancel()
        if self.notes is not None and (self.notes.active or self.notes.unsaved):
            # The meeting ended for us: save what's left, including a stop that was cut
            # short (the room may already be gone).
            try:
                await self.notes.stop()
            except Exception:
                log.exception("could not save meeting notes at the end of the meeting")
        await self.listener.aclose()


async def run(grant: AgentGrant, config: AgentConfig) -> None:
    """Join the meeting from an approved grant and run until the meeting ends for us."""
    import aiohttp

    from .providers import build_providers
    from .room import MeetingRoom

    room = MeetingRoom()
    agent: Agent | None = None
    async with aiohttp.ClientSession() as http:
        try:
            try:
                await room.connect(grant.url, grant.token)
            except Exception as err:
                raise ClaimError(
                    "connect_failed", f"Could not join the meeting's media server: {err}"
                ) from err
            stt, tts, brain = build_providers(http=http, me=room.me, config=config)
            agent = Agent(room=room, stt=stt, tts=tts, brain=brain)
            agent.wire()
            await room.wait_closed()
            log.info("left the meeting")
        finally:
            if agent:
                await agent.aclose()
            await room.disconnect()
