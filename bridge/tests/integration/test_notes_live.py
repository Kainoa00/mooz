"""Notes consent as the bridge reads it from a real LiveKit room (set by the server API)."""

import asyncio
import json

import pytest
from livekit import api, rtc

from mooz_agent.room import MOOZ_TOPIC, MeetingRoom

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
