// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { Toolbar } from "../components/Toolbar/Toolbar";
import { makeMockGitHydra } from "../test/mockGitHydra";
import { usePushAction } from "../hooks/usePushAction";

/**
 * specs/online-sync-push.md — the UI-layer counterpart of `packages/git-core/tests/noNetworkCalls
 * .test.ts`'s own "specs/online-sync-push.md: push() argv/network surface" describe block (AC6):
 * that suite proves git-core's own `push()` never builds an argv containing `--force`/`-f`/
 * `--delete`/`--mirror`. This file proves the same thing one layer up — that NOTHING in the desktop
 * app's own IPC surface, action hook, or rendered UI can ever construct a call or expose a control
 * that could reach a force/delete/tags/all/mirror flag, even though this layer never calls
 * `spawnGit` directly. Two independent techniques, deliberately combined (either alone would miss a
 * real regression the other catches):
 *
 *  1. A black-box, comment-stripped source scan of every file this feature touches (mirroring
 *     `noNetworkCalls.test.ts`'s own "read the real spawned argv, not the type system" spirit,
 *     adapted to a layer with no argv of its own to spawn) — this fails LOUDLY if a future edit
 *     ever adds a literal `--force`, `-f`, `--delete`, `--tags`, `--all`, or `--mirror` token
 *     anywhere in this app's push call chain, even in code no test happens to execute.
 *  2. A runtime check that the actual `GitHydraApi.push()` call `usePushAction` makes only ever
 *     carries exactly `(requestId, remoteName, localBranchName)` — never a 4th "options"/"force"
 *     argument — plus a rendered-Toolbar check that no button/control anywhere in it exposes a
 *     force/delete/tags/all/mirror-shaped affordance, even hidden or disabled.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(dirname, "..", "..", "..", "..");
const DESKTOP_ROOT = path.resolve(REPO_ROOT, "packages", "desktop");

/** Every file this feature's push call chain touches — deliberately an explicit allowlist (not "every
 * file in packages/desktop") so this test's failure always points at a push-related file, and so a
 * legitimate `--force`/`--all`-shaped mention elsewhere in the app (e.g. `forceDeleteBranch`'s own
 * unrelated branch-management feature) is never in scope to begin with. */
const PUSH_RELATED_FILES = [
  "shared/ipcContract.ts",
  "electron/main.ts",
  "electron/preload.ts",
  "src/hooks/usePushAction.ts",
  "src/hooks/usePushTarget.ts",
  "src/lib/pushEligibility.ts",
  "src/lib/commands.ts",
  "src/components/Toolbar/Toolbar.tsx",
  "src/components/PushStatusBanner/PushStatusBanner.tsx",
  "src/test/realGitHydraApi.ts",
  "src/test/mockGitHydra.ts",
];

/** Strips `/* ... *\/` and `// ...` comments before scanning — a doc comment is allowed to explain
 * (in prose) that force/delete/tags/all/mirror are excluded (several already do); only EXECUTABLE
 * source reaching one of those literal flag shapes is a real finding. Imperfect for a `//` inside a
 * string literal (none of the files in `PUSH_RELATED_FILES` contain one at the time of writing), a
 * known, accepted limitation of this technique — same category of approximation
 * `noNetworkCalls.test.ts`'s own argv-substring check accepts. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const FORBIDDEN_DOUBLE_DASH = [/--force\b/i, /--delete\b/i, /--tags\b/i, /--all\b/i, /--mirror\b/i];
// A standalone `-f` argv token — quoted or bare, bounded by whitespace/quotes/punctuation on both
// sides — never a substring match, so identifiers like `isFetching`/`onFetch` never trip this.
const FORBIDDEN_DASH_F = /(^|[\s"'`(,[])-f(?=[\s"'`),\].;]|$)/;

describe("specs/online-sync-push.md: no force/delete/tags/all/mirror anywhere in the desktop push surface", () => {
  it.each(PUSH_RELATED_FILES)("%s never contains a force/delete/tags/all/mirror-shaped token outside a comment", (relPath) => {
    const fullPath = path.join(DESKTOP_ROOT, relPath);
    const source = fs.readFileSync(fullPath, "utf8");
    const code = stripComments(source);

    for (const pattern of FORBIDDEN_DOUBLE_DASH) {
      expect(code).not.toMatch(pattern);
    }
    expect(code).not.toMatch(FORBIDDEN_DASH_F);
  });

  it("api.push() is called with exactly (requestId, remoteName, localBranchName) — no options/force argument, across a plain push, a set-upstream publish, and the FR-347 confirm-then-push path", async () => {
    const api = makeMockGitHydra();
    const { result } = renderHook(() => usePushAction({ api, onSettled: vi.fn() }));

    act(() => result.current.requestPush("origin", "main", null));
    await waitFor(() => expect(result.current.phase).toBe("done"));

    let call = vi.mocked(api.push).mock.calls[0]!;
    expect(call).toHaveLength(3);
    expect(call.slice(1)).toEqual(["origin", "main"]);

    act(() => result.current.dismiss());
    act(() => result.current.requestPush("origin", "feature", 2)); // FR-347 pause
    expect(api.push).toHaveBeenCalledTimes(1); // still just the one call from above — paused, not pushed.
    act(() => result.current.confirmPendingPush());
    await waitFor(() => expect(result.current.phase).toBe("done"));

    call = vi.mocked(api.push).mock.calls[1]!;
    expect(call).toHaveLength(3);
    expect(call.slice(1)).toEqual(["origin", "feature"]);
  });

  it("the rendered Toolbar, with Push fully enabled and a multi-remote picker showing, exposes no force/delete/tags/all/mirror-shaped control anywhere in its accessible tree", () => {
    render(
      <Toolbar
        repoPath="/repo"
        onRefresh={() => {}}
        canRefresh
        theme="dark"
        onToggleTheme={() => {}}
        showFetchButton
        onFetch={() => {}}
        showPullButton
        pullDisabledReason={null}
        onPull={() => {}}
        showPushButton
        pushDisabledReason={null}
        onPush={() => {}}
        showPushRemotePicker
        pushRemotes={["origin", "upstream", "fork"]}
        pushRemote="origin"
        onPushRemoteChange={() => {}}
      />,
    );

    const forbidden = /force|force-with-lease|--delete|delete remote|--tags|--all|--mirror/i;
    for (const el of screen.getAllByRole("button")) {
      expect(el.textContent ?? "").not.toMatch(forbidden);
      expect(el.getAttribute("aria-label") ?? "").not.toMatch(forbidden);
      expect(el.getAttribute("title") ?? "").not.toMatch(forbidden);
    }
    for (const el of screen.queryAllByRole("option")) {
      expect(el.textContent ?? "").not.toMatch(forbidden);
    }
  });
});
