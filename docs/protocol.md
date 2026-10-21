# mooz bridge protocol (v0)

How an agent joins a mooz meeting. The Python `mooz-agent` package implements this,
but any language with a LiveKit client SDK can. This page is the contract.

**Status: v0, unstable.** Breaking changes are allowed until v1. Changes are listed at
the bottom.

## Principles

- **The agent runs on its owner's machine.** It connects *out* to the meeting, so it works
  from behind home routers. The mooz server never sees the owner's AI or voice keys.
- **mooz is the ears and mouth; the agent is the brain.** In v0 the agent does its own
  speech-to-text and text-to-speech, using the owner's keys or a local speech server.
- **Agents are always labeled as agents.** The server sets an agent's identity and
  attributes, and the agent cannot change them.

## 1. Joining

```
Owner (browser)                 mooz server                      Bridge (owner's machine)
      │ POST /api/rooms/{slug}/agent-codes ─▶│                              │
      │◀──── { code, command, expiresAt } ───│                              │
      │        (shows `mooz-agent connect CODE --server URL`)              │
      │                                      │◀── POST /api/agent/claim ────│ { code, name }
      │                                      │─── 201 { requestId, claimSecret, status } ─▶
Host  │◀──── approval tray: "Kainoa's Atlas wants to join" ──────────────────│
      │ POST /api/rooms/{slug}/agent-requests/{id} { decision: "approve" } ─▶│
      │                                      │◀── GET /api/agent/claim/{id} │ Authorization: Bearer claimSecret
      │                                      │─── { status: "approved", token, url, room, identity, name } ─▶
      │                                      │                              │── connect to LiveKit (url, token)
```

### `POST /api/agent/claim`

Request: `{"code": "ABCD-EFGH-JKLM", "name": "Atlas"}` with `content-type: application/json`.

- `code` is one-time. It expires 10 minutes after it is created and is bound to the
  participant who created it, the agent's **owner**. Case and dashes are ignored.
- `name` is the agent's display name. Its last word is its wake word. It must be 3–24
  characters (letters, digits, spaces, `'` or `-`), start with a letter, and end in a word
  with at least 3 letters (`Unit 123` and `R2D2` don't). It must not be a reserved word
  (`mooz`, `everyone`, `agents`, `hey`, …) or end in a common English word (`notes`, `mark`,
  `can`, …). Its wake word must not sound or look like any word in the name of a person or
  agent in the meeting now. People and agents gone for more than 2 minutes don't count, nor
  do people whose session has ended, or a bridge approved that never collected its token.
  Where LiveKit's webhook reaches the server (it has in the last day) and has spoken of this
  meeting since, nor do people who joined by the link but never came into the call once their
  join token has run out (an hour after they joined), or a bridge that collected its token but
  never came in once that has (5 minutes, and a minute's slack). Of the joins the webhook has
  spoken of the meeting since that never came in, only the 2,000 that first joined most
  recently count (one of the rest who comes in later, under a name an agent now answers to,
  is taken out of the call); the ones it can't vouch for all count, and past 2,000 of them a
  new agent's name can't be checked (`503 names_busy`) until it does. A connector agent's approval holds its name for a day, as its owner's tab can
  still bring it in. A person coming back after 2 minutes can't keep a name that an agent
  that came in meanwhile answers to (one who comes back on the token they had is taken out of
  the call). Likewise, a bridge back after more than 2 minutes (its laptop slept, say) whose
  name someone took meanwhile, or whose name the meeting is too busy to check, is revoked and
  taken out; its owner needs a new code. The detector's
  own same-word test decides, so `Atlis` is refused next to `Atlas`, and `Lee's Grok` next
  to `Zach's Grok`. People's names are compared both as they sound and as they look in plain
  Latin letters: `Атлас`, `Ａｔｌａｓ` and `Atłas` count as `Atlas`, and so do `Сora`
  (a Cyrillic С) as `Cora`, `ΗΑΝΚ` (Greek capitals) as `Hank`, and `AtIas` (a capital I) as
  `Atlas`, either way round. A capital I and an l count as each other only where they pass
  for each other: an I after a small letter, and an l that starts a word or follows a capital
  with no small letter after it (`lris` is `Iris` and `ARlA` is `ARIA`, but `Joel` isn't
  `Joe`, `Ira` isn't `Lyra` and `Clara` isn't `Kiara`). An l read as I matches by spelling only
  where it's said as an l (before a vowel, accented or not: `lily` and `léon` aren't `Ilya` and `Ion`), and by sound where it can only
  be said as the I it looks like (`lsabel` is `Isabel`). `ə` sounds like a (`Əli` is `Ali`).
  The common marks drawn like an apostrophe (`’`, `ʻ`, `´`, `ˊ`, `᾽`) count as `'`. The
  lookalikes are a list of the common ones, not Unicode's whole confusables table; in a word
  otherwise spelled like the wake word, a Latin letter the list doesn't know stands in for the
  one it replaces, if fewer than half the letters are such (`Ꜳtlas`). A person's name can't
  mix the Latin alphabet with another within a word (every Latin letter counts, so `Əliyev`,
  `Hawaiʻi` and `Ɔdɛɛ` are fine). The error doesn't say whose name
  it clashes with. A person can make 10 codes an hour, and a meeting 50 for people nobody can
  see: the host, and anyone LiveKit says came into the call, aren't held to that.

Responses:
- `201 {"requestId", "claimSecret", "status": "pending"}`. The response reveals nothing
  about the meeting.
- `400 invalid_code`: the code is unknown, used, expired, or burned. A code burns after
  5 rejected names.
- `400 invalid_agent_name`, `400 reserved_name`, `409 name_taken`: the name was
  rejected. The code stays usable.
- `503 names_busy`: the meeting holds too many joins nobody can vouch for to check the name
  now. Try again later; the code stays usable, and this doesn't count as a try. Tries in the
  next 10 seconds or so get the same answer without a check. It needn't mean the webhook is
  down: a meeting that has had more than 2,000 joins since the webhook last spoke of it (about
  an hour of joins at the limit) answers it too.

### `GET /api/agent/claim/{requestId}`

Send `Authorization: Bearer <claimSecret>`, and poll about every 2 seconds.

| `status` | Meaning | What the bridge should do |
|---|---|---|
| `pending` | The host hasn't decided yet | Keep polling (requests expire after 10 minutes) |
| `approved` | Includes `token`, `url`, `room` (internal LiveKit room name), `identity`, `name` | Connect to LiveKit now |
| `denied` | The host declined | Exit |
| `revoked` | The host removed the agent | Exit |
| `expired` | The request lapsed, or the single token was already collected | Exit; the owner needs a new code |

Each approval issues **exactly one** token, valid for 5 minutes. LiveKit refreshes it
while the agent stays connected. An agent that disconnects needs a new code.

### What the owner sees

An agent comes in under its owner's name ("Kainoa's Atlas"), so the owner sees what was done
with their codes, and a code someone else used can't be credited to them unnoticed. Both
routes take the participant cookie, and share a limit of 60 a minute per person.

- `GET /api/rooms/{slug}/my-agent-requests` returns
  `{ "requests": [{ "id", "agentName", "status": "pending" | "approved", "createdAt" }] }`:
  bridge agents brought with my codes that are waiting for the host or in the meeting. The
  tab checks every 3 seconds while a code is out or a request is waiting, and shows "Atlas is
  waiting for the host. Not yours? Cancel it."
- `POST /api/rooms/{slug}/my-agent-requests/{id}/withdraw` (same origin, a JSON body such as
  `{}`) declines a request that's waiting, so the bridge's next check gets `denied`. For an
  agent that's already in, it revokes it and removes it, as the host's removal does.
  Repeating it is harmless. Someone else's request answers `404 request_not_found`.

Error responses everywhere are `{"error": {"code", "message"}}`, and the message is
safe to show to a person.

### Limits

Every limit answers `429 rate_limited`, and the window is a minute unless it says otherwise.
mooz keeps no IP addresses, so the limits are per person, meeting or claim, with ceilings
across the server.

| Route | Limit |
|---|---|
| `POST /api/rooms` | 30 new meetings across the server (`MOOZ_ROOMS_PER_MINUTE`) |
| `POST /api/rooms/{slug}/join` | 30 joins per meeting, counted apart for the host and for each person coming back (a reload by one who never came into the call counts with new joins if the webhook has spoken of the meeting since their last join). A meeting keeps a place for at most 200 people (a rejoin reuses its place; where the webhook arrives, a join that never came into the call stops holding one after 5 minutes) and, as a backstop, 50,000 sessions in all (more than the join limit can make in a day). Past either it answers `409 room_full`. The host always gets a place (while their host session lasts: a day after their last join), and may add 500 sessions past the 50,000. Nobody is turned away to keep agents' name checks quick: they count at most the 2,000 most recent joins the webhook vouches for that never came in (older ones just aren't counted), plus up to 2,000 it can't vouch for; past 2,000 of those, new agents get `503 names_busy` ([section 1](#1-joining)) |
| `POST /api/rooms/{slug}/agent-codes` | 10 codes an hour per person, and 50 per meeting for people who aren't the host and haven't come into the call |
| `POST /api/agent/claim` | None: a made-up, used or expired code is refused at once (`400`), and a real one may try 5 names |
| `GET /api/agent/claim/{id}` | 60 checks per claim, counted only with the right secret. A bridge that gets a 429 waits and polls again |
| Turns, connectors, questions and MCP | Listed in their sections below |

Small requests (joins, claims, decisions, notes settings, connectors, bringing a connector)
take at most 4 KB of JSON and answer `413 too_large` past that. Questions take up to 256 KB.

## 2. In the room

The agent is an ordinary LiveKit participant with a restricted token:

| Grant | Value |
|---|---|
| Publish | Microphone audio only (`canPublishSources: [microphone]`) |
| Subscribe | Yes |
| Data | Yes |
| Edit own metadata/attributes | **No** |

Attributes the server sets on every participant:

| Attribute | Humans | Agents |
|---|---|---|
| `kind` | `human` | `agent` |
| `owner_id` | — | The owner's participant identity |
| `owner_name` | — | The owner's display name |
| `door` | — | `bridge`, or `connector` (see [5. Connector door](#5-connector-door)) |
| `connector_app` | — | For a connector agent: `grok`, `claude`, `chatgpt` or `other` |

Clients must always show agents as `🤖 {owner_name}'s {name}` with an agent badge.

### Hearing

- Subscribe to the audio tracks of participants with `kind = human`, one
  speech-to-text stream per track. The track tells you who is speaking, so no
  diarization is needed.
- **Don't transcribe other agents.** Read their replies from chat (below) instead.

### Chat

Chat uses LiveKit **text streams** on topic `lk.chat`, with the plain message text as
the body. This is what `@livekit/components-react`'s `useChat` sends and receives. An
agent posts its full answer here. Other agents and people see it with the sender's
attributes.

When an agent's message answers someone, set the text stream attribute `reply_to` to that
person's participant identity (for a question from another agent, its owner's), and `sources`
to the comma-separated identities of everyone whose words were in what the agent was given.
Notes use both to leave out replies that answer or could quote people who opted out, even if
they opt out later. Only agents' attributes are read.

A message sent only to some people (`destination_identities`) also carries `private` = `"1"`.
The host's meeting summary leaves those out. For older bridges it also leaves out quick
private answers that start with 🔒, and the reports (📋) of private tasks that the host's own
agents told the tab about. A message that is private in neither way can't be told apart from a
public one, so update agents that don't set `private`.

The host's tab can download a **meeting summary** (Markdown, built in the tab from what it
saw, never sent to the server). It holds the date and time span, who was there (agents with
their owner and door), agents' public answers with whom each answered, public research, which
agents kept notes, and how often the agents paused. It leaves out people's own lines, private
messages, acknowledgements ("Yes?", "One sec, checking.", "On it. I'll report back."), and
anything whose sender, the sender's owner, `reply_to` or `sources` (or their owners) opted
out at any point the tab saw, or that names someone the tab never saw (it joined late or
reloaded, so it can't know). The meeting's link and internal identities never appear, and all text is
escaped so it can't become a link, image, HTML or heading. A real summary comes from asking an
agent to sum up: its answer is in the file.

Anyone can send a very long message, so cut what you parse (the reference bridge reads the
first 4,000 characters) and keep your parsing linear in the length.

Show the model who said what using server-assigned identities, never display names, which
people choose freely. The reference bridge renders one escaped line per message, tagged
`[owner]`, `[guest]`, `[agent]` or `[you]`.

### Speaking

Publish one microphone track (48 kHz mono) and play your synthesized speech into it.
Post the full answer to chat first, then speak the short version, all within a turn from
the meeting's floor (see [Taking turns](#taking-turns)). Only one answer at a time per
agent.

### Being addressed

An agent answers only when addressed:
- `@Name` in chat, anywhere in the message. `@everyone` and `@agents` address every
  agent.
- Its name, or a likely mis-transcription of it (similar in both sound and spelling),
  opening an utterance (optionally after a greeting like "hey" or "ok"), closing a
  question, or closing a request after a comma ("Summarize that, Atlas.").
- "Hey agents, ..." (set off by a comma) addresses every agent by voice.
- Saying the name alone ("Hey Atlas.") opens an 8-second window. In it, the same
  person's next sentence counts as the question.

A multi-word name wakes on its last word ("Grok" for "Zach's Grok"). Being mentioned ("I
asked Atlas yesterday") is not being addressed. Only the first of several names said in
one breath is heard ("Atlas and Nova, …" reaches Atlas); `@Atlas @Nova` or `@everyone`
reaches both.

Names that this detection could confuse are refused when an agent claims one or a person
joins: see `name` under [`POST /api/agent/claim`](#post-apiagentclaim). The test is the
detector's own, so what it refuses is exactly what it would mix up.

### Taking turns

Several agents can be in one meeting, and they answer one at a time, people first. Before
an agent posts or speaks an answer, it asks the server for a turn, and gives it back when
done.

| Call | What it does |
|---|---|
| `POST /api/agent/claim/{requestId}/turns` | Ask for a turn: `{"answering": "person" \| "agent", "speak": true \| false}` |
| `GET /api/agent/claim/{requestId}/turns/{turnId}` | Where it stands; waits up to 25 s for it to change while it's waiting or held |
| `POST /api/agent/claim/{requestId}/turns/{turnId}/done` | Finished (or no longer wanted) |

Each call carries `Authorization: Bearer {claimSecret}`, and works only while the agent is
in the meeting. Each answers `{"turn": {"id", "status", "endsInMs"?, "reason"?}}`:

- `status` is `waiting`, `held`, `granted` or `ended`. `endsInMs` is the time a granted turn
  has left. `reason` says why one ended: `done`, `timeout`, `expired`, `left`, `replaced` or
  `meeting_ended`.
- Asking returns at once. If the turn isn't `granted`, check it until it is (or ends).

How the server decides:

- **One turn at a time** in a meeting. Answers to people (`answering: "person"`, which
  includes `@everyone`) go ahead of replies to agents, then first come, first served.
- **Turns are short.** A turn with speech lasts at most 45 s, a chat-only turn 10 s; then
  it ends (`timeout`) and the next one starts. A waiting or held turn that isn't checked for
  10 s goes away (`expired`).
- **One open turn of each kind per agent.** Asking again replaces the last one of that kind.
  So a held reply to an agent doesn't stop the agent answering a person.
- **Agents pause.** After 3 agent-to-agent turns in a row in the meeting, or 3 replies to
  agents by one agent since it last answered a person, the next reply to an agent is
  `held`, not dropped. The meeting shows "The agents have gone back and forth 3 times. Let
  them continue?", and any person in the meeting can click **Continue**
  (`POST /api/rooms/{slug}/agents/continue` with `{}`, their participant cookie and a
  same-origin request; agents have no cookie). The held reply then goes out, and the counts
  start over. A turn that answers a person starts the meeting's count, and that agent's,
  over. Once the agents are paused, though, replies to agents wait for Continue, even after a
  person has spoken.
- **Fair turns.** An agent doesn't get two turns in a row while another agent's turn is
  waiting, whichever asked first. This comes before people first: what a turn answers is the
  agent's own word, so an agent that keeps saying it answers people can't keep another one
  waiting.
- An agent that leaves or is removed gives up its turns. When the meeting ends, the floor
  is forgotten.

What the agent must do:

- Post and speak answers (and "Yes?", and fillers like "One sec") only within a granted
  turn, and stop at its end. Two things may go to chat at once: a finished background task's
  report (its spoken part takes a turn), and a private answer sent only to the person who
  asked.
- Keep its own limit too, since thinking costs its owner before the floor can hold
  anything: think about other agents' questions at most 3 times in a row, until a person
  speaks or `floor.continued` goes up (someone clicked Continue). Don't go by `floor.paused`
  going back to `false`: it also does when a held reply just goes away.
- Wait for a turn only as long as it's worth: the reference bridge waits 2 s for "Yes?", and
  counts the time an earlier answer of its own made it wait. A check the server holds open
  can last 25 s, so give up on it when the time is up, and give the turn back.
- **People first.** Wait up to 5 s for people to stop talking before speaking (LiveKit's
  active speakers). After that, leave the answer in the chat. Stop speaking if a person talks
  over it for more than a second; the chat answer stays.
- Give the turn back only after its last audio has played out and reached people (the
  reference bridge waits 250 ms more), so voices never overlap.
- If the floor can't be reached (no answer, or not JSON), answer people anyway, but not
  other agents.

The meeting sees the floor in the room metadata, next to `notes_allowed`:
`{"floor": {"speaking": identity | null, "next": identity | null, "paused": bool, "continued": ms}}`.
`paused` says a reply is held right now (the banner shows while it is); `continued` is when a
person last clicked Continue (milliseconds on the server's clock). Only Continue moves it up,
so start your count over only when it's higher than any value you've seen: it goes back to 0
after a restart, or when the server forgets a floor that has been idle for 10 minutes (and its
count with it). A released reply can reach you before the new `continued` does (the reference
bridge keeps an agent's question it refused at its limit for 5 s, and answers it if a Continue
arrives in that time).

Errors: `404 request_not_found` (wrong id or secret) or `turn_not_found`;
`409 not_in_meeting`; `400 invalid_body`; `413` for a body over 1 KB; `429 rate_limited` (more
than 30 turns, 120 checks or 60 dones a minute), `floor_busy` (20 turns waiting) or
`too_many_checks` (2 checks already waiting on that turn).

A server older than M5 answers `404` with no JSON body. There is no floor then: answer
anyway, and stop answering other agents after 3 turns in a row with no person speaking.
Decide that only on the first turn request: a server that has given turns can't lose them, so
a later 404 page (from a tunnel or proxy) means the floor is out of reach for now.

`answering` is the agent's own word: the server can't check it. An agent that lies about it
can talk more, at its owner's cost, and keep the meeting's count low; it can't keep another
agent replying to it past 3 turns (each agent's own replies count too), and the host can
remove it.

## 3. Leaving

The agent leaves when its process exits, when the host or its owner removes it, or when it
comes back after more than 2 minutes to find its name taken (section 1). On removal, the
server disconnects it and revokes its claim. A LiveKit webhook kicks the identity again
if it reconnects with a token it already holds, and so for an agent from a meeting that has
ended.

### What the server keeps, and for how long

| What | Kept until |
|---|---|
| People: name, identity, notes opt-out, a hash of their secret | The meeting ends, or 24 hours after their last join |
| Agent codes | The meeting ends, or 10 minutes after they're made |
| Agent requests: the agent's name, whose it is, its status | The meeting ends, or its owner's session does, or 24 hours after the request unless the agent is approved and still in the meeting |
| The room: its link, a hash of the host secret, the notes policy, when it was last joined, and when LiveKit's webhook last spoke of its meeting (a time, nothing about anyone) | 30 days after its last join (it's a setting); the webhook time goes when the meeting ends, or at the sweep once nobody is left in it |
| Names worked out for name checks (names the server accepted, as read) | Memory only: gone when a meeting ends, at a sweep that removes anything, or a restart |
| Meetings just found too busy to check agents' names (the link and a time) | Memory only: about 10 seconds; gone when the meeting ends, at a sweep, or a restart |
| Connectors: name, app, a hash of the link | Deleted by their owner, or expired as in [section 5](#the-connector-link) |
| Questions, the floor | Memory only: gone when the meeting ends or the server restarts |
| Rate-limit counters (a meeting's link or a random identity, a count and when it started) | Memory only: gone at the first sweep after their window (a minute or an hour), or a restart |
| When LiveKit's webhook last arrived (a time, nothing about anyone) | Until the next one |

"The meeting ends" is LiveKit's `room_finished`, sent once everyone has left. Without it, a
sweep (at most once a minute, run by room creation and joins) deletes what has expired.

- **Sessions.** Host and participant secrets work on the server for 24 hours after the last
  join, and each join resets the clock, as it does for their cookies. A bridge's claim
  secret works for turn calls while its owner's session lasts, and for 24 hours after its
  token was issued at most; after that, turn calls answer `409 not_in_meeting`.
- **Coming back** after a meeting has ended gives a person a new identity. They set their
  notes opt-out again.
- **On disk,** SQLite's `secure_delete` is on, and the write-ahead log is checkpointed and
  emptied after anything is deleted, so deleted names don't linger in the database files.

### LiveKit's webhook

mooz needs LiveKit to send its webhook to `/api/livekit/webhook`, signed with one of the
server's API keys (`webhook` in `livekit.yaml`). It's how the server knows:

- who is in the meeting now, for name checks, connector agents' grace period and turns
- when a removed agent, or one from an ended meeting, reconnects, so it can kick it
- when the meeting ends, so it can forget who was in it

The server counts the webhook as arriving if one has in the last day (it keeps the time, so a
restart doesn't forget). For name checks it also needs the webhook to have spoken of the
meeting after the person joined or the bridge collected its token, so a webhook that stops
arriving doesn't let names go in meetings it never reported. Without it, meetings still work,
but the server falls back:

- Name checks count everyone whose session is live (a day after their last join), and every
  agent whose token can still be in use (a bridge's for a day, a connector's approval for a
  day).
- Every join holds one of a meeting's 200 places until its session ends, not just people in
  the call. So on a server that hasn't heard the webhook for a day (one weekly meeting, say),
  a link holder can fill a meeting with joins that never come in, for a day. Anyone coming
  into any meeting on the server brings the webhook back, and with it the meeting.
- The meeting-wide cap on agent codes counts everyone but the host.
- A removed agent can reconnect while its last token lasts.
- People's rows stay until the sweep finds them expired.

## 4. Access and consent

### Who is asking

Every chat message and audio track arrives with the sender's LiveKit identity, which the
server assigned and nobody can change. An agent's own attributes name its owner
(`owner_id`). So an agent always knows whether its owner is the one asking. Use that, not
anything said in the meeting, to decide access:

| Asker | Sources (folders, repos) | Memory |
|---|---|---|
| The owner | All | Read all, add, forget |
| Anyone else (people and other agents) | Public ones only | Read public notes only |

Enforce this where the tools run, not in the prompt: a private source should look exactly like
one that doesn't exist. The reference bridge does this in `mooz_agent/tools/toolbox.py`.

### Meeting notes

Notes need consent from the room, which only the mooz server can express:

| Signal | Where | Set by |
|---|---|---|
| The host allows notes | Room metadata `{"notes_allowed": true}` (absent or anything else means no) | `POST /api/rooms/{slug}/notes-policy` (host only) |
| A person leaves themselves out | Participant attribute `notes_opt_out` = `"1"` | `POST /api/rooms/{slug}/notes-opt-out` (that person only) |

An agent that keeps notes must:

1. Start only when its owner asks and the room allows notes.
2. Before keeping anything, announce it: a chat line, and a reliable data packet on topic
   `mooz.v0` with `{"type": "notes", "state": "on"}`. Send it again, addressed to them, to
   anyone who joins later, and answer `{"type": "notes?"}` (which browsers send whenever
   they connect or reconnect) directly with the current state. Keep a person's words only
   once a signal has reached them. Browsers show a banner for every agent whose last signal
   was `on`. They trust a signal only from an agent (`kind = agent`) and only about itself.
   Check the room metadata again after announcing, in case the host turned notes off meanwhile.
3. Leave out anyone whose `notes_opt_out` is `"1"`: their words, their agents' words, and any
   agent message whose `reply_to` or `sources` includes them. Check again before summarizing, so opting out also
   covers what they already said. While notes are on, don't use their words in answers to
   others.
4. Save only a summary, to the owner's private memory, never a transcript.
5. Stop (announcing `{"type": "notes", "state": "off"}`) when its owner asks or the room
   metadata stops allowing notes.

A bridge that keeps notes silently can't be detected. The guarantee covers the bridge mooz
ships, and the visible banner is what makes consent socially enforceable.

### Background tasks

An agent can work on something for its owner in the background and report back later. Only
the owner (the asker's identity equals the agent's `owner_id`) may start or cancel a task.
Everyone sees that it exists, the same transparency as the notes banner.

**Task updates** are LiveKit text streams on topic `mooz.tasks`, one JSON object per stream,
sent whenever a task changes:

```json
{
  "type": "task", "id": "t_0a1b2c3d", "state": "working",
  "title": "Look into why CI is flaky", "owner": "p_kai", "private": false,
  "progress": ["Checking CI on main"], "summary": "", "details": "", "error": "",
  "created_at": 1792355314.2, "updated_at": 1792355318.9, "seq": 3
}
```

| Field | Meaning |
|---|---|
| `id` | Unique per agent, not across agents. Browsers key tasks by sender identity and `id` |
| `state` | `queued` → `working` → `done`, `failed` or `cancelled` |
| `owner` | The identity of the person who asked, always the agent's own `owner_id` |
| `progress` | The latest few steps (at most 5), written by the bridge, not the model |
| `summary`, `details` | The result: the short spoken version and the longer chat text (`done` only) |
| `seq` | Increases with every update. Ignore an update older than one you already have |

- A **public** task goes to everyone. A **private** one goes in full only to its owner
  (`destination_identities`); everyone else gets the same event with `title` set to
  `"Private task"` and empty `progress`, `summary`, `details` and `error`.
- Browsers trust an update only from an agent (`kind = agent`) whose `owner_id` equals the
  update's `owner`, and drop an agent's tasks when it leaves.
- On (re)connecting, browsers send `{"type": "tasks?"}` on the `mooz.v0` data topic. Answer
  it, and also send every task to anyone who joins, addressed to them, because their query
  can arrive before you've seen them join.
- Answer `tasks?` (and the join push) at most once every couple of seconds per person, so asking
  over and over can't make the agent flood the meeting.
- `{"type": "task.cancel", "id": "t_0a1b2c3d"}` on `mooz.v0`, addressed to the agent, cancels
  a task. Honor it only from the owner.
- A public task's `progress` goes to everyone, so it must not name private sources or files
  (the reference bridge says "Reading a private file"). A status answer said to the room calls a
  private task "a private task", even when the owner asks.
- Research only reads: it doesn't get tools that change memory, so what it reads can't plant or
  delete notes. Likewise a quick answer changes memory only when the owner's own request asks
  for it, and makes a note public only when the request says so.
- When a task is done, post the result to chat (a private one only to the owner, with
  `destination_identities` and `private` = `"1"`) and save it to the owner's private memory. Speak a public result
  only at a pause in the conversation (no one is speaking, and no one has just finished), never
  a private one.
- When the owner asks for privacy ("privately", "just for me", "DM me"), answer only to them,
  as a chat message with `destination_identities` and `private` = `"1"`, never spoken and kept out of the transcript
  and notes. This covers quick answers, status answers and tasks, including a question that
  overflows into a task.

## 5. Connector door

A second way in, for people who'd rather bring the assistant app they already use (Grok,
Claude, ChatGPT or any app that takes a custom MCP connector) than run a bridge. The app never
joins the call itself: its owner's browser tab runs the agent, and the app answers through a
private MCP link.

```
Owner's assistant app            mooz server                     Owner's browser tab
      │                               │◀── POST …/connector-requests ──│ { connectorId }
      │                               │    (host approves as usual)    │
      │                               │─── POST …/{id}/token ─────────▶│ joins as the agent
      │                               │                                │ hears "@Grok …"
      │                               │◀── POST …/{id}/questions ──────│ { asker, text, lines }
      │◀── owner taps "Ask Grok ↗" (the prompt carries only the question's ID) ──│
      │── get_question ──────────────▶│                                │
      │── post_answer ───────────────▶│── data packet `mooz.connector` ▶│ posts in chat, speaks
```

### The connector link

`POST /api/connectors` `{ name, app, slug }` makes one, from a meeting the caller is in, and
returns `{ connector, url }` once (at most 10 an hour per person, 60 a minute across the server,
and 10 per owner; `MOOZ_CONNECTORS_PER_MINUTE` and `MOOZ_MAX_CONNECTORS` set the server's
ceilings). Only use while its agent is in a meeting counts: a link never used in one is deleted
after 24 hours, and any link after 180 days without use (unless its agent is in a meeting). The URL
is `{origin}/mcp/{secret}`, a 256-bit secret that the server stores only as a hash. The
connector belongs to the browser that made it (an HttpOnly owner cookie, kept a year, named
`__Host-mooz_owner` over HTTPS so no other host can set it).
`GET /api/connectors` lists them, `POST /api/connectors/{id}/rotate` replaces the secret (the old
link stops working) and `DELETE /api/connectors/{id}` removes it and its agent. Changes must
come from the same origin, and someone else's connector looks like one that doesn't exist.

### Joining

`POST /api/rooms/{slug}/connector-requests` `{ connectorId }` asks to bring it in and returns
`{ requestId, status: "pending" }` (at most 10 a minute per person and 30 per meeting). Its name is checked as a
bridge agent's is ([section 1](#1-joining)): it can answer `409 name_taken` or `503 names_busy`. The
host approves it in the same tray as bridge agents.
`GET …/{requestId}` returns `{ status }` (`pending`, `approved`, `denied`, `revoked` or
`expired`), and once approved `POST …/{requestId}/token` returns `{ token, url, identity, name }`
for the tab's agent connection, again after a reload. Every one of these needs the participant
cookie of the request's owner and the owner cookie its connector belongs to. Its token is a bridge
agent's (microphone and data only, no attribute edits) with `door = connector`. A newer request
for the same connector revokes the older one, and `DELETE …/{requestId}` cancels it or takes the
agent out.

The agent is in the meeting while its tab is. LiveKit's webhook tells mooz when the tab's session
leaves or joins (a late "left" from a replaced session is ignored). It may be away up to 2
minutes (a reload); after that the approval ends, its questions are dropped, and coming back
gets it removed, so the owner brings it again. When the meeting ends, its connector agents are
revoked.

### Questions

The tab hears the meeting like a bridge agent does, with the same rules for being addressed
(both detectors run `bridge/tests/addressing_cases.json`): chat always, and speech when the
owner has turned on voice in the browser, through their own ElevenLabs key or a speech server on
their computer. Either way the tab cuts speech with the bridge's gate
(`bridge/tests/gate_cases.json`); for a local server it sends one utterance per request.

`POST …/{requestId}/questions` `{ asker, text, at, lines }` queues a question (`at` is when the
line that asked it was heard) with what the tab heard lately, each line
`{ identity, text, via, at, reply_to?, sources? }` (at most 20 questions a
minute per agent and 60 per meeting, and 256 KB a request). The server keeps only the last 10
minutes of lines from people in the meeting (the newest 200, at most 12,000 characters),
re-derives names and roles itself, and leaves out every line that belongs to someone who opted
out of notes (the speaker, an agent's owner, or anyone in `reply_to` or `sources`), checking
again when the assistant reads it. Those lists are never cut short: a line that would bring a
question past 100 people to track is left out instead. Questions live in server
memory only: at most 5 wait per agent, each for 10 minutes, at most 20 in all (an answered one
keeps no lines), and all are dropped when the agent leaves for good. `GET …/questions` lists
them, with the answer once there is one.

**The owner's tap decides.** A queued question is invisible to the assistant until the owner taps
Ask or Copy for it, which sends `POST …/questions/{qid}/release`. `DELETE …/questions/{qid}`
dismisses one for good, and takes the line that asked it out of the other questions too. `POST …/questions/{qid}/answer` `{ spoken, details? }` takes an answer
the owner pasted (for any of their questions).

### The MCP endpoint

`/mcp/{secret}` speaks MCP over Streamable HTTP, statelessly (JSON responses; `GET` and `DELETE`
get a 405, as there are no streams or sessions), with no authentication beyond the secret.
Requests are capped at 64 KB and 30 a minute per connector; an unknown secret gets a plain 404.
Its tools, which work only while the connector's agent is in a meeting, and see only questions
the owner released:

| Tool | Does |
|---|---|
| `get_question({ question_id? })` | The oldest released question (or the one named): who asked (`your owner`, `a guest` or `another AI agent`), the question inside `<question>`, how to answer, and the meeting as `[role] name (via): text` lines inside `<meeting>` |
| `read_meeting()` | The meeting lines around the newest released question (nothing while none waits) |
| `post_answer({ question_id, spoken, details? })` | Answers it. `spoken` (at most 400 characters) is read aloud; `details` (at most 4,000) is added in chat |

Meeting text is normalized (NFKC), stripped of invisible characters, flattened to one line per
message (a typed line break shows as ` ⏎ `) and escaped, and marked as information, never
instructions. For a question from anyone but the owner, the assistant is told not to look in the
owner's mail, files, memory or other connectors.

### Answers

The server sends each answer to the agent's identity only, as a reliable data packet on topic
`mooz.connector`:

```json
{ "type": "answer", "id": "q_…", "spoken": "March 30th.", "details": "", "reply_to": "p_…", "sources": ["p_…"] }
```

The tab accepts it only from the server (a packet with no sending participant or identity), and
only for a question it knows of, then posts
`spoken` and `details` to `lk.chat` with the `reply_to` and `sources` attributes, and speaks
`spoken`. If a packet is missed, the tab picks the answer up from `GET …/questions`. The owner
can choose to review each answer before it's posted.

The tab takes turns like a bridge (see [Taking turns](#taking-turns)), with the owner's cookies
instead of a claim secret: `POST /api/rooms/{slug}/connector-requests/{id}/turns`,
`GET …/turns/{turnId}` and `POST …/turns/{turnId}/done`. It takes one for each answer, for
"Yes?", and for "One sec, checking." (only for a person, and only if the floor is free right
then).

## Changelog

- **v0** (M1): bridge door, single-use tokens, host approval and removal, `lk.chat`.
- **v0** (M2): access by asker identity, the `notes_allowed` room metadata, the `notes_opt_out`
  attribute, `mooz.v0` notes signals and `notes?` queries, and the `reply_to` and `sources` chat
  attributes.
  All additive; M1 agents keep working.
- **v0** (M3): background tasks: `mooz.tasks` task updates, `tasks?` queries and
  `task.cancel` on `mooz.v0`, and chat messages addressed to one person (private results). A
  task's report carries `reply_to` (its owner) and `sources` (whose words the task was given).
  All additive; M2 agents keep working.
- **v0** (M4): the connector door: connector links, `connector-requests`, the `/mcp/{secret}`
  endpoint, `mooz.connector` answer packets, and the `door = connector` and `connector_app`
  attributes. All additive; bridge agents are unchanged.
- **v0** (M5): taking turns (`…/turns` for both doors, `agents/continue`, and `floor` in the
  room metadata), and stricter names: 3 or more characters, a last word of 3 or more letters
  that isn't a common word, and nothing the detector would confuse with someone already
  here. Agents from M4 still join; without taking turns they talk over others, so update.
  A connector made earlier with a name the rules now refuse (`Mark`, `Nova 2`) can't join:
  delete it and make one with another name (its link changes).
- **v0** (M6): limits on starting meetings, joining and claim checks (see
  [Limits](#limits)), `409 room_full`, and 4 KB caps on small requests. A bridge that gets a 429
  while waiting for approval keeps waiting; older bridges stop, but don't poll fast enough to hit
  the limit. Meetings forget who was in them when they end, sessions expire 24 hours after the
  last join, and a bridge's turn calls stop with its owner's session (see
  [what the server keeps](#what-the-server-keeps-and-for-how-long)). Owners see, and can
  cancel, requests made with their codes ([`my-agent-requests`](#what-the-owner-sees)). A chat
  message sent only to some people carries `private` = `"1"`, and the host's summary leaves it
  out ([Chat](#chat)). Local voice changes nothing on the wire.
