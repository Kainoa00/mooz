/** Next.js runs this once when the server starts: a production server with unsafe settings stops here. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NODE_ENV !== "production") return;
  const { checkConfig } = await import("./lib/config-check");
  const problems = checkConfig();
  if (problems.length === 0) return;
  console.error(`mooz can't start with these settings:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
