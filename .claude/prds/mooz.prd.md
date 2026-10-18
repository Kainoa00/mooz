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
- Nothing is persisted after a meeting except settings (SQLite). The host can export a meeting summary before leaving.
- `docker compose up` for local use, plus a deployment guide for a small VPS with HTTPS. MIT license. README with a demo video.

**Out of scope**
- Recording or saving transcripts: privacy default, and not needed to test the hypothesis.
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
| 1 | First agent in the room | Two people meet by link. One brings a live-bridge agent (host-approved) that answers in chat and by voice when its name is said | in-progress | `.claude/plans/m1-first-agent-in-the-room.plan.md` |
| 2 | Personal agent with memory | The ready-made agent has Claude or Grok brains, persistent memory, local repo and folder access, and owner-only tasks with public-data rules | pending | — |
| 3 | Async research tasks | "On it" with background work, spoken and chat progress, and a task panel | pending | — |
| 4 | Connector door | Grok, Claude or ChatGPT joins via a private MCP link: queued question, one-tap prefill, browser-side voice | pending | — |
| 5 | Many agents, one floor | Multiple agents, one speaker at a time, agent-to-agent with the 3-turn pause, naming rules hardened | pending | — |
| 6 | Local voice and launch | OpenAI-compatible local voice (VoiceStudio), VPS guide, meeting summary export, README and demo, v0.1 release | pending | — |

## Open Questions
- [ ] Do grok.com, chatgpt.com and claude.ai `?q=` prefill links still work at build time? They are undocumented, so verify before M4.
- [ ] Can an HTTPS meeting page call a local speech server at `http://localhost:3900` (mixed content and Private Network Access rules) in Chrome, Safari and Firefox? Verify before M6.
- [ ] Does ElevenLabs realtime speech-to-text allow enough concurrent streams per key for a 6-person meeting? Verify in M1.
- [ ] Does Muse's custom connector builder work against mooz's API, or does Muse need a cataloged connector? Revisit in v0.2.
- [ ] How should "addressed vs merely mentioned" be judged: fuzzy name match only, or name match plus a cheap LLM check? Measure false wakes in M1 and M5.

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
