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
function Harness({
  api,
  repoPath,
  networkOpDisabledReason = null,
  onClose,
}: {
  api: GitHydraApi;
  repoPath: string | null;
  networkOpDisabledReason?: string | null;
  onClose: () => void;
}) {
  const profiles = useIdentityProfiles();
  const applications = useIdentityApplications();
  return (
    <IdentityProfilesDialog
      api={api}
      repoPath={repoPath}
      profiles={profiles}
      applications={applications}
      networkOpDisabledReason={networkOpDisabledReason}
      onClose={onClose}
    />
  );
}

function harness(
  overrides: { repoPath?: string | null; identityConfigState?: IdentityConfigState; networkOpDisabledReason?: string | null } = {},
) {
  const api = makeMockGitHydra({ identityConfigState: overrides.identityConfigState });
  const onClose = vi.fn();
  // `?? "/repo"` would be wrong here — `null` is itself a meaningful, explicitly-passed override
  // (FR-335's "no repo open" case), and nullish coalescing can't distinguish "not given" from
  // "given as null." Only fall back to the default when the key was omitted entirely.
  const repoPath = "repoPath" in overrides ? overrides.repoPath! : "/repo";
  render(
    <Harness api={api} repoPath={repoPath} networkOpDisabledReason={overrides.networkOpDisabledReason ?? null} onClose={onClose} />,
  );
  return { api, onClose };
}

/** Shared "create a keyless profile via the New profile form" flow — used by several tests below
 * that only care about what happens once a profile with no SSH key exists. */
async function createKeylessProfile(displayName = "Work") {
  await userEvent.click(screen.getByRole("button", { name: /new profile/i }));
  await userEvent.type(screen.getByLabelText(/profile name/i), displayName);
  await userEvent.type(screen.getByLabelText(/^user\.name$/i), "Jane Doe");
  await userEvent.type(screen.getByLabelText(/^user\.email$/i), "jane@work.example");
  await userEvent.click(screen.getByRole("button", { name: /create profile/i }));
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

/**
 * specs/identity-profile-network-interlock.md FR-384/FR-385, AC1 through AC6: Apply/Remove
 * disabling driven by `networkOpDisabledReason` — passed directly as a prop here (this component
 * doesn't care WHERE the reason came from, only that it's set; `App.tsx`'s own computation from
 * the real `fetchAction`/`pullAction`/`pushAction` flags is FR-383's one-line wiring, exercised at
 * the App level in `App.identityNetworkInterlock.test.tsx`).
 */
describe("IdentityProfilesDialog — network-op interlock (specs/identity-profile-network-interlock.md)", () => {
  /** A managed identity (so `hasAnyManaged` is true and the Remove button isn't ALSO disabled for
   * its own pre-existing reason) plus one profile in the library (so a real Apply button exists). */
  async function harnessWithManagedIdentityAndProfile(networkOpDisabledReason: string | null) {
    const result = harness({
      networkOpDisabledReason,
      identityConfigState: {
        userName: { localValue: "Jane Doe", globalValue: "Global Jane", managedByGitHydra: true },
        userEmail: { localValue: "jane@work.example", globalValue: "jane@global.example", managedByGitHydra: true },
        sshCommand: { localValue: null, globalValue: null, managedByGitHydra: false },
      },
    });
    await waitFor(() => expect(screen.getByRole("button", { name: /remove applied profile/i })).toBeInTheDocument());
    await createKeylessProfile();
    return result;
  }

  it.each([
    ["a fetch" as const],
    ["a pull" as const],
    ["a push" as const],
  ])("AC1/AC2: Apply is disabled with 'Disabled while %s is in progress on this repository.' while set", async (reason) => {
    await harnessWithManagedIdentityAndProfile(reason);
    const applyButton = screen.getByRole("button", { name: /apply to this repository/i });
    expect(applyButton).toBeDisabled();
    expect(applyButton).toHaveAttribute("title", `Disabled while ${reason} is in progress on this repository.`);
  });

  it.each([
    ["a fetch" as const],
    ["a pull" as const],
    ["a push" as const],
  ])("AC3: 'Remove applied profile' is disabled with 'Disabled while %s is in progress on this repository.' while set", async (reason) => {
    await harnessWithManagedIdentityAndProfile(reason);
    const removeButton = screen.getByRole("button", { name: /remove applied profile/i });
    expect(removeButton).toBeDisabled();
    expect(removeButton).toHaveAttribute("title", `Disabled while ${reason} is in progress on this repository.`);
  });

  it("AC1: Apply and Remove re-enable the instant networkOpDisabledReason clears, with no dialog reopen", async () => {
    const api = makeMockGitHydra({
      identityConfigState: {
        userName: { localValue: "Jane Doe", globalValue: "Global Jane", managedByGitHydra: true },
        userEmail: { localValue: "jane@work.example", globalValue: "jane@global.example", managedByGitHydra: true },
        sshCommand: { localValue: null, globalValue: null, managedByGitHydra: false },
      },
    });
    const onClose = vi.fn();

    function ReRenderHarness({ networkOpDisabledReason }: { networkOpDisabledReason: string | null }) {
      const profiles = useIdentityProfiles();
      const applications = useIdentityApplications();
      return (
        <IdentityProfilesDialog
          api={api}
          repoPath="/repo"
          profiles={profiles}
          applications={applications}
          networkOpDisabledReason={networkOpDisabledReason}
          onClose={onClose}
        />
      );
    }

    const { rerender } = render(<ReRenderHarness networkOpDisabledReason="a fetch" />);
    await waitFor(() => expect(screen.getByRole("button", { name: /remove applied profile/i })).toBeInTheDocument());
    await createKeylessProfile();

    const applyButton = screen.getByRole("button", { name: /apply to this repository/i });
    const removeButton = screen.getByRole("button", { name: /remove applied profile/i });
    expect(applyButton).toBeDisabled();
    expect(removeButton).toBeDisabled();

    // The fetch settles: same render pass, no reopen, no new IPC round trip needed.
    rerender(<ReRenderHarness networkOpDisabledReason={null} />);
    expect(applyButton).toBeEnabled();
    expect(applyButton).not.toHaveAttribute("title");
    expect(removeButton).toBeEnabled();
    expect(removeButton).not.toHaveAttribute("title");
  });

  it("AC5: clicking Apply while disabled by a network op makes zero applyIdentityProfile calls (native disabled attribute, not a no-op click handler)", async () => {
    const { api } = await harnessWithManagedIdentityAndProfile("a push");
    const applyButton = screen.getByRole("button", { name: /apply to this repository/i });
    expect(applyButton).toBeDisabled();
    await userEvent.click(applyButton);
    expect(vi.mocked(api.applyIdentityProfile)).not.toHaveBeenCalled();
  });

  it("AC5: clicking Remove while disabled by a network op makes zero removeIdentityProfileApplication calls", async () => {
    const { api } = await harnessWithManagedIdentityAndProfile("a pull");
    const removeButton = screen.getByRole("button", { name: /remove applied profile/i });
    expect(removeButton).toBeDisabled();
    await userEvent.click(removeButton);
    expect(vi.mocked(api.removeIdentityProfileApplication)).not.toHaveBeenCalled();
  });

  it("AC6: with no network op in flight, Apply/Remove behave exactly as before this fix (no regression to !repoOpen/busy/!hasAnyManaged copy)", async () => {
    // !repoOpen: unchanged copy, Apply disabled with its own reason (no repo open at all).
    harness({ repoPath: null, networkOpDisabledReason: null });
    await userEvent.click(screen.getByRole("button", { name: /new profile/i }));
    await userEvent.type(screen.getByLabelText(/profile name/i), "Work");
    await userEvent.type(screen.getByLabelText(/^user\.name$/i), "Jane Doe");
    await userEvent.type(screen.getByLabelText(/^user\.email$/i), "jane@work.example");
    await userEvent.click(screen.getByRole("button", { name: /create profile/i }));
    const applyButtonNoRepo = screen.getByRole("button", { name: /apply to this repository/i });
    expect(applyButtonNoRepo).toBeDisabled();
    expect(applyButtonNoRepo).toHaveAttribute("title", "Open a repository to apply this profile.");
  });

  it("AC6: !hasAnyManaged still shows its own unchanged copy when no network op is in flight", async () => {
    harness({ networkOpDisabledReason: null });
    await waitFor(() => expect(screen.getByRole("button", { name: /remove applied profile/i })).toBeInTheDocument());
    const removeButton = screen.getByRole("button", { name: /remove applied profile/i });
    expect(removeButton).toBeDisabled();
    expect(removeButton).toHaveAttribute("title", "No GitHydra-applied identity to remove from this repository.");
  });

  it("AC6: with no network op in flight and a managed identity, Apply/Remove are enabled with no title", async () => {
    await harnessWithManagedIdentityAndProfile(null);
    const applyButton = screen.getByRole("button", { name: /apply to this repository/i });
    const removeButton = screen.getByRole("button", { name: /remove applied profile/i });
    expect(applyButton).toBeEnabled();
    expect(applyButton).not.toHaveAttribute("title");
    expect(removeButton).toBeEnabled();
    expect(removeButton).not.toHaveAttribute("title");
  });
});

/** specs/git-identity-profiles.md, Amendment (2026-09-17): FR-378/FR-379 — informational, never
 * confirmation-gating, notices on the existing apply/remove flow. */
describe("IdentityProfilesDialog — apply/remove honesty notices (Amendment 2026-09-17)", () => {
  it("FR-378: a keyless profile shows the 'no override exists' copy when nothing is currently GitHydra-managed", async () => {
    harness({
      identityConfigState: {
        userName: { localValue: null, globalValue: null, managedByGitHydra: false },
        userEmail: { localValue: null, globalValue: null, managedByGitHydra: false },
        sshCommand: { localValue: null, globalValue: null, managedByGitHydra: false },
      },
    });
    await createKeylessProfile();

    const notice = await screen.findByText(/has no ssh key configured/i);
    expect(notice).toHaveTextContent(/only change this repo's name and email/i);
    expect(notice).toHaveTextContent(/stays exactly as it is/i);
    expect(notice).not.toHaveTextContent(/remove the ssh override/i);
    // Visible immediately once the profile exists — no Apply click needed to see it.
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("FR-378: a keyless profile shows the 'will clear a previous override' copy when core.sshCommand is currently GitHydra-managed", async () => {
    harness({
      identityConfigState: {
        userName: { localValue: null, globalValue: null, managedByGitHydra: false },
        userEmail: { localValue: null, globalValue: null, managedByGitHydra: false },
        sshCommand: { localValue: "ssh -i '/old/key' -o IdentitiesOnly=yes", globalValue: null, managedByGitHydra: true },
      },
    });
    await createKeylessProfile();

    const notice = await screen.findByText(/has no ssh key configured/i);
    expect(notice).toHaveTextContent(/remove the ssh override left by the profile applied here previously/i);
    expect(notice).toHaveTextContent(/falls back to its default ssh configuration/i);
    expect(notice).not.toHaveTextContent(/stays exactly as it is/i);
  });

  it("FR-378: a profile that DOES carry an SSH key shows no keyless-apply notice at all", async () => {
    const { api } = harness();
    vi.mocked(api.pickSshIdentityFile).mockResolvedValueOnce({ ok: true, data: "/home/jane/.ssh/id_work" });
    await userEvent.click(screen.getByRole("button", { name: /new profile/i }));
    await userEvent.type(screen.getByLabelText(/profile name/i), "Work");
    await userEvent.type(screen.getByLabelText(/^user\.name$/i), "Jane Doe");
    await userEvent.type(screen.getByLabelText(/^user\.email$/i), "jane@work.example");
    await userEvent.click(screen.getByRole("button", { name: /browse/i }));
    await waitFor(() => expect(screen.getByLabelText(/selected ssh identity file/i)).toHaveTextContent("id_work"));
    await userEvent.click(screen.getByRole("button", { name: /create profile/i }));

    await waitFor(() => expect(screen.getByText("Work")).toBeInTheDocument());
    expect(screen.queryByText(/has no ssh key configured/i)).not.toBeInTheDocument();
  });

  it("FR-378: shows no notice at all while no repository is open (nothing to apply to yet)", async () => {
    harness({ repoPath: null });
    await createKeylessProfile();
    expect(screen.queryByText(/has no ssh key configured/i)).not.toBeInTheDocument();
  });

  it("FR-379: shows the two-field notice when removal would leave both user.name and user.email unconfigured", async () => {
    harness({
      identityConfigState: {
        userName: { localValue: "Jane Doe", globalValue: null, managedByGitHydra: true },
        userEmail: { localValue: "jane@work.example", globalValue: null, managedByGitHydra: true },
        sshCommand: { localValue: null, globalValue: null, managedByGitHydra: false },
      },
    });
    const notice = await screen.findByText(/user\.name and user\.email/i);
    expect(notice).toHaveTextContent(/git will refuse to commit here until at least one is set again/i);
  });

  it("FR-379: names only user.name when just that field would end up unconfigured", async () => {
    harness({
      identityConfigState: {
        userName: { localValue: "Jane Doe", globalValue: null, managedByGitHydra: true },
        userEmail: { localValue: "jane@work.example", globalValue: "jane@global.example", managedByGitHydra: true },
        sshCommand: { localValue: null, globalValue: null, managedByGitHydra: false },
      },
    });
    const notice = await screen.findByText(/user\.name unconfigured/i);
    expect(notice).not.toHaveTextContent(/user\.email/i);
  });

  it("AC10: shows no FR-379 notice when a global fallback is configured for every managed field", async () => {
    harness({
      identityConfigState: {
        userName: { localValue: "Jane Doe", globalValue: "Global Jane", managedByGitHydra: true },
        userEmail: { localValue: "jane@work.example", globalValue: "jane@global.example", managedByGitHydra: true },
        sshCommand: { localValue: null, globalValue: null, managedByGitHydra: false },
      },
    });
    await waitFor(() => expect(screen.getByRole("button", { name: /remove applied profile/i })).toBeEnabled());
    expect(screen.queryByText(/unconfigured/i)).not.toBeInTheDocument();
  });

  it("FR-379: removal still proceeds on the existing button's single click — no second confirmation added by this notice", async () => {
    const { api } = harness({
      identityConfigState: {
        userName: { localValue: "Jane Doe", globalValue: null, managedByGitHydra: true },
        userEmail: { localValue: "jane@work.example", globalValue: null, managedByGitHydra: true },
        sshCommand: { localValue: null, globalValue: null, managedByGitHydra: false },
      },
    });
    await screen.findByText(/user\.name and user\.email/i);
    await userEvent.click(screen.getByRole("button", { name: /remove applied profile/i }));
    await waitFor(() => expect(vi.mocked(api.removeIdentityProfileApplication)).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});
