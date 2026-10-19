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

function isHttps(req: Request): boolean {
  const forwarded = req.headers.get("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0].trim() === "https";
  return new URL(req.url).protocol === "https:";
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
