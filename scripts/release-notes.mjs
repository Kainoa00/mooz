#!/usr/bin/env node
// The CHANGELOG entry for a version, as the GitHub Release's notes:
// `node scripts/release-notes.mjs 0.1.0 https://github.com/OWNER/REPO/blob/v0.1.0/`.
// Links to files in the repository are made absolute (the base), so they work on the release
// page too.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The body of the `## [version]` entry, or undefined if there's none. */
export function releaseNotes(changelog, version, base) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  // The entry ends at the next one, or at the link definitions at the bottom.
  const end = rest.findIndex((line) => line.startsWith("## [") || /^\[[^\]]+\]: /.test(line));
  const body = rest.slice(0, end === -1 ? undefined : end).join("\n").trim();
  return body.replace(/\]\((?![a-z][a-z0-9+.-]*:|#)([^)\s]+)\)/gi, (_, path) => `](${new URL(path, base)})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [version, base] = process.argv.slice(2);
  if (!version || !base) {
    console.error("Usage: node scripts/release-notes.mjs VERSION BASE_URL");
    process.exit(2);
  }
  const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  const notes = releaseNotes(changelog, version, base);
  if (!notes) {
    console.error(`CHANGELOG.md has no entry for ${version}`);
    process.exit(1);
  }
  console.log(notes);
}
