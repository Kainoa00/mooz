// node --test scripts/check-version.test.mjs (the version check and the release notes)
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkVersions } from "./check-version.mjs";
import { releaseNotes } from "./release-notes.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FILES = [
  "apps/web/package.json",
  "bridge/pyproject.toml",
  "apps/web/lib/mcp.ts",
  "apps/web/Dockerfile",
  "deploy/compose.yaml",
  "CHANGELOG.md",
];

let dirs = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** A copy of the version files, so a test can change them. */
function copy() {
  const dir = mkdtempSync(join(tmpdir(), "mooz-version-"));
  dirs.push(dir);
  for (const file of FILES) cpSync(join(ROOT, file), join(dir, file), { recursive: true });
  return dir;
}

function edit(dir, file, from, to) {
  const text = readFileSync(join(dir, file), "utf8");
  assert.ok(text.includes(from), `${file} has ${from}`);
  writeFileSync(join(dir, file), text.replace(from, to));
}

const current = () => checkVersions(ROOT).version;

test("the repository's versions agree", () => {
  const { version, problems } = checkVersions(ROOT);
  assert.deepEqual(problems, []);
  assert.match(version, /^\d+\.\d+\.\d+/);
});

for (const [file, from, to] of [
  ["apps/web/package.json", (v) => `"version": "${v}"`, `"version": "9.9.9"`],
  ["bridge/pyproject.toml", (v) => `version = "${v}"`, `version = "9.9.9"`],
  ["apps/web/lib/mcp.ts", (v) => `version: "${v}"`, `version: "9.9.9"`],
  ["apps/web/Dockerfile", (v) => `ARG VERSION=${v}`, "ARG VERSION=9.9.9"],
  ["deploy/compose.yaml", (v) => `MOOZ_VERSION:-${v}}`, "MOOZ_VERSION:-9.9.9}"],
  ["CHANGELOG.md", (v) => `## [${v}]`, "## [9.9.9]"],
]) {
  test(`a different version in ${file} fails`, () => {
    const dir = copy();
    edit(dir, file, from(current()), to);
    const { problems } = checkVersions(dir);
    assert.equal(problems.length, 1);
    assert.match(problems[0], new RegExp(`${file.replace(".", "\\.")} says 9\\.9\\.9`));
  });
}

test("a version it can't find fails", () => {
  const dir = copy();
  edit(dir, "apps/web/lib/mcp.ts", `version: "${current()}"`, "version: VERSION");
  assert.deepEqual(checkVersions(dir).problems, ["apps/web/lib/mcp.ts: no version found"]);
});

test("a missing file fails", () => {
  const dir = copy();
  rmSync(join(dir, "CHANGELOG.md"));
  assert.deepEqual(checkVersions(dir).problems, ["CHANGELOG.md: missing"]);
});

test("only the project's own version in pyproject counts", () => {
  const dir = copy();
  edit(dir, "bridge/pyproject.toml", `version = "${current()}"`, `# version = "${current()}"`);
  const text = readFileSync(join(dir, "bridge/pyproject.toml"), "utf8");
  writeFileSync(join(dir, "bridge/pyproject.toml"), `${text}\n[tool.other]\nversion = "${current()}"\n`);
  assert.deepEqual(checkVersions(dir).problems, ["bridge/pyproject.toml: no version found"]);
});

test("a release needs the matching tag and a dated changelog entry", () => {
  const dir = copy();
  const v = current();
  const heading = readFileSync(join(dir, "CHANGELOG.md"), "utf8").match(new RegExp(`^## \\[${v.replaceAll(".", "\\.")}\\].*$`, "m"))[0];

  edit(dir, "CHANGELOG.md", heading, `## [${v}] - Unreleased`);
  assert.deepEqual(checkVersions(dir, `v${v}`).problems, [
    `CHANGELOG.md: date the ${v} entry ("## [${v}] - YYYY-MM-DD") before releasing it`,
  ]);
  assert.deepEqual(checkVersions(dir).problems, [], "fine before a release");

  edit(dir, "CHANGELOG.md", `## [${v}] - Unreleased`, `## [${v}] - 2026-10-30`);
  assert.deepEqual(checkVersions(dir, `v${v}`).problems, []);
  assert.deepEqual(checkVersions(dir, "v9.9.9").problems, [`the tag v9.9.9 isn't v${v}`]);
  assert.deepEqual(checkVersions(dir, v).problems, [`the tag ${v} isn't v${v}`]);
});

test("an Unreleased section above the entry is skipped", () => {
  const dir = copy();
  const v = current();
  edit(dir, "CHANGELOG.md", `## [${v}]`, `## [Unreleased]\n\n- Something new\n\n## [${v}]`);
  assert.deepEqual(checkVersions(dir).problems, []);
});

test("the release notes are the version's changelog entry, with links that work on GitHub", () => {
  const changelog = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "- Next",
    "",
    "## [0.2.0] - 2026-11-01",
    "",
    "### Added",
    "",
    "- A [guide](docs/deploy-vps.md), [policy](SECURITY.md), [limits](docs/protocol.md#limits),",
    "  [LiveKit](https://livekit.io), [mail](mailto:a@b.c) and [here](#added).",
    "",
    "## [0.1.0] - 2026-10-30",
    "",
    "- First",
    "",
    "[0.2.0]: https://github.com/o/r/releases/tag/v0.2.0",
    "",
  ].join("\n");
  const base = "https://github.com/o/r/blob/v0.2.0/";
  assert.equal(
    releaseNotes(changelog, "0.2.0", base),
    [
      "### Added",
      "",
      "- A [guide](https://github.com/o/r/blob/v0.2.0/docs/deploy-vps.md), [policy](https://github.com/o/r/blob/v0.2.0/SECURITY.md), [limits](https://github.com/o/r/blob/v0.2.0/docs/protocol.md#limits),",
      "  [LiveKit](https://livekit.io), [mail](mailto:a@b.c) and [here](#added).",
    ].join("\n"),
  );
  assert.equal(releaseNotes(changelog, "0.1.0", base), "- First");
  assert.equal(releaseNotes(changelog, "0.3.0", base), undefined);
});

test("the repository's changelog has notes for its version", () => {
  const v = current();
  const notes = releaseNotes(readFileSync(join(ROOT, "CHANGELOG.md"), "utf8"), v, `https://github.com/o/r/blob/v${v}/`);
  assert.match(notes, /^The first release|### Added/m);
  assert.doesNotMatch(notes, /\]\((?!https:|#)/, "every link is absolute");
});
