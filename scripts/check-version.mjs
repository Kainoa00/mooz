#!/usr/bin/env node
// Every place that names mooz's version must agree, with the top CHANGELOG entry and with the
// tag being released (if any). `node scripts/check-version.mjs [vX.Y.Z]`; in a GitHub Actions
// run for a tag, the tag comes from the environment.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Each file, and how to find the version in it. */
const SITES = [
  { file: "apps/web/package.json", find: (text) => JSON.parse(text).version },
  {
    file: "bridge/pyproject.toml",
    find: (text) => {
      const project = /^\[project\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(text)?.[1] ?? "";
      return /^version\s*=\s*"([^"]+)"\s*$/m.exec(project)?.[1];
    },
  },
  { file: "apps/web/lib/mcp.ts", find: (text) => /new McpServer\(\{\s*name:\s*"mooz",\s*version:\s*"([^"]+)"/.exec(text)?.[1] },
  { file: "apps/web/Dockerfile", find: (text) => /^ARG VERSION=(\S+)$/m.exec(text)?.[1] },
  { file: "deploy/compose.yaml", find: (text) => /mooz-web:\$\{MOOZ_VERSION:-([^}]+)\}/.exec(text)?.[1] },
];

// Keep a Changelog headings: "## [Unreleased]" (skipped), then "## [0.1.0] - 2026-10-30" or
// "## [0.1.0] - Unreleased" while it's being written.
const ENTRY = /^## \[([^\]]+)\](?: - (.+))?$/gm;

/** The problems found under `root`, for the release `tag` (like "v0.1.0") if there is one. */
export function checkVersions(root, tag) {
  const problems = [];
  const read = (file) => {
    try {
      return readFileSync(join(root, file), "utf8");
    } catch {
      problems.push(`${file}: missing`);
      return undefined;
    }
  };

  const found = [];
  for (const { file, find } of SITES) {
    const text = read(file);
    if (text === undefined) continue;
    let version;
    try {
      version = find(text);
    } catch {
      // unparseable, reported below
    }
    if (typeof version !== "string" || !SEMVER.test(version)) {
      problems.push(`${file}: no version found`);
    } else {
      found.push({ file, version });
    }
  }

  const changelog = read("CHANGELOG.md");
  let entry;
  if (changelog !== undefined) {
    entry = [...changelog.matchAll(ENTRY)].map((m) => ({ version: m[1], date: m[2] })).find((e) => e.version !== "Unreleased");
    if (!entry || !SEMVER.test(entry.version)) problems.push("CHANGELOG.md: no version entry found");
    else found.push({ file: "CHANGELOG.md", version: entry.version });
  }

  const versions = new Set(found.map((f) => f.version));
  if (versions.size > 1) {
    problems.push(`versions disagree: ${found.map((f) => `${f.file} says ${f.version}`).join(", ")}`);
  }

  if (tag !== undefined) {
    const [version] = versions;
    if (tag !== `v${version}`) problems.push(`the tag ${tag} isn't v${version ?? "?"}`);
    if (entry && !/^\d{4}-\d{2}-\d{2}$/.test(entry.date ?? "")) {
      problems.push(`CHANGELOG.md: date the ${entry.version} entry ("## [${entry.version}] - YYYY-MM-DD") before releasing it`);
    }
  }
  return { version: versions.size === 1 ? [...versions][0] : undefined, problems };
}

function releaseTag(argv, env) {
  if (argv[0] !== undefined) return argv[0];
  return env.GITHUB_REF_TYPE === "tag" ? env.GITHUB_REF_NAME : undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const tag = releaseTag(process.argv.slice(2), process.env);
  const { version, problems } = checkVersions(root, tag);
  if (problems.length > 0) {
    console.error(`Version check failed:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log(`mooz ${version}${tag ? ` (tag ${tag})` : ""}: every version agrees`);
}
