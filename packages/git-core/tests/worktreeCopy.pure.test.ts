// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import {
  COPY_SKIP_MESSAGES,
  copyLineText,
  decide,
  decideInitialTicks,
  evictRecords,
  formatCopySize,
  isLargeRow,
  isSecretLooking,
  normalizeRecord,
  nextRecordAt,
  runsCodeWhenOpened,
  validateCopyPath,
  type CopyCandidateRow,
  type CopyMemoryRecord,
} from "../src/worktreeCopyPure";

const row = (path: string, bytes: number | null = 10, extra: Partial<CopyCandidateRow> = {}): CopyCandidateRow => ({
  path,
  isDirectory: path.endsWith("/"),
  fileCount: 1,
  bytes,
  ...extra,
});
const MB = 1024 * 1024;

describe("secret-looking classifier (FR-627)", () => {
  const yes = [".env", ".env.local", ".ENV", "a/b/.env.production", "server.pem", "x.KEY", "a.p12", "a.pfx", "a.jks", "id_rsa", "id_ed25519", "credentials", "credentials.json", ".npmrc", ".netrc", ".pypirc", "my-secret.txt", "tokens.json", "Password.txt", "environment.ts".replace("environment", ".envx"), "tokenizer.js", "secrets/"];
  const no = ["environment.ts", "env", "src/index.ts", "keyboard.ts", "config/local.json", "pem", "idea.txt", ".npmrc.bak".replace(".npmrc.bak", "npmrc"), "monkey.ts"];
  it.each(yes)("flags %s", (p) => expect(isSecretLooking(p)).toBe(true));
  it.each(no)("accepts %s", (p) => expect(isSecretLooking(p)).toBe(false));
  it("documents false positives and matches the basename only", () => {
    expect(isSecretLooking("tokenizer.js")).toBe(true);
    expect(isSecretLooking("secret/readme.md")).toBe(false);
  });
  it("does not stall on a hostile name", () => {
    const t = Date.now();
    isSecretLooking("a".repeat(200000));
    expect(Date.now() - t).toBeLessThan(500);
  });
});

describe("run-code table", () => {
  const yes = [".envrc", ".vscode/", ".vscode/tasks.json", ".vscode/launch.json", ".vscode/settings.json", ".idea/", ".husky/", ".githooks/", ".devcontainer/", ".claude/", ".cursor/", ".zed/", ".cargo/", ".cargo/config.toml", ".yarnrc.yml", ".yarn/", ".mise.toml", ".direnv/", ".mvn/", ".bundle/config", ".pre-commit-config.yaml", ".lefthook.yml", "sub/.VSCODE/tasks.json"];
  const no = [".vscode/extensions.json", ".env", "src/a.ts", "cargo/config.toml", ".cargo/other.toml", "notes.txt"];
  it.each(yes)("tags %s", (p) => expect(runsCodeWhenOpened(p)).toBe(true));
  it.each(no)("does not tag %s", (p) => expect(runsCodeWhenOpened(p)).toBe(false));
});

describe("large classifier", () => {
  it.each(["node_modules/", "target/", "dist/", "build/", ".venv/", "venv/", "vendor/", ".gradle/", "Pods/", "a/node_modules/"])("named dir %s", (p) => expect(isLargeRow({ path: p })).toBe(true));
  it("size and count boundaries", () => {
    expect(isLargeRow({ path: "x/", bytes: 50 * MB - 1, fileCount: 4999 })).toBe(false);
    expect(isLargeRow({ path: "x/", bytes: 50 * MB })).toBe(true);
    expect(isLargeRow({ path: "x/", fileCount: 5000 })).toBe(true);
    expect(isLargeRow({ path: "x/", bytes: null, fileCount: null })).toBe(false);
  });
});

describe("path hygiene (FR-630), every platform", () => {
  const refused: [string, string][] = [
    ["", "empty"],
    ["a\0b", "nul"],
    ["a\x01b", "control-character"],
    ["a\nb", "control-character"],
    ["a\u202eb", "bidi"],
    ["a\u2066b", "bidi"],
    ["/etc/passwd", "absolute"],
    ["\\x", "absolute"],
    ["C:\\x", "absolute"],
    ["C:x", "drive-relative"],
    ["../x", "parent-segment"],
    ["a/../x", "parent-segment"],
    [".git/config", "git-directory"],
    ["a/.GIT/hooks", "git-directory"],
    ["a/.g\u200bit/x", "git-directory"],
    ["GIT~1/x", "git-directory"],
    ["con", "reserved-name"],
    ["nul.txt", "reserved-name"],
    ["a/AUX.tar.gz", "reserved-name"],
    ["COM\u00b9", "reserved-name"],
    ["lpt\u00b2.txt", "reserved-name"],
    ["COM3", "reserved-name"],
    ["CONIN$", "reserved-name"],
    ["conout$", "reserved-name"],
    ["PROGRA~1/x", "short-name"],
    ["a/ABCDEF~12.TXT", "short-name"],
    ["\\\\?\\C:\\x", "extended-prefix"],
    ["a.txt:stream", "alternate-stream"],
    [".git::$INDEX_ALLOCATION", "alternate-stream"],
    ["a./b", "trailing-dot-or-space"],
    ["a /b", "trailing-dot-or-space"],
    ["a//b", "empty-segment"],
    [`${"a/".repeat(130)}b`, "too-long"],
  ];
  it.each(refused)("refuses %j as %s", (p, reason) => {
    const r = validateCopyPath(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(reason);
  });
  it.each([".env", ".vscode/", "src/b.log", "config/local.json", "\u00fcber/\u65e5\u672c.txt", ".github/x", "a b/c", "my~file", "git/x", `${"x/".repeat(129)}x`])("accepts %j", (p) => {
    expect(validateCopyPath(p).ok).toBe(true);
  });
  it("refuses exactly 260 characters", () => expect(validateCopyPath(`${"x/".repeat(129)}xy`).ok).toBe(false));
});

describe("decideInitialTicks (FR-627)", () => {
  const rec = (...paths: string[]): CopyMemoryRecord => ({ v: 1, paths, at: 1 });
  it("memory first, including a remembered secret; include matches stay unticked", () => {
    const c = [row(".env"), row(".vscode/"), row("a.log")];
    const t = decideInitialTicks({ candidates: c, record: rec(".env", "gone.txt"), includeMatches: ["a.log", ".env"] });
    expect(t.ticked).toEqual([".env"]);
    expect(t.source).toBe("memory");
    expect(t.includeUnticked).toEqual(["a.log"]);
  });
  it("without a record: non-secret, non-run-code, in-budget matches", () => {
    const c = [row(".env"), row(".vscode/"), row("a.log"), row("b.log")];
    const t = decideInitialTicks({ candidates: c, record: null, includeMatches: [".env", ".vscode/", "a.log", "b.log"] });
    expect(t.ticked).toEqual(["a.log", "b.log"]);
    expect(t.source).toBe("worktreeinclude");
    expect(t.secretsInInclude).toEqual([".env"]);
  });
  it("a secret from .worktreeinclude is never ticked", () => {
    const t = decideInitialTicks({ candidates: [row(".env")], record: null, includeMatches: [".env"] });
    expect(t.ticked).toEqual([]);
    expect(t.source).toBe("none");
  });
  it("nothing without record or file", () => {
    expect(decideInitialTicks({ candidates: [row("a")], record: null, includeMatches: [] }).ticked).toEqual([]);
  });
  it("row budget 20 vs 21", () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => row(`f${i}.log`));
    expect(decideInitialTicks({ candidates: mk(20), record: null, includeMatches: mk(20).map((r) => r.path) }).ticked).toHaveLength(20);
    expect(decideInitialTicks({ candidates: mk(21), record: null, includeMatches: mk(21).map((r) => r.path) }).ticked).toHaveLength(0);
  });
  it("byte budget 20 MB vs 20 MB + 1, large and unknown size", () => {
    const at = (b: number | null) => decideInitialTicks({ candidates: [row("a.log", b)], record: null, includeMatches: ["a.log"] }).ticked.length;
    expect(at(20 * MB)).toBe(1);
    expect(at(20 * MB + 1)).toBe(0);
    expect(at(null)).toBe(0);
    expect(decideInitialTicks({ candidates: [row("node_modules/", 5)], record: null, includeMatches: ["node_modules/"] }).ticked).toEqual([]);
  });
  it("disabled rows are never ticked", () => {
    const c = [row("sub/", 1, { disabledReason: "nested-repository" })];
    expect(decideInitialTicks({ candidates: c, record: rec("sub/"), includeMatches: ["sub/"] }).ticked).toEqual([]);
  });
});

describe("decide (FR-629)", () => {
  const cands = [row("a"), row("b.log"), row(".env")];
  it("unchanged writes nothing; checkbox off writes nothing", () => {
    expect(decide(["a"], ["a"], true, cands, null)).toEqual({ action: "none" });
    expect(decide(["a"], ["b.log"], false, cands, null)).toEqual({ action: "none" });
  });
  it("empty final deletes an existing record only", () => {
    expect(decide(["a"], [], true, cands, { v: 1, paths: ["a"], at: 1 })).toEqual({ action: "delete" });
    expect(decide(["a"], [], true, cands, null)).toEqual({ action: "none" });
  });
  it("record {a,b} with candidate {a}: unticking a leaves {b}", () => {
    expect(decide(["a"], [], true, [row("a")], { v: 1, paths: ["a", "b"], at: 1 })).toEqual({ action: "write", paths: ["b"] });
  });
  it("writes the final set", () => {
    expect(decide([], ["a", "b.log"], true, cands, null)).toEqual({ action: "write", paths: ["a", "b.log"] });
  });
  it("secret only when ticked by hand or already in the user's own record", () => {
    // seeded from .worktreeinclude (in initial, not in record): dropped
    expect(decide([".env", "a"], [".env", "a", "b.log"], true, cands, null)).toEqual({ action: "write", paths: ["a", "b.log"] });
    // ticked by hand
    expect(decide(["a"], ["a", ".env"], true, cands, null)).toEqual({ action: "write", paths: ["a", ".env"] });
    // remembered secret stays
    expect(decide([".env"], [".env", "a"], true, cands, { v: 1, paths: [".env"], at: 1 })).toEqual({ action: "write", paths: [".env", "a"] });
  });
  it("caps at 200, dropping the 201st; invalid paths never written", () => {
    const many = Array.from({ length: 201 }, (_, i) => `f${i}`);
    const d = decide([], many, true, many.map((p) => row(p)), null);
    expect(d.action === "write" && d.paths.length).toBe(200);
    expect(d.action === "write" && d.paths.includes("f200")).toBe(false);
    expect(decide([], ["../x"], true, cands, null)).toEqual({ action: "none" });
  });
});

describe("records", () => {
  it("normalizeRecord drops corrupt, wrong-shape and over-cap records without throwing", () => {
    for (const bad of [null, undefined, 1, "x", [], {}, { v: 2, paths: ["a"], at: 1 }, { v: 1, paths: "a", at: 1 }, { v: 1, paths: ["a"], at: "1" }, { v: 1, paths: ["a"], at: NaN }, { v: 1, paths: Array.from({ length: 201 }, (_, i) => `f${i}`), at: 1 }, { v: 1, paths: ["../x", "/abs", ".git/x", "a\0b", 4], at: 1 }]) {
      expect(normalizeRecord(bad)).toBeNull();
    }
    expect(normalizeRecord({ v: 1, paths: ["a", "../x", ".git/c", "a", "ok/"], at: 5 })).toEqual({ v: 1, paths: ["a", "ok/"], at: 5 });
    expect(normalizeRecord({ v: 1, paths: Array.from({ length: 200 }, (_, i) => `f${i}`), at: 1 })?.paths).toHaveLength(200);
  });
  it("evictRecords removes the oldest, ties by order", () => {
    const e = Array.from({ length: 201 }, (_, i) => ({ key: `k${i}`, at: 100 + i }));
    expect(evictRecords(e)).toEqual(["k0"]);
    expect(evictRecords([{ key: "x", at: 1 }, { key: "y", at: 1 }], 1)).toEqual(["x"]);
    expect(evictRecords(e.slice(0, 200))).toEqual([]);
    expect(nextRecordAt(5, 5)).toBe(6);
    expect(nextRecordAt(9, 5)).toBe(9);
  });
});

describe("copyLineText (FR-628), byte-exact", () => {
  it("formats sizes", () => {
    expect(formatCopySize(0)).toBe("0 B");
    expect(formatCopySize(1023)).toBe("1023 B");
    expect(formatCopySize(1024)).toBe("1 KB");
    expect(formatCopySize(4096)).toBe("4 KB");
    expect(formatCopySize(1536)).toBe("2 KB");
    expect(formatCopySize(3 * MB)).toBe("3 MB");
    expect(formatCopySize(MB - 1)).toBe("1 MB");
  });
  it("the 8 states", () => {
    expect(copyLineText({ kind: "checking" })).toEqual({ text: "Checking for ignored files..." });
    expect(copyLineText({ kind: "none-ticked" })).toEqual({ text: "No ignored files will be copied.", action: "Choose files" });
    expect(copyLineText({ kind: "from-memory", count: 3, bytes: 4096, names: [".env", ".vscode/", "config/local.json"] })).toEqual({
      text: "Copy 3 files \u00b7 4 KB",
      note: "remembered for this repo",
      detail: ".env, .vscode/, config/local.json",
    });
    expect(copyLineText({ kind: "from-memory", count: 1, bytes: 10, names: ["a", "b", "c", "d", "e"] })).toMatchObject({ text: "Copy 1 file \u00b7 10 B", detail: "a, b, c and 2 more" });
    expect(copyLineText({ kind: "from-include", count: 2, bytes: 3072 }).text).toBe("Copy 2 files \u00b7 3 KB from .worktreeinclude");
    expect(copyLineText({ kind: "secret-ticked", names: [".env"] }).text).toBe("1 secret file: .env");
    expect(copyLineText({ kind: "secret-ticked", names: [".env", ".npmrc"] }).text).toBe("2 secret files: .env, .npmrc");
    expect(copyLineText({ kind: "include-secrets-unticked", names: [".env"] }).text).toBe(".env is listed in .worktreeinclude but looks like a secret, so it is not ticked.");
    expect(copyLineText({ kind: "include-secrets-unticked", names: [".env", ".npmrc"] }).text).toBe("2 files listed in .worktreeinclude look like secrets, so they are not ticked: .env, .npmrc.");
    expect(copyLineText({ kind: "skipped-this-time", count: 3 })).toEqual({ text: "Copy 3 files", note: "skipped this time" });
    expect(copyLineText({ kind: "failed" })).toMatchObject({ text: "Couldn't list ignored files. The worktree will be created without copying.", action: "Try again" });
  });
  it("skip message wording", () => expect(COPY_SKIP_MESSAGES["changed-since-review"]).toBe("changed since you reviewed"));
});
