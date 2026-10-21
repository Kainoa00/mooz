# Releasing mooz

The web app and `mooz-agent` share one version. A `v*` tag runs
[`release.yml`](../.github/workflows/release.yml):

1. CI again (the whole of [`ci.yml`](../.github/workflows/ci.yml)).
2. The version check: every version agrees, the tag is `v<version>`, and its CHANGELOG entry is
   dated.
3. `uv build` of the bridge, then a check that the wheel installs and runs.
4. **PyPI** (waits for approval in the `pypi` environment): trusted publishing, no token.
5. **GHCR** (waits for approval in the `release` environment): the web image for amd64 and
   arm64, tagged `X.Y.Z`, `X.Y` and `latest` (a pre-release like `X.Y.Z-rc.1` gets only its own
   tag).
6. **GitHub Release** (`release` environment): the CHANGELOG entry, plus the wheel and sdist.

Running the workflow by hand (Actions → Release → Run workflow) is a dry run: the same builds,
the package goes to TestPyPI, and the image is built but not pushed.

## One-time setup

- **PyPI.** At pypi.org → Your projects → Publishing, add a pending publisher: project
  `mooz-agent`, owner `Kainoa00`, repository `mooz`, workflow `release.yml`, environment
  `pypi`. Do the same on test.pypi.org with environment `testpypi`. A pending publisher
  doesn't reserve the name; the first upload does.
- **Environments.** In the repository's Settings → Environments, create `pypi`, `testpypi` and
  `release`. Give `pypi` and `release` a required reviewer (you) and limit them to tags
  matching `v*`.
- **Private vulnerability reporting.** Settings → Code security → turn it on (it's what
  [SECURITY.md](../SECURITY.md) points to).
- **After the first image push.** GHCR packages start private: on the `mooz-web` package's page,
  Package settings → Change visibility → Public, so servers can pull it without logging in.

## Each release

1. Set the new version everywhere `node scripts/check-version.mjs` looks (it says which file
   disagrees): `apps/web/package.json`, `bridge/pyproject.toml`, `apps/web/lib/mcp.ts`,
   `apps/web/Dockerfile`, `deploy/compose.yaml`, and a new `## [X.Y.Z] - YYYY-MM-DD` entry at the
   top of `CHANGELOG.md`. Run `uv lock` in `bridge` so the lockfile has it too.
2. Commit, push `main`, and wait for green CI.
3. Optional: the dry run. TestPyPI keeps a version forever, so a second dry run of the same
   version skips the upload.
4. Tag the green commit and push the tag:

   ```bash
   git tag -a v0.1.0 -m "mooz 0.1.0"
   git push origin v0.1.0
   ```

5. Approve the `pypi` and `release` deployments when the workflow asks.
6. Check: `uvx mooz-agent --version`, `docker pull ghcr.io/kainoa00/mooz-web:0.1.0` (logged out),
   and the release page.

A PyPI version can never be uploaded again, even after deleting it. If something is wrong after
the upload, fix it and release the next patch version.
