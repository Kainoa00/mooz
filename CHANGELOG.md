# Changelog

All notable changes to mooz (the web app and `mooz-agent`, which share a version). The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/) (before 1.0, a minor version may break things; the
upgrade notes say how).

## [0.1.0] - Unreleased

The first release: video meetings where everyone can bring their own AI agent.

### Added

- **Meetings by link.** Start a meeting, share the link, join with a name. Audio, video and
  chat through [LiveKit](https://livekit.io). Whoever starts the meeting is its host.
- **Bring your own agent (`mooz-agent`).** A Python bridge on the owner's machine joins with a
  one-time code once the host approves. It hears each person, answers by voice and in chat
  when its name is said or typed (`@Atlas`), and is always shown as `🤖 Owner's Name` with an
  agent badge.
- **Brains and voices.** Claude or Grok, with the owner's keys. ElevenLabs for hearing and
  speech, or any OpenAI-compatible speech server on the owner's machine, such as VoiceStudio.
- **A personal agent.** Folders and GitHub repos it may read (read-only, secrets hidden,
  private unless marked public), memory the owner controls, and private answers ("privately",
  "DM me"). Everyone else gets only what's public, enforced in code by who is asking.
- **Meeting notes with consent.** The host allows them, an owner asks for them, everyone sees
  a banner, and anyone can choose **Leave me out**. Notes are summaries in the owner's private
  memory, never transcripts.
- **Background research.** "Atlas, look into why CI is flaky": the agent says "On it", works
  through files, GitHub and the web, and reports back. A task panel shows what each agent is
  doing.
- **The connector door.** Bring the Grok, Claude or ChatGPT app you already use through a
  private MCP link. Questions reach your app after one tap; its answers are posted and, with
  voice on, spoken from your browser.
- **Many agents.** One speaker at a time, people first, agent-to-agent replies that pause
  after 3 for anyone to **Continue**, and names that can't be confused (by sound or by look).
- **The host's summary.** A Markdown file of what agents said in public, who was there and
  when the agents paused, built in the host's tab. Never anyone's own words or private
  answers (from agents that mark them, as mooz's do).
- **Running it for others.** A production kit (`deploy/`: Caddy for HTTPS, LiveKit without
  dev mode, the web image from GHCR), a [VPS guide](docs/deploy-vps.md), `/api/ready`, and a
  server that refuses to start with weak or missing settings.
- `mooz-agent --version`. The bridge reads its keys from `~/.mooz/.env` (or your
  environment), never from a `.env` in the folder you run it in, which a project could use to
  send your keys elsewhere.

### Security

- Every agent needs the host's approval; codes are single-use and expire in 10 minutes; agent
  tokens are single-issue and short-lived. Agents publish only audio and chat and can't
  relabel themselves.
- No AI or voice keys on the server. Each owner's keys stay on their machine or in their
  browser.
- Rate limits per person, meeting and claim, with server-wide ceilings, and small caps on
  request bodies. No IP addresses kept.
- When a meeting ends the server forgets who was in it; sessions expire 24 hours after the
  last join; a room's link and notes policy are kept for 30 days without use. Deleted rows are
  overwritten (`secure_delete`).
- Pages run only scripts with a per-request nonce, connect only to the mooz server, its
  LiveKit, ElevenLabs and a speech server on the viewer's own computer, and can't be framed.
- Report vulnerabilities privately: see [SECURITY.md](SECURITY.md).

### Known limits

- Prompt injection on an owner's own turns is mitigated, not eliminated: what the AI does with
  what it may see is up to the model. Access for everyone else is enforced in code.
- Opt-outs can't catch someone else repeating your words, or agents not built on mooz that
  don't mark whose words they used.
- Only the first of several names said aloud is heard; `@Atlas @Nova` reaches both.
- Turn-taking, rate limits and connector questions live in the web server's memory: run one
  instance, and a restart drops answers waiting for a turn.
- Server-wide ceilings (new meetings and new connectors a minute, the number of connectors) can
  be used up by one client, since mooz keeps no IP addresses: on a public server, add per-IP
  limits in the proxy (see the server guide), per /64 for IPv6; a client with many addresses
  still gets past them.
- Local voice in the browser works in Chrome, Edge and Firefox; Safari and iPhone or iPad
  browsers block it. On a CPU, local speech is much slower than on a GPU or Apple Silicon.
- The memory file lock uses `fcntl`: on Windows, avoid the CLI's memory commands while the
  agent is in a meeting.
- Not yet checked live with real keys at release time: see the release notes for which of the
  ElevenLabs, VoiceStudio, two-agent, connector-app and VPS checks ran.

### Upgrade notes

For anyone who ran mooz from `main` before this release:

- The database upgrades itself on start. Room links count as used at the upgrade, so they're
  kept 30 days from then (if you ran a build from `main` that counted them as used when they
  were made, links made over 30 days before it are already gone). Sessions from before it end 24 hours after that person first joined
  (so some end at once: join again), and meetings that ended are forgotten at the next sweep.
- The bridge no longer reads `bridge/.env`: move your keys to `~/.mooz/.env`
  (`mkdir -p ~/.mooz && mv -n bridge/.env ~/.mooz/.env && chmod 600 ~/.mooz/.env`). If
  `~/.mooz/.env` already exists, `mv -n` moves nothing: copy the keys you need across by hand
  (not empty `KEY=` lines, which would hide a real value), then delete `bridge/.env`.
- Bridges from before M5 don't take turns, and ones from before M6 stop if the server says
  they're polling too fast: update (`uv tool upgrade mooz-agent`, or `git pull && uv sync`).
- A connector made with a name the M5 rules refuse can't join: delete it and make one with
  another name.
- `deploy/` replaces running the development `docker compose` on a server, which uses
  LiveKit's public dev keys and must never be exposed.

[0.1.0]: https://github.com/kainoa00/mooz/releases/tag/v0.1.0
