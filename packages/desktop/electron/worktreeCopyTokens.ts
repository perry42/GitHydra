// SPDX-License-Identifier: GPL-3.0-or-later
import type { CopyManifest } from "@githydra/git-core";

/**
 * specs/worktree-copy-ignored.md FR-643 and FR-653: the manifest never leaves the main process; the renderer holds only this
 * opaque token. Two PURPOSES, each in its own slot ("create" for the Create dialog, "copy-into-existing" for section G), so a
 * listing or release of one can never kill the other's token. Each slot holds one manifest at a time (a new listing replaces
 * the old one), single-use, expiring, and bound to the repository and the source worktree, plus the selected row ids
 * (and, for section G, the destination the listing validated).
 */
export const COPY_TOKEN_TTL_MS = 10 * 60 * 1000;

export type CopyTokenRefusal =
  | "unknown"
  | "purpose-mismatch"
  | "expired"
  | "other-repository"
  | "other-source"
  | "destination-changed"
  | "selection-changed"
  | "not-bound";

export interface CopyTokenContext {
  repoKey: string;
  /** The session repo's path the dialog was opened from (the source worktree), as the session spells it. */
  sourceRoot: string;
}

export type CopyTokenUse = { ok: true; manifest: CopyManifest } | { ok: false; reason: CopyTokenRefusal };

/** FR-653 (M8): the purpose literal is the first thing every check looks at. */
interface Held {
  purpose: "create";
  token: string;
  manifest: CopyManifest;
  repoKey: string;
  issuedAt: number;
  sourceRoot: string;
  bound: { destination: string; ids: string } | null;
}

interface HeldExisting {
  purpose: "copy-into-existing";
  token: string;
  manifest: CopyManifest;
  repoKey: string;
  sourceRoot: string;
  destId: string | null;
  destRoot: string;
  issuedAt: number;
  /** The sorted selected row ids, fixed by the first redeem attempt. */
  boundIds: string | null;
}

export type ExistingTokenUse =
  | { ok: true; manifest: CopyManifest; destId: string | null; destRoot: string }
  | { ok: false; reason: CopyTokenRefusal };

export interface CopyTokenStore {
  issue(manifest: CopyManifest, repoKey: string, sourceRoot: string): string;
  /** A create starts: fix destination and selection. A different second binding invalidates the token. */
  bind(token: string, ctx: CopyTokenContext, destination: string, rowIds: readonly string[]): CopyTokenUse;
  /** The add failed: the token stays valid for another attempt, but the binding is dropped. */
  unbind(token: string): void;
  /** After a successful add: single use. Succeeds only for exactly the bound destination and selection. */
  consume(token: string, ctx: CopyTokenContext, destination: string, rowIds: readonly string[]): CopyTokenUse;
  /** Releases the CREATE slot only. */
  release(): void;
  /** Test seam. */
  hasToken(): boolean;

  /** Section G: the destination id and realpath are what the listing validated. Replaces any earlier token of this purpose. */
  issueExisting(manifest: CopyManifest, repoKey: string, sourceRoot: string, dest: { id: string | null; root: string }): string;
  /** Cheap structural checks plus the selection binding. Does NOT consume, so a refusal that follows (busy) keeps the token. */
  checkExisting(token: string, ctx: CopyTokenContext, rowIds: readonly string[]): ExistingTokenUse;
  /** Single use: burns the token only after every binding, including the freshly re-resolved destination, matches. */
  consumeExisting(token: string, ctx: CopyTokenContext, rowIds: readonly string[], fresh: { destId: string | null; destRoot: string }): ExistingTokenUse;
  /** Releases the section G slot only. */
  releaseExisting(): void;
  hasExistingToken(): boolean;
}

const idsKey = (ids: readonly string[]): string => JSON.stringify([...new Set(ids)].sort());

export function createCopyTokenStore(opts: { now?: () => number; ttlMs?: number; platform?: string } = {}): CopyTokenStore {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? COPY_TOKEN_TTL_MS;
  const win = (opts.platform ?? process.platform) === "win32";
  const fold = (p: string): string => (win ? p.replace(/\\/g, "/").toLowerCase() : p);
  let held: Held | null = null;
  let heldExisting: HeldExisting | null = null;

  function check(token: string, ctx: CopyTokenContext): { ok: true; h: Held } | { ok: false; reason: CopyTokenRefusal } {
    // M8: a token minted by the other purpose is named as such, never confused with an unknown one, and never touched.
    if (heldExisting && typeof token === "string" && heldExisting.token === token) return { ok: false, reason: "purpose-mismatch" };
    const h = held;
    if (!h || h.purpose !== "create" || typeof token !== "string" || h.token !== token) return { ok: false, reason: "unknown" };
    if (now() - h.issuedAt > ttl) {
      held = null;
      return { ok: false, reason: "expired" };
    }
    if (h.repoKey !== ctx.repoKey) return { ok: false, reason: "other-repository" };
    if (fold(h.sourceRoot) !== fold(ctx.sourceRoot)) return { ok: false, reason: "other-source" };
    return { ok: true, h };
  }

  function checkExisting(token: string, ctx: CopyTokenContext): { ok: true; h: HeldExisting } | { ok: false; reason: CopyTokenRefusal } {
    if (held && typeof token === "string" && held.token === token) return { ok: false, reason: "purpose-mismatch" };
    const h = heldExisting;
    if (!h || h.purpose !== "copy-into-existing" || typeof token !== "string" || h.token !== token) return { ok: false, reason: "unknown" };
    if (now() - h.issuedAt > ttl) {
      heldExisting = null;
      return { ok: false, reason: "expired" };
    }
    if (h.repoKey !== ctx.repoKey) return { ok: false, reason: "other-repository" };
    if (fold(h.sourceRoot) !== fold(ctx.sourceRoot)) return { ok: false, reason: "other-source" };
    return { ok: true, h };
  }

  return {
    issue(manifest, repoKey, sourceRoot) {
      held = { purpose: "create", token: manifest.token, manifest, repoKey, sourceRoot, issuedAt: now(), bound: null };
      return manifest.token;
    },
    bind(token, ctx, destination, rowIds) {
      const c = check(token, ctx);
      if (!c.ok) return c;
      const next = { destination: fold(destination), ids: idsKey(rowIds) };
      if (c.h.bound && (c.h.bound.destination !== next.destination || c.h.bound.ids !== next.ids)) {
        held = null;
        return { ok: false, reason: c.h.bound.ids !== next.ids ? "selection-changed" : "destination-changed" };
      }
      c.h.bound = next;
      return { ok: true, manifest: c.h.manifest };
    },
    unbind(token) {
      if (held && held.token === token) held.bound = null;
    },
    consume(token, ctx, destination, rowIds) {
      const c = check(token, ctx);
      if (!c.ok) return c;
      if (!c.h.bound) return { ok: false, reason: "not-bound" };
      if (c.h.bound.destination !== fold(destination)) {
        held = null;
        return { ok: false, reason: "destination-changed" };
      }
      if (c.h.bound.ids !== idsKey(rowIds)) {
        held = null;
        return { ok: false, reason: "selection-changed" };
      }
      held = null;
      return { ok: true, manifest: c.h.manifest };
    },
    release() {
      held = null;
    },
    hasToken: () => held !== null,

    issueExisting(manifest, repoKey, sourceRoot, dest) {
      heldExisting = { purpose: "copy-into-existing", token: manifest.token, manifest, repoKey, sourceRoot, destId: dest.id, destRoot: dest.root, issuedAt: now(), boundIds: null };
      return manifest.token;
    },
    checkExisting(token, ctx, rowIds) {
      const c = checkExisting(token, ctx);
      if (!c.ok) return c;
      const ids = idsKey(rowIds);
      if (c.h.boundIds !== null && c.h.boundIds !== ids) {
        heldExisting = null;
        return { ok: false, reason: "selection-changed" };
      }
      c.h.boundIds = ids;
      return { ok: true, manifest: c.h.manifest, destId: c.h.destId, destRoot: c.h.destRoot };
    },
    consumeExisting(token, ctx, rowIds, fresh) {
      const c = checkExisting(token, ctx);
      if (!c.ok) return c;
      if (c.h.destId !== fresh.destId || fold(c.h.destRoot) !== fold(fresh.destRoot)) {
        heldExisting = null;
        return { ok: false, reason: "destination-changed" };
      }
      if (c.h.boundIds !== null && c.h.boundIds !== idsKey(rowIds)) {
        heldExisting = null;
        return { ok: false, reason: "selection-changed" };
      }
      heldExisting = null;
      return { ok: true, manifest: c.h.manifest, destId: c.h.destId, destRoot: c.h.destRoot };
    },
    releaseExisting() {
      heldExisting = null;
    },
    hasExistingToken: () => heldExisting !== null,
  };
}

/**
 * FR-653 (M8): ONE main-process mutex per repository, shared by Create's post-add copy, the copy into an existing worktree,
 * worktree remove, prune and move for that repository. Copies take it without waiting (a second one gets `busy`); remove, prune
 * and move wait their turn so a worktree is never deleted under a running copy.
 */
export interface RepoMutex {
  /** Null when the repository is busy. Call the returned function exactly once to release. */
  tryAcquire(key: string): (() => void) | null;
  /** Waits for earlier holders (FIFO), then runs `fn` alone. */
  run<T>(key: string, fn: () => Promise<T>): Promise<T>;
  isBusy(key: string): boolean;
}

export function createRepoMutex(): RepoMutex {
  const holders = new Set<string>();
  const queues = new Map<string, (() => void)[]>();
  // Hands the mutex to the next waiter without ever leaving it free in between, so tryAcquire cannot slip in.
  const release = (key: string): void => {
    const next = queues.get(key)?.shift();
    if (next) next();
    else {
      holders.delete(key);
      queues.delete(key);
    }
  };
  return {
    tryAcquire(key) {
      if (holders.has(key)) return null;
      holders.add(key);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        release(key);
      };
    },
    run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const start = (): void => {
          Promise.resolve().then(fn).then(resolve, reject).finally(() => release(key));
        };
        if (!holders.has(key)) {
          holders.add(key);
          start();
        } else {
          const q = queues.get(key);
          if (q) q.push(start);
          else queues.set(key, [start]);
        }
      });
    },
    isBusy: (key) => holders.has(key),
  };
}
