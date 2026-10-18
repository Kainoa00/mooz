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
from .providers.base import Answer, Brain, BrainError, SpeechToText, TextToSpeech
from .room import ChatHandler, ChatMessage, Speaker, TrackEndedHandler, TrackHandler
from .speaking import Mouth
from .transcript import TranscriptBuffer, Utterance

log = logging.getLogger(__name__)

# After "Hey Atlas." on its own, the same person's next sentence is the question.
FOLLOW_UP_SECONDS = 8.0
# Answer other agents at most this many times in a row before a person speaks again,
# so two agents cannot talk to each other forever (the host-facing pause comes in M5).
MAX_AGENT_STREAK = 3
APOLOGY = Answer("Sorry, I couldn't think that through just now. Please try again.")
# Said out loud (not posted to chat) when an answer needs tools, so the room isn't left in silence.
FILLER = Answer("One sec, checking.")


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

    def send_chat(self, text: str) -> Awaitable[None]: ...
    def replay_tracks(self) -> None: ...


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

    def wire(self) -> None:
        self.room.on_human_track = lambda speaker, track: self.listener.attach(
            speaker, lambda: track_frames(track)
        )
        self.room.on_human_track_ended = self.listener.detach
        self.room.on_chat = self.on_chat
        # People already in the room published before these handlers existed.
        self.room.replay_tracks()

    def on_chat(self, msg: ChatMessage) -> None:
        self.on_utterance(Utterance(msg.speaker, msg.text, msg.timestamp, "chat"))

    def on_utterance(self, u: Utterance) -> None:
        heard_at = self._clock()
        self.transcript.add(u)
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
        await self._say(Answer("Yes?"), heard_at)
        if asker.identity in self._follow_up:
            self._follow_up[asker.identity] = self._clock() + FOLLOW_UP_SECONDS

    async def _respond(self, asker: Speaker, question: str, heard_at: float) -> None:
        log.info("%s asked: %s", asker.name, question)
        try:
            answer = await self.brain.answer(
                question=question, asker=asker, transcript=self.transcript.render()
            )
        except BrainError:
            answer = APOLOGY
        await self._say(answer, heard_at)

    async def _filler(self) -> None:
        try:
            await self.mouth.say(FILLER, chat=False)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("could not say the filler")

    async def _say(self, answer: Answer, heard_at: float) -> None:
        def first_frame() -> None:
            latency_ms = (self._clock() - heard_at) * 1000
            log.info("latency heard→voice %.0f ms", latency_ms)

        try:
            await self.mouth.say(answer, on_first_frame=first_frame)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("could not say the answer (it may have reached chat only)")
        finally:
            self.transcript.add(Utterance(self.me, answer.spoken, time.time(), "chat"))

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
