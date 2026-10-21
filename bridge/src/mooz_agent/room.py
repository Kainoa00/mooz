"""A thin adapter over a LiveKit room: who is speaking, chat in and out, and the agent's voice."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal, Protocol

from livekit import rtc

log = logging.getLogger(__name__)

CHAT_TOPIC = "lk.chat"
# mooz's own messages between agents and browsers (see apps/web/lib/notes-protocol.ts).
MOOZ_TOPIC = "mooz.v0"
# Task updates and results (text streams: results can be long). See docs/protocol.md.
TASKS_TOPIC = "mooz.tasks"
NOTES_OPT_OUT_ATTRIBUTE = "notes_opt_out"
REPLY_TO_ATTRIBUTE = "reply_to"
SOURCES_ATTRIBUTE = "sources"
# On a message sent only to some people: it's theirs, and stays out of the host's summary.
PRIVATE_ATTRIBUTE = "private"
SAMPLE_RATE = 48_000
NUM_CHANNELS = 1
# Leave this long after the last person does, so the agent doesn't keep an empty room open.
ALONE_GRACE_SECONDS = 60.0


def _wire(text: str) -> str:
    """Text LiveKit can send as UTF-8. A model can write half a character pair: two halves side
    by side become the character, and a stray one becomes \ufffd instead of failing the send."""
    return text.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "replace")


@dataclass(frozen=True)
class Speaker:
    identity: str
    name: str
    kind: Literal["human", "agent"]
    owner_identity: str | None = None
    owner_name: str | None = None


@dataclass(frozen=True)
class ChatMessage:
    speaker: Speaker
    text: str
    timestamp: float
    # For an agent's reply: the person it answers, and whose words it may repeat (the
    # `reply_to` and `sources` text stream attributes).
    about: str | None = None
    sources: frozenset[str] = frozenset()


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
        owner_name=attrs.get("owner_name") if kind == "agent" else None,
    )


ChatHandler = Callable[[ChatMessage], None]
TrackHandler = Callable[[Speaker, rtc.Track], None]
TrackEndedHandler = Callable[[str], None]
JoinHandler = Callable[[Speaker], None]
SignalHandler = Callable[[Speaker, dict[str, object]], None]


class MeetingRoom:
    """Joins a meeting as an agent participant and exposes the few things an agent needs."""

    def __init__(self, room: rtc.Room | None = None) -> None:
        self._room = room or rtc.Room()
        self._tasks: set[asyncio.Task[None]] = set()
        self.voice = rtc.AudioSource(SAMPLE_RATE, NUM_CHANNELS)
        self.on_chat: ChatHandler | None = None
        self.on_human_track: TrackHandler | None = None
        self.on_human_track_ended: TrackEndedHandler | None = None
        self.on_participant_joined: JoinHandler | None = None
        self.on_notes_policy_changed: Callable[[], None] | None = None
        self.on_floor_changed: Callable[[], None] | None = None
        self.on_signal: SignalHandler | None = None
        self._opted_out: set[str] = set()
        self._speaking: set[str] = set()  # people talking right now (LiveKit's active speakers)
        self._closed = asyncio.Event()
        self._audio_sid: dict[str, str] = {}
        self._alone_timer: asyncio.TimerHandle | None = None
        self.alone_grace_seconds = ALONE_GRACE_SECONDS

    @property
    def me(self) -> Speaker:
        return speaker_from_participant(self._room.local_participant)

    def participants(self) -> list[Speaker]:
        return [speaker_from_participant(p) for p in self._room.remote_participants.values()]

    async def connect(self, url: str, token: str) -> None:
        self._room.on("track_subscribed", self._handle_track_subscribed)
        self._room.on("track_unsubscribed", self._handle_track_unsubscribed)
        self._room.on("disconnected", lambda *_: self._closed.set())
        self._room.on("participant_connected", self._handle_participant_connected)
        self._room.on("participant_disconnected", self._handle_participant_change)
        self._room.on("participant_attributes_changed", self._handle_attributes_changed)
        self._room.on("room_metadata_changed", self._handle_metadata_changed)
        self._room.on("data_received", self._handle_data)
        self._room.on("active_speakers_changed", self._handle_active_speakers)
        self._room.register_text_stream_handler(CHAT_TOPIC, self._handle_chat_stream)
        await self._room.connect(url, token, rtc.RoomOptions(auto_subscribe=True))
        for participant in self._room.remote_participants.values():
            self._track_opt_out(participant)
        track = rtc.LocalAudioTrack.create_audio_track("agent-voice", self.voice)
        options = rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
        await self._room.local_participant.publish_track(track, options)
        log.info("joined room %s as %s", self._room.name, self.me.identity)

    def replay_tracks(self) -> None:
        """Offer audio already subscribed before handlers were set (people who were here first)."""
        for participant in list(self._room.remote_participants.values()):
            for publication in list(participant.track_publications.values()):
                track = publication.track
                if publication.subscribed and track is not None:
                    self._handle_track_subscribed(track, publication, participant)

    def humans_speaking(self) -> bool:
        """Whether a person is talking right now, mid-sentence included."""
        return bool(self._speaking)

    def _handle_active_speakers(self, speakers: list[rtc.Participant]) -> None:
        self._speaking = {
            p.identity for p in speakers if speaker_from_participant(p).kind == "human"
        }

    # -- meeting notes consent (set only by the mooz server) ----------------------

    def notes_allowed(self) -> bool:
        """Whether the host allows agent notes: room metadata {"notes_allowed": true}."""
        try:
            data = json.loads(self._room.metadata or "{}")
        except ValueError:
            return False
        return isinstance(data, dict) and data.get("notes_allowed") is True

    def is_opted_out(self, identity: str) -> bool:
        """Whether this person asked to be left out of notes (remembered after they leave)."""
        participant = self._room.remote_participants.get(identity)
        if participant is not None:
            self._track_opt_out(participant)
        return identity in self._opted_out

    def _track_opt_out(self, participant: rtc.RemoteParticipant) -> None:
        if (participant.attributes or {}).get(NOTES_OPT_OUT_ATTRIBUTE) == "1":
            self._opted_out.add(participant.identity)
        else:
            self._opted_out.discard(participant.identity)

    def _handle_attributes_changed(
        self, _changed: dict[str, str], participant: rtc.Participant
    ) -> None:
        if isinstance(participant, rtc.RemoteParticipant):
            self._track_opt_out(participant)

    def floor_continued(self) -> int:
        """When a person last let the agents continue: room metadata floor.continued (ms on the
        server's clock). Only a person's Continue moves it up; it's 0 when the server has
        forgotten the floor (a restart, or 10 idle minutes), which isn't a Continue."""
        try:
            data = json.loads(self._room.metadata or "{}")
        except ValueError:
            return 0
        floor = data.get("floor") if isinstance(data, dict) else None
        value = floor.get("continued") if isinstance(floor, dict) else None
        return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else 0

    def _handle_metadata_changed(self, _old: str, _new: str) -> None:
        if self.on_notes_policy_changed:
            self.on_notes_policy_changed()
        if self.on_floor_changed:
            self.on_floor_changed()

    async def send_signal(self, message: dict[str, object], to: list[str] | None = None) -> None:
        """A mooz.v0 message to everyone, or only to `to`. LiveKit stamps us as the sender."""
        await self._room.local_participant.publish_data(
            json.dumps(message), reliable=True, topic=MOOZ_TOPIC, destination_identities=to or []
        )

    def _handle_data(self, packet: rtc.DataPacket) -> None:
        if packet.topic != MOOZ_TOPIC or packet.participant is None or not self.on_signal:
            return
        try:
            message = json.loads(packet.data)
        except ValueError:
            return
        if isinstance(message, dict):
            self.on_signal(speaker_from_participant(packet.participant), message)

    # -- presence ------------------------------------------------------------------

    def _handle_participant_connected(self, participant: rtc.RemoteParticipant) -> None:
        self._track_opt_out(participant)
        self._handle_participant_change(participant)
        if self.on_participant_joined:
            self.on_participant_joined(speaker_from_participant(participant))

    def _handle_participant_change(self, _participant: rtc.RemoteParticipant) -> None:
        humans = [p for p in self.participants() if p.kind == "human"]
        if humans:
            if self._alone_timer:
                self._alone_timer.cancel()
                self._alone_timer = None
        elif self._alone_timer is None:
            log.info(
                "everyone left; leaving in %.0fs unless someone returns", self.alone_grace_seconds
            )
            loop = asyncio.get_running_loop()
            self._alone_timer = loop.call_later(self.alone_grace_seconds, self._closed.set)

    async def wait_closed(self) -> None:
        """Return when the meeting ends for us (left, removed by the host, or connection lost)."""
        await self._closed.wait()

    async def send_chat(
        self,
        text: str,
        reply_to: str | None = None,
        sources: frozenset[str] = frozenset(),
        to: list[str] | None = None,
    ) -> None:
        """Post to chat (or only to `to`, marked private), saying whom it answers and whose words
        it drew on."""
        attributes: dict[str, str] = {}
        if reply_to:
            attributes[REPLY_TO_ATTRIBUTE] = reply_to
        if sources:
            attributes[SOURCES_ATTRIBUTE] = ",".join(sorted(sources))
        if to:
            attributes[PRIVATE_ATTRIBUTE] = "1"
        await self._room.local_participant.send_text(
            _wire(text), topic=CHAT_TOPIC, attributes=attributes or None, destination_identities=to
        )

    async def send_task_event(
        self, message: dict[str, object], to: list[str] | None = None
    ) -> None:
        """A task update on mooz.tasks, to everyone or only to `to`."""
        # As written, not \uXXXX: escaped, a long result in another alphabet outgrows what
        # the task panel reads.
        await self._room.local_participant.send_text(
            _wire(json.dumps(message, ensure_ascii=False)),
            topic=TASKS_TOPIC,
            destination_identities=to,
        )

    async def disconnect(self) -> None:
        if self._alone_timer:
            self._alone_timer.cancel()
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
            self._audio_sid[participant.identity] = track.sid
            self.on_human_track(speaker, track)

    def _handle_track_unsubscribed(
        self,
        track: rtc.Track,
        _publication: rtc.RemoteTrackPublication,
        participant: rtc.RemoteParticipant,
    ) -> None:
        # Only end the stream for the track we are transcribing (not a second or stale one).
        if track.kind != rtc.TrackKind.KIND_AUDIO:
            return
        if self._audio_sid.get(participant.identity) != track.sid:
            return
        del self._audio_sid[participant.identity]
        if self.on_human_track_ended:
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
        speaker = speaker_from_participant(participant)
        attrs = (reader.info.attributes or {}) if speaker.kind == "agent" else {}
        # Only an agent's reply says whom it answers; a person's message is about themselves.
        about = attrs.get(REPLY_TO_ATTRIBUTE) or None
        sources = frozenset(i for i in attrs.get(SOURCES_ATTRIBUTE, "").split(",") if i)
        self.on_chat(ChatMessage(speaker, text, time.time(), about=about, sources=sources))
