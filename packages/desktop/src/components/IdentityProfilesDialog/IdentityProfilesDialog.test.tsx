// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { IdentityConfigState } from "@githydra/git-core";
import type { GitHydraApi } from "../../../shared/ipcContract";
import { IdentityProfilesDialog } from "./IdentityProfilesDialog";
import { makeMockGitHydra } from "../../test/mockGitHydra";
import { useIdentityApplications } from "../../hooks/useIdentityApplications";
import { useIdentityProfiles } from "../../hooks/useIdentityProfiles";

afterEach(() => {
  window.localStorage.clear();
});

/**
 * A thin wrapper that owns `useIdentityProfiles()`/`useIdentityApplications()` itself (mirroring
 * how `App.tsx` actually owns them) rather than constructing them via a separate `renderHook` call
 * and passing a one-off snapshot down as a prop — the latter would never re-render this component
 * when the dialog itself calls `profiles.createProfile()`/etc., since a `renderHook` instance and
 * this component's own render tree are two independent React roots.
 */
function Harness({ api, repoPath, onClose }: { api: GitHydraApi; repoPath: string | null; onClose: () => void }) {
  const profiles = useIdentityProfiles();
  const applications = useIdentityApplications();
  return <IdentityProfilesDialog api={api} repoPath={repoPath} profiles={profiles} applications={applications} onClose={onClose} />;
}

function harness(overrides: { repoPath?: string | null; identityConfigState?: IdentityConfigState } = {}) {
  const api = makeMockGitHydra({ identityConfigState: overrides.identityConfigState });
  const onClose = vi.fn();
  // `?? "/repo"` would be wrong here — `null` is itself a meaningful, explicitly-passed override
  // (FR-335's "no repo open" case), and nullish coalescing can't distinguish "not given" from
  // "given as null." Only fall back to the default when the key was omitted entirely.
  const repoPath = "repoPath" in overrides ? overrides.repoPath! : "/repo";
  render(<Harness api={api} repoPath={repoPath} onClose={onClose} />);
  return { api, onClose };
}

describe("IdentityProfilesDialog", () => {
  it("FR-329: shows an empty-library message, then creates a profile via the form", async () => {
    harness();
    expect(screen.getByText(/no profiles yet/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /new profile/i }));
    await userEvent.type(screen.getByLabelText(/profile name/i), "Work");
    await userEvent.type(screen.getByLabelText(/^user\.name$/i), "Jane Doe");
    await userEvent.type(screen.getByLabelText(/^user\.email$/i), "jane@work.example");
    await userEvent.click(screen.getByRole("button", { name: /create profile/i }));

    expect(screen.getByText("Work")).toBeInTheDocument();
    expect(screen.getByText(/jane doe/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/profile name/i)).not.toBeInTheDocument(); // form closed
  });

  it("FR-332: the SSH identity file is picked via the native dialog only — Browse fills a read-only path, never a free-text field", async () => {
    const { api } = harness();
    vi.mocked(api.pickSshIdentityFile).mockResolvedValueOnce({ ok: true, data: "/home/jane/.ssh/id_work" });

    await userEvent.click(screen.getByRole("button", { name: /new profile/i }));
    // No free-text input exists for the ssh path anywhere in the form.
    expect(screen.queryByRole("textbox", { name: /ssh/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/selected ssh identity file/i)).toHaveTextContent("(none)");

    await userEvent.click(screen.getByRole("button", { name: /browse/i }));
    await waitFor(() => expect(screen.getByLabelText(/selected ssh identity file/i)).toHaveTextContent("/home/jane/.ssh/id_work"));

    await userEvent.click(screen.getByRole("button", { name: /clear/i }));
    expect(screen.getByLabelText(/selected ssh identity file/i)).toHaveTextContent("(none)");
  });

  it("editing an existing profile pre-fills the form and saves changes in place", async () => {
    harness();
    await userEvent.click(screen.getByRole("button", { name: /new profile/i }));
    await userEvent.type(screen.getByLabelText(/profile name/i), "Work");
    await userEvent.type(screen.getByLabelText(/^user\.name$/i), "Jane Doe");
    await userEvent.type(screen.getByLabelText(/^user\.email$/i), "jane@work.example");
    await userEvent.click(screen.getByRole("button", { name: /create profile/i }));

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const nameInput = screen.getByLabelText(/profile name/i) as HTMLInputElement;
    expect(nameInput.value).toBe("Work");
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "Work (renamed)");
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

    expect(screen.getByText("Work (renamed)")).toBeInTheDocument();
  });

  it("deleting a profile routes through ConfirmDialog (No Single-Click Destruction Rule)", async () => {
    harness();
    await userEvent.click(screen.getByRole("button", { name: /new profile/i }));
    await userEvent.type(screen.getByLabelText(/profile name/i), "Work");
    await userEvent.type(screen.getByLabelText(/^user\.name$/i), "Jane Doe");
    await userEvent.type(screen.getByLabelText(/^user\.email$/i), "jane@work.example");
    await userEvent.click(screen.getByRole("button", { name: /create profile/i }));

    await userEvent.click(screen.getByRole("button", { name: /delete/i }));
    const dialog = screen.getByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Work")).toBeInTheDocument(); // not deleted yet

    await userEvent.click(screen.getByRole("button", { name: /delete/i }));
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    expect(screen.queryByText("Work")).not.toBeInTheDocument();
  });

  it("FR-335: shows 'open a repository' messaging with no repo open, and the repo's identity status once one is", async () => {
    harness({ repoPath: null });
    expect(screen.getByText(/open a repository to see or apply/i)).toBeInTheDocument();
  });

  it("FR-335: distinguishes GitHydra-managed, locally-set, and global-inherited values", async () => {
    harness({
      identityConfigState: {
        userName: { localValue: "Jane Doe", globalValue: "Global Name", managedByGitHydra: true },
        userEmail: { localValue: "someone@else.example", globalValue: null, managedByGitHydra: false },
        sshCommand: { localValue: null, globalValue: null, managedByGitHydra: false },
      },
    });
    await waitFor(() => expect(screen.getByText("user.name")).toBeInTheDocument());
    expect(screen.getByText(/applied by githydra/i)).toBeInTheDocument();
    expect(screen.getByText(/set locally \(not by githydra\)/i)).toBeInTheDocument();
    expect(screen.getByText("core.sshCommand")).toBeInTheDocument();
    expect(screen.getByText("Not set")).toBeInTheDocument();
  });

  it("FR-330: applying a profile with no conflict writes it immediately, no confirmation needed", async () => {
    const { api } = harness();
    await userEvent.click(screen.getByRole("button", { name: /new profile/i }));
    await userEvent.type(screen.getByLabelText(/profile name/i), "Work");
    await userEvent.type(screen.getByLabelText(/^user\.name$/i), "Jane Doe");
    await userEvent.type(screen.getByLabelText(/^user\.email$/i), "jane@work.example");
    await userEvent.click(screen.getByRole("button", { name: /create profile/i }));

    await userEvent.click(screen.getByRole("button", { name: /apply to this repository/i }));
    await waitFor(() =>
      expect(vi.mocked(api.applyIdentityProfile)).toHaveBeenCalledWith(
        expect.objectContaining({ userName: "Jane Doe", userEmail: "jane@work.example", force: false }),
      ),
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("FR-334: a conflicting apply requires explicit confirmation before overwriting, and declining leaves it untouched", async () => {
    const { api } = harness({
      identityConfigState: {
        userName: { localValue: "Corp Bot", globalValue: null, managedByGitHydra: false },
        userEmail: { localValue: null, globalValue: null, managedByGitHydra: false },
        sshCommand: { localValue: null, globalValue: null, managedByGitHydra: false },
      },
    });
    await userEvent.click(screen.getByRole("button", { name: /new profile/i }));
    await userEvent.type(screen.getByLabelText(/profile name/i), "Work");
    await userEvent.type(screen.getByLabelText(/^user\.name$/i), "Jane Doe");
    await userEvent.type(screen.getByLabelText(/^user\.email$/i), "jane@work.example");
    await userEvent.click(screen.getByRole("button", { name: /create profile/i }));

    await userEvent.click(screen.getByRole("button", { name: /apply to this repository/i }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(/user\.name/);
    expect(vi.mocked(api.applyIdentityProfile)).toHaveBeenCalledWith(expect.objectContaining({ force: false }));

    // Declining leaves the pre-existing value untouched (never retried with force).
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(vi.mocked(api.applyIdentityProfile)).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: /apply to this repository/i }));
    await screen.findByRole("alertdialog");
    await userEvent.click(screen.getByRole("button", { name: /overwrite and apply/i }));
    await waitFor(() =>
      expect(vi.mocked(api.applyIdentityProfile)).toHaveBeenLastCalledWith(expect.objectContaining({ force: true })),
    );
  });

  it("FR-336: 'Remove applied profile' is disabled with a reason until something is GitHydra-managed", async () => {
    harness();
    await waitFor(() => expect(screen.getByRole("button", { name: /remove applied profile/i })).toBeInTheDocument());
    const button = screen.getByRole("button", { name: /remove applied profile/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", expect.stringMatching(/no githydra-applied identity/i));
  });

  it("FR-336: removing an applied profile unsets the managed keys", async () => {
    const { api } = harness({
      identityConfigState: {
        userName: { localValue: "Jane Doe", globalValue: null, managedByGitHydra: true },
        userEmail: { localValue: "jane@work.example", globalValue: null, managedByGitHydra: true },
        sshCommand: { localValue: null, globalValue: null, managedByGitHydra: false },
      },
    });
    await waitFor(() => expect(screen.getByRole("button", { name: /remove applied profile/i })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: /remove applied profile/i }));
    await waitFor(() => expect(vi.mocked(api.removeIdentityProfileApplication)).toHaveBeenCalledTimes(1));
  });

  it("Escape closes the innermost thing first: the form, then the dialog itself", async () => {
    const { onClose } = harness();
    await userEvent.click(screen.getByRole("button", { name: /new profile/i }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByLabelText(/profile name/i)).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking Done closes the dialog", async () => {
    const { onClose } = harness();
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
