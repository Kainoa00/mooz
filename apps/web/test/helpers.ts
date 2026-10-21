import { resetSweepForTests } from "@/lib/cleanup";
import { resetDbForTests } from "@/lib/db";
import { resetRateLimitsForTests } from "@/lib/rate-limit";

/** Fresh in-memory database and LiveKit test credentials for each test. */
export function useTestEnv(): void {
  process.env.MOOZ_DB_PATH = ":memory:";
  process.env.LIVEKIT_URL = "ws://livekit.test:7880";
  process.env.LIVEKIT_API_KEY = "testkey";
  process.env.LIVEKIT_API_SECRET = "testsecret-testsecret-testsecret-0";
  resetDbForTests();
  resetRateLimitsForTests();
  resetSweepForTests();
}

export const LK_KEY = "testkey";
export const LK_SECRET = "testsecret-testsecret-testsecret-0";

export function jsonRequest(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

export function params<T extends Record<string, string>>(
  value: T,
): { params: Promise<T> } {
  return { params: Promise.resolve(value) };
}

/** Extract `name=value` pairs from a response's Set-Cookie headers. */
export function setCookies(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const idx = pair.indexOf("=");
    out[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return out;
}

/** Agent names that are valid and that no two of sound alike, for tests that need many. */
export const AGENT_NAMES = [
  "Atlas",
  "Nova",
  "Grok",
  "Orion",
  "Pixel",
  "Quill",
  "Sage",
  "Vega",
  "Juno",
  "Kiwi",
  "Lumen",
  "Rocket",
] as const;
