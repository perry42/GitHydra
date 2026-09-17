// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  getIdentityConfigState,
  applyIdentityProfile,
  removeIdentityProfileApplication,
  assertValidSshIdentityFile,
  assertSafeSshIdentityPathSyntax,
  buildSshCommandValue,
  findForbiddenSshPathCharacter,
  SSH_PATH_FORBIDDEN_CHARACTERS,
  type ExpectedIdentityApplication,
} from "../src/identityProfile";
import { Repository } from "../src/index";
import { InvalidArgumentError, UnmanagedIdentityConfigConflictError } from "../src/errors";
import { git, initRepo, writeFile, commit, cleanup, makeTempDir } from "./testRepo";

/**
 * specs/git-identity-profiles.md's git-core surface (FR-329 through FR-337): `applyIdentityProfile`,
 * `removeIdentityProfileApplication`, `getIdentityConfigState`, and the `core.sshCommand`
 * construction/validation helpers. See specs/online-sync-security-flags.md #3 for why the
 * injection-focused describe blocks below are this suite's highest-priority coverage.
 *
 * security-reviewer finding (post-initial-pass): "GitHydra-managed" is no longer decided by
 * anything read from the target repo's own `.git/config` (a `githydra.managed-*` marker there is
 * forgeable by anyone who can plant a `.git/config`, e.g. via a zip) — it is decided entirely by
 * comparing the live config value against an `ExpectedIdentityApplication` the CALLER supplies,
 * standing in for the real app's own local-storage record (`useIdentityApplications.ts` on the
 * desktop side). Every test below that needs an "already applied by GitHydra" repo state
 * constructs its own `ExpectedIdentityApplication` explicitly (`expectedFrom()` helper) rather than
 * relying on any in-repo signal — mirroring exactly how the real app is expected to call this
 * module. The "forged marker" describe block is the direct regression test for the vulnerability
 * itself: a hand-planted in-repo marker must never substitute for the caller's own record.
 */

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
});

async function makeRepo(): Promise<string> {
  const dir = await initRepo();
  cleanupDirs.push(dir);
  await git(dir, ["config", "core.autocrlf", "false"]);
  return dir;
}

async function makeIdentityFile(dir: string, relPath = "id_ed25519"): Promise<string> {
  const full = path.join(dir, relPath);
  await fs.writeFile(full, "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n", "utf8");
  return full;
}

async function localConfigGet(dir: string, key: string): Promise<string | null> {
  try {
    const { stdout } = await git(dir, ["config", "--local", "--get", key]);
    return stdout.replace(/\r?\n$/, "");
  } catch {
    return null;
  }
}

async function localConfigList(dir: string): Promise<string> {
  try {
    const { stdout } = await git(dir, ["config", "--local", "--list"]);
    return stdout;
  } catch {
    return "";
  }
}

/** Build the `ExpectedIdentityApplication` a real caller's app storage would hold immediately
 * after a successful `applyIdentityProfile()` call with these exact fields — the standard way
 * every test below simulates "the app already recorded this application." */
function expectedFrom(userName: string, userEmail: string, sshCommand: string | null = null): ExpectedIdentityApplication {
  return { userName, userEmail, sshCommand };
}

describe("applyIdentityProfile (FR-330): local-only, per-repo, independent", () => {
  it("acceptance criterion 1: two profiles applied to two different repos end up with independent user.email values", async () => {
    const dirA = await makeRepo();
    const dirB = await makeRepo();

    await applyIdentityProfile(dirA, { userName: "Alice Work", userEmail: "alice@work.example" });
    await applyIdentityProfile(dirB, { userName: "Alice Personal", userEmail: "alice@personal.example" });

    expect(await localConfigGet(dirA, "user.email")).toBe("alice@work.example");
    expect(await localConfigGet(dirB, "user.email")).toBe("alice@personal.example");
    expect(await localConfigGet(dirA, "user.name")).toBe("Alice Work");
    expect(await localConfigGet(dirB, "user.name")).toBe("Alice Personal");
  });

  it("writes only --local config, never touches global user.name/user.email (AC2, first half)", async () => {
    const dir = await makeRepo();
    const globalNameBefore = await (async () => {
      try {
        return (await git(dir, ["config", "--global", "--get", "user.name"])).stdout;
      } catch {
        return null;
      }
    })();

    await applyIdentityProfile(dir, { userName: "Local Only", userEmail: "local@example.com" });

    const globalNameAfter = await (async () => {
      try {
        return (await git(dir, ["config", "--global", "--get", "user.name"])).stdout;
      } catch {
        return null;
      }
    })();
    expect(globalNameAfter).toBe(globalNameBefore);
  });

  it("supports non-ASCII user.name/user.email content round-tripping exactly", async () => {
    const dir = await makeRepo();
    await applyIdentityProfile(dir, { userName: "田中 太郎 — Ünïcödé", userEmail: "田中@example.com" });
    expect(await localConfigGet(dir, "user.name")).toBe("田中 太郎 — Ünïcödé");
    expect(await localConfigGet(dir, "user.email")).toBe("田中@example.com");
  });

  it("throws InvalidArgumentError for an empty userName/userEmail, making no git call", async () => {
    const dir = await makeRepo();
    await expect(applyIdentityProfile(dir, { userName: "", userEmail: "a@b.com" })).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
    await expect(applyIdentityProfile(dir, { userName: "A", userEmail: "   " })).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
    expect(await localConfigGet(dir, "user.name")).toBeNull();
    expect(await localConfigGet(dir, "user.email")).toBeNull();
  });

  it("works against a bare repository, an empty (unborn-HEAD) repository, and a detached HEAD checkout", async () => {
    const bareDir = await initRepo({ bare: true });
    cleanupDirs.push(bareDir);
    await applyIdentityProfile(bareDir, { userName: "Bare", userEmail: "bare@example.com" });
    expect(await localConfigGet(bareDir, "user.email")).toBe("bare@example.com");

    const emptyDir = await makeRepo(); // initRepo() alone has zero commits (unborn HEAD)
    await applyIdentityProfile(emptyDir, { userName: "Empty", userEmail: "empty@example.com" });
    expect(await localConfigGet(emptyDir, "user.email")).toBe("empty@example.com");

    const detachedDir = await makeRepo();
    await writeFile(detachedDir, "a.txt", "1\n");
    const sha = await commit(detachedDir, "one");
    await git(detachedDir, ["checkout", "-q", sha]);
    await applyIdentityProfile(detachedDir, { userName: "Detached", userEmail: "detached@example.com" });
    expect(await localConfigGet(detachedDir, "user.email")).toBe("detached@example.com");
  });

  it("applies correctly from a linked worktree (shared local config, same as the main checkout)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1\n");
    await commit(dir, "one");
    const worktreeDir = `${dir}-wt`;
    cleanupDirs.push(worktreeDir);
    await git(dir, ["worktree", "add", "-q", "-b", "feature", worktreeDir]);

    await applyIdentityProfile(worktreeDir, { userName: "From Worktree", userEmail: "wt@example.com" });

    // Reflected identically from the main checkout — the same shared local config file.
    expect(await localConfigGet(dir, "user.email")).toBe("wt@example.com");
    expect(await localConfigGet(worktreeDir, "user.email")).toBe("wt@example.com");
  });
});

describe("applyIdentityProfile (FR-331): core.sshCommand construction", () => {
  it("writes ssh -i '<path>' -o IdentitiesOnly=yes for a valid identity file path", async () => {
    const dir = await makeRepo();
    const identityDir = await makeTempDir();
    cleanupDirs.push(identityDir);
    const keyPath = await makeIdentityFile(identityDir);

    await applyIdentityProfile(dir, {
      userName: "SSH User",
      userEmail: "ssh@example.com",
      sshIdentityFilePath: keyPath,
    });

    const value = await localConfigGet(dir, "core.sshCommand");
    expect(value).toBe(`ssh -i '${keyPath}' -o IdentitiesOnly=yes`);
  });

  it("handles an identity file path containing spaces correctly", async () => {
    const dir = await makeRepo();
    const identityDir = await makeTempDir();
    cleanupDirs.push(identityDir);
    const keyPath = await makeIdentityFile(identityDir, "my key with spaces");

    await applyIdentityProfile(dir, {
      userName: "Spacey",
      userEmail: "spacey@example.com",
      sshIdentityFilePath: keyPath,
    });

    expect(await localConfigGet(dir, "core.sshCommand")).toBe(`ssh -i '${keyPath}' -o IdentitiesOnly=yes`);
  });

  it("never writes core.sshCommand when the profile specifies no SSH identity file", async () => {
    const dir = await makeRepo();
    await applyIdentityProfile(dir, { userName: "No SSH", userEmail: "nossh@example.com" });
    expect(await localConfigGet(dir, "core.sshCommand")).toBeNull();
  });

  it("clears a PRIOR GitHydra-managed core.sshCommand when a later-applied profile specifies none", async () => {
    const dir = await makeRepo();
    const identityDir = await makeTempDir();
    cleanupDirs.push(identityDir);
    const keyPath = await makeIdentityFile(identityDir);

    await applyIdentityProfile(dir, { userName: "A", userEmail: "a@example.com", sshIdentityFilePath: keyPath });
    const sshValue = await localConfigGet(dir, "core.sshCommand");
    expect(sshValue).not.toBeNull();
    const knownApplication = expectedFrom("A", "a@example.com", sshValue);

    // The caller's own record of the prior apply is what makes user.name/user.email/sshCommand
    // recognized as already-managed -- without it this second call would need force:true.
    await applyIdentityProfile(dir, { userName: "B", userEmail: "b@example.com", knownApplication });
    expect(await localConfigGet(dir, "core.sshCommand")).toBeNull();
  });

  it("does NOT clear a FOREIGN (not GitHydra-managed) core.sshCommand when a profile without an SSH key is applied", async () => {
    const dir = await makeRepo();
    await git(dir, ["config", "--local", "core.sshCommand", "ssh -o ProxyCommand=corp-proxy %h"]);

    await applyIdentityProfile(dir, { userName: "No SSH", userEmail: "nossh@example.com" });

    expect(await localConfigGet(dir, "core.sshCommand")).toBe("ssh -o ProxyCommand=corp-proxy %h");
  });
});

describe("core.sshCommand path validation (FR-332/FR-333): rejects, never escapes", () => {
  it("rejects every defined forbidden character individually, naming it, before any git call", async () => {
    const dir = await makeRepo();
    for (const forbidden of SSH_PATH_FORBIDDEN_CHARACTERS) {
      const maliciousPath = `${path.resolve(dir, "..")}${path.sep}evil${forbidden.char}key`;
      let caught: unknown;
      try {
        await applyIdentityProfile(dir, {
          userName: "X",
          userEmail: "x@example.com",
          sshIdentityFilePath: maliciousPath,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(InvalidArgumentError);
      expect((caught as Error).message).toContain(forbidden.label);
      // No config write happened as a side effect of the rejected attempt.
      expect(await localConfigGet(dir, "core.sshCommand")).toBeNull();
      expect(await localConfigGet(dir, "user.name")).toBeNull();
    }
  });

  it("classic injection shapes are all rejected outright: command substitution, chaining, piping", async () => {
    const dir = await makeRepo();
    const base = path.resolve(dir, "..");
    const maliciousPaths = [
      `${base}${path.sep}id_rsa; rm -rf /tmp/x`,
      `${base}${path.sep}id_rsa\` touch pwned \``,
      `${base}${path.sep}id_rsa$(touch pwned)`,
      `${base}${path.sep}id_rsa | touch pwned`,
      `${base}${path.sep}id_rsa && touch pwned`,
      `${base}${path.sep}id_rsa" ; touch pwned #`,
      `${base}${path.sep}id_rsa' ; touch pwned #`,
      `${base}${path.sep}id_rsa\ntouch pwned`,
    ];
    for (const maliciousPath of maliciousPaths) {
      await expect(
        applyIdentityProfile(dir, {
          userName: "X",
          userEmail: "x@example.com",
          sshIdentityFilePath: maliciousPath,
        }),
      ).rejects.toBeInstanceOf(InvalidArgumentError);
    }
    expect(await localConfigGet(dir, "core.sshCommand")).toBeNull();
  });

  it("rejects a relative path (must come from the native file dialog, which only returns absolute paths)", () => {
    expect(() => assertSafeSshIdentityPathSyntax("relative/id_rsa")).toThrow(InvalidArgumentError);
  });

  it("rejects an empty path", () => {
    expect(() => assertSafeSshIdentityPathSyntax("")).toThrow(InvalidArgumentError);
    expect(() => assertSafeSshIdentityPathSyntax("   ")).toThrow(InvalidArgumentError);
  });

  it("findForbiddenSshPathCharacter finds the FIRST offending character in list order", () => {
    const found = findForbiddenSshPathCharacter(`/a/b';rm -rf /`);
    expect(found?.char).toBe("'");
  });

  it("rejects a path that does not exist on disk", async () => {
    const dir = await makeRepo();
    await expect(assertValidSshIdentityFile(path.join(dir, "does-not-exist"))).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
  });

  it("rejects a path that is a directory, not a regular file", async () => {
    const dir = await makeRepo();
    const subdir = path.join(dir, "a-directory");
    await fs.mkdir(subdir);
    await expect(assertValidSshIdentityFile(subdir)).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it("accepts a valid, existing, metacharacter-free absolute path", async () => {
    const dir = await makeTempDir();
    cleanupDirs.push(dir);
    const keyPath = await makeIdentityFile(dir);
    await expect(assertValidSshIdentityFile(keyPath)).resolves.toBeUndefined();
  });

  it("supports a non-ASCII identity file path", async () => {
    const dir = await makeTempDir();
    cleanupDirs.push(dir);
    const keyPath = await makeIdentityFile(dir, "clé_privée_ключ");
    await expect(assertValidSshIdentityFile(keyPath)).resolves.toBeUndefined();
    expect(buildSshCommandValue(keyPath)).toBe(`ssh -i '${keyPath}' -o IdentitiesOnly=yes`);
  });

  it("buildSshCommandValue itself re-validates and refuses a malicious path even if called directly", () => {
    expect(() => buildSshCommandValue("/tmp/evil'; touch pwned #")).toThrow(InvalidArgumentError);
  });
});

/**
 * security-reviewer finding (Low): `path.isAbsolute()` alone accepts a Windows UNC (network share)
 * path, and nothing previously rejected one before `fs.stat()` touched it -- on Windows, merely
 * `stat`-ing a `\\host\share\...` path makes the OS attempt an SMB/NTLM handshake against `host`,
 * a real forced-authentication technique, regardless of whether anything actually exists there.
 */
describe("core.sshCommand path validation: rejects Windows UNC (network) paths", () => {
  const uncPaths = [
    "\\\\evil-host\\share\\id_rsa",
    "\\\\evil-host\\share",
    "//evil-host/share/id_rsa",
    "\\\\?\\UNC\\evil-host\\share\\id_rsa",
  ];

  it("assertSafeSshIdentityPathSyntax rejects every UNC spelling synchronously, before any filesystem access", () => {
    for (const uncPath of uncPaths) {
      expect(() => assertSafeSshIdentityPathSyntax(uncPath)).toThrow(InvalidArgumentError);
    }
  });

  it("does not reject the extended-length LOCAL path prefix (\\\\?\\C:\\...), which is not a network path", () => {
    // Still needs to pass the OTHER checks (existence) to fully validate, but the SYNTAX check
    // specifically must not treat this as a UNC path.
    expect(() => assertSafeSshIdentityPathSyntax("\\\\?\\C:\\Users\\id_rsa")).not.toThrow();
  });

  it("applyIdentityProfile rejects a UNC identity-file path outright, with no git config write", async () => {
    const dir = await makeRepo();
    for (const uncPath of uncPaths) {
      await expect(
        applyIdentityProfile(dir, {
          userName: "X",
          userEmail: "x@example.com",
          sshIdentityFilePath: uncPath,
        }),
      ).rejects.toBeInstanceOf(InvalidArgumentError);
    }
    expect(await localConfigGet(dir, "core.sshCommand")).toBeNull();
    expect(await localConfigGet(dir, "user.name")).toBeNull();
  });

  it("assertValidSshIdentityFile rejects a UNC path without ever reaching fs.stat (the network-touching step)", async () => {
    // If this reached fs.stat() on a UNC path, Windows would attempt (and, for a nonexistent
    // host, eventually time out on) an SMB handshake -- this assertion completing quickly and
    // with the expected error is itself evidence the rejection happened at the synchronous
    // syntax-check layer, never falling through to the filesystem call.
    await expect(assertValidSshIdentityFile("\\\\evil-host\\share\\id_rsa")).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
  }, 5_000);
});

/**
 * specs/online-sync-security-flags.md #3: the core positive-control proof that `core.sshCommand`
 * really is shell-parsed by git in this exact environment — i.e. that the vulnerability class
 * `SSH_PATH_FORBIDDEN_CHARACTERS`/`assertSafeSshIdentityPathSyntax` defend against is real, not
 * theoretical. This deliberately bypasses `applyIdentityProfile()` (setting `core.sshCommand`
 * directly via a raw `git config` call the way a naive, unvalidated implementation would) to prove
 * the underlying git behavior, never to prove anything about this module's own code.
 */
describe("core.sshCommand shell-parsing (positive control, specs/online-sync-security-flags.md #3)", () => {
  it("a manually-set malicious core.sshCommand value IS executed by git when it invokes ssh, even though the actual connection then fails", async () => {
    const dir = await makeRepo();
    const markerPath = path.join(dir, "PWNED_MARKER.txt");
    await fs.rm(markerPath, { force: true });

    const maliciousValue = `sh -c 'echo pwned > ${JSON.stringify(markerPath)}' #`;
    await git(dir, ["config", "--local", "core.sshCommand", maliciousValue]);

    // Never a real network attempt (FR-9-equivalent posture for this test itself): the "connect"
    // targets an address nothing listens on and always fails, but the SHELL PARSING of
    // core.sshCommand happens unconditionally before git ever gets as far as actually dialing out.
    const result = spawnSync("git", ["ls-remote", "ssh://127.0.0.1:1/nonexistent.git"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0); // the ssh connection itself still fails, as expected

    const markerExists = await fs
      .access(markerPath)
      .then(() => true)
      .catch(() => false);
    expect(markerExists).toBe(true); // ...but the embedded shell command already ran.
  }, 20_000);

  it("applyIdentityProfile() never lets an equivalent malicious path reach core.sshCommand in the first place", async () => {
    const dir = await makeRepo();
    const markerPath = path.join(dir, "PWNED_MARKER2.txt");
    await fs.rm(markerPath, { force: true });

    const maliciousIdentityPath = `/tmp/id_rsa'; sh -c 'echo pwned > ${JSON.stringify(markerPath)}' #`;
    await expect(
      applyIdentityProfile(dir, {
        userName: "X",
        userEmail: "x@example.com",
        sshIdentityFilePath: maliciousIdentityPath,
      }),
    ).rejects.toBeInstanceOf(InvalidArgumentError);

    expect(await localConfigGet(dir, "core.sshCommand")).toBeNull();
    const markerExists = await fs
      .access(markerPath)
      .then(() => true)
      .catch(() => false);
    expect(markerExists).toBe(false);
  });
});

describe("getIdentityConfigState (FR-335's data dependency)", () => {
  it("distinguishes an unset key, a GitHydra-managed local value (per the caller's knownApplication), and a foreign local value", async () => {
    const dir = await makeRepo();
    const before = await getIdentityConfigState(dir, null);
    expect(before.userName.localValue).toBeNull();
    expect(before.userName.managedByGitHydra).toBe(false);

    await applyIdentityProfile(dir, { userName: "Managed", userEmail: "managed@example.com" });
    const knownApplication = expectedFrom("Managed", "managed@example.com");
    const afterApply = await getIdentityConfigState(dir, knownApplication);
    expect(afterApply.userName.localValue).toBe("Managed");
    expect(afterApply.userName.managedByGitHydra).toBe(true);

    // A manual edit outside GitHydra makes the CALLER's record stale -- the live value no longer
    // matches what the caller believes was applied, so it must not be reported as managed even
    // though `knownApplication` itself hasn't changed.
    await git(dir, ["config", "--local", "user.name", "Hand Edited"]);
    const afterManualEdit = await getIdentityConfigState(dir, knownApplication);
    expect(afterManualEdit.userName.localValue).toBe("Hand Edited");
    expect(afterManualEdit.userName.managedByGitHydra).toBe(false);
  });

  it("reports managedByGitHydra: false for every key when knownApplication is null, regardless of what's set locally", async () => {
    const dir = await makeRepo();
    await applyIdentityProfile(dir, { userName: "Managed", userEmail: "managed@example.com" });
    const state = await getIdentityConfigState(dir, null);
    expect(state.userName.localValue).toBe("Managed");
    expect(state.userName.managedByGitHydra).toBe(false);
    expect(state.userEmail.managedByGitHydra).toBe(false);
  });

  it("reports a global-scope value distinctly from a local one, without ever writing to global config", async () => {
    const dir = await makeRepo();
    const state = await getIdentityConfigState(dir, null);
    expect(state.userName.localValue).toBeNull();
    expect(typeof state.userName.managedByGitHydra).toBe("boolean");
  });
});

/**
 * security-reviewer finding (Medium, the primary fix in this describe block's parent file):
 * "GitHydra-managed" must be decided ONLY by the caller-supplied `ExpectedIdentityApplication`,
 * never by anything read from the target repo's own `.git/config` -- because this app opens repos
 * from arbitrary (including untrusted) sources, e.g. a zip, so a hand-planted `.git/config` is
 * squarely in-scope for an attacker to control. These tests plant a config value AND a
 * `githydra.managed-*`-shaped key by hand (simulating a forged repo) and confirm neither
 * `getIdentityConfigState` nor `removeIdentityProfileApplication` ever treats the value as
 * GitHydra's own unless the CALLER's own `knownApplication` says so.
 */
describe("forged in-repo marker cannot substitute for the caller's own record (security regression)", () => {
  it("a hand-planted githydra.managed-* key matching the live value does NOT make getIdentityConfigState report it as managed", async () => {
    const dir = await makeRepo();
    // Simulate a repo shipped with a forged config: the attacker sets BOTH the real key and a
    // plausible-looking marker, hoping a marker-trusting implementation would treat this as
    // GitHydra's own. Only a caller-supplied ExpectedIdentityApplication may do that now.
    await git(dir, ["config", "--local", "user.name", "Attacker Controlled"]);
    await git(dir, ["config", "--local", "user.email", "attacker@example.com"]);
    await git(dir, ["config", "--local", "githydra.managed-user-name", "Attacker Controlled"]);
    await git(dir, ["config", "--local", "githydra.managed-user-email", "attacker@example.com"]);

    const state = await getIdentityConfigState(dir, null);
    expect(state.userName.localValue).toBe("Attacker Controlled");
    expect(state.userName.managedByGitHydra).toBe(false);
    expect(state.userEmail.managedByGitHydra).toBe(false);
  });

  it("removeIdentityProfileApplication does NOT unset a value with a forged marker when knownApplication is null", async () => {
    const dir = await makeRepo();
    await git(dir, ["config", "--local", "user.name", "Attacker Controlled"]);
    await git(dir, ["config", "--local", "githydra.managed-user-name", "Attacker Controlled"]);

    const result = await removeIdentityProfileApplication(dir, null);
    expect(result.removedKeys).toEqual([]);
    expect(await localConfigGet(dir, "user.name")).toBe("Attacker Controlled");
  });

  it("removeIdentityProfileApplication does NOT unset a value with a forged marker even when knownApplication names a DIFFERENT value", async () => {
    const dir = await makeRepo();
    await git(dir, ["config", "--local", "user.name", "Attacker Controlled"]);
    await git(dir, ["config", "--local", "githydra.managed-user-name", "Attacker Controlled"]);
    // The app's real record says something else was applied (e.g. this repo was never actually
    // touched by GitHydra's identity feature at all) -- must never be treated as a match.
    const knownApplication = expectedFrom("Someone Else", "someone@example.com");

    const result = await removeIdentityProfileApplication(dir, knownApplication);
    expect(result.removedKeys).toEqual([]);
    expect(await localConfigGet(dir, "user.name")).toBe("Attacker Controlled");
  });

  it("applyIdentityProfile still requires force:true to overwrite a value with a forged marker (FR-334 is not bypassed)", async () => {
    const dir = await makeRepo();
    await git(dir, ["config", "--local", "user.name", "Attacker Controlled"]);
    await git(dir, ["config", "--local", "user.email", "attacker@example.com"]);
    await git(dir, ["config", "--local", "githydra.managed-user-name", "Attacker Controlled"]);
    await git(dir, ["config", "--local", "githydra.managed-user-email", "attacker@example.com"]);

    await expect(
      applyIdentityProfile(dir, { userName: "New", userEmail: "new@example.com" }),
    ).rejects.toBeInstanceOf(UnmanagedIdentityConfigConflictError);
    expect(await localConfigGet(dir, "user.name")).toBe("Attacker Controlled");
  });

  it("a forged marker whose value happens to equal what knownApplication ALSO expects does not create a false negative (sanity check on the fix's own logic)", async () => {
    // Distinguishes "the fix ignores the marker" from "the fix happens to also read the value
    // through some other path" -- applies for real, so the value legitimately matches
    // knownApplication AND (incidentally) a marker some other actor also planted.
    const dir = await makeRepo();
    await applyIdentityProfile(dir, { userName: "Legit", userEmail: "legit@example.com" });
    await git(dir, ["config", "--local", "githydra.managed-user-name", "Legit"]);
    const knownApplication = expectedFrom("Legit", "legit@example.com");

    const state = await getIdentityConfigState(dir, knownApplication);
    expect(state.userName.managedByGitHydra).toBe(true);
  });
});

describe("applyIdentityProfile (FR-334): unmanaged pre-existing value requires confirmation", () => {
  it("acceptance criterion 4: refuses with UnmanagedIdentityConfigConflictError, leaves the pre-existing core.sshCommand untouched, then succeeds with force:true", async () => {
    const dir = await makeRepo();
    const corpProxyValue = "ssh -o ProxyCommand=corp-proxy %h";
    await git(dir, ["config", "--local", "core.sshCommand", corpProxyValue]);

    const identityDir = await makeTempDir();
    cleanupDirs.push(identityDir);
    const keyPath = await makeIdentityFile(identityDir);

    let caught: unknown;
    try {
      await applyIdentityProfile(dir, {
        userName: "New",
        userEmail: "new@example.com",
        sshIdentityFilePath: keyPath,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnmanagedIdentityConfigConflictError);
    const typed = caught as UnmanagedIdentityConfigConflictError;
    expect(typed.conflicts).toContainEqual({ key: "core.sshCommand", currentValue: corpProxyValue });

    // Declining (not retrying at all) leaves everything exactly as it was.
    expect(await localConfigGet(dir, "core.sshCommand")).toBe(corpProxyValue);
    expect(await localConfigGet(dir, "user.name")).toBeNull();

    // Confirmed retry succeeds and overwrites.
    await applyIdentityProfile(dir, {
      userName: "New",
      userEmail: "new@example.com",
      sshIdentityFilePath: keyPath,
      force: true,
    });
    expect(await localConfigGet(dir, "core.sshCommand")).toBe(`ssh -i '${keyPath}' -o IdentitiesOnly=yes`);
    expect(await localConfigGet(dir, "user.name")).toBe("New");
  });

  it("flags a foreign user.name/user.email the same way, naming both conflicts together", async () => {
    const dir = await makeRepo();
    await git(dir, ["config", "--local", "user.name", "Some Human"]);
    await git(dir, ["config", "--local", "user.email", "human@example.com"]);

    let caught: unknown;
    try {
      await applyIdentityProfile(dir, { userName: "Profile Name", userEmail: "profile@example.com" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnmanagedIdentityConfigConflictError);
    const typed = caught as UnmanagedIdentityConfigConflictError;
    expect(typed.conflicts).toEqual(
      expect.arrayContaining([
        { key: "user.name", currentValue: "Some Human" },
        { key: "user.email", currentValue: "human@example.com" },
      ]),
    );
    expect(await localConfigGet(dir, "user.name")).toBe("Some Human");
  });

  it("never requires force to UPDATE a value the caller's knownApplication already accounts for (re-apply / edited profile)", async () => {
    const dir = await makeRepo();
    await applyIdentityProfile(dir, { userName: "V1", userEmail: "v1@example.com" });
    const knownApplication = expectedFrom("V1", "v1@example.com");
    await expect(
      applyIdentityProfile(dir, { userName: "V2", userEmail: "v2@example.com", knownApplication }),
    ).resolves.toBeUndefined();
    expect(await localConfigGet(dir, "user.name")).toBe("V2");
  });

  it("still requires force to update an already-managed value if the caller omits knownApplication (fails safe, never assumes)", async () => {
    const dir = await makeRepo();
    await applyIdentityProfile(dir, { userName: "V1", userEmail: "v1@example.com" });
    // No knownApplication passed this time -- the caller "forgot" its own record. Must fail safe
    // (require confirmation) rather than silently trusting anything in the repo itself.
    await expect(
      applyIdentityProfile(dir, { userName: "V2", userEmail: "v2@example.com" }),
    ).rejects.toBeInstanceOf(UnmanagedIdentityConfigConflictError);
    expect(await localConfigGet(dir, "user.name")).toBe("V1");
  });

  it("does not require force when the pre-existing value happens to be identical text but is genuinely unmanaged", async () => {
    const dir = await makeRepo();
    await git(dir, ["config", "--local", "user.name", "Same Text"]);
    await git(dir, ["config", "--local", "user.email", "same@example.com"]);
    await expect(
      applyIdentityProfile(dir, { userName: "Same Text", userEmail: "same@example.com" }),
    ).rejects.toBeInstanceOf(UnmanagedIdentityConfigConflictError);
  });
});

describe("removeIdentityProfileApplication (FR-336)", () => {
  it("acceptance criterion 5: unsets exactly the keys profile-apply wrote, verified via --local --list, and never touches an unrelated pre-existing key", async () => {
    const dir = await makeRepo();
    await git(dir, ["config", "--local", "core.editor", "true"]); // unrelated pre-existing key
    const identityDir = await makeTempDir();
    cleanupDirs.push(identityDir);
    const keyPath = await makeIdentityFile(identityDir);

    await applyIdentityProfile(dir, {
      userName: "Managed",
      userEmail: "managed@example.com",
      sshIdentityFilePath: keyPath,
    });
    const listBefore = await localConfigList(dir);
    expect(listBefore).toContain("user.name=Managed");
    expect(listBefore).toContain("core.editor=true");

    const knownApplication = expectedFrom("Managed", "managed@example.com", `ssh -i '${keyPath}' -o IdentitiesOnly=yes`);
    const result = await removeIdentityProfileApplication(dir, knownApplication);
    expect(result.removedKeys).toEqual(
      expect.arrayContaining(["user.name", "user.email", "core.sshCommand"]),
    );

    const listAfter = await localConfigList(dir);
    expect(listAfter).not.toContain("user.name=");
    expect(listAfter).not.toContain("user.email=");
    expect(listAfter).not.toContain("core.sshcommand=");
    // The unrelated pre-existing key survives untouched.
    expect(listAfter).toContain("core.editor=true");
  });

  it("never unsets a foreign (not GitHydra-managed) value, even one with the same key", async () => {
    const dir = await makeRepo();
    await git(dir, ["config", "--local", "user.name", "Human Set This"]);

    const result = await removeIdentityProfileApplication(dir, null);
    expect(result.removedKeys).toEqual([]);
    expect(await localConfigGet(dir, "user.name")).toBe("Human Set This");
  });

  it("is a no-op (never throws) on a repo with nothing GitHydra-managed at all", async () => {
    const dir = await makeRepo();
    await expect(removeIdentityProfileApplication(dir, null)).resolves.toEqual({ removedKeys: [] });
  });

  it("global config is never touched by remove either", async () => {
    const dir = await makeRepo();
    await applyIdentityProfile(dir, { userName: "Managed", userEmail: "managed@example.com" });
    const knownApplication = expectedFrom("Managed", "managed@example.com");
    const globalBefore = await (async () => {
      try {
        return (await git(dir, ["config", "--global", "--get", "user.name"])).stdout;
      } catch {
        return null;
      }
    })();
    await removeIdentityProfileApplication(dir, knownApplication);
    const globalAfter = await (async () => {
      try {
        return (await git(dir, ["config", "--global", "--get", "user.name"])).stdout;
      } catch {
        return null;
      }
    })();
    expect(globalAfter).toBe(globalBefore);
  });
});

describe("FR-337: SSH private key CONTENTS are never read", () => {
  it("identityProfile.ts's source contains no fs.readFile/readFileSync call at all", async () => {
    const sourcePath = path.join(__dirname, "..", "src", "identityProfile.ts");
    const source = await fs.readFile(sourcePath, "utf8");
    expect(source).not.toMatch(/\breadFile(Sync)?\s*\(/);
  });

  it("applying a profile against an identity file with unreadable content-permission still succeeds on POSIX (never needs to read bytes, only stat)", async () => {
    if (process.platform === "win32") return; // POSIX permission bits aren't meaningful on Windows here
    const dir = await makeTempDir();
    cleanupDirs.push(dir);
    const keyPath = await makeIdentityFile(dir);
    await fs.chmod(keyPath, 0o000);
    try {
      const repoDir = await makeRepo();
      await expect(
        applyIdentityProfile(repoDir, {
          userName: "NoRead",
          userEmail: "noread@example.com",
          sshIdentityFilePath: keyPath,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await fs.chmod(keyPath, 0o600);
    }
  });
});

describe("Repository facade (identity profiles)", () => {
  it("round-trips apply/get/remove through the Repository facade", async () => {
    const dir = await makeRepo();
    const repo = await Repository.open(dir);

    const before = await repo.getIdentityConfigState(null);
    expect(before.userName.localValue).toBeNull();

    await repo.applyIdentityProfile({ userName: "Facade User", userEmail: "facade@example.com" });
    const knownApplication = expectedFrom("Facade User", "facade@example.com");
    const after = await repo.getIdentityConfigState(knownApplication);
    expect(after.userName.localValue).toBe("Facade User");
    expect(after.userName.managedByGitHydra).toBe(true);

    const result = await repo.removeIdentityProfileApplication(knownApplication);
    expect(result.removedKeys).toEqual(expect.arrayContaining(["user.name", "user.email"]));
    expect((await repo.getIdentityConfigState(knownApplication)).userName.localValue).toBeNull();
  });

  it("facade apply surfaces UnmanagedIdentityConfigConflictError unchanged", async () => {
    const dir = await makeRepo();
    await git(dir, ["config", "--local", "user.name", "Foreign"]);
    const repo = await Repository.open(dir);
    await expect(
      repo.applyIdentityProfile({ userName: "Mine", userEmail: "mine@example.com" }),
    ).rejects.toBeInstanceOf(UnmanagedIdentityConfigConflictError);
  });
});
