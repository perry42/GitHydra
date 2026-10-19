// SPDX-License-Identifier: GPL-3.0-or-later
import * as path from "node:path";
import { constants as C } from "node:fs";
import type { CopyFs, FsHandle, FsStat } from "../src/worktreeCopyFs";

/** In-memory CopyFs for the copy-engine tests (specs/worktree-copy-ignored.md AC 8): lets a test fake links, swaps and clocks. */

type Node = { type: "file"; data: Buffer; mode: number; ino: bigint; mtimeNs: bigint } | { type: "dir"; ino: bigint } | { type: "link"; target: string; ino: bigint };

export interface OpenRecord {
  path: string;
  flags: number;
  mode?: number;
}

export class MemFs implements CopyFs {
  nodes = new Map<string, Node>();
  opens: OpenRecord[] = [];
  /** Every byte written, by path. */
  written = new Map<string, number>();
  unlinked: string[] = [];
  /** Hooks a test can use to change the world at a precise moment. */
  onRead?: (p: string, count: number) => void;
  onOpen?: (p: string, flags: number) => void;
  realpathOverride?: (p: string) => string | undefined;
  failWrite?: Error;
  /** Make lstat of a path report ENOENT (a file created somewhere else). */
  lstatMissing?: (p: string) => boolean;
  rmdirs: string[] = [];
  /** Report every inode as 0 (a platform without file ids). */
  zeroIno = false;
  /** Runs when a handle is closed (a test swaps the file here). */
  onClose?: (p: string) => void;
  private nextIno = 1n;
  private reads = 0;

  constructor(private readonly caseInsensitive = false) {}

  private key(p: string): string {
    const r = path.resolve(p);
    return this.caseInsensitive ? r.toLowerCase() : r;
  }
  private ino(): bigint {
    return this.nextIno++;
  }

  mkdirp(p: string): void {
    let cur = path.parse(path.resolve(p)).root;
    for (const part of path.resolve(p).slice(cur.length).split(path.sep).filter(Boolean)) {
      cur = path.join(cur, part);
      if (!this.nodes.has(this.key(cur))) this.nodes.set(this.key(cur), { type: "dir", ino: this.ino() });
    }
  }
  addFile(p: string, data: string | Buffer, mode = 0o644, mtimeNs = 1000n): void {
    this.mkdirp(path.dirname(p));
    this.nodes.set(this.key(p), { type: "file", data: Buffer.from(data), mode, ino: this.ino(), mtimeNs });
  }
  addLink(p: string, target: string): void {
    this.mkdirp(path.dirname(p));
    this.nodes.set(this.key(p), { type: "link", target, ino: this.ino() });
  }
  read(p: string): Buffer | undefined {
    const n = this.nodes.get(this.key(p));
    return n?.type === "file" ? n.data : undefined;
  }
  exists(p: string): boolean {
    return this.nodes.has(this.key(p));
  }

  private stat(n: Node): FsStat {
    const size = n.type === "file" ? BigInt(n.data.length) : 0n;
    return {
      dev: 1n,
      ino: this.zeroIno ? 0n : n.ino,
      size,
      mtimeNs: n.type === "file" ? n.mtimeNs : 0n,
      mode: BigInt(n.type === "file" ? 0o100000 | n.mode : n.type === "dir" ? 0o040755 : 0o120777),
      isFile: () => n.type === "file",
      isDirectory: () => n.type === "dir",
      isSymbolicLink: () => n.type === "link",
    };
  }
  private enoent(): Error {
    return Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }

  async lstat(p: string): Promise<FsStat> {
    if (this.lstatMissing?.(p)) throw this.enoent();
    const n = this.nodes.get(this.key(p));
    if (!n) throw this.enoent();
    return this.stat(n);
  }

  private resolve(p: string): string {
    let parts = path.resolve(p).split(path.sep);
    let cur = parts.shift()! + path.sep;
    let hops = 0;
    while (parts.length) {
      cur = path.join(cur, parts.shift()!);
      const n = this.nodes.get(this.key(cur));
      if (n?.type === "link") {
        if (++hops > 20) throw Object.assign(new Error("ELOOP"), { code: "ELOOP" });
        parts = path.resolve(path.dirname(cur), n.target).split(path.sep).slice(1).concat(parts);
        cur = path.parse(cur).root;
      }
    }
    return cur;
  }

  async realpath(p: string): Promise<string> {
    const o = this.realpathOverride?.(p);
    if (o !== undefined) return o;
    const r = this.resolve(p);
    if (!this.nodes.has(this.key(r))) throw this.enoent();
    return r;
  }

  async mkdir(p: string): Promise<void> {
    if (this.nodes.has(this.key(p))) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    if (!this.nodes.has(this.key(path.dirname(p)))) throw this.enoent();
    this.nodes.set(this.key(p), { type: "dir", ino: this.ino() });
  }

  async rmdir(p: string): Promise<void> {
    const prefix = this.key(p) + path.sep;
    if ([...this.nodes.keys()].some((k) => k.startsWith(prefix))) throw Object.assign(new Error("ENOTEMPTY"), { code: "ENOTEMPTY" });
    this.nodes.delete(this.key(p));
    this.rmdirs.push(p);
  }

  async unlink(p: string): Promise<void> {
    if (!this.nodes.delete(this.key(p))) throw this.enoent();
    this.unlinked.push(p);
  }

  async open(p: string, flags: number, mode?: number): Promise<FsHandle> {
    this.opens.push({ path: p, flags, mode });
    this.onOpen?.(p, flags);
    const creating = (flags & C.O_CREAT) !== 0;
    let node = this.nodes.get(this.key(p));
    if (creating) {
      if (node && (flags & C.O_EXCL) !== 0) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
      if (!node) {
        node = { type: "file", data: Buffer.alloc(0), mode: (mode ?? 0o644) & 0o777, ino: this.ino(), mtimeNs: 5000n };
        this.nodes.set(this.key(p), node);
      }
    } else {
      if (!node) throw this.enoent();
      if (node.type === "link") {
        // A real no-follow open fails on a link; without the flag it would follow it.
        if ((C.O_NOFOLLOW ?? 0) !== 0) throw Object.assign(new Error("ELOOP"), { code: "ELOOP" });
        const t = this.nodes.get(this.key(this.resolve(p)));
        if (!t) throw this.enoent();
        node = t;
      }
    }
    const n = node as Node;
    let pos = 0;
    const self = this;
    return {
      stat: async () => self.stat(n),
      read: async (buf, off, len) => {
        self.reads++;
        self.onRead?.(p, self.reads);
        if (n.type !== "file") return { bytesRead: 0 };
        const slice = n.data.subarray(pos, pos + len);
        slice.copy(buf, off);
        pos += slice.length;
        return { bytesRead: slice.length };
      },
      write: async (buf, off, len) => {
        if (self.failWrite) throw self.failWrite;
        if (n.type !== "file") throw new Error("EISDIR");
        n.data = Buffer.concat([n.data, buf.subarray(off, off + len)]);
        self.written.set(p, (self.written.get(p) ?? 0) + len);
        return { bytesWritten: len };
      },
      close: async () => self.onClose?.(p),
    };
  }
}
