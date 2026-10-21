import { checkConfig } from "@/lib/config-check";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * For the container's health check and the operator: the database opens and the settings
 * would pass the startup check. Details go to the logs only.
 */
export async function GET(): Promise<Response> {
  const problems = checkConfig();
  try {
    getDb().prepare("SELECT 1").get();
  } catch (err) {
    problems.push(`The database didn't open: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (problems.length) {
    console.error(`mooz isn't ready:\n- ${problems.join("\n- ")}`);
    return Response.json({ ok: false }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
