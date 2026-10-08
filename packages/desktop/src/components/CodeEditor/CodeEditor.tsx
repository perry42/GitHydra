// SPDX-License-Identifier: GPL-3.0-or-later
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { EditorState, Transaction, type ChangeSpec, type Text } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  type Command,
} from "@codemirror/view";
import { history, historyKeymap, standardKeymap } from "@codemirror/commands";

/**
 * specs/edit-in-diff.md FR-469/FR-538: a plain-text CodeMirror 6 editor. Deliberately no language, autocomplete, search or
 * highlighting packages; only line numbers, undo history, Tab indent and the three escape hatches (Esc, Ctrl+M).
 */
export interface CodeEditorHandle {
  getValue(): string;
  /** Opaque document snapshot to hand back to `markSaved` once a write of exactly this text succeeded. */
  snapshot(): Text;
  /** The text in `snapshot` is now the saved baseline; typing done while the write was in flight stays dirty. */
  markSaved(snapshot: Text): void;
  isDirty(): boolean;
  /** An IME composition is in progress; nothing may rewrite the document meanwhile. */
  isComposing(): boolean;
  /** Replace the document (disk reload) keeping line/column and scroll; outside undo history; leaves the buffer clean. */
  replaceAll(text: string): void;
  focus(): void;
  getCursor(): { line: number; column: number };
  /** Test seam; app code goes through the methods above. */
  getView(): EditorView | null;
}

export interface CodeEditorProps {
  initialValue: string;
  ariaLabel: string;
  describedBy?: string;
  /** "verbatim": a mixed-EOL file; the only line break CodeMirror knows is "\n" so every "\r" stays in the text (FR-469). */
  verbatimBreaks?: boolean;
  indentUnit: string;
  /** 1-based line and 0-based column to put the caret on and scroll to (FR-539); omitted: top of the file. */
  initialCaret?: { line: number; column: number } | null;
  /** Saved baseline when it differs from `initialValue`: a restored recovery draft opens dirty (specs/edit-recovery-draft.md FR-550). */
  baseValue?: string;
  onDirtyChange?: (dirty: boolean) => void;
  /** Every document change (not only dirty transitions); drives the recovery-draft debounce (FR-545). */
  onChange?: () => void;
  onBlur?: () => void;
  onCursorChange?: (pos: { line: number; col: number }) => void;
  /** Esc, never fired during IME composition (FR-469). */
  onEscape?: () => void;
  /** Ctrl+M (FR-469): the way out of the editor, since Tab indents. */
  onFocusToolbar?: () => void;
  onReady?: () => void;
}

const theme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--gh-surface)",
    color: "var(--gh-ink-primary)",
    fontSize: "12px",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--gh-font-mono)", lineHeight: "18px", overflow: "auto" },
  ".cm-content": { padding: "6px 0", caretColor: "var(--gh-accent)" },
  ".cm-line": { padding: "0 8px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--gh-accent)", borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": {
    background: "color-mix(in srgb, var(--gh-accent) 35%, transparent)",
  },
  ".cm-gutters": {
    width: "54px",
    boxSizing: "border-box",
    backgroundColor: "var(--gh-page)",
    color: "var(--gh-ink-muted)",
    border: "none",
    borderRight: "1px solid var(--gh-border)",
    fontFamily: "var(--gh-font-mono)",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "0",
    padding: "0 8px 0 4px",
    fontSize: "11px",
    fontVariantNumeric: "tabular-nums",
  },
  ".cm-specialChar": { color: "var(--gh-status-serious)" },
});

const posOf = (state: EditorState) => {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  return { line: line.number, col: head - line.from + 1 };
};

function indentChanges(state: EditorState, unit: string, outdent: boolean): ChangeSpec[] | null {
  const seen = new Set<number>();
  const changes: ChangeSpec[] = [];
  for (const r of state.selection.ranges) {
    const first = state.doc.lineAt(r.from);
    let last = state.doc.lineAt(r.to);
    // A range ending at a line start does not include that line (matches every code editor).
    if (!r.empty && last.number > first.number && r.to === last.from) last = state.doc.line(last.number - 1);
    const multi = last.number > first.number;
    for (let n = first.number; n <= last.number; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      const line = state.doc.line(n);
      if (outdent) {
        const m = /^(\t| {1,8})/.exec(line.text);
        if (!m) continue;
        const drop = m[1] === "\t" ? 1 : Math.min(m[1]!.length, unit === "\t" ? 4 : unit.length);
        changes.push({ from: line.from, to: line.from + drop });
      } else if (!multi || line.length > 0) changes.push({ from: line.from, insert: unit });
    }
  }
  return changes.length ? changes : null;
}

export const CodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor(props, ref) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const baselineRef = useRef<Text | null>(null);
  const dirtyRef = useRef(false);
  // Callbacks are read through a ref so the view (built once) never goes stale or gets rebuilt on a re-render.
  const cb = useRef(props);
  cb.current = props;

  useImperativeHandle(
    ref,
    () => ({
      getValue: () => viewRef.current?.state.doc.toString() ?? "",
      snapshot: () => viewRef.current!.state.doc,
      markSaved: (snap) => {
        baselineRef.current = snap;
        const view = viewRef.current;
        if (!view) return;
        const dirty = !view.state.doc.eq(snap);
        if (dirty !== dirtyRef.current) {
          dirtyRef.current = dirty;
          cb.current.onDirtyChange?.(dirty);
        }
      },
      isDirty: () => dirtyRef.current,
      isComposing: () => !!viewRef.current && (viewRef.current.composing || viewRef.current.compositionStarted),
      replaceAll: (text) => {
        const view = viewRef.current;
        if (!view) return;
        const before = posOf(view.state);
        const scrollTop = view.scrollDOM.scrollTop;
        const scrollLeft = view.scrollDOM.scrollLeft;
        const probe = EditorState.create({ doc: text, extensions: cb.current.verbatimBreaks ? [EditorState.lineSeparator.of("\n")] : [] });
        const line = probe.doc.line(Math.min(before.line, probe.doc.lines));
        const head = line.from + Math.min(before.col - 1, line.length);
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          selection: { anchor: head },
          annotations: Transaction.addToHistory.of(false),
        });
        baselineRef.current = view.state.doc;
        if (dirtyRef.current) {
          dirtyRef.current = false;
          cb.current.onDirtyChange?.(false);
        }
        view.scrollDOM.scrollTop = scrollTop;
        view.scrollDOM.scrollLeft = scrollLeft;
        requestAnimationFrame(() => {
          view.scrollDOM.scrollTop = scrollTop;
          view.scrollDOM.scrollLeft = scrollLeft;
        });
      },
      focus: () => viewRef.current?.focus(),
      getCursor: () => {
        const p = posOf(viewRef.current!.state);
        return { line: p.line, column: p.col - 1 };
      },
      getView: () => viewRef.current,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const { initialValue, verbatimBreaks, indentUnit, initialCaret, ariaLabel, describedBy } = cb.current;

    const indent = (outdent: boolean): Command => (view) => {
      const changes = indentChanges(view.state, indentUnit, outdent);
      if (!changes) return true; // swallow Tab/Shift+Tab either way: it is never a focus trap exit (Ctrl+M is)
      view.dispatch(view.state.update({ changes, userEvent: outdent ? "delete.dedent" : "input.indent", scrollIntoView: true }));
      return true;
    };
    const tab: Command = (view) => {
      const multi = view.state.selection.ranges.some((r) => !r.empty);
      if (multi) return indent(false)(view);
      view.dispatch(view.state.replaceSelection(indentUnit));
      view.dispatch({ scrollIntoView: true });
      return true;
    };
    const escape: Command = (view) => {
      if (view.composing || view.compositionStarted) return false;
      cb.current.onEscape?.();
      return true;
    };

    const state = EditorState.create({
      doc: initialValue,
      extensions: [
        lineNumbers(),
        drawSelection(),
        history(),
        EditorState.tabSize.of(4),
        ...(verbatimBreaks ? [EditorState.lineSeparator.of("\n"), highlightSpecialChars()] : []),
        keymap.of([
          { key: "Escape", run: escape, preventDefault: true, stopPropagation: true },
          { key: "Tab", run: tab, preventDefault: true },
          { key: "Shift-Tab", run: indent(true), preventDefault: true },
          ...historyKeymap,
          ...standardKeymap,
        ]),
        EditorView.domEventHandlers({
          // By physical key so Ctrl+M works on the Hebrew layout (FR-527).
          blur() {
            cb.current.onBlur?.();
            return false;
          },
          keydown(e) {
            if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.code === "KeyM") {
              e.preventDefault();
              e.stopPropagation();
              cb.current.onFocusToolbar?.();
              return true;
            }
            return false;
          },
        }),
        EditorView.contentAttributes.of({
          "aria-label": ariaLabel,
          "aria-multiline": "true",
          ...(describedBy ? { "aria-describedby": describedBy } : {}),
          spellcheck: "false",
          autocorrect: "off",
          autocapitalize: "off",
          "data-gramm": "false",
        }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            const dirty = !u.state.doc.eq(baselineRef.current!);
            if (dirty !== dirtyRef.current) {
              dirtyRef.current = dirty;
              cb.current.onDirtyChange?.(dirty);
            }
          }
          if (u.docChanged) cb.current.onChange?.();
          if (u.docChanged || u.selectionSet) cb.current.onCursorChange?.(posOf(u.state));
        }),
        theme,
      ],
    });
    const { baseValue } = cb.current;
    baselineRef.current =
      baseValue === undefined
        ? state.doc
        : EditorState.create({ doc: baseValue, extensions: verbatimBreaks ? [EditorState.lineSeparator.of("\n")] : [] }).doc;
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    if (!state.doc.eq(baselineRef.current)) {
      dirtyRef.current = true;
      cb.current.onDirtyChange?.(true);
    }

    if (initialCaret) {
      const line = state.doc.line(Math.min(Math.max(1, initialCaret.line), state.doc.lines));
      const head = line.from + Math.min(Math.max(0, initialCaret.column), line.length);
      view.dispatch({
        selection: { anchor: head },
        // Leaves a few lines of hunk context above the target (FR-539).
        effects: EditorView.scrollIntoView(head, { y: "start", yMargin: 54 }),
      });
    }
    cb.current.onCursorChange?.(posOf(view.state));
    view.focus();
    cb.current.onReady?.();

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  return <div ref={hostRef} className="gh-code-editor" />;
});
