"""`mooz-agent connect CODE --server URL --name NAME`: bring your agent into a meeting."""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from collections.abc import Sequence
from pathlib import Path

import httpx
from dotenv import load_dotenv

from .claim import AgentGrant, ClaimError, claim_code, wait_for_approval
from .config import AgentConfig, ConfigError

log = logging.getLogger("mooz_agent")


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="mooz-agent", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    def agent_option(p: argparse.ArgumentParser) -> None:
        p.add_argument(
            "--agent",
            default=os.environ.get("MOOZ_AGENT"),
            help="which personal agent to use (created with `mooz-agent init`; env: MOOZ_AGENT)",
        )

    connect = sub.add_parser("connect", help="join a meeting with a one-time code")
    connect.add_argument("code", help="the code shown under 'Bring my agent'")
    connect.add_argument("--server", required=True, help="the meeting's web address")
    agent_option(connect)
    connect.add_argument(
        "--name",
        default=os.environ.get("MOOZ_AGENT_NAME"),
        help="join as a basic agent with this name and no sources (env: MOOZ_AGENT_NAME)",
    )
    connect.add_argument("-v", "--verbose", action="store_true")

    init = sub.add_parser("init", help="create a personal agent")
    init.add_argument("name", help="its name, which is also its wake word")
    init.add_argument("--brain", choices=["claude", "grok"], default="claude")
    init.add_argument("--model", help="override the default model for that brain")
    init.add_argument("--voice", dest="voice_id", help="ElevenLabs voice ID")
    init.add_argument(
        "--source",
        action="append",
        default=[],
        help="a folder (or github:owner/repo) it may read, privately",
    )
    init.add_argument(
        "--public-source",
        action="append",
        default=[],
        help="a folder (or github:owner/repo) anyone in the meeting may ask about",
    )
    init.add_argument(
        "--no-web-search",
        dest="web_search",
        action="store_false",
        help="don't let research tasks search the web",
    )
    init.add_argument("--force", action="store_true", help="replace an existing agent's settings")

    sources = sub.add_parser(
        "sources", help="manage the folders and GitHub repos an agent may read"
    )
    sources_sub = sources.add_subparsers(dest="action", required=True)
    s_list = sources_sub.add_parser("list")
    agent_option(s_list)
    s_add = sources_sub.add_parser("add")
    s_add.add_argument("path", help="a folder, or github:owner/repo")
    s_add.add_argument("--label")
    s_add.add_argument("--public", action="store_true", help="anyone in the meeting may ask")
    agent_option(s_add)
    s_remove = sources_sub.add_parser("remove")
    s_remove.add_argument("label")
    agent_option(s_remove)

    memory = sub.add_parser("memory", help="see or edit what an agent remembers")
    memory_sub = memory.add_subparsers(dest="action", required=True)
    m_list = memory_sub.add_parser("list")
    agent_option(m_list)
    m_add = memory_sub.add_parser("add")
    m_add.add_argument("text")
    m_add.add_argument("--public", action="store_true", help="anyone in a meeting may hear this")
    agent_option(m_add)
    m_forget = memory_sub.add_parser("forget")
    m_forget.add_argument("id")
    agent_option(m_forget)

    return parser.parse_args(argv)


def _load_agent(args: argparse.Namespace) -> AgentConfig:
    if not args.agent:
        raise ConfigError("Say which agent with --agent NAME (or set MOOZ_AGENT)")
    return AgentConfig.load(args.agent)


def cmd_init(args: argparse.Namespace) -> int:
    from .config import agent_dir

    if (agent_dir(args.name) / "agent.toml").exists() and not args.force:
        raise ConfigError(f"{args.name} already exists. Use --force to replace its settings.")
    cfg = AgentConfig(
        name=args.name.strip(),
        brain=args.brain,
        model=args.model,
        voice_id=args.voice_id,
        web_search=args.web_search,
    )
    cfg.validate()
    for path in args.source:
        _add(cfg, path)
    for path in args.public_source:
        _add(cfg, path, public=True)
    target = cfg.save()
    print(f"Created {cfg.name} ({cfg.brain}) at {target.parent}")
    _print_sources(cfg)
    return 0


def _add(cfg: AgentConfig, path: str, *, label: str | None = None, public: bool = False) -> str:
    if path.startswith("github:"):
        repo = cfg.add_github(path, label=label, public=public)
        return repo.label
    return cfg.add_source(Path(path), label=label, public=public).label


def _print_sources(cfg: AgentConfig) -> None:
    if not cfg.sources and not cfg.github:
        print("  No sources yet. Add one with: mooz-agent sources add PATH --agent " + cfg.name)
    for s in cfg.sources:
        print(f"  {s.label:<20} {'public ' if s.public else 'private'}  {s.path}")
    for g in cfg.github:
        print(f"  {g.label:<20} {'public ' if g.public else 'private'}  github:{g.repo}")
    print(f"  Web search for research tasks: {'on' if cfg.web_search else 'off'}")


def cmd_sources(args: argparse.Namespace) -> int:
    cfg = _load_agent(args)
    if args.action == "add":
        label = _add(cfg, args.path, label=args.label, public=args.public)
        cfg.save()
        print(f"Added {label} ({'public' if args.public else 'private'})")
    elif args.action == "remove":
        cfg.remove_source(args.label)
        cfg.save()
        print(f"Removed {args.label}")
    _print_sources(cfg)
    return 0


def cmd_memory(args: argparse.Namespace) -> int:
    from .memory import MemoryStore

    cfg = _load_agent(args)
    store = MemoryStore(cfg.memory_path)
    if args.action == "add":
        try:
            note = store.remember(args.text, public=args.public)
        except ValueError as err:
            raise ConfigError(str(err)) from err
        print(f"Remembered {note.id}")
    elif args.action == "forget":
        if not store.forget(args.id):
            raise ConfigError(f"No note called {args.id}")
        print(f"Forgot {args.id}")
    else:
        notes = store.all(owner=True)
        if not notes:
            print(f"{cfg.name} doesn't remember anything yet.")
        for n in notes:
            print(f"{n.id}  {'public ' if n.public else 'private'}  {n.text}")
    return 0


async def obtain_grant(*, server: str, code: str, name: str) -> AgentGrant:
    try:
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
    except httpx.HTTPError as err:
        raise ClaimError("network", f"Could not reach {server}: {err}") from err


async def run_agent(grant: AgentGrant, config: AgentConfig) -> None:
    from .agent import run  # imported lazily: pulls in LiveKit and model SDKs

    await run(grant, config)


def cmd_connect(args: argparse.Namespace) -> int:
    from .providers import ProviderConfigError, check_environment

    if args.agent:
        config = AgentConfig.load(args.agent)
    elif args.name:
        config = AgentConfig(name=args.name)
        config.validate()
    else:
        print(
            "mooz-agent: say which agent with --agent NAME (or --name NAME for a basic agent)",
            file=sys.stderr,
        )
        return 2
    try:
        check_environment(config.brain)
    except ProviderConfigError as err:
        print(f"mooz-agent: {err}", file=sys.stderr)
        return 2
    try:
        grant = asyncio.run(obtain_grant(server=args.server, code=args.code, name=config.name))
        print(
            f"Approved. {grant.name} is joining the meeting. Press Ctrl-C to leave.",
            file=sys.stderr,
        )
        asyncio.run(run_agent(grant, config))
    except ClaimError as err:
        print(f"mooz-agent: {err}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("Left the meeting.", file=sys.stderr)
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    load_dotenv()
    args = parse_args(sys.argv[1:] if argv is None else argv)
    logging.basicConfig(
        level=logging.DEBUG if getattr(args, "verbose", False) else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    commands = {
        "connect": cmd_connect,
        "init": cmd_init,
        "sources": cmd_sources,
        "memory": cmd_memory,
    }
    try:
        return commands[args.command](args)
    except ConfigError as err:
        print(f"mooz-agent: {err}", file=sys.stderr)
        return 2
