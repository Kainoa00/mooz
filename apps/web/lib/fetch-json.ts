/** Read a JSON body without throwing on a non-JSON error page (proxies, 502s). */
export async function readBody(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await res.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The server's human-readable error message, or a fallback. */
export function errorMessage(body: Record<string, unknown> | null, fallback: string): string {
  const error = body?.error as { message?: unknown } | undefined;
  return typeof error?.message === "string" ? error.message : fallback;
}
