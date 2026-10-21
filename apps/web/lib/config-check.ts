/**
 * What a server needs before it takes meetings, checked at startup (instrumentation.ts) and by
 * GET /api/ready. Each problem is a sentence for the operator's logs, never for a browser.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "livekit"]);
const WEAK_SECRETS = new Set(["secret", "devkey", "changeme", "change-me"]);
/** Placeholders people forget to replace (an earlier deploy/.env.example had one). */
const PLACEHOLDER = /^(replace|change)[-_ ]?(me|with|this)|^your[-_ ]/i;

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

const isLocal = (url: URL) => LOCAL_HOSTS.has(url.hostname);

export function checkConfig(env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const problems: string[] = [];
  const livekitUrl = env.LIVEKIT_URL ? parse(env.LIVEKIT_URL) : null;
  if (!env.LIVEKIT_URL) problems.push("LIVEKIT_URL is not set (the LiveKit address browsers and bridges use).");
  else if (!livekitUrl || (livekitUrl.protocol !== "ws:" && livekitUrl.protocol !== "wss:")) {
    problems.push("LIVEKIT_URL must be a ws:// or wss:// address, like wss://livekit.example.com.");
  }
  if (!env.LIVEKIT_API_KEY) problems.push("LIVEKIT_API_KEY is not set.");
  const secret = env.LIVEKIT_API_SECRET ?? "";
  if (!secret) problems.push("LIVEKIT_API_SECRET is not set.");

  const exposed = livekitUrl !== null && !isLocal(livekitUrl);
  if (exposed) {
    // The dev keys are public: with them anyone can mint any token, admin ones included.
    if (secret && (secret.length < 32 || WEAK_SECRETS.has(secret) || PLACEHOLDER.test(secret))) {
      problems.push("LIVEKIT_API_SECRET must be a random secret of 32 characters or more (openssl rand -base64 48).");
    }
    if (env.LIVEKIT_API_KEY === "devkey") problems.push("LIVEKIT_API_KEY is LiveKit's public dev key; use your own (the guide uses mooz).");
    if (livekitUrl.protocol === "ws:") problems.push("LIVEKIT_URL must be wss:// when LiveKit isn't on this machine.");
  }

  const publicUrl = env.MOOZ_PUBLIC_URL ? parse(env.MOOZ_PUBLIC_URL) : null;
  if (env.MOOZ_PUBLIC_URL) {
    if (!publicUrl || (publicUrl.protocol !== "https:" && publicUrl.protocol !== "http:")) {
      problems.push("MOOZ_PUBLIC_URL must be the address people open, like https://meet.example.com.");
    } else {
      if (publicUrl.protocol === "http:" && !isLocal(publicUrl)) {
        problems.push("MOOZ_PUBLIC_URL must be https:// (cookies, voice and assistant apps need it), unless it's localhost.");
      }
      if (publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password) {
        problems.push("MOOZ_PUBLIC_URL must be just the origin, like https://meet.example.com, with no path.");
      }
      if (publicUrl.protocol === "https:" && livekitUrl?.protocol === "ws:" && !isLocal(livekitUrl)) {
        problems.push("An https:// meeting needs a wss:// LIVEKIT_URL: browsers won't connect to ws:// from it.");
      }
    }
  } else if (exposed) {
    problems.push("Set MOOZ_PUBLIC_URL to the address people open, like https://meet.example.com.");
  }
  return problems;
}
