// SPDX-License-Identifier: GPL-3.0-or-later
import type { WorktreeDependencyKind, WorktreeSetupHints } from "./ipcContract";

/**
 * specs/worktrees.md FR-633: the commands "Copy command" can put on the clipboard. A built-in table keyed by what was
 * detected, never anything derived from repo content, and never executed by GitHydra.
 */
export const DEPENDENCY_COMMANDS: Readonly<Record<WorktreeDependencyKind, string>> = {
  npm: "npm ci",
  yarn: "yarn install --frozen-lockfile",
  pnpm: "pnpm install --frozen-lockfile",
  python: "python -m pip install -e .",
  rust: "cargo fetch",
  go: "go mod download",
  ruby: "bundle install",
  php: "composer install",
};

/** FR-632: the one command offered as a fallback; not run by GitHydra in this slice. */
export const SUBMODULE_COMMAND = "git submodule update --init";

/** `names` are the fixed file names found as regular files at the worktree root. */
export function detectWorktreeSetup(names: ReadonlySet<string>): WorktreeSetupHints {
  let dependency: WorktreeSetupHints["dependency"] = null;
  if (names.has("package.json")) {
    // A package.json alone does not say which tool installs it: a lockfile is required (FR-633).
    if (names.has("pnpm-lock.yaml")) dependency = { kind: "pnpm", manifest: "package.json" };
    else if (names.has("yarn.lock")) dependency = { kind: "yarn", manifest: "package.json" };
    else if (names.has("package-lock.json")) dependency = { kind: "npm", manifest: "package.json" };
  }
  if (!dependency) {
    if (names.has("pyproject.toml")) dependency = { kind: "python", manifest: "pyproject.toml" };
    else if (names.has("Cargo.toml")) dependency = { kind: "rust", manifest: "Cargo.toml" };
    else if (names.has("go.mod")) dependency = { kind: "go", manifest: "go.mod" };
    else if (names.has("Gemfile")) dependency = { kind: "ruby", manifest: "Gemfile" };
    else if (names.has("composer.json")) dependency = { kind: "php", manifest: "composer.json" };
  }
  return { dependency, hasSubmodules: names.has(".gitmodules") };
}
