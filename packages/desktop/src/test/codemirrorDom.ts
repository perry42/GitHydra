// SPDX-License-Identifier: GPL-3.0-or-later
import { EditorView } from "@codemirror/view";

/** jsdom has no layout; CodeMirror measures through these. Zeroed rects are enough for tests that never assert geometry. */
export function polyfillCodeMirrorDom(): void {
  const rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
  const list = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
  Range.prototype.getClientRects = list;
  Range.prototype.getBoundingClientRect = rect;
  if (!document.elementFromPoint) document.elementFromPoint = () => null;
}

export const viewOf = (root: ParentNode): EditorView => {
  const dom = root.querySelector<HTMLElement>(".cm-editor");
  const view = dom && EditorView.findFromDOM(dom);
  if (!view) throw new Error("no CodeMirror view in the DOM");
  return view;
};

/** Types at the end of the document (a transaction, as jsdom cannot drive contenteditable input). */
export function typeAtEnd(root: ParentNode, text: string): void {
  const view = viewOf(root);
  view.dispatch({ changes: { from: view.state.doc.length, insert: text }, selection: { anchor: view.state.doc.length + text.length } });
}
