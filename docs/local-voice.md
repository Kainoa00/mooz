# Local voice

An agent can hear and speak through a speech server on its owner's own computer instead of
ElevenLabs: no voice key, no per-minute bill, and nobody's speech leaves that computer. It works
for both kinds of agent:

| | Bridge (`mooz-agent`) | Connector (Grok, Claude or ChatGPT in your browser tab) |
|---|---|---|
| Where the speech server runs | This computer, or another one through an SSH tunnel | This computer (`127.0.0.1` or `localhost`) |
| Browsers | Any | Chrome, Edge and Firefox. Not Safari, or any browser on iPhone or iPad |
| Turn it on | `MOOZ_VOICE=local` | Bring my agent → Grok, Claude or ChatGPT → voice → **Speech server on this computer** |

Any server with OpenAI's `/v1/audio/transcriptions` and `/v1/audio/speech` works.
[VoiceStudio](https://github.com/debpalash/VoiceStudio) is the one this guide sets up.

## VoiceStudio

VoiceStudio is a separate app (AGPL-3.0), installed on its own: mooz doesn't bundle or modify
it, and only talks to its local API.

1. **Install it** from [its README](https://github.com/debpalash/VoiceStudio#readme)
   (version 0.5.7 or later). It downloads several GB of speech models.
2. **Hardware.** An NVIDIA GPU or Apple Silicon. It runs on a CPU too, but its own docs say
   10–50 times slower, which is too slow for a conversation.
3. **Check it's up:** `curl http://127.0.0.1:3900/v1/models` lists its models. It listens on
   `127.0.0.1:3900` and needs no key from this computer.
4. **For the connector tab:** let the meeting page in. Start VoiceStudio with
   `OMNIVOICE_ALLOWED_ORIGINS` set to the meeting's address plus VoiceStudio's own defaults
   (setting it replaces them), then restart it:

   ```bash
   OMNIVOICE_ALLOWED_ORIGINS="https://meet.example.com,http://localhost:3901,http://127.0.0.1:3901,app://voicestudio"
   ```

   Exact origins only (scheme, host and port, no path or `*`). For a local mooz, that's
   `http://localhost:3000`, even with a tunnel for the connector link. The bridge doesn't need
   this.

**Engines.** Its default speech engine is OmniVoice. `tts-1` and `whisper-1` (mooz's
defaults) map to the active engines. If you name an engine instead, it must be the active one,
or VoiceStudio answers `model_not_active`. A voice is a VoiceStudio profile ID or name.

## In the bridge

In `~/.mooz/.env` (or your environment):

```bash
MOOZ_VOICE=local
# MOOZ_SPEECH_URL=http://127.0.0.1:3900/v1   # the default
```

Or per agent: `mooz-agent init Atlas --voice-provider local --voice my-profile`. The agent's
setting wins over `MOOZ_VOICE`.

| Setting | Default | What it's for |
|---|---|---|
| `MOOZ_SPEECH_URL` | `http://127.0.0.1:3900/v1` | The server |
| `MOOZ_STT_URL`, `MOOZ_TTS_URL` | `MOOZ_SPEECH_URL` | Separate servers for hearing and speaking |
| `MOOZ_STT_MODEL` | `whisper-1` | The transcription model |
| `MOOZ_TTS_MODEL` | `tts-1` | The speech model |
| `MOOZ_TTS_VOICE` | `default` | The voice (the agent's `--voice` wins) |
| `MOOZ_TTS_FORMAT` | `pcm` | `pcm` (raw 16-bit mono) or `wav` |
| `MOOZ_TTS_RATE` | `24000` | The sample rate of your server's raw `pcm` |
| `MOOZ_SPEECH_API_KEY` | none | Only if your server wants a key; sent only over `https://` or to this computer |
| `MOOZ_STT_CONCURRENCY` | `2` | Transcriptions at once (a backlog drops its oldest) |

How it works: each person's audio goes through a speech gate (the same one the tab uses), and
each utterance is sent as a 16 kHz WAV. Answers are spoken one sentence at a time, the next
requested while the current one plays, because VoiceStudio makes a whole clip before sending
any of it. "Yes?" and "One sec, checking." are made once when the agent connects, which also
wakes the model.

Before joining, the bridge checks the server answers. It refuses to send a key over `http://` to
another machine, and warns when everyone's audio would cross the network unencrypted.

**No AI key either?** `MOOZ_BRAIN=offline` pairs the offline brain (a few fixed phrases) with
real local voice: a talking agent with no keys at all.

## In the connector tab

In **Bring my agent → Grok, Claude or ChatGPT**, turn on voice and pick **Speech server on
this computer**:

- **Server address:** `http://127.0.0.1:PORT/v1` or `http://localhost:PORT/v1` only (default
  `http://127.0.0.1:3900/v1`). There's no key field.
- **Voice** (optional), and under **More**, the speech and transcription models.

**Turn on voice** checks the server first, so a browser prompt or a refusal shows up now, not
mid-meeting. The settings stay in this browser. The tab transcribes up to 6 people, and only
while someone is talking.

### Browsers

From the browsers' documentation as of October 2026, not yet tried live with mooz:

| Browser | A meeting page on `https://` | A meeting page on `http://localhost` |
|---|---|---|
| Chrome, Edge 142+ | Works after you allow "apps on this device" once | Works |
| Firefox 153+ | Works (it may ask about your local network once) | Works |
| Safari | Blocked: mooz says to use another browser or the bridge | Works |
| Any browser on iPhone or iPad | Blocked | Not applicable |

To let the page reach the server, its security policy allows `http://127.0.0.1` and
`http://localhost` on any port. Scripts still need the page's nonce, so this only lets mooz's
own scripts reach services on the viewer's own computer.

## Troubleshooting

| What you see | What to do |
|---|---|
| "Can't reach your speech server" | Is it running (`curl http://127.0.0.1:3900/v1/models`)? Did you block "apps on this device" or local network access? Allow it in the site's settings (the icon left of the address) and save again |
| "Your speech server is running but doesn't let this page in" | Add the meeting's address to `OMNIVOICE_ALLOWED_ORIGINS`, keeping the defaults, and restart VoiceStudio |
| The first answer after a quiet spell is slow | VoiceStudio unloads its speech model after 15 minutes idle and takes about 8 s to load it again |
| Answers take many seconds | Check that VoiceStudio uses your GPU or Apple Silicon, not the CPU |
| `model_not_active` | Leave the models at `tts-1` and `whisper-1`, or name the active engine |
| `ambiguous_voice` | Use the voice profile's ID rather than its name |
| The agent never hears its name | Check VoiceStudio's transcription engine is loaded; the bridge logs failed requests once a minute |

## Other servers

From their documentation, not tested by us:

| Server | Hearing | Speaking | Notes |
|---|---|---|---|
| [Speaches](https://github.com/speaches-ai/speaches) (MIT) | Yes | Yes (Kokoro, Piper) | Port 8000, and it listens on every interface: publish it on `127.0.0.1` only. Download models first. Set `ALLOW_ORIGINS` for the tab. Piper's `pcm` may not be 24 kHz: set `MOOZ_TTS_RATE` |
| [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) (Apache-2.0) | No | Yes | Port 8880, `pcm` at 24 kHz. Listens on every interface: `docker run -p 127.0.0.1:8880:8880 …`. Bridge only (the tab needs one server for both): `MOOZ_TTS_URL=http://127.0.0.1:8880/v1` |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp)'s server (MIT) | Yes | No | Run with `--inference-path /v1/audio/transcriptions`; default `127.0.0.1:8080`. Bridge only: `MOOZ_STT_URL=http://127.0.0.1:8080/v1` |

A speech server on another machine (a GPU box) works from the bridge over `https://`, or from
either the bridge or the tab through a tunnel, so it looks like this computer:
`ssh -L 3900:gpu-box:3900 gpu-box`.

## Privacy

- Everyone's speech in the meeting goes to your speech server, and only there. The mooz
  server never sees it, and holds no voice keys.
- A server on `127.0.0.1` is reachable only from this computer. One that listens on every
  interface lets others on your network use it (and hear what you send it): bind it to
  `127.0.0.1`.
- Whatever your server keeps (logs, history) is up to it: check its settings.

## How fast is it?

Not measured yet: the numbers come from the live checks before the release. To measure on your
machine:

```bash
cd bridge
MOOZ_LIVE_TESTS=1 MOOZ_LOCAL_SPEECH_URL=http://127.0.0.1:3900/v1 uv run pytest -m live -s tests/live/test_local_speech_live.py
```

It prints the time to the first audio of a sentence, and how long transcribing it back took. In a meeting, the bridge logs how long
each answer took from hearing its name to starting to speak, and when it leaves,
`heard→voice over N answers: p50 …, p95 … (local)`.
