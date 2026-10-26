# Releasing mooz

The web app and `mooz-agent` share one version. A `v*` tag runs
[`release.yml`](../.github/workflows/release.yml):

1. CI again (the whole of [`ci.yml`](../.github/workflows/ci.yml)).
2. The version check: every version agrees, the tag is `v<version>`, and its CHANGELOG entry is
   dated.
3. `uv build` of the bridge, then a check that the wheel installs and runs.
4. **PyPI** (waits for approval in the `pypi` environment): trusted publishing, no token.
5. **GHCR** (waits for approval in the `release` environment): the web image for amd64 and
   arm64, tagged `X.Y.Z`, `X.Y` and `latest`. Versions are plain `X.Y.Z`: the version check
   refuses pre-release forms like `0.1.0-rc.1`, which Python spells differently.
6. **GitHub Release** (`release` environment): the CHANGELOG entry, plus the wheel and sdist.

Running the workflow by hand (Actions → Release → Run workflow) is a dry run: the same builds,
the package goes to TestPyPI, and the image is built but not pushed.

## One-time setup

- **PyPI.** At pypi.org → Your projects → Publishing, add a pending publisher: project
  `mooz-agent`, owner `Kainoa00`, repository `mooz`, workflow `release.yml`, environment
  `pypi`. Do the same on test.pypi.org with environment `testpypi`. A pending publisher
  doesn't reserve the name; the first upload does.
- **Environments.** In the repository's Settings → Environments, create `pypi`, `testpypi` and
  `release`. Give `pypi` and `release` a required reviewer (you) and limit them to tags
  matching `v*`.
- **Private vulnerability reporting.** Settings → Code security → turn it on (it's what
  [SECURITY.md](../SECURITY.md) points to).
- **After the first image push.** GHCR packages start private: on the `mooz-web` package's page,
  Package settings → Change visibility → Public, so servers can pull it without logging in.

## Each release

1. Set the new version everywhere `node scripts/check-version.mjs` looks (it says which file
   disagrees): `apps/web/package.json`, `bridge/pyproject.toml`, `apps/web/lib/mcp.ts`,
   `apps/web/Dockerfile`, `deploy/compose.yaml`, and a new `## [X.Y.Z] - YYYY-MM-DD` entry at the
   top of `CHANGELOG.md`. Run `uv lock` in `bridge` so the lockfile has it too.
2. Commit, push `main`, and wait for green CI.
   Then run the [live checks](#live-checks-before-a-release) on that commit.
3. Optional: the dry run. TestPyPI keeps a version forever, so a second dry run of the same
   version skips the upload.
4. Tag the green commit and push the tag:

   ```bash
   git tag -a v0.1.0 -m "mooz 0.1.0"
   git push origin v0.1.0
   ```

5. Approve the `pypi` and `release` deployments when the workflow asks.
6. Check: `uvx mooz-agent --version`, `docker pull ghcr.io/kainoa00/mooz-web:0.1.0` (logged out),
   and the release page.

A PyPI version can never be uploaded again, even after deleting it. If something is wrong after
the upload, fix it and release the next patch version.

## Live checks before a release

CI runs everything with a scripted agent and no keys. These checks need real keys, a speech
server, a VPS and a domain, so a person runs them before tagging. Record each result (the
numbers, or what failed) in the release notes; anything not run is listed there as unverified.

| # | Check | You need | Pass when |
|---|---|---|---|
| 1 | Voice latency with ElevenLabs | `ANTHROPIC_API_KEY`, `ELEVEN_API_KEY` | p50 under 2.5 s, p95 under 4 s |
| 2 | Local voice in the bridge | VoiceStudio on a GPU or Apple Silicon | it hears its name and answers aloud |
| 3 | Local voice in the tab | VoiceStudio, the VPS from check 4 | works in Chrome and Firefox; Safari shows the "use another browser" message |
| 4 | A fresh server install | a VPS, two DNS names | clone to first meeting in under 10 minutes |
| 5 | Two real agents | two sets of keys (or one, twice) | one speaks at a time; the pause and Continue work |
| 6 | The connector apps | Grok, Claude and ChatGPT accounts, the VPS from check 4 or a tunnel | each answers a question in the meeting |
| 7 | Six people at once | six people (or devices) talking | the bridge hears all six with no ElevenLabs errors |

### 1. Voice latency with ElevenLabs

```bash
uv tool install mooz-agent   # or, before it's on PyPI: cd bridge && uv sync, then uv run mooz-agent
mkdir -p ~/.mooz && touch ~/.mooz/.env && chmod 600 ~/.mooz/.env
printf 'ANTHROPIC_API_KEY=…\nELEVEN_API_KEY=…\n' >> ~/.mooz/.env
mooz-agent connect CODE --server http://localhost:3000 --name Atlas -v
```

Ask it at least 10 short questions out loud ("Hey Atlas, what's two plus two?"), with a pause
between them. Press Ctrl-C, and copy the last line: `heard→voice over N answers: p50 … ms,
p95 … ms (elevenlabs)`.

### 2. Local voice in the bridge

Install VoiceStudio ([docs/local-voice.md](local-voice.md)), then measure the parts and try it
in a meeting with no AI key:

```bash
cd bridge
MOOZ_LIVE_TESTS=1 MOOZ_LOCAL_SPEECH_URL=http://127.0.0.1:3900/v1 uv run pytest -m live -s tests/live/test_local_speech_live.py
MOOZ_VOICE=local MOOZ_BRAIN=offline mooz-agent connect CODE --server http://localhost:3000 --name Atlas -v
```

Say "Hey Atlas, remember that the demo is on Friday", then "Hey Atlas, what do you remember?".
Record the test's two timings, the `(local)` latency line at Ctrl-C, and your hardware.

### 3. Local voice in the tab

On the VPS from check 4, start VoiceStudio on your own computer with
`OMNIVOICE_ALLOWED_ORIGINS` set to the meeting's address plus its defaults. In a meeting, open
Bring my agent → Grok, Claude or ChatGPT, turn on voice with **Speech server on this
computer**, and bring the connector in. In Chrome, then Firefox: allow the browser's prompt,
say "Hey Grok, …", and check it speaks. In Safari, check the voice settings say it can't.

### 4. A fresh server install

Time it from `git clone` to two people in a meeting, following
[docs/deploy-vps.md](deploy-vps.md) exactly. Then run its "Check it" list, including a phone on
mobile data. Note every step that was unclear or failed.

### 5. Two real agents

Bring two agents with real brains (two people, or two `mooz-agent connect` runs with different
names). Check:

- `@everyone what's the plan?`: both answer, one after the other, never over each other.
- "Atlas, ask Nova what she thinks": after 3 replies between them the banner asks to
  continue; **Continue** lets them go on.
- Talk over an agent while it speaks: it stops within about a second, and its answer stays in
  the chat.

### 6. The connector apps

Use the VPS from check 4, or a laptop with a tunnel as the README says: there, open mooz at
http://localhost:3000, not at the tunnel's address, and be the other person from a private
window. For each of Grok, Claude and ChatGPT: make a connector link, add it to the app
(README → Connect Grok, Claude or ChatGPT), bring it in, ask `@Grok …` from another person,
tap **Ask Grok ↗**, and check the answer appears in the meeting. Note whether the prefill link
filled the prompt (Grok and Claude) or sent it (ChatGPT).

### 7. Six people at once

With a bridge agent in a meeting of six people (or six devices with microphones), have
everyone talk in turn for a few minutes. Check the bridge's log has no ElevenLabs errors or
reconnects, and that the agent still notices its name from each of them.
