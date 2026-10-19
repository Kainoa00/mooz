/**
 * The pages' Content Security Policy. Scripts run only with this request's nonce, so injected
 * markup can't run code (and read an owner's ElevenLabs key); connections go only to this
 * server, its LiveKit, and ElevenLabs; and no other site can frame the meeting.
 */

export const ELEVENLABS_ORIGINS = ["https://api.elevenlabs.io", "wss://api.elevenlabs.io"];

/** LiveKit's WebSocket origin and the HTTP one its client checks a failed connection with. */
export function livekitOrigins(url: string | undefined): string[] {
  if (!url) return [];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return [];
  if (!/^[A-Za-z0-9.\-[\]:]+$/.test(parsed.host)) return []; // nothing that could end a directive
  const ws = `${parsed.protocol}//${parsed.host}`;
  const http = `${parsed.protocol === "wss:" ? "https:" : "http:"}//${parsed.host}`;
  return [ws, http];
}

export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

export function contentSecurityPolicy({
  nonce,
  livekitUrl,
  dev = false,
}: {
  nonce: string;
  livekitUrl?: string;
  dev?: boolean;
}): string {
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    // React needs eval in development only, for its debugging stacks.
    "script-src": ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(dev ? ["'unsafe-eval'"] : [])],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "blob:", "data:"],
    "font-src": ["'self'"],
    "media-src": ["'self'", "blob:"],
    "connect-src": ["'self'", ...livekitOrigins(livekitUrl), ...ELEVENLABS_ORIGINS],
    "worker-src": ["'self'", "blob:"],
    "object-src": ["'none'"],
    "base-uri": ["'none'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}
