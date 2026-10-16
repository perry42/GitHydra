// SPDX-License-Identifier: GPL-3.0-or-later
import type { CopyManifest } from "@githydra/git-core";

/**
 * specs/worktree-copy-ignored.md FR-643: the manifest never leaves the main process; the renderer holds only this opaque token.
 * One manifest at a time (a new listing replaces the old one), single-use, expiring, and bound to the repository, the source
 * worktree, and, once a create starts, to the validated destination and the sorted selected row ids.
 */
export const COPY_TOKEN_TTL_MS = 10 * 60 * 1000;

export type CopyTokenRefusal = "unknown" | "expired" | "other-repository" | "other-source" | "destination-changed" | "selection-changed" | "not-bound";

export interface CopyTokenContext {
  repoKey: string;
  /** The session repo's path the dialog was opened from (the source worktree), as the session spells it. */
  sourceRoot: string;
}

export type CopyTokenUse = { ok: true; manifest: CopyManifest } | { ok: false; reason: CopyTokenRefusal };

interface Held {
  token: string;
  manifest: CopyManifest;
  repoKey: string;
  issuedAt: number;
  sourceRoot: string;
  bound: { destination: string; ids: string } | null;
}

export interface CopyTokenStore {
  issue(manifest: CopyManifest, repoKey: string, sourceRoot: string): string;
  /** A create starts: fix destination and selection. A different second binding invalidates the token. */
  bind(token: string, ctx: CopyTokenContext, destination: string, rowIds: readonly string[]): CopyTokenUse;
  /** The add failed: the token stays valid for another attempt, but the binding is dropped. */
  unbind(token: string): void;
  /** After a successful add: single use. Succeeds only for exactly the bound destination and selection. */
  consume(token: string, ctx: CopyTokenContext, destination: string, rowIds: readonly string[]): CopyTokenUse;
  release(): void;
  /** Test seam. */
  hasToken(): boolean;
}

const idsKey = (ids: readonly string[]): string => JSON.stringify([...new Set(ids)].sort());

export function createCopyTokenStore(opts: { now?: () => number; ttlMs?: number; platform?: string } = {}): CopyTokenStore {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? COPY_TOKEN_TTL_MS;
  const win = (opts.platform ?? process.platform) === "win32";
  const fold = (p: string): string => (win ? p.replace(/\\/g, "/").toLowerCase() : p);
  let held: Held | null = null;

  function check(token: string, ctx: CopyTokenContext): { ok: true; h: Held } | { ok: false; reason: CopyTokenRefusal } {
    const h = held;
    if (!h || typeof token !== "string" || h.token !== token) return { ok: false, reason: "unknown" };
    if (now() - h.issuedAt > ttl) {
      held = null;
      return { ok: false, reason: "expired" };
    }
    if (h.repoKey !== ctx.repoKey) return { ok: false, reason: "other-repository" };
    if (fold(h.sourceRoot) !== fold(ctx.sourceRoot)) return { ok: false, reason: "other-source" };
    return { ok: true, h };
  }

  return {
    issue(manifest, repoKey, sourceRoot) {
      held = { token: manifest.token, manifest, repoKey, sourceRoot, issuedAt: now(), bound: null };
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
  };
}
