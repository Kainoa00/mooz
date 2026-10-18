"""A thin adapter over a LiveKit room: who is speaking, chat in and out, and the agent's voice."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal, Protocol

from livekit import rtc

log = logging.getLogger(__name__)

CHAT_TOPIC = "lk.chat"
SAMPLE_RATE = 48_000
NUM_CHANNELS = 1


@dataclass(frozen=True)
class Speaker:
    identity: str
    name: str
    kind: Literal["human", "agent"]
    owner_identity: str | None = None


@dataclass(frozen=True)
class ChatMessage:
    speaker: Speaker
    text: str
    timestamp: float


class _ParticipantLike(Protocol):
    @property
    def identity(self) -> str: ...
    @property
    def name(self) -> str: ...
    @property
    def attributes(self) -> dict[str, str]: ...


def speaker_from_participant(p: _ParticipantLike) -> Speaker:
    """Classify a participant. Only the server sets attributes, so `kind` can be trusted."""
    attrs = p.attributes or {}
    kind: Literal["human", "agent"] = "agent" if attrs.get("kind") == "agent" else "human"
    return Speaker(
        identity=p.identity,
        name=p.name or p.identity,
        kind=kind,
        owner_identity=attrs.get("owner_id") if kind == "agent" else None,
    )


ChatHandler = Callable[[ChatMessage], None]
TrackHandler = Callable[[Speaker, rtc.Track], None]
TrackEndedHandler = Callable[[str], None]


class MeetingRoom:
    """Joins a meeting as an agent participant and exposes the few things an agent needs."""

    def __init__(self, room: rtc.Room | None = None) -> None:
        self._room = room or rtc.Room()
        self._tasks: set[asyncio.Task[None]] = set()
        self.voice = rtc.AudioSource(SAMPLE_RATE, NUM_CHANNELS)
        self.on_chat: ChatHandler | None = None
        self.on_human_track: TrackHandler | None = None
        self.on_human_track_ended: TrackEndedHandler | None = None

    @property
    def me(self) -> Speaker:
        return speaker_from_participant(self._room.local_participant)

    def participants(self) -> list[Speaker]:
        return [speaker_from_participant(p) for p in self._room.remote_participants.values()]

    async def connect(self, url: str, token: str) -> None:
        self._room.on("track_subscribed", self._handle_track_subscribed)
        self._room.on("track_unsubscribed", self._handle_track_unsubscribed)
        self._room.register_text_stream_handler(CHAT_TOPIC, self._handle_chat_stream)
        await self._room.connect(url, token, rtc.RoomOptions(auto_subscribe=True))
        track = rtc.LocalAudioTrack.create_audio_track("agent-voice", self.voice)
        options = rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
        await self._room.local_participant.publish_track(track, options)
        log.info("joined room %s as %s", self._room.name, self.me.identity)

    async def send_chat(self, text: str) -> None:
        await self._room.local_participant.send_text(text, topic=CHAT_TOPIC)

    async def disconnect(self) -> None:
        for task in list(self._tasks):
            task.cancel()
        await self._room.disconnect()

    def _handle_track_subscribed(
        self,
        track: rtc.Track,
        _publication: rtc.RemoteTrackPublication,
        participant: rtc.RemoteParticipant,
    ) -> None:
        speaker = speaker_from_participant(participant)
        # Agents are heard through their chat text, never transcribed: cheaper and exact.
        if track.kind != rtc.TrackKind.KIND_AUDIO or speaker.kind != "human":
            return
        if self.on_human_track:
            self.on_human_track(speaker, track)

    def _handle_track_unsubscribed(
        self,
        track: rtc.Track,
        _publication: rtc.RemoteTrackPublication,
        participant: rtc.RemoteParticipant,
    ) -> None:
        if track.kind == rtc.TrackKind.KIND_AUDIO and self.on_human_track_ended:
            self.on_human_track_ended(participant.identity)

    def _handle_chat_stream(self, reader: rtc.TextStreamReader, participant_identity: str) -> None:
        task = asyncio.ensure_future(self._read_chat(reader, participant_identity))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _read_chat(self, reader: rtc.TextStreamReader, participant_identity: str) -> None:
        text = await reader.read_all()
        participant = self._room.remote_participants.get(participant_identity)
        if participant is None or not self.on_chat:
            return
        self.on_chat(ChatMessage(speaker_from_participant(participant), text, time.time()))
