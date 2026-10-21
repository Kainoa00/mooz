"""Which addresses are this machine, and HTTP clients that reach it directly."""

from __future__ import annotations

import ipaddress
from collections.abc import Iterable
from typing import Any
from urllib.parse import urlsplit

import httpx


def is_this_machine(host: str) -> bool:
    """localhost, or a loopback IP address (127.0.0.0/8, ::1): not a name that starts with 127."""
    host = host.lower().rstrip(".").strip("[]")
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def direct_client(urls: Iterable[str] = (), **kwargs: Any) -> httpx.AsyncClient:
    """An httpx client that never sends a request for this machine (localhost, 127.0.0.1, ::1,
    and any loopback host in `urls`) through a proxy, from HTTP_PROXY or the system settings:
    httpx makes no exception for loopback, so plain-http speech or a local mooz would go to it."""
    hosts = {"127.0.0.1", "localhost", "[::1]"}
    for url in urls:
        host = urlsplit(url).hostname or ""
        if is_this_machine(host):
            hosts.add(f"[{host}]" if ":" in host else host)
    return httpx.AsyncClient(mounts={f"all://{h}": None for h in sorted(hosts)}, **kwargs)
