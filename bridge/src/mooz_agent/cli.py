"""`mooz-agent connect CODE --server URL --name NAME`: bring your agent into a meeting."""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from collections.abc import Sequence

import httpx
from dotenv import load_dotenv

from .claim import AgentGrant, ClaimError, claim_code, wait_for_approval

log = logging.getLogger("mooz_agent")


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="mooz-agent", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    connect = sub.add_parser("connect", help="join a meeting with a one-time code")
    connect.add_argument("code", help="the code shown under 'Bring my agent'")
    connect.add_argument("--server", required=True, help="the meeting's web address")
    connect.add_argument(
        "--name",
        default=os.environ.get("MOOZ_AGENT_NAME"),
        help="your agent's name, which is also its wake word (env: MOOZ_AGENT_NAME)",
    )
    connect.add_argument("-v", "--verbose", action="store_true")
    return parser.parse_args(argv)


async def obtain_grant(*, server: str, code: str, name: str) -> AgentGrant:
    async with httpx.AsyncClient(timeout=15) as http:
        ticket = await claim_code(http, server, code=code, name=name)
        return await wait_for_approval(
            http,
            server,
            request_id=ticket.request_id,
            claim_secret=ticket.claim_secret,
            on_pending=lambda: print(
                "Waiting for the host to approve your agent…", file=sys.stderr
            ),
        )


async def run_agent(grant: AgentGrant) -> None:
    from .agent import run  # imported lazily: pulls in LiveKit and model SDKs

    await run(grant)


def main(argv: Sequence[str] | None = None) -> int:
    load_dotenv()
    args = parse_args(sys.argv[1:] if argv is None else argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    if not args.name:
        print("mooz-agent: --name is required (or set MOOZ_AGENT_NAME)", file=sys.stderr)
        return 2
    from .providers import ProviderConfigError, check_environment

    try:
        check_environment()
    except ProviderConfigError as err:
        print(f"mooz-agent: {err}", file=sys.stderr)
        return 2
    try:
        grant = asyncio.run(obtain_grant(server=args.server, code=args.code, name=args.name))
        print(
            f"Approved. {grant.name} is joining the meeting. Press Ctrl-C to leave.",
            file=sys.stderr,
        )
        asyncio.run(run_agent(grant))
    except ClaimError as err:
        print(f"mooz-agent: {err}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("Left the meeting.", file=sys.stderr)
    return 0
