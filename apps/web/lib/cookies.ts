export const hostCookie = (slug: string) => `mooz_host_${slug}`;
export const participantCookie = (slug: string) => `mooz_p_${slug}`;

/** Read one cookie from a request's Cookie header. */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0 && part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return undefined;
}

/** This machine's own names, as a Host header carries them (with or without a port). */
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

export function isHttps(req: Request): boolean {
  const forwarded = req.headers.get("x-forwarded-proto");
  const said = forwarded ? forwarded.split(",")[0].trim() === "https" : new URL(req.url).protocol === "https:";
  // Someone on the server's own machine over plain http (a laptop whose public address is a
  // tunnel) gets cookies without Secure: Safari drops Secure ones on http://localhost.
  if (!said && LOOPBACK_HOST.test(req.headers.get("host") ?? new URL(req.url).host)) return false;
  // Otherwise the configured public address is the truth (a TLS proxy may not say x-forwarded-proto).
  const configured = process.env.MOOZ_PUBLIC_URL;
  if (configured) {
    try {
      return new URL(configured).protocol === "https:";
    } catch {
      // fall through to what the request says
    }
  }
  return said;
}

/** Build an HTTP-only, SameSite=Lax session cookie, Secure whenever served over HTTPS. */
export function sessionCookie(req: Request, name: string, value: string, maxAgeSeconds = 86400): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isHttps(req)) parts.push("Secure");
  return parts.join("; ");
}
