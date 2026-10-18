import os
import uuid

import pytest
from livekit import api

LIVEKIT_URL = os.environ.get("LIVEKIT_URL", "ws://localhost:7880")
API_KEY = os.environ.get("LIVEKIT_API_KEY", "devkey")
API_SECRET = os.environ.get("LIVEKIT_API_SECRET", "secret")


@pytest.fixture
def room_name() -> str:
    return f"it-{uuid.uuid4().hex[:8]}"


def mint(room: str, identity: str, name: str, attributes: dict[str, str]) -> str:
    """Mint tokens the way the mooz server does (see apps/web/lib/livekit.ts)."""
    grants = api.VideoGrants(
        room_join=True,
        room=room,
        can_publish=True,
        can_subscribe=True,
        can_publish_data=True,
        can_update_own_metadata=False,
    )
    return (
        api.AccessToken(API_KEY, API_SECRET)
        .with_identity(identity)
        .with_name(name)
        .with_attributes(attributes)
        .with_grants(grants)
        .to_jwt()
    )
