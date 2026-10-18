"""Run an agent in a meeting until interrupted."""

from __future__ import annotations

import asyncio
import logging

from .claim import AgentGrant
from .room import MeetingRoom

log = logging.getLogger(__name__)


async def run(grant: AgentGrant) -> None:
    room = MeetingRoom()
    room.on_chat = lambda msg: log.info("chat from %s: %s", msg.speaker.name, msg.text)
    await room.connect(grant.url, grant.token)
    try:
        await asyncio.Event().wait()
    finally:
        await room.disconnect()
