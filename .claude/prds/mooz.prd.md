# mooz

## Problem
People already rely on personal AI assistants (Grok, Claude, ChatGPT, Muse, Instinct, self-run agents) that hold their project context, code knowledge and memory. Video meetings are where questions about that context come up, but there is no way to bring your assistant into a call. Today someone has to alt-tab, retype the question into a side window and read the answer back to the group. Meeting AI tools that exist (Zoom AI Companion, Otter and similar) only listen and summarize. They are the vendor's assistant, not yours, and they cannot speak in the call with your context.

## Evidence
- Founder's own workflow: meetings with collaborators (e.g. Zach) where questions about code and projects need an assistant that already has the context.
- Market scan (Oct 2026): joinly, Vexa and Attendee are open-source bots that join Zoom, Meet or Teams. None combines its own call app, voice participation, and an agent that brings its owner's context. Vexa's open-core version cannot speak.
- Platform reality (Oct 2026): consumer assistants expose no API to their memory, but Grok and Claude accept custom MCP connectors. ChatGPT accepts them read-only on Plus and Pro, with write actions on Business, Enterprise and Edu.
- Assumption: other people want this enough to self-host it. Needs validation via an open-source launch (stars, issues, demo-video engagement) and 5 user interviews.

## Users
- **Primary**: a person who already uses a personal AI assistant or runs their own agent, and meets by video with collaborators: developers, founders, students on group projects. Trigger: a question comes up mid-call that "my assistant would know."
- **Secondary**: meeting guests without an agent. They join by link and can ask other people's agents questions.
- **Not for**: enterprises needing compliance recording, people who want Zoom or Meet itself augmented (v0.1), or anyone wanting a vendor-hosted SaaS (v0.1 is self-host only).

## Hypothesis
We believe **a meeting room where each participant can bring their own personal AI assistant, which listens, answers by voice when addressed, and reports back on longer research** will **remove the alt-tab-and-relay friction of using AI during calls** for **people who already rely on a personal assistant**.
We'll know we're right when **people who complete setup use an agent in at least 50% of the meetings they host in their first two weeks, and the repo earns at least 500 GitHub stars within 60 days of launch**.

## Success Metrics
| Metric | Target | How measured |
|---|---|---|
| Name-spoken to agent-voice-start latency (live bridge, cloud voice) | p50 under 2.5s, p95 under 4s | Bridge timing logs in the demo meeting |
| Connector round trip (question asked to assistant speaks) | p50 under 25s including the owner's tap | Server timestamps on queued and answered questions |
| Clone-to-first-meeting setup time | under 10 minutes on a laptop | Timed fresh-install runs from the README |
| Agent addressed correctly (no false wakes) | at least 95% correct, false wakes under 1 per meeting-hour | Scripted test meetings |
| Adoption | 500 stars in 60 days | GitHub |
| Repeat use | at least 50% of hosted meetings include an agent | TBD: needs validation via opt-in local stats or interviews (no telemetry by default) |

## Scope
**MVP (v0.1)**
- Web app (browser): create a meeting, share a link, join with a display name. No accounts.
- Video, audio and chat for two or more people.
- **Bring my agent, two ways in, host approves each agent:**
  - **Live bridge**: a `mooz-agent` program on the owner's machine joins as a participant, hears the meeting, and answers when its name is said. Ships with a Python SDK, a documented bridge protocol, and a ready-made personal agent (Claude or Grok brain, persistent local memory, access to local repos and folders).
  - **Connector**: a private MCP connector link that the owner pastes into Grok, Claude or ChatGPT. When someone addresses that assistant, mooz queues the question and shows the owner a one-tap prefilled link (with a copy fallback). The assistant reads the meeting through the connector and posts its answer, which mooz speaks.
- Agents answer only when addressed by name, both spoken and in chat. Names are unique per meeting, and common words and "mooz" are blocked.
- Multiple agents per meeting with one speaker at a time. Agents may address each other, and agents pause after 3 consecutive agent turns with no human until someone clicks Continue.
- Async research tasks: the agent says "on it", keeps listening, and reports back by voice and chat, with a task panel in the UI.
- Access rules: anyone may ask an agent questions. Only the owner can start long tasks. For live-bridge agents, a non-owner asker gets answers only from data the owner marked public, enforced at the tool layer. For connector assistants, the owner's tap is the safeguard.
- Voice runs on each agent owner's side (bridge process or browser tab), using the owner's ElevenLabs key (speech-to-text and voice) or any OpenAI-compatible local speech server (VoiceStudio documented). The mooz server holds no AI or voice keys.
- Agents are always labeled ("🤖 Kainoa's Grok", agent badge on tile) and can never appear as a human participant.
- Nothing is persisted on the mooz server after a meeting except settings (SQLite). The host can export a meeting summary before leaving.
- Opt-in meeting notes. The host allows them, an agent's owner asks for them, and everyone sees a banner. Anyone can opt out, and their words are left out. The notes are saved as a summary, not a transcript, to the owner's private memory on the owner's machine.
- `docker compose up` for local use, plus a deployment guide for a small VPS with HTTPS. MIT license. README with a demo video.

**Out of scope**
- Recording or saving verbatim transcripts, audio or video: privacy default. Opt-in notes save summaries only.
- Mobile apps: the browser is enough for v0.1.
- Joining Zoom, Meet or Teams: Zoom's bot review and auth burden per self-hoster is too heavy (v0.2+ adapter, via Recall.ai or a browser bot).
- Phone dial-in (needed for Instinct and phone-based agents): requires a paid SIP trunk (v0.2).
- Muse via its own connector and A2A protocol support (v0.2).
- Accounts and OAuth: private links stand in for auth in v0.1.
- Pulling memory out of consumer apps: not possible with today's APIs.
- Hosted SaaS: self-host only.
- Bundling VoiceStudio: it stays a separate optional app, to keep mooz MIT-licensed and the install small.

## Delivery Milestones
<!-- Status: pending | in-progress | complete -->

| # | Milestone | Outcome | Status | Plan |
|---|---|---|---|---|
| 1 | First agent in the room | Two people meet by link. One brings a live-bridge agent (host-approved) that answers in chat and by voice when its name is said (live voice check pending keys) | complete | `.claude/plans/m1-first-agent-in-the-room.plan.md` |
| 2 | Personal agent with memory | The ready-made agent has Claude or Grok brains, persistent memory, local repo and folder access, and owner-only tasks with public-data rules, plus opt-in meeting notes (live Claude/Grok checks pending keys) | complete | `.claude/plans/m2-personal-agent-with-memory.plan.md` |
| 3 | Async research tasks | "On it" with background work, spoken and chat progress, and a task panel; GitHub issues, PRs and CI; web search; private answers (live Claude/Grok/GitHub checks pending keys) | complete | `.claude/plans/m3-async-research-tasks.plan.md` |
| 4 | Connector door | Grok, Claude or ChatGPT joins via a private MCP link: queued question, one-tap prefill, browser-side voice | complete | `.claude/plans/m4-connector-door.plan.md` |
| 5 | Many agents, one floor | Multiple agents, one speaker at a time (people first), agent-to-agent with the 3-turn pause and Continue, names the detector could confuse refused (live two-agent check pending keys) | complete | `.claude/plans/m5-many-agents-one-floor.plan.md` |
| 6 | Local voice and launch | OpenAI-compatible local voice (VoiceStudio), VPS guide, meeting summary export, security hardening backlog (below), README and demo, v0.1 release | in-progress | `.claude/plans/m6-local-voice-and-launch.plan.md` |

## Open Questions
- [x] Do grok.com, chatgpt.com and claude.ai `?q=` prefill links still work at build time? Yes, as of October 2026 (third-party reports): ChatGPT sends the prompt at once; Claude (`/new?q=`) and Grok fill it in and wait for Enter. They are still undocumented, so mooz always offers Copy prompt and Paste the answer too, and the live check confirms them.
- [ ] Can an HTTPS meeting page call a local speech server at `http://localhost:3900` (mixed content and Private Network Access rules) in Chrome, Safari and Firefox? Verify before M6.
- [ ] Does ElevenLabs realtime speech-to-text allow enough concurrent streams per key for a 6-person meeting? Verify in M1.
- [ ] Does Muse's custom connector builder work against mooz's API, or does Muse need a cataloged connector? Revisit in v0.2.
- [x] How should "addressed vs merely mentioned" be judged: fuzzy name match only, or name match plus a cheap LLM check? Fuzzy rules only (decided in M5): no extra model call, cost or latency per utterance. Instead, names the detector could confuse are refused (for agents and people), and the rules are measured on the shared corpus in `bridge/tests/addressing_cases.json`, which both detectors run.

## Security hardening backlog (from the M1 security review; scheduled for M6)
- [ ] Rate limits on room creation, joins, code minting and claims, plus cleanup of old rows (review L5)
- [ ] Server-side expiry for host and participant sessions, not just cookie Max-Age (H2)
- [ ] Derive the cookie `Secure` flag from `MOOZ_PUBLIC_URL` instead of `x-forwarded-proto` (H3)
- [ ] Request body size limit on JSON endpoints (H4)
- [ ] CSP and `frame-ancestors 'none'` headers (H5)
- [ ] Show a code's owner the pending request so a stolen code can't be credited to them unnoticed (H6)
- [ ] VPS guide: generate a 32+ character LiveKit secret and never run `--dev` (the server already refuses weak secrets off localhost) (H1)

## Known limits after M2 (documented in the README; revisit in M5/M6)
- Prompt injection on the owner's own turns is mitigated (server-derived speaker roles, one escaped line per message, "information, not instructions" rule, notes kept out of the standing prompt), not eliminated. Access limits for everyone else are enforced in code.
- Notes opt-outs can't catch someone else repeating your words in their own, or agents not built on mooz that don't send `reply_to` / `sources`.
- The memory file lock uses `fcntl`; on Windows, avoid running the CLI's memory commands while the agent is in a meeting.
- Live Claude tool use and Grok have only been tested against recorded request shapes until the opt-in live tests run with real keys.

## Known limits after M3 (documented in the README)
- A public task reads private sources, untrusted GitHub text and web results together, and its result goes to the room. Untrusted text can try to steer it into repeating private details. Mitigations: "information, not instructions", the prompt states the audience, research can't change memory, Claude's search can't open links, Grok's search is off unless turned on. For sensitive work, ask privately.
- Privacy is recognised from phrases ("privately", "just for me", "DM me", "as a private task"…); an unrecognised phrasing gets a public answer.
- The web search cap is about 5 per task: Claude must keep the tool on a paused turn's continuation, so a step that pauses mid-search can run a few more; Grok can run a few more within one step.
- Live Claude and Grok research, web search and GitHub have only been tested against recorded request shapes until the opt-in live tests run with real keys.

## Known limits after M5 (documented in `docs/protocol.md`)
- What an answer is for (`answering: person` or `agent`) is the agent's own word. An agent that lies skips the pause and talks more, at its owner's cost; it can't keep another agent replying past 3 turns (each agent's own replies count), and the host can remove it.
- Who is "in the meeting" for name checks comes from LiveKit's webhook; a server that doesn't get webhooks counts everyone who ever joined by the link (and every approved agent), as before M5.
- An agent can hold the floor (up to 45 s) without being able to speak: a connector agent in its 2-minute grace after its tab left, or a bridge before LiveKit says it joined.
- Participant rows (names) still outlive the meeting; their cleanup is in the security backlog (L5).
- People first relies on LiveKit's active speakers: noise or a loud room can delay an agent (up to 5 s, then chat only) or cut it off; the chat answer always stays.
- Only the first of several names said aloud is heard ("Atlas and Nova, …" reaches Atlas); `@Atlas @Nova` and `@everyone` reach both.
- Bridges from before M5 don't take turns (they keep their own 3-in-a-row limit); the floor is in this server's memory, so a server restart forgets it (and the answers waiting for a turn just then are dropped).

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Prompt injection: a guest talks an agent into revealing private data | High | High | Enforce public-data scope in tool code by asker identity, not in the prompt. Connector answers require the owner's tap. Security review on M2 and M4 |
| Speech-to-text mishears agent names (false or missed wakes) | Medium | High | Phonetic and fuzzy matching, distinct-name rules, `@Name` in chat as a deterministic fallback |
| Undocumented prefill links break | Medium | Medium | Copy-to-clipboard fallback. The connector still works without them |
| Agent-to-agent loops run up costs | Medium | Medium | 3-turn pause, owner tap for connector replies |
| Local voice too slow on CPU-only machines | High | Medium | Document GPU or Apple Silicon. ElevenLabs remains the default |
| Cloned voice used to impersonate | Medium | High | Permanent agent labels and badges. Agents can never join as humans. Consent note in docs |
| Leaked join code or connector link | Medium | Medium | One-time, short-lived codes, host approval for every agent, rotatable connector links |
| ChatGPT Plus and Pro connectors are read-only | High | Low | Document it. ChatGPT can still read the meeting, and Grok and Claude work fully |

---
*Status: DRAFT — requirements only. Implementation planning in progress via /plan (milestone 1).*
