# Run mooz on a server

One Linux server runs three things in Docker, from [`deploy/`](../deploy):

| Service | What it does | Listens on |
|---|---|---|
| Caddy 2.11.7 | HTTPS for both names, with certificates from Let's Encrypt | 80/tcp, 443/tcp and udp |
| LiveKit v1.13.10 | Meetings' audio, video and chat | 7880 on 127.0.0.1 only (Caddy serves it as `wss://`), media on 7881/tcp, 7882/udp and TURN on 3478/udp |
| mooz web | The app | 3000 on 127.0.0.1 only |

Everything uses the host's network, so LiveKit sees people's real addresses. The server holds
no AI or voice keys: people bring their own agents. What it keeps is listed in
[what the server keeps](protocol.md#what-the-server-keeps-and-for-how-long).

## What you need

- A server with a public IPv4 address (IPv6 too, if you have it), Docker Engine with the
  Compose plugin, and `git`.
- Two DNS names, one for the app and one for LiveKit, for example `meet.example.com` and
  `livekit.example.com`.
- Size: 2 vCPUs and 2 GB of RAM handle a few small meetings. Bandwidth is the limit: each
  person sends their video once and receives everyone else's, so a 10-person meeting with
  video needs roughly 10 × 9 × 0.5 to 1.5 Mbps through the server. To measure yours, run
  LiveKit's load test against it, for example
  `lk load-test --url wss://livekit.example.com --api-key mooz --api-secret "$SECRET" --room load --video-publishers 5 --subscribers 10 --duration 1m`
  (see `lk load-test --help` for the current flags).

## 1. DNS

Point both names at the server: an `A` record for each, and an `AAAA` record for each if the
server has IPv6. Caddy can't get certificates until both resolve.

## 2. Firewall

Open these, for IPv4 and IPv6 both:

| Port | Why |
|---|---|
| 22/tcp | SSH |
| 80/tcp | Let's Encrypt, and redirects to HTTPS |
| 443/tcp and 443/udp | HTTPS (443/udp is HTTP/3) |
| 7881/tcp | Media over TCP, for networks that block UDP |
| 7882/udp | Media |
| 3478/udp | TURN, for people behind strict NATs |

Never open 7880 or 3000. They listen on 127.0.0.1 anyway; the firewall is a second line.

With `ufw`:

```bash
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443
sudo ufw allow 7881/tcp && sudo ufw allow 7882/udp && sudo ufw allow 3478/udp
sudo ufw enable
```

Check `IPV6=yes` in `/etc/default/ufw` so the rules cover IPv6 too.

## 3. Settings

```bash
git clone https://github.com/Kainoa00/mooz.git && cd mooz/deploy
cp .env.example .env && chmod 600 .env
openssl rand -base64 48        # the LiveKit secret
nano .env
```

Fill in both domains, `MOOZ_PUBLIC_URL` (`https://` plus the app's name), `LIVEKIT_URL`
(`wss://` plus LiveKit's name) and `LIVEKIT_API_SECRET`. The server refuses to start with a
short or well-known secret, a `ws://` LiveKit address, or no `MOOZ_PUBLIC_URL`, and says which.
Keep `.env` out of git and out of backups that others can read.

## 4. Start it

```bash
docker compose up -d
docker compose logs -f web
```

The web image comes from `ghcr.io/kainoa00/mooz-web`; if it can't be pulled, Compose builds
it from this checkout. The first start takes a minute while Caddy gets certificates.

## 5. Check it

- `curl -s https://meet.example.com/api/ready` says `{"ok":true}`.
- `sudo ss -lntup | grep -E ':(3000|7880)\b'` shows both on `127.0.0.1` only.
- Start a meeting in Chrome and join it from Firefox: both see and hear each other.
- Join from a phone on mobile data (not your Wi-Fi): media works. If it works on Wi-Fi but not
  on mobile data, check 7882/udp and 3478/udp. If it still fails only on strict networks,
  LiveKit's TURN also relays on 30000–40000/udp (it logs this range at startup); opening that
  range is a first thing to try. That case isn't verified yet.
- `docker compose logs web | grep "webhooks are reaching"` finds the line
  `LiveKit webhooks are reaching mooz.` after the first meeting. Without webhooks, removed
  agents can come back while their token lasts, and meetings aren't forgotten when they end
  (see [LiveKit's webhook](protocol.md#livekits-webhook)).

## People bringing agents

- **Bridge (`mooz-agent`):** the dialog shows the command with `--server https://meet.example.com`.
  The bridge refuses an `http://` server on another machine, because its secret would cross
  the network unencrypted (`--allow-http` exists for tests on your own network).
- **Connector (Grok, Claude or ChatGPT):** the assistant app calls the connector link from the
  internet, so `MOOZ_PUBLIC_URL` must be the real `https://` address.
- **Local voice:** a speech server runs on each owner's own computer, never on this server.
  - In the browser (Chrome, Edge or Firefox), the meeting page reaches it at
    `http://127.0.0.1:3900/v1`. VoiceStudio needs the meeting's address in
    `OMNIVOICE_ALLOWED_ORIGINS`, for example
    `https://meet.example.com,http://localhost:3901,http://127.0.0.1:3901,app://voicestudio`
    (setting it replaces VoiceStudio's defaults, so keep them).
  - For a bridge, set `MOOZ_VOICE=local`.
  - A speech server on another machine is reached through a tunnel, so it still looks like
    this computer: `ssh -L 3900:gpu-box:3900 gpu-box`.

## Backups

The database holds rooms (a link, a hash of the host's secret, the notes policy) and
connectors; people and meetings are deleted when they end. A copy taken during a meeting holds
the names of the people in it, so back up between meetings. SQLite's own copy is safe while the
server runs:

```bash
docker compose exec web node -e "new (require('node:sqlite').DatabaseSync)('/data/mooz.db').exec(\"VACUUM INTO '/data/backup.db'\")"
docker compose cp web:/data/backup.db ./mooz-$(date +%F).db
docker compose exec web rm /data/backup.db
```

Keep `.env` backed up separately; without the LiveKit secret, a restore needs a new one (every
connector keeps working; nobody is mid-meeting after a restore anyway).

## Upgrades

Between meetings: back up, then

```bash
git pull && docker compose pull && docker compose up -d
```

The database upgrades itself when the new version starts. Set `MOOZ_VERSION` in `.env` to pin
a version.

## One web instance

Run exactly one web container. Turn-taking, rate limits and connector questions live in its
memory, so a second instance would split them (and a restart forgets them: the answers
waiting for a turn are dropped, and the chat still has them).

## Limits by IP address

mooz's own limits are per person, meeting and claim, with ceilings across the server (new
meetings and new connectors a minute, and the number of connectors); it keeps no IP addresses.
So one client that joins over and over can use up a ceiling for everyone. On a server open to
the internet, add per-IP limits in Caddy, below those ceilings, with the `caddy-ratelimit`
module. This isn't part of the tested setup yet, so check the module's documentation for the
current syntax.

1. Build Caddy with the module. Save this as `deploy/Caddy.Dockerfile` (it pins a commit: the
   module's only release, v0.1.0, can't group IPv6 addresses):

   ```dockerfile
   FROM caddy:2.11.7-builder AS builder
   RUN xcaddy build --with github.com/mholt/caddy-ratelimit@5625512f24f6f59d6f64fb3aafe5eecff0b286db
   FROM caddy:2.11.7
   COPY --from=builder /usr/bin/caddy /usr/bin/caddy
   ```

2. In `deploy/compose.yaml`, have the `caddy` service build it instead of using the stock image
   (which refuses `rate_limit`). Replace `image: caddy:2.11.7` with:

   ```yaml
       build:
         context: .
         dockerfile: Caddy.Dockerfile
   ```

3. In `deploy/Caddyfile`, add a `rate_limit` block at the top of the `{$MOOZ_DOMAIN}` site, so it
   reads as below. Leave the global block at the top of the file (the log filter) and the
   `{$LIVEKIT_DOMAIN}` site as they are. No `order` line is needed: the module runs before
   `reverse_proxy` on its own.

   ```caddyfile
   {$MOOZ_DOMAIN} {
   	rate_limit {
   		# Below the server-wide ceilings, so one address (one /64 over IPv6) can't use them up.
   		zone new_things {
   			match {
   				method POST
   				path /api/rooms /api/connectors
   			}
   			key {remote_host}
   			ipv6_prefix 64
   			events 5
   			window 1m
   		}
   		zone joins {
   			match {
   				method POST
   				path /api/rooms/*/join
   			}
   			key {remote_host}
   			ipv6_prefix 64
   			events 20
   			window 1m
   		}
   		zone everything {
   			key {remote_host}
   			ipv6_prefix 64
   			events 300
   			window 1m
   		}
   	}
   	header Strict-Transport-Security "max-age=31536000; includeSubDomains"
   	reverse_proxy 127.0.0.1:3000
   }
   ```

4. In `deploy`, build it and check the file, then start it:

   ```bash
   docker compose build caddy
   docker compose run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile
   docker compose up -d caddy
   ```

   These are edits to files in the repository: at an upgrade, if `git pull` refuses because
   they changed upstream too, run `git stash`, pull, then `git stash pop`.

People behind one address or one IPv6 /64 (an office, a school, a home) share these, so raise
them if they get in each other's way. A client with many addresses (several /64s, or a botnet)
still gets past them: they raise the cost of using up a ceiling, they don't remove it.

## Appendix: TURN over TLS on 443 (untested)

Some networks allow only TCP 443. LiveKit can serve TURN over TLS so media gets through them,
but 443 belongs to Caddy here. The usual answer is Caddy's `layer4` module, which routes TLS by
name before HTTP: send `turn.example.com` to LiveKit's TURN TLS port, everything else to the
HTTP server. In `livekit.yaml` that means `turn.domain: turn.example.com`, `turn.tls_port`, and
`external_tls: true`. We haven't tested this, so treat it as a starting point, and check
LiveKit's and caddy-l4's documentation for the current settings.
