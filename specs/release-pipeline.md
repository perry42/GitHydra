# PRD: Release Pipeline

Status: draft — spec-first per `AGENTS.md`; not yet implemented.
Owner: product-manager
Sequencing: this is CI/build infrastructure, not git logic or UI rendering — it doesn't cleanly
fall under either git-core-engineer's or ui-graphics's stated domain in `AGENTS.md`. Closest fit is
ui-graphics, since it already owns "the Electron shell" and landed the electron-builder/icon work
this spec builds on (`e8e248e`) — but either agent (or a direct main-thread implementation) is fine
since FR-171–180 touch no `packages/git-core` logic and no rendered UI beyond a small README edit.
No git-core-engineer/ui-graphics split is needed for this spec; it's one contiguous piece of work.

Raised in `ROADMAP.md` ("Release pipeline (queued — the actual gap once packaging lands)"),
explicitly marked next once the licensing decision landed. This spec turns that intake note into
buildable scope.

## Problem

`packages/desktop/electron-builder.yml` and the app icon set (`e8e248e`) already make
`npm run package` produce a Windows NSIS `.exe`, a macOS `.dmg` (x64 + arm64), and a Linux
AppImage/`.deb` — but only on the machine that runs that command. There is no way today for
anyone who isn't willing to clone the repo and build it themselves to get a running copy of
GitHydra. The root README (`README.md`'s "Download" section) already links to
`github.com/perry42/GitHydra/releases/latest` with a placeholder "no installers published yet"
note — the public-facing surface is already written assuming this gap closes next. Until it does,
GitHydra is source-available to contributors but not actually downloadable by a real user, which
undercuts the point of finishing the licensing and README work.

## Target user

Two distinct users, both required for this to be "done":
- **A prospective user** who finds the GitHub repo, wants to try GitHydra, and should not need to
  install Node, clone the repo, or run a build to do it — same bar as any other desktop app's
  install experience (GitKraken, Sourcetree, Fork).
- **The maintainer**, tagging a release, who should not need to hand-run `npm run package` on three
  separate physical machines (Windows/macOS/Linux) and manually upload the results — a `git push
  --tags` should be sufficient.

## Must-have behavior

### CI workflow (`.github/workflows/release.yml`)

- FR-171: Triggered only by pushing a tag matching `v[0-9]+.[0-9]+.[0-9]+` (e.g. `v1.0.0`) — not by
  pushes to any branch, not by other tag patterns (e.g. no accidental trigger on a `v1.0.0-rc1`
  pre-release tag unless that pattern is explicitly included later; out of scope for v1 of this
  pipeline). No workflow runs — and no CI minutes are spent — on ordinary commits.
- FR-172: A version-consistency check runs before any packaging step, on any one runner: the pushed
  tag's version (stripped of the leading `v`) must exactly match `packages/desktop/package.json`'s
  `"version"` field. On mismatch, the workflow fails immediately with a clear error message and no
  packaging job runs — this prevents ever publishing installers whose `artifactName` (which embeds
  `${version}` per `electron-builder.yml`) doesn't match the tag/Release it's attached to. This
  means the maintainer's release process is: bump `version` in `package.json` (root and
  `packages/desktop`, kept in lockstep), commit, tag that commit `vX.Y.Z`, push the tag. Documented
  in this spec's own "Releasing" section below since no `CONTRIBUTING.md` exists yet.
- FR-173: Three build jobs run in a matrix — `windows-latest`, `macos-latest`, `ubuntu-latest` —
  each: checkout, set up Node.js >=18 (matching `packages/desktop/package.json`'s `engines.node`),
  `npm ci` at the repo root (this is an npm-workspaces monorepo — `packages/desktop` depends on
  hoisted root `node_modules` plus the local `@githydra/git-core` workspace package, so `npm ci`
  must run at root, not inside `packages/desktop`), then `npm run build` (root script: builds
  `git-core` first, then the desktop app), then `npm run package --workspace=packages/desktop`
  (electron-builder, using the existing `electron-builder.yml` unchanged).
- FR-174: The macOS job's single `electron-builder` invocation produces both x64 and arm64 `.dmg`
  files in one run, per `electron-builder.yml`'s existing `mac.target[0].arch: [x64, arm64]` —
  no separate per-architecture job needed.
- FR-175: Each matrix job uploads its produced installer(s) from `packages/desktop/release/` as a
  named CI artifact (`actions/upload-artifact` or equivalent), scoped per-OS so the publish job
  (FR-176) can collect all three without re-running any build.
- FR-176: A fourth job (`publish`), gated with `needs:` on all three matrix build jobs succeeding,
  downloads every uploaded artifact and creates one GitHub Release for the pushed tag using the
  repo's automatically-provided `GITHUB_TOKEN` — no additional secret, credential, or external
  account required. It uploads: the Windows `.exe`, both macOS `.dmg` files, the Linux AppImage, and
  the Linux `.deb`, plus a generated `SHA256SUMS.txt` covering all of them (computed in this job
  from the collected files, not per-platform, so it's one file with all hashes).
- FR-177: If any of the three matrix build jobs fails, the `publish` job does not run (enforced by
  its `needs:` dependency) — no GitHub Release is created and no partial set of assets is ever
  uploaded. A failed platform build is visible as a failed Actions run, not a silently incomplete
  release.
- FR-178: The Release body includes (hand-written boilerplate text checked into the workflow or a
  template file, not auto-generated release notes) a short note that installers are unsigned, plus
  the exact workaround for each platform: Windows SmartScreen's "More info → Run anyway" click-
  through, and macOS Gatekeeper's right-click → Open (or `xattr -cr` on the `.app` after mounting
  the `.dmg`) for an unsigned/unnotarized build. This is the "ship unsigned + document the
  workaround" plan `ROADMAP.md` already committed to — this spec does not reopen the code-signing
  cost question.

### Documentation

- FR-179: Root `README.md`'s existing "Download" section (already present, linking to
  `github.com/perry42/GitHydra/releases/latest`) has its "No installers published yet... build from
  source in the meantime" placeholder note removed once this pipeline has produced at least one
  real tagged release — the badges/links themselves need no change, only the caveat text beneath
  them.
- FR-180: Document the FR-172 version-bump-then-tag release sequence so the maintainer doesn't have
  to reverse-engineer it from the workflow YAML next time — see "Releasing a new version" below.
  Move it into `CONTRIBUTING.md` if/when that file is created; no need to block this spec on that.

## Non-goals

- **Code signing / notarization.** Explicitly deferred per `ROADMAP.md`'s own note — a real cost
  decision (Windows EV cert, Apple Developer Program) for the user to make later, not assumed here
  either way. This spec ships unsigned installers with documented workarounds (FR-178) as the
  interim plan.
- **Auto-update mechanism.** Materially larger scope (update-check + in-app download/apply flow);
  not required to get versioned installers onto a Release page. Track separately if/when raised.
- **Publishing to package managers or app stores** (Homebrew Cask, winget, Scoop, Snap, Flathub,
  etc.). GitHub Releases only for v1 of this pipeline — a future item if there's real pull for it.
- **Pre-release/nightly/dev builds** from non-tag pushes. Only version tags matching FR-171's
  pattern trigger a build; no CI-minute spend on every commit.
- **Changing `electron-builder.yml`'s existing targets, icons, or config.** That work already
  shipped (`e8e248e`) and is out of scope here — this pipeline only automates running the existing,
  unchanged `npm run package` on three hosted runners instead of by hand.
- **Any hosted/proprietary distribution backend.** GitHub Actions + GitHub Releases is pure CI
  infrastructure that builds and hosts artifacts for GitHydra's own project releases — it is not a
  service the running desktop app talks to, connects through, or depends on at runtime, and does
  not conflict with the "works with any git host, no host lock-in" principle (that principle
  governs what repos a *user* can open in GitHydra, not where GitHydra's own source/releases live).
- **Auto-generated release notes / changelog.** FR-176's Release gets the fixed unsigned-binary
  boilerplate (FR-178) only; writing actual per-version changelog content is a separate, manual
  maintainer task each time, not automated by this pipeline.

## Acceptance criteria

1. Pushing a tag matching `v[0-9]+.[0-9]+.[0-9]+` triggers `.github/workflows/release.yml`; pushing
   a branch, or a tag not matching that pattern, does not trigger it.
2. If the pushed tag's version doesn't match `packages/desktop/package.json`'s `"version"`, the
   workflow fails before any platform build job starts, with an error naming both values.
3. On a matching, consistent tag, three build jobs run (windows-latest, macos-latest,
   ubuntu-latest), each completing `npm ci` → `npm run build` → `npm run package` for
   `packages/desktop` successfully and uploading its resulting installer(s) as a CI artifact.
4. On all three succeeding, exactly one GitHub Release is created for that tag, containing: one
   Windows `.exe`, two macOS `.dmg` files (x64 and arm64), one Linux AppImage, one Linux `.deb`, and
   one `SHA256SUMS.txt` covering all five binaries.
5. If any one matrix job fails (simulate by temporarily breaking one platform's build), no GitHub
   Release is created at all — verified by the `publish` job not running / the workflow run showing
   a failure with zero Release created.
6. The workflow requires no repository secret beyond the built-in `GITHUB_TOKEN` — confirmed by
   reading the workflow YAML for any other `secrets.*` reference.
7. The created Release's body contains the unsigned-binary disclaimer and both platforms' documented
   workarounds (SmartScreen click-through, Gatekeeper right-click-open/`xattr -cr`).
8. `packages/desktop/electron-builder.yml` is byte-for-byte unchanged by this work — a contributor
   running `npm run package` locally gets identical output before and after this pipeline ships.
9. After the first real tagged release exists, `README.md`'s "Download" section no longer shows the
   "no installers published yet" placeholder text.
10. Zero new runtime network surface in the shipped app itself — this is CI-time infrastructure only;
    `packages/git-core`'s existing no-network-calls test coverage is unaffected and requires no
    changes.

## Releasing a new version (maintainer reference — FR-180)

1. Bump `"version"` in root `package.json` and `packages/desktop/package.json` to the same new
   value (e.g. `1.1.0`), commit that change.
2. Tag the commit: `git tag v1.1.0` (must match `v[0-9]+.[0-9]+.[0-9]+`, and must equal the
   `package.json` version with the `v` stripped — FR-172 enforces this).
3. `git push origin v1.1.0` (or `git push --tags`). This alone triggers the workflow; no manual
   build or upload step is needed.
4. Watch the Actions run. On success, a GitHub Release for `v1.1.0` appears with all five
   installers plus `SHA256SUMS.txt` attached automatically.

## References

- `ROADMAP.md`, "Release pipeline (queued — the actual gap once packaging lands)" — the intake note
  this spec formalizes, including the code-signing open question this spec deliberately does not
  reopen.
- `packages/desktop/electron-builder.yml` — existing, unchanged packaging config this pipeline
  automates running, including `artifactName: "${productName}-${version}-${os}-${arch}.${ext}"`
  (the string FR-172's version check protects) and the `mac.target[0].arch: [x64, arm64]` dual-arch
  config FR-174 relies on.
- `packages/desktop/package.json`'s `package`/`package:dir` scripts — the exact local command each
  matrix job's steps reproduce on a hosted runner.
- `README.md`'s "Download" section — the existing public-facing surface this pipeline makes real
  (FR-179).
- Commit `e8e248e` (`feat(desktop): add app icon and electron-builder packaging config`) — the
  already-landed, in-scope-unchanged prerequisite this spec builds on.
