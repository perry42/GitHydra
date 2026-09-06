<p align="center">
  <img src="packages/desktop/build/icons/512x512.png" width="120" height="120" alt="GitHydra logo">
</p>

<h1 align="center">GitHydra</h1>

<p align="center">
  <strong>A free, open-source, GitKraken-style visual git client.</strong><br>
  Works with any git repo. No sign-in. No telemetry. No paywalls. Free, forever.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: GPL-3.0-or-later" src="https://img.shields.io/badge/license-GPL--3.0--or--later-2a78d6?style=flat-square"></a>
  <img alt="Platforms" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-1a1a19?style=flat-square">
  <img alt="Built with Electron, React, TypeScript" src="https://img.shields.io/badge/built%20with-Electron%20%C2%B7%20React%20%C2%B7%20TypeScript-1a1a19?style=flat-square">
</p>

<p align="center">
  <img src="docs/assets/demo.gif" alt="GitHydra demo: browsing a merge-heavy commit graph, opening a commit's details, and staging a file to view its diff" width="880">
</p>

<br>

## See your repo's shape, not its text

GitHydra treats a commit graph the way a transit map treats a rail network: branches are
lines, merges are interchange stations, commits are stops. Open any repo and immediately see
where you are, what happened, and how it all connects, instead of reconstructing topology
from `git log --graph` in your head.

## Download

<p align="center">
  <a href="https://github.com/perry42/GitHydra/releases/latest"><img alt="Download for Windows" src="https://img.shields.io/badge/Windows-Releases-2a78d6?style=for-the-badge&logo=windows&logoColor=white"></a>
  <a href="https://github.com/perry42/GitHydra/releases/latest"><img alt="Download for macOS" src="https://img.shields.io/badge/macOS-Releases-2a78d6?style=for-the-badge&logo=apple&logoColor=white"></a>
  <a href="https://github.com/perry42/GitHydra/releases/latest"><img alt="Download for Linux" src="https://img.shields.io/badge/Linux-Releases-2a78d6?style=for-the-badge&logo=linux&logoColor=white"></a>
</p>
<p align="center"><sub>
  🚧 No installers published yet. The release pipeline is still queued (see <a href="ROADMAP.md">ROADMAP.md</a>) —
  <a href="#build-from-source">build from source</a> in the meantime, it's two commands.
</sub></p>

## Why GitHydra

- **Works with any git host, or none at all.** GitHub, GitLab, Bitbucket, self-hosted (Gitea
  and friends), local-only repos, bare repos, submodules, worktrees: all first-class, none required.
- **No forced sign-in, no telemetry by default, no feature paywalls.** GitHydra runs entirely
  against your local git and your own remotes. There's no proprietary backend to sign into,
  and nothing phones home.
- **Always free, and it stays that way.** Licensed [GPL-3.0-or-later](#license): GitHydra and
  every fork of it stay free and open, not just this release.

## Features

| | |
|---|---|
| **Commit graph** | Branch topology and merge structure rendered as a schematic diagram, legible at a glance even on large, merge-heavy histories. |
| **Stage, diff, commit** | Per-file working-directory status, full diff view (image diffs included), stage / unstage / discard, and a commit composer. |
| **Branch management** | Create, switch, and delete local and remote-tracking branches, with locally-computed ahead/behind and zero network calls. |
| **Merge & rebase** | Rich in-progress-operation detail plus a real conflict-resolution UI across text, rename, delete/modify, binary, and submodule conflicts. |
| **Stash** | List, preview, create, apply, pop, and drop stashes, aware of shared worktrees. |
| **Cherry-pick** | Single or multi-commit selection, graph-order application, full conflict resolution. |
| **Blame & file history** | Per-line authorship and file evolution, paged to stay fast on huge histories. |

## Build from source

Requires [Node.js](https://nodejs.org) ≥ 18 and [git](https://git-scm.com) ≥ 2.24 on your `PATH`.

```bash
git clone https://github.com/perry42/GitHydra.git
cd GitHydra
npm install
npm run build
npm start
```

## Contributing

Issues and pull requests are welcome.

## License

GitHydra is licensed under [GPL-3.0-or-later](LICENSE).

GitHydra is not affiliated with, endorsed by, or sponsored by Axosoft or GitKraken.
