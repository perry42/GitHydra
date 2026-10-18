# Branches and releases

- **`dev`** is where work lands day to day (feature branches merge into it). CI runs on every push to `dev` and on pull requests (`.github/workflows/ci.yml`).
- **`main`** moves only at a release. It always matches the latest released version.
- **Release steps**
  1. On `dev`: bump the version in `packages/*/package.json`, update `CHANGELOG`/`ROADMAP.md`, make sure CI is green (run the nightly e2e job by hand once: Actions > CI > Run workflow).
  2. Merge `dev` into `main` (fast-forward or `--no-ff`), push `main`.
  3. Tag `vX.Y.Z` on `main` and push the tag: `release.yml` builds the installers and the GitHub Release.
  4. Update the README (version, download links, screenshots) and the landing page: the site lives on the separate `gh-pages` branch, bump its version label there too (manual by design).
  5. Merge `main` back into `dev` if the release commit touched it.
