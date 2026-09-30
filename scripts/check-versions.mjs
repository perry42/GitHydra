// SPDX-License-Identifier: GPL-3.0-or-later
// Fails if the root, packages/git-core and packages/desktop "version" fields drift apart.
// Run via `npm run check:versions`; also runs in release.yml's version-check job.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const files = ["package.json", "packages/git-core/package.json", "packages/desktop/package.json"];
const versions = files.map((f) => {
  const url = new URL(`../${f}`, import.meta.url);
  return [f, JSON.parse(readFileSync(fileURLToPath(url), "utf8")).version];
});
if (new Set(versions.map(([, v]) => v)).size !== 1) {
  console.error("Package versions have drifted; they must all match:");
  for (const [f, v] of versions) console.error(`  ${f}: ${v}`);
  process.exit(1);
}
console.log(`All package versions match (${versions[0][1]}).`);
