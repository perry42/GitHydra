// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * specs/worktrees.md FR-644: the per-repository "Remember my choice" record for the post-checkout hook. It lives in a
 * main-process file under userData, never in renderer storage (a compromised renderer must not be able to mark a repo trusted).
 * A choice is bound to the hook fingerprint git-core computed: any change to the hook set makes the stored choice not apply.
 * There is deliberately no global switch and no API to store a choice without a repo key and a fingerprint.
 */
export type HookChoice = "run" | "skip";

export interface HookTrustRecord {
  choice: HookChoice;
  /** `PostCheckoutHookInfo.fingerprint` at the time of the choice. */
  fingerprint: string;
  at: number;
}

export const MAX_TRUST_REPOS = 200;
const FILE_NAME = "worktree-hook-trust.json";
const MAX_FILE_BYTES = 256 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;

export const isRepoKey = (v: unknown): v is string => typeof v === "string" && HEX64.test(v);

/** Anything malformed is dropped entry by entry; a damaged file never blocks the app and never widens what is trusted. */
export function validateTrust(raw: unknown): Map<string, HookTrustRecord> {
  const out = new Map<string, HookTrustRecord>();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const repos = (raw as Record<string, unknown>).repos;
  if (typeof repos !== "object" || repos === null || Array.isArray(repos)) return out;
  const good: [string, HookTrustRecord][] = [];
  for (const [key, value] of Object.entries(repos as Record<string, unknown>)) {
    if (!isRepoKey(key) || typeof value !== "object" || value === null) continue;
    const v = value as Record<string, unknown>;
    if (v.choice !== "run" && v.choice !== "skip") continue;
    if (!isRepoKey(v.fingerprint)) continue;
    if (typeof v.at !== "number" || !Number.isFinite(v.at) || v.at < 0) continue;
    good.push([key, { choice: v.choice, fingerprint: v.fingerprint, at: v.at }]);
  }
  // Over the cap the oldest choices go first.
  good.sort((a, b) => b[1].at - a[1].at);
  for (const [k, r] of good.slice(0, MAX_TRUST_REPOS)) out.set(k, r);
  return out;
}

export interface HookTrustStore {
  /** The stored choice for `repoKey` only if it was made for exactly this fingerprint. */
  get(repoKey: string, currentFingerprint: string): Promise<HookChoice | null>;
  set(repoKey: string, record: HookTrustRecord): Promise<void>;
  /** Deletes the record when it was made for a DIFFERENT fingerprint, so an old choice cannot return when the hook reverts. */
  dropStale(repoKey: string, currentFingerprint: string): Promise<void>;
}

export function createFileHookTrustStore(dir: string): HookTrustStore {
  const file = path.join(dir, FILE_NAME);
  // Serialised: a read-modify-write must not interleave with another one.
  let queue: Promise<unknown> = Promise.resolve();

  async function read(): Promise<Map<string, HookTrustRecord>> {
    try {
      const st = await fs.stat(file);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) return new Map();
      return validateTrust(JSON.parse(await fs.readFile(file, "utf8")));
    } catch {
      return new Map();
    }
  }

  async function write(all: Map<string, HookTrustRecord>): Promise<void> {
    const kept = [...all.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_TRUST_REPOS);
    const repos: Record<string, HookTrustRecord> = {};
    for (const [k, r] of kept) repos[k] = r;
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ version: 1, repos }, null, 2), "utf8");
    await fs.rename(tmp, file);
  }

  return {
    async get(repoKey, currentFingerprint) {
      if (!isRepoKey(repoKey) || !isRepoKey(currentFingerprint)) return null;
      const rec = (await read()).get(repoKey);
      return rec && rec.fingerprint === currentFingerprint ? rec.choice : null;
    },
    dropStale(repoKey, currentFingerprint) {
      const next = queue.then(async () => {
        if (!isRepoKey(repoKey)) return;
        const all = await read();
        const rec = all.get(repoKey);
        if (!rec || rec.fingerprint === currentFingerprint) return;
        all.delete(repoKey);
        await write(all);
      });
      queue = next.catch(() => undefined);
      return next;
    },
    set(repoKey, record) {
      const next = queue.then(async () => {
        if (!isRepoKey(repoKey)) throw new Error("invalid repo key");
        const all = await read();
        const clean = validateTrust({ repos: { [repoKey]: record } }).get(repoKey);
        if (!clean) throw new Error("invalid trust record");
        all.set(repoKey, clean);
        await write(all);
      });
      queue = next.catch(() => undefined);
      return next;
    },
  };
}
