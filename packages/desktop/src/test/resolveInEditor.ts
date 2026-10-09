// SPDX-License-Identifier: GPL-3.0-or-later
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * specs/edit-in-diff.md FR-567: clicking an editor-eligible conflicted row opens the block editor, so integration tests that
 * used to take a side in the file-level view now decide every block by chip and Mark as resolved. `side` is git's stage:
 * "ours" is the first chip of the row (stage 2), "theirs" the second (stage 3), whatever the sections are called.
 */
export async function resolveOpenEditor(path: string, side: "ours" | "theirs"): Promise<void> {
  await screen.findByRole("textbox", { name: `Editing ${path}` }, { timeout: 15000 });
  const groups = await screen.findAllByRole("group", { name: /^Resolution for conflict/ });
  for (const g of groups) {
    const chips = within(g).getAllByRole("button");
    await userEvent.click(chips[side === "ours" ? 0 : 1]!);
  }
  await userEvent.click(screen.getByTestId("mark-resolved"));
  await screen.findByTestId("resolved-strip", {}, { timeout: 20000 });
}
