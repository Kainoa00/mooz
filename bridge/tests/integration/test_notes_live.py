"""Notes consent as the bridge reads it from a real LiveKit room (set by the server API)."""

import asyncio
import json

import pytest
from livekit import api, rtc

from mooz_agent.room import MOOZ_TOPIC, ChatMessage, MeetingRoom

from .conftest import API_KEY, API_SECRET, LIVEKIT_URL, mint
from .test_room_live import wait_for

pytestmark = pytest.mark.integration


async def test_reads_policy_and_opt_outs_and_signals(room_name: str) -> None:
    agent = MeetingRoom()
    policy_changes: list[bool] = []
    agent.on_notes_policy_changed = lambda: policy_changes.append(agent.notes_allowed())
    await agent.connect(LIVEKIT_URL, mint(room_name, "a_it", "Atlas", {"kind": "agent"}))

    human = rtc.Room()
    signals: list[tuple[str, dict[str, object]]] = []

    def on_data(packet: rtc.DataPacket) -> None:
        if packet.topic == MOOZ_TOPIC and packet.participant is not None:
            signals.append((packet.participant.identity, json.loads(packet.data)))

    human.on("data_received", on_data)
    await human.connect(LIVEKIT_URL, mint(room_name, "p_zach", "Zach", {"kind": "human"}))
    lk = api.LiveKitAPI(LIVEKIT_URL.replace("ws", "http"), API_KEY, API_SECRET)
    try:
        await wait_for(lambda: len(agent.participants()) == 1)
        assert agent.notes_allowed() is False
        assert agent.is_opted_out("p_zach") is False

        await lk.room.update_room_metadata(
            api.UpdateRoomMetadataRequest(room=room_name, metadata='{"notes_allowed": true}')
        )
        await wait_for(lambda: policy_changes == [True])
        assert agent.notes_allowed() is True

        await lk.room.update_participant(
            api.UpdateParticipantRequest(
                room=room_name, identity="p_zach", attributes={"notes_opt_out": "1"}
            )
        )
        await wait_for(lambda: agent.is_opted_out("p_zach"))

        await agent.send_signal({"type": "notes", "state": "on"})
        await agent.send_signal({"type": "notes", "state": "off"}, to=["p_zach"])
        await wait_for(lambda: len(signals) == 2)
        assert signals == [
            ("a_it", {"type": "notes", "state": "on"}),
            ("a_it", {"type": "notes", "state": "off"}),
        ]

        await human.disconnect()
        await asyncio.sleep(0.5)
        assert agent.is_opted_out("p_zach")  # still left out after leaving
    finally:
        await lk.aclose()
        await human.disconnect()
        await agent.disconnect()


async def test_replies_say_whom_they_answer_and_queries_reach_agents(room_name: str) -> None:
    atlas, grok = MeetingRoom(), MeetingRoom()
    heard: list[ChatMessage] = []
    queries: list[tuple[str, dict[str, object]]] = []
    grok.on_chat = heard.append
    atlas.on_signal = lambda speaker, message: queries.append((speaker.identity, message))
    await atlas.connect(LIVEKIT_URL, mint(room_name, "a_atlas", "Atlas", {"kind": "agent"}))
    await grok.connect(LIVEKIT_URL, mint(room_name, "a_grok", "Grok", {"kind": "agent"}))
    human = rtc.Room()
    await human.connect(LIVEKIT_URL, mint(room_name, "p_zach", "Zach", {"kind": "human"}))
    try:
        await wait_for(lambda: len(atlas.participants()) == 2 and len(grok.participants()) == 2)
        await atlas.send_chat("You asked: when is lunch", reply_to="p_zach")
        await wait_for(lambda: len(heard) == 1)
        assert heard[0].about == "p_zach" and heard[0].speaker.identity == "a_atlas"

        await human.local_participant.publish_data(
            json.dumps({"type": "notes?"}), reliable=True, topic=MOOZ_TOPIC
        )
        await wait_for(lambda: len(queries) == 1)
        assert queries == [("p_zach", {"type": "notes?"})]
    finally:
        await human.disconnect()
        await grok.disconnect()
        await atlas.disconnect()
