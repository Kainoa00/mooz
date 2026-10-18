# mooz

**Video meetings where everyone can bring their own AI agent.** Ask it out loud ("Hey Atlas,
what's blocking the deploy?") and it answers in the call, by voice and in chat, using what it
heard in the meeting.

- **Your agent, your keys.** Each agent runs on its owner's machine and connects out to the
  meeting. The mooz server never holds anyone's AI or voice keys.
- **The host stays in control.** Every agent waits for the host's approval before it can hear
  anything, and the host can remove it at any time.
- **Agents never pass as people.** They're always shown as `🤖 Kainoa's Atlas` with an agent
  badge.
- **It speaks only when addressed.** Say its name or type `@Atlas`. Just mentioning it ("I asked
  Atlas yesterday") doesn't wake it.
- **Self-hosted and open source** under the MIT license.

> **Status: v0.1 in progress.** Milestone 1 works: people meet by link, a person brings an
> agent, and the agent answers when addressed. Next up are persistent memory and repo access
> (M2), long research tasks (M3), and connecting your existing Grok / Claude / ChatGPT app
> (M4). See the [roadmap](#roadmap).

## Quickstart (local)

You need Docker, Node 22 with pnpm, and [uv](https://docs.astral.sh/uv/).

```bash
git clone https://github.com/kainoa00/mooz && cd mooz
cp .env.example .env
docker compose up -d            # LiveKit media server + the mooz web app
open http://localhost:3000      # start a meeting and share the link
```

### Bring your agent

In the meeting, click **Bring my agent** and copy the command. On the machine where your
agent will run:

```bash
cd bridge
cp .env.example .env            # add ANTHROPIC_API_KEY and ELEVEN_API_KEY (your keys, your machine)
uv sync
uv run mooz-agent connect ABCD-EFGH-JKLM --server http://localhost:3000 --name Atlas
```

The host approves the agent. Then say **"Hey Atlas, …"** or type **`@Atlas …`** in chat.

- **No keys yet?** Run the bridge with `MOOZ_PROVIDERS=fake` for an offline demo. The agent
  repeats your question back in chat and makes no audio.
- **Choosing a model:** the agent uses `claude-opus-5-5` at low effort, which keeps spoken
  replies fast. Override it with `MOOZ_CLAUDE_MODEL`.
- **Choosing a voice:** set `MOOZ_VOICE_ID` to any voice in your ElevenLabs library.

### What it costs

**Each agent owner pays for their own agent.** People who don't bring an agent pay nothing.

- **Hearing:** the agent transcribes every person in the meeting, all the time, so it can
  notice its name. Scribe v2 Realtime bills per minute of audio.
- **Answering:** Claude and ElevenLabs voice are billed only when someone actually talks to
  the agent.

ElevenLabs runs in zero-retention mode, so it keeps no audio.

## How it works

```
 Meeting (mooz server)                         Agent owner's machine
 ┌─────────────────────────────┐   outbound    ┌──────────────────────────┐
 │ Next.js app: rooms, links,  │   LiveKit     │ mooz-agent bridge        │
 │ host approval, agent tokens │◄─────────────►│  hears each person (STT) │
 │ LiveKit: audio/video/chat   │   WebRTC +    │  notices its name        │
 └─────────────────────────────┘   chat        │  asks Claude, speaks     │
                                               └──────────────────────────┘
```

- `apps/web`: the Next.js app (rooms, join links, the approval flow, the meeting UI).
- `bridge`: `mooz-agent`, a Python package that is both the CLI and an SDK.
- [`docs/protocol.md`](docs/protocol.md): the bridge protocol, for connecting agents written
  in any language.

## Development

```bash
pnpm install
docker compose up -d livekit
pnpm -C apps/web dev                                  # http://localhost:3000
pnpm -C apps/web test && pnpm -C apps/web test:e2e    # unit + Playwright (uses the bridge)
cd bridge && uv run pytest -m "not live"              # unit + integration (needs LiveKit)
MOOZ_LIVE_TESTS=1 uv run pytest -m live               # real Claude/ElevenLabs calls (costs money)
```

The project's planning documents are in `.claude/prds/` (requirements) and `.claude/plans/`
(milestone plans).

## Roadmap

| Milestone | What you get |
|---|---|
| **M1 ✅ First agent in the room** | Meet by link. Host-approved agents that answer by voice and chat when addressed |
| M2 Personal agent with memory | Claude or Grok brains, memory across meetings, your repos and folders, owner-only tasks |
| M3 Async research tasks | "On it". It works in the background and reports back mid-meeting |
| M4 Connector | Bring the Grok / Claude / ChatGPT app you already use, with its memory, via a private MCP link |
| M5 Many agents | One speaker at a time, agent-to-agent conversations with a "Continue?" pause |
| M6 Local voice and launch | VoiceStudio / any OpenAI-compatible local speech server, VPS guide, security hardening |

## Security

Hosts approve every agent, codes are single-use, and agent tokens are single-issue and
short-lived. Agents can publish only audio and chat, and can't relabel themselves. The
local `docker compose` setup uses LiveKit's public dev keys and listens only on localhost.
**Don't expose it to a network as-is.** Outside localhost, the server refuses weak LiveKit
secrets. A production guide comes with M6.

## License

MIT
