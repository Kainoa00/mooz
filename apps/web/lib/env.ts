/** A positive whole number from the environment, or `fallback` when it's unset or not one. */
export function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
