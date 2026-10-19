/** An error that maps directly onto an HTTP response. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Render any thrown value as a JSON error response, hiding internals for unexpected errors. */
export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return Response.json({ error: { code: err.code, message: err.message } }, { status: err.status });
  }
  console.error(err);
  return Response.json(
    { error: { code: "internal", message: "Something went wrong" } },
    { status: 500 },
  );
}

/** Request bodies past this are refused before they're read into memory. */
export const MAX_JSON_BYTES = 256 * 1024;

/** The body as text, or null once it passes `max` bytes (it stops reading there). */
export async function readCapped(req: Request, max: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Parse a request body that must be a JSON object (at most `maxBytes`). */
export async function readJson(req: Request, maxBytes = MAX_JSON_BYTES): Promise<Record<string, unknown>> {
  // Requiring the JSON content type means a plain HTML form (text/plain) can never
  // forge a request body, which is half of the CSRF defense (see session.ts).
  const type = req.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (type !== "application/json") {
    throw new HttpError(415, "unsupported_media_type", "Send the body as application/json");
  }
  const text = await readCapped(req, maxBytes);
  if (text === null) throw new HttpError(413, "too_large", "Request body is too large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "invalid_json", "Request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}
