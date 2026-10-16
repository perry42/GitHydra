// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileHookTrustStore, MAX_TRUST_REPOS, validateTrust } from "./worktreeHookTrust";

const hex = (n: number): string => n.toString(16).padStart(64, "0");
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-hook-trust-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("hook trust record (specs/worktrees.md FR-644)", () => {
  it("applies a remembered choice only while the current fingerprint equals the stored one", async () => {
    const store = createFileHookTrustStore(dir);
    await store.set(hex(1), { choice: "run", fingerprint: hex(10), at: 1 });
    expect(await store.get(hex(1), hex(10))).toBe("run");
    expect(await store.get(hex(1), hex(11))).toBeNull();
    expect(await store.get(hex(2), hex(10))).toBeNull();
  });

  it("can remember 'skip' too, and a later choice replaces the earlier one", async () => {
    const store = createFileHookTrustStore(dir);
    await store.set(hex(1), { choice: "skip", fingerprint: hex(10), at: 1 });
    expect(await store.get(hex(1), hex(10))).toBe("skip");
    await store.set(hex(1), { choice: "run", fingerprint: hex(12), at: 2 });
    expect(await store.get(hex(1), hex(10))).toBeNull();
    expect(await store.get(hex(1), hex(12))).toBe("run");
  });

  it("drops every malformed entry on read instead of trusting it", () => {
    const m = validateTrust({
      repos: {
        [hex(1)]: { choice: "run", fingerprint: hex(9), at: 5 },
        [hex(2)]: { choice: "trusted", fingerprint: hex(9), at: 5 },
        [hex(3)]: { choice: "run", fingerprint: "nope", at: 5 },
        [hex(4)]: { choice: "run", fingerprint: hex(9), at: "x" },
        notAKey: { choice: "run", fingerprint: hex(9), at: 5 },
        [hex(5)]: null,
      },
    });
    expect([...m.keys()]).toEqual([hex(1)]);
    expect(validateTrust(null).size).toBe(0);
    expect(validateTrust({ repos: [1] }).size).toBe(0);
    expect(validateTrust("x").size).toBe(0);
  });

  it("treats a corrupt or oversized file as empty", async () => {
    const store = createFileHookTrustStore(dir);
    await fs.writeFile(path.join(dir, "worktree-hook-trust.json"), "{not json", "utf8");
    expect(await store.get(hex(1), hex(10))).toBeNull();
    await fs.writeFile(path.join(dir, "worktree-hook-trust.json"), " ".repeat(300 * 1024), "utf8");
    expect(await store.get(hex(1), hex(10))).toBeNull();
  });

  it("caps at 200 repositories, evicting the oldest", async () => {
    const repos: Record<string, unknown> = {};
    for (let i = 1; i <= MAX_TRUST_REPOS + 5; i++) repos[hex(i)] = { choice: "run", fingerprint: hex(9), at: i };
    const m = validateTrust({ repos });
    expect(m.size).toBe(MAX_TRUST_REPOS);
    expect(m.has(hex(1))).toBe(false);
    expect(m.has(hex(MAX_TRUST_REPOS + 5))).toBe(true);

    const store = createFileHookTrustStore(dir);
    await fs.writeFile(path.join(dir, "worktree-hook-trust.json"), JSON.stringify({ version: 1, repos }), "utf8");
    await store.set(hex(999), { choice: "skip", fingerprint: hex(9), at: 1_000_000 });
    const written = JSON.parse(await fs.readFile(path.join(dir, "worktree-hook-trust.json"), "utf8")) as { repos: Record<string, unknown> };
    expect(Object.keys(written.repos)).toHaveLength(MAX_TRUST_REPOS);
    expect(written.repos[hex(999)]).toBeDefined();
  });

  it("dropStale removes only a record made for another fingerprint", async () => {
    const store = createFileHookTrustStore(dir);
    await store.set(hex(1), { choice: "run", fingerprint: hex(10), at: 1 });
    await store.dropStale(hex(1), hex(10));
    expect(await store.get(hex(1), hex(10))).toBe("run");
    await store.dropStale(hex(1), hex(11));
    expect(await store.get(hex(1), hex(10))).toBeNull();
    await store.dropStale(hex(2), hex(11));
  });

  it("refuses to store a record that is not a valid run/skip choice or has a bad key (no 'trusted' value)", async () => {
    const store = createFileHookTrustStore(dir);
    await expect(store.set(hex(1), { choice: "trusted" as never, fingerprint: hex(9), at: 1 })).rejects.toThrow();
    await expect(store.set("../../x", { choice: "run", fingerprint: hex(9), at: 1 })).rejects.toThrow();
    await expect(store.set(hex(1), { choice: "run", fingerprint: "short", at: 1 })).rejects.toThrow();
    expect(await store.get(hex(1), hex(9))).toBeNull();
  });

  it("writes atomically (no temp file left) and has no global 'never ask again' field", async () => {
    const store = createFileHookTrustStore(dir);
    await Promise.all([1, 2, 3].map((i) => store.set(hex(i), { choice: "run", fingerprint: hex(9), at: i })));
    expect((await fs.readdir(dir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    const text = await fs.readFile(path.join(dir, "worktree-hook-trust.json"), "utf8");
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual(["repos", "version"]);
    expect(text).not.toMatch(/never|always|global/i);
    expect(await store.get(hex(2), hex(9))).toBe("run");
  });
});
