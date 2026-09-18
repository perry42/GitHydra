// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CloneDialog } from "./CloneDialog";
import { makeMockGitHydra } from "../../test/mockGitHydra";
import type { CloneIpcOutcome } from "../../../shared/ipcContract";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("CloneDialog (specs/online-sync-clone.md FR-351/FR-354/FR-356/FR-357)", () => {
  it("renders as an accessible modal with the URL and destination fields, Clone disabled until both are filled", async () => {
    const api = makeMockGitHydra();
    render(<CloneDialog api={api} onClose={vi.fn()} onCloned={vi.fn()} />);

    const dialog = screen.getByRole("dialog", { name: /clone a repository/i });
    expect(dialog).toHaveAttribute("aria-modal", "true");

    const cloneButton = screen.getByRole("button", { name: /^clone$/i });
    expect(cloneButton).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/repository url/i), "https://example.com/owner/repo.git");
    expect(cloneButton).toBeDisabled(); // destination still empty.

    await userEvent.type(screen.getByLabelText(/destination folder/i), "/dest/repo");
    expect(cloneButton).toBeEnabled();
  });

  it("never restricts the URL field's shape — accepts https, ssh, and a bare local path verbatim", async () => {
    const api = makeMockGitHydra();
    render(<CloneDialog api={api} onClose={vi.fn()} onCloned={vi.fn()} />);
    const urlInput = screen.getByLabelText(/repository url/i) as HTMLInputElement;

    await userEvent.type(urlInput, "git@example.com:owner/repo.git");
    expect(urlInput.value).toBe("git@example.com:owner/repo.git");
    await userEvent.clear(urlInput);
    await userEvent.type(urlInput, "/srv/git/bare-repo.git");
    expect(urlInput.value).toBe("/srv/git/bare-repo.git");
  });

  it("FR-351: Browse reuses the existing openRepoDialog channel and fills the destination with the picked parent + a derived repo name", async () => {
    const api = makeMockGitHydra();
    vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: "/home/user/projects" });
    render(<CloneDialog api={api} onClose={vi.fn()} onCloned={vi.fn()} />);

    await userEvent.type(screen.getByLabelText(/repository url/i), "https://example.com/owner/my-repo.git");
    await userEvent.click(screen.getByRole("button", { name: /browse/i }));

    expect(api.openRepoDialog).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect((screen.getByLabelText(/destination folder/i) as HTMLInputElement).value).toBe("/home/user/projects/my-repo"),
    );
  });

  it("Browse is a no-op when the native dialog is cancelled", async () => {
    const api = makeMockGitHydra();
    vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: null });
    render(<CloneDialog api={api} onClose={vi.fn()} onCloned={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: /browse/i }));
    expect((screen.getByLabelText(/destination folder/i) as HTMLInputElement).value).toBe("");
  });

  it("the destination field stays freely editable after Browse — never a read-only <output>", async () => {
    const api = makeMockGitHydra();
    render(<CloneDialog api={api} onClose={vi.fn()} onCloned={vi.fn()} />);
    const destInput = screen.getByLabelText(/destination folder/i) as HTMLInputElement;
    expect(destInput.tagName).toBe("INPUT");
    expect(destInput).not.toHaveAttribute("readonly");
    await userEvent.type(destInput, "/anywhere/I/type");
    expect(destInput.value).toBe("/anywhere/I/type");
  });

  it("submitting calls api.clone with the trimmed url/destination and a fresh requestId, showing the in-progress banner with Cancel", async () => {
    const api = makeMockGitHydra();
    const gate = deferred<CloneIpcOutcome>();
    vi.mocked(api.clone).mockReturnValueOnce(gate.promise);
    render(<CloneDialog api={api} onClose={vi.fn()} onCloned={vi.fn()} />);

    await userEvent.type(screen.getByLabelText(/repository url/i), "  https://example.com/owner/repo.git  ");
    await userEvent.type(screen.getByLabelText(/destination folder/i), "  /dest/repo  ");
    await userEvent.click(screen.getByRole("button", { name: /^clone$/i }));

    expect(screen.getByText(/cloning…/i)).toBeInTheDocument();
    const cancelButton = screen.getByRole("button", { name: /^cancel$/i });
    expect(cancelButton).toBeInTheDocument();

    const [, url, destination] = vi.mocked(api.clone).mock.calls[0]!;
    expect(url).toBe("https://example.com/owner/repo.git");
    expect(destination).toBe("/dest/repo");

    await userEvent.click(cancelButton);
    expect(api.cancelClone).toHaveBeenCalledTimes(1);
    gate.resolve({ outcome: "cancelled" });
    await waitFor(() => expect(screen.queryByText(/cloning…/i)).not.toBeInTheDocument());
  });

  it("FR-356: on success, calls onCloned with the resolved destination path", async () => {
    const api = makeMockGitHydra();
    vi.mocked(api.clone).mockResolvedValueOnce({ outcome: "settled", result: { ok: true, data: { path: "/dest/repo" } } });
    const onCloned = vi.fn();
    render(<CloneDialog api={api} onClose={vi.fn()} onCloned={onCloned} />);

    await userEvent.type(screen.getByLabelText(/repository url/i), "https://example.com/owner/repo.git");
    await userEvent.type(screen.getByLabelText(/destination folder/i), "/dest/repo");
    await userEvent.click(screen.getByRole("button", { name: /^clone$/i }));

    await waitFor(() => expect(onCloned).toHaveBeenCalledWith("/dest/repo"));
  });

  it("FR-353: a destination-already-exists refusal shows git's real reason via the Details disclosure, and Dismiss returns to the editable form", async () => {
    const api = makeMockGitHydra();
    vi.mocked(api.clone).mockResolvedValueOnce({
      outcome: "settled",
      result: {
        ok: false,
        error: {
          name: "GitCommandError",
          message: "git clone exited with code 128: fatal: destination path 'repo' already exists and is not an empty directory.",
          stderr: "fatal: destination path 'repo' already exists and is not an empty directory.",
        },
      },
    });
    render(<CloneDialog api={api} onClose={vi.fn()} onCloned={vi.fn()} />);

    await userEvent.type(screen.getByLabelText(/repository url/i), "https://example.com/owner/repo.git");
    await userEvent.type(screen.getByLabelText(/destination folder/i), "/dest/repo");
    await userEvent.click(screen.getByRole("button", { name: /^clone$/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/could not clone/i);
    await userEvent.click(within(alert).getByText(/^details$/i));
    expect(alert).toHaveTextContent(/already exists and is not an empty directory/i);

    // The form is still there, still editable, so the user can fix the destination and retry.
    expect(screen.getByLabelText(/repository url/i)).toHaveValue("https://example.com/owner/repo.git");
    await userEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("FR-357: a credential failure shows the identical classified message Phase 1/Push already use", async () => {
    const api = makeMockGitHydra();
    vi.mocked(api.clone).mockResolvedValueOnce({
      outcome: "settled",
      result: {
        ok: false,
        error: {
          name: "GitCommandError",
          message: "git clone exited with code 128: fatal: Authentication failed for 'https://example.com/owner/repo.git/'",
          stderr: "fatal: Authentication failed for 'https://example.com/owner/repo.git/'",
        },
      },
    });
    render(<CloneDialog api={api} onClose={vi.fn()} onCloned={vi.fn()} />);

    await userEvent.type(screen.getByLabelText(/repository url/i), "https://example.com/owner/repo.git");
    await userEvent.type(screen.getByLabelText(/destination folder/i), "/dest/repo");
    await userEvent.click(screen.getByRole("button", { name: /^clone$/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/HTTPS authentication failed/i);
  });

  it("clicking the plain Cancel button in the form phase calls onClose without ever calling api.clone", async () => {
    const api = makeMockGitHydra();
    const onClose = vi.fn();
    render(<CloneDialog api={api} onClose={onClose} onCloned={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(api.clone).not.toHaveBeenCalled();
  });

  it("Escape closes the dialog while in the form phase", async () => {
    const api = makeMockGitHydra();
    const onClose = vi.fn();
    render(<CloneDialog api={api} onClose={onClose} onCloned={vi.fn()} />);

    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape cancels the in-flight clone (never silently orphans it) instead of closing while cloning", async () => {
    const api = makeMockGitHydra();
    const gate = deferred<CloneIpcOutcome>();
    vi.mocked(api.clone).mockReturnValueOnce(gate.promise);
    const onClose = vi.fn();
    render(<CloneDialog api={api} onClose={onClose} onCloned={vi.fn()} />);

    await userEvent.type(screen.getByLabelText(/repository url/i), "https://example.com/owner/repo.git");
    await userEvent.type(screen.getByLabelText(/destination folder/i), "/dest/repo");
    await userEvent.click(screen.getByRole("button", { name: /^clone$/i }));

    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    expect(api.cancelClone).toHaveBeenCalledTimes(1);
  });

  it("clicking the overlay backdrop while cloning does not close the dialog", async () => {
    const api = makeMockGitHydra();
    const gate = deferred<CloneIpcOutcome>();
    vi.mocked(api.clone).mockReturnValueOnce(gate.promise);
    const onClose = vi.fn();
    render(<CloneDialog api={api} onClose={onClose} onCloned={vi.fn()} />);

    await userEvent.type(screen.getByLabelText(/repository url/i), "https://example.com/owner/repo.git");
    await userEvent.type(screen.getByLabelText(/destination folder/i), "/dest/repo");
    await userEvent.click(screen.getByRole("button", { name: /^clone$/i }));

    await userEvent.click(document.querySelector(".gh-clone-dialog__overlay")!);
    expect(onClose).not.toHaveBeenCalled();
  });
});
