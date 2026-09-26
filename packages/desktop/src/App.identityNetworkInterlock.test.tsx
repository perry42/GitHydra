// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { makeMockGitHydra } from "./test/mockGitHydra";
import { makeCommit } from "./test/fixtures";
import type { CloneIpcOutcome, FetchOutcome } from "../shared/ipcContract";

/**
 * specs/identity-profile-network-interlock.md — App-level proof that FR-383's real wiring (not
 * just the isolated pure function or the dialog fed a hand-written prop) actually disables
 * IdentityProfilesDialog's Apply/Remove while a REAL `fetchAction`/`pullAction`/`pushAction`
 * in-flight op targets the active tab's repo (AC1), that Toolbar's own Fetch/Pull/Push buttons stay
 * governed purely by their own flags with no new dependency on whether the dialog is open (AC9),
 * and that a concurrently-open `CloneDialog` never feeds into this interlock at all (AC7/FR-381).
 *
 * `IdentityProfilesDialog.test.tsx` covers FR-384/FR-385's exact disabled-expression/title-priority
 * behavior (AC1 through AC6) directly against the `networkOpDisabledReason` prop, and
 * `identityNotices.test.ts` covers the pure function itself exhaustively (AC8) — this file's job is
 * only the parts that need the real `App.tsx` composition to mean anything.
 */

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(() => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
  window.localStorage.clear();
});

async function browseInto(api: ReturnType<typeof makeMockGitHydra>, path: string): Promise<void> {
  vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: path });
  await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
}

async function openIdentityDialogAndCreateProfile(): Promise<HTMLElement> {
  await userEvent.click(screen.getByRole("button", { name: /git identity profiles/i }));
  const dialog = await screen.findByRole("dialog", { name: /git identity profiles/i });
  await userEvent.click(within(dialog).getByRole("button", { name: /new profile/i }));
  await userEvent.type(within(dialog).getByLabelText(/profile name/i), "Work");
  await userEvent.type(within(dialog).getByLabelText(/^user\.name$/i), "Jane Doe");
  await userEvent.type(within(dialog).getByLabelText(/^user\.email$/i), "jane@work.example");
  await userEvent.click(within(dialog).getByRole("button", { name: /create profile/i }));
  return dialog;
}

describe("specs/identity-profile-network-interlock.md — real App wiring", () => {
  it("AC1/AC9: a real in-flight fetch disables Apply/Remove, re-enables the instant it settles, and Toolbar's own Fetch button stays governed only by isFetching (not by the dialog's open/closed state)", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "Repo A commit" })],
      identityConfigState: {
        userName: { localValue: "Jane Doe", globalValue: "Global Jane", managedByGitHydra: true },
        userEmail: { localValue: "jane@work.example", globalValue: "jane@global.example", managedByGitHydra: true },
        sshCommand: { localValue: null, globalValue: null, managedByGitHydra: false },
      },
    });
    window.gitHydra = api;
    render(<App />);
    await browseInto(api, "/repoA");
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());

    const dialog = await openIdentityDialogAndCreateProfile();
    const applyButton = () => within(dialog).getByRole("button", { name: /apply to this repository/i });
    const removeButton = () => within(dialog).getByRole("button", { name: /remove applied profile/i });
    expect(applyButton()).toBeEnabled();
    expect(removeButton()).toBeEnabled();

    // A real fetch, held open — `fetchAction.isFetching` flips true the instant `runFetch()` is
    // called and stays true until this promise resolves.
    const fetchDeferred = deferred<FetchOutcome>();
    vi.mocked(api.fetchAllRemotes).mockImplementationOnce(() => fetchDeferred.promise);
    await userEvent.click(screen.getByRole("button", { name: /^fetch all remotes$/i }));

    await waitFor(() => expect(screen.getByRole("button", { name: /fetching remotes…/i })).toBeDisabled());
    await waitFor(() => expect(applyButton()).toBeDisabled());
    expect(applyButton()).toHaveAttribute("title", "Disabled while a fetch is in progress on this repository.");
    expect(removeButton()).toBeDisabled();
    expect(removeButton()).toHaveAttribute("title", "Disabled while a fetch is in progress on this repository.");

    // AC9: closing the dialog mid-fetch doesn't change Toolbar's own Fetch button state at all —
    // it never depended on `identityProfilesOpen` in the first place.
    await userEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog", { name: /git identity profiles/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /fetching remotes…/i })).toBeDisabled();

    // The fetch settles.
    fetchDeferred.resolve({ outcome: "settled", result: { ok: true, data: { outcomes: [] } } });
    await waitFor(() => expect(screen.getByRole("button", { name: /^fetch all remotes$/i })).toBeEnabled());

    // Reopening confirms the disabled state cleared along with it (no reload needed).
    await userEvent.click(screen.getByRole("button", { name: /git identity profiles/i }));
    const reopened = await screen.findByRole("dialog", { name: /git identity profiles/i });
    const reopenedApply = within(reopened).getByRole("button", { name: /apply to this repository/i });
    expect(reopenedApply).toBeEnabled();
    expect(reopenedApply).not.toHaveAttribute("title");
  });

  it("AC7/FR-381: a concurrently-open CloneDialog with a clone in flight does NOT disable the already-open repo's Apply/Remove buttons", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "Repo A commit" })],
      identityConfigState: {
        userName: { localValue: "Jane Doe", globalValue: "Global Jane", managedByGitHydra: true },
        userEmail: { localValue: "jane@work.example", globalValue: "jane@global.example", managedByGitHydra: true },
        sshCommand: { localValue: null, globalValue: null, managedByGitHydra: false },
      },
    });
    window.gitHydra = api;
    render(<App />);
    await browseInto(api, "/repoA");
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());

    // Open CloneDialog first (via the Command Palette — the only route with a repo already open,
    // specs/online-sync-clone.md FR-351) and start a clone that never settles.
    const cloneDeferred = deferred<CloneIpcOutcome>();
    vi.mocked(api.clone).mockImplementationOnce(() => cloneDeferred.promise);
    await userEvent.keyboard("{Control>}k{/Control}");
    await userEvent.click(await screen.findByRole("option", { name: /clone a repository/i }));
    const cloneDialog = await screen.findByRole("dialog", { name: /clone a repository/i });
    await userEvent.type(within(cloneDialog).getByLabelText(/repository url/i), "/some/remote");
    await userEvent.type(within(cloneDialog).getByLabelText(/destination folder/i), "/some/destination");
    await userEvent.click(within(cloneDialog).getByRole("button", { name: /^clone$/i }));
    await within(cloneDialog).findByText(/cloning…/i);

    // With the clone still pending, open IdentityProfilesDialog against the SAME already-open
    // repo (`/repoA` — unrelated to the clone's not-yet-open destination) and confirm it is
    // completely unaffected.
    const identityDialog = await openIdentityDialogAndCreateProfile();
    const applyButton = within(identityDialog).getByRole("button", { name: /apply to this repository/i });
    const removeButton = within(identityDialog).getByRole("button", { name: /remove applied profile/i });
    expect(applyButton).toBeEnabled();
    expect(applyButton).not.toHaveAttribute("title");
    expect(removeButton).toBeEnabled();
    expect(removeButton).not.toHaveAttribute("title");

    // Let the clone settle so this test doesn't leak a dangling promise/timer.
    cloneDeferred.resolve({ outcome: "settled", result: { ok: true, data: { path: "/some/destination" } } });
  });
});
