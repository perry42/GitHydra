// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import { createRequire } from "node:module";
import * as ts from "typescript";

/**
 * The sandboxed renderer value-imports from "@githydra/git-core", so the whole package is evaluated there at load time,
 * where Node globals (`Buffer`, `process`) do not exist. A top-level use shipped once (ignore.ts) and blanked the window.
 */
const SRC = path.resolve(__dirname, "..", "src");
const NODE_GLOBALS = new Set(["Buffer", "process", "global", "__dirname", "__filename"]);

function topLevelGlobalUses(file: string): string[] {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);
  const hits: string[] = [];
  const visit = (n: ts.Node): void => {
    // Anything deferred (function bodies, class members, types) is not evaluated at module load.
    if (ts.isFunctionLike(n) || ts.isClassLike(n) || ts.isTypeNode(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) return;
    if (ts.isIdentifier(n) && NODE_GLOBALS.has(n.text)) {
      const parent = n.parent;
      const isPropName = ts.isPropertyAccessExpression(parent) && parent.name === n;
      if (!isPropName) hits.push(`${path.basename(file)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${n.text}`);
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(sf, visit);
  return hits;
}

describe("renderer-reachable load safety", () => {
  it("no source file touches a Node global while the module is being evaluated (static)", () => {
    const files = fs.readdirSync(SRC).filter((f) => f.endsWith(".ts")).map((f) => path.join(SRC, f));
    expect(files.length).toBeGreaterThan(30);
    expect(files.flatMap(topLevelGlobalUses)).toEqual([]);
  });

  it("src/index.ts evaluates in a context with no Buffer and no process (runtime)", () => {
    const hostRequire = createRequire(path.join(SRC, "index.ts"));
    const cache = new Map<string, { exports: unknown }>();
    const context = vm.createContext({ TextDecoder, TextEncoder, URL, AbortController, setTimeout, clearTimeout, queueMicrotask });
    expect(vm.runInContext("typeof Buffer + typeof process", context)).toBe("undefinedundefined");

    const load = (file: string): unknown => {
      const hit = cache.get(file);
      if (hit) return hit.exports;
      const mod = { exports: {} as unknown };
      cache.set(file, mod);
      const js = ts.transpileModule(fs.readFileSync(file, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: false },
      }).outputText;
      const req = (spec: string): unknown => {
        if (!spec.startsWith(".")) return hostRequire(spec);
        const base = path.resolve(path.dirname(file), spec);
        return load(fs.existsSync(base + ".ts") ? base + ".ts" : path.join(base, "index.ts"));
      };
      const fn = vm.runInContext(`(function (exports, require, module) {${js}\n})`, context, { filename: file }) as (...a: unknown[]) => void;
      fn(mod.exports, req, mod);
      return mod.exports;
    };

    const api = load(path.join(SRC, "index.ts")) as Record<string, unknown>;
    expect(typeof api.Repository).toBe("function");
    expect(typeof api.StaleBatchError).toBe("function");
  });
});
