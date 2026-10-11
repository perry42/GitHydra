// SPDX-License-Identifier: GPL-3.0-or-later
// Scenario registry. To add a scenario: append an object to any array in this folder (see conflicts.mjs for the shape:
// name, summary, tryText, build(ctx) -> { repo, extra?, meta?, autoTick? }, expect, optional expectExtra/stable), then list it in docs/manual-testing/README.md.
import { changeScenarios } from "./changes.mjs";
import { conflictScenarios } from "./conflicts.mjs";
import { repoScenarios } from "./repos.mjs";

export const scenarios = [...conflictScenarios, ...changeScenarios, ...repoScenarios];
export const byName = (name) => scenarios.find((s) => s.name === name);
