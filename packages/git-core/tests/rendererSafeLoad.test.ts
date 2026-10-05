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

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return e.name.endsWith(".ts") && !e.name.endsWith(".d.ts") ? [full] : [];
  });
}

const unwrapParens = (e: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(e) ? unwrapParens(e.expression) : e);

export function topLevelGlobalUses(file: string, text = fs.readFileSync(file, "utf8")): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const hits: string[] = [];
  const visit = (n: ts.Node): void => {
    // Class static blocks run at class definition, so they are module-load code unlike other function bodies.
    if (ts.isClassStaticBlockDeclaration(n)) return void ts.forEachChild(n, visit);
    // An immediately-invoked function runs at load; every other function body is deferred.
    if (ts.isCallExpression(n)) {
      const callee = unwrapParens(n.expression);
      if (ts.isFunctionExpression(callee) || ts.isArrowFunction(callee)) {
        callee.parameters.forEach(visit);
        ts.forEachChild(callee.body, visit);
        n.arguments.forEach(visit);
        return;
      }
    }
    if (ts.isClassLike(n)) {
      // Evaluated at definition: heritage, decorators, computed names, static fields/blocks. Instance members are deferred.
      // `extends X` parses as a type-ish node, so visit its expression directly.
      n.heritageClauses?.forEach((h) => h.types.forEach((t) => visit(t.expression)));
      ts.getDecorators(n)?.forEach(visit);
      for (const m of n.members) {
        if (m.name && ts.isComputedPropertyName(m.name)) visit(m.name);
        if (ts.isClassStaticBlockDeclaration(m)) visit(m);
        else if (ts.isPropertyDeclaration(m) && m.initializer && m.modifiers?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword)) visit(m.initializer);
      }
      return;
    }
    // Anything else deferred (function bodies, types) is not evaluated at module load.
    if (ts.isFunctionLike(n) || ts.isTypeNode(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) return;
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
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(30);
    expect(files.flatMap((f) => topLevelGlobalUses(f))).toEqual([]);
  });

  it("the scan flags load-time uses in static initialisers, static blocks and top-level IIFEs, not deferred code", () => {
    const bad = [
      "class A { static x = Buffer.alloc(1); }",
      "class B { static { process.cwd(); } }",
      "const v = (() => process.env.X)();",
      "(function () { Buffer.from('a'); })();",
      "class C extends (Buffer as any) {}",
    ];
    for (const src of bad) expect(topLevelGlobalUses("x.ts", src), src).toHaveLength(1);
    const ok = [
      "class A { y = Buffer.alloc(1); m() { return process.cwd(); } static s() { return Buffer.alloc(1); } }",
      "const f = () => process.env.X;",
      "export function g() { return Buffer.from('a'); }",
    ];
    for (const src of ok) expect(topLevelGlobalUses("x.ts", src), src).toEqual([]);
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
