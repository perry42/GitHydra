// SPDX-License-Identifier: GPL-3.0-or-later
import { Facet, RangeSet, StateEffect, StateField, Prec, type EditorState, type Extension, type Range, type Text, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, WidgetType, keymap, lineNumberMarkers, type DecorationSet } from "@codemirror/view";
import { invertedEffects, redo, undo } from "@codemirror/commands";
import { parseConflictText, type ConflictBlock, type ParsedConflictText } from "@githydra/git-core";
import {
  EMPTY_SUMMARY,
  capitalize,
  choiceLabel,
  decisionStatus,
  deriveChoice,
  roleSpans,
  textForChip,
  type BothOrder,
  type ChipKey,
  type ConflictEvent,
  type ConflictSummary,
  type DerivedChoice,
  type SideName,
  type SideNames,
} from "../../lib/conflictModel";
import "./ConflictEditor.css";

/**
 * specs/edit-in-diff.md FR-556..FR-564: the conflict block layer over the ONE editable buffer. The text is the only truth: a
 * block's selected chip is derived from it on every change (FR-557), and each chip click is one transaction (one undo step).
 * `Entry` holds only what the text cannot say: the original sides, the pristine marker form for Reset, and the Custom slot.
 */

export interface ConflictEditorOptions {
  names: SideNames;
  /** FR-559: false when stage 2 or 3 is missing, binary or over the cap; Yours/Incoming/Both are then disabled. */
  sidesOk: boolean;
  sidesReason?: string;
  onSummary: (s: ConflictSummary) => void;
  onEvent: (e: ConflictEvent) => void;
}

interface Entry {
  id: number;
  /** Current region in the document: the markers while open, the result text once decided. */
  from: number;
  to: number;
  open: boolean;
  ours: string;
  theirs: string;
  base: string | null;
  /** The block exactly as first seen, for Reset (FR-561). */
  raw: string;
  /** FR-560: one remembered custom text per block, in memory only. */
  custom: string | null;
  order: BothOrder;
}

interface Cf {
  enabled: boolean;
  entries: Entry[];
  parse: ParsedConflictText;
  currentId: number | null;
  nextId: number;
  derived: Map<number, DerivedChoice>;
  decos: DecorationSet;
  gutter: RangeSet<GutterMarker>;
  summary: ConflictSummary;
}

const cfOptions = Facet.define<ConflictEditorOptions, ConflictEditorOptions | null>({ combine: (v) => v[0] ?? null });

const placeEffect = StateEffect.define<{ id: number; from: number; to: number }>({
  map: (v, ch) => ({ id: v.id, from: ch.mapPos(v.from, -1), to: ch.mapPos(v.to, -1) }),
});
const patchEffect = StateEffect.define<{ id: number; order?: BothOrder; custom?: string | null }>();
const resetEffect = StateEffect.define<null>();
const enableEffect = StateEffect.define<boolean>();
const currentEffect = StateEffect.define<number>();

class LineMarker extends GutterMarker {
  constructor(readonly elementClass: string) {
    super();
  }
  eq(o: LineMarker): boolean {
    return o.elementClass === this.elementClass;
  }
}
const OPEN_MARK = new LineMarker("gh-cf-ln gh-cf-ln--open");
const STRAY_MARK = new LineMarker("gh-cf-ln gh-cf-ln--stray");

const slice = (doc: Text, from: number, to: number): string => doc.sliceString(Math.min(from, doc.length), Math.min(Math.max(from, to), doc.length));

function overlaps(e: Entry, p: ConflictBlock): boolean {
  if (e.from === p.from) return true;
  return e.from < p.toWithEol && p.from < e.to;
}

/** Match parsed blocks to remembered entries by position, so identity (sides, Custom slot) survives typing, undo and redo. */
function resync(doc: Text, entries: Entry[], nextId: number): { entries: Entry[]; parse: ParsedConflictText; nextId: number } {
  const text = doc.toString();
  const parse = parseConflictText(text);
  const used = new Set<number>();
  const out: Entry[] = [];
  for (const p of parse.blocks) {
    let best: Entry | null = null;
    for (const e of entries) {
      if (used.has(e.id) || !overlaps(e, p)) continue;
      if (!best || Math.abs(e.from - p.from) < Math.abs(best.from - p.from)) best = e;
    }
    if (best) {
      used.add(best.id);
      out.push({ ...best, open: true, from: p.from, to: p.toWithEol });
    } else {
      out.push({
        id: nextId++,
        from: p.from,
        to: p.toWithEol,
        open: true,
        ours: p.ours.text,
        theirs: p.theirs.text,
        base: p.base ? p.base.text : null,
        raw: text.slice(p.from, p.toWithEol),
        custom: null,
        order: "file",
      });
    }
  }
  for (const e of entries) {
    if (used.has(e.id)) continue;
    const from = Math.min(e.from, doc.length);
    const to = Math.min(Math.max(e.to, from), doc.length);
    const t = text.slice(from, to);
    const d = deriveChoice(t, e.ours, e.theirs);
    // FR-560: whatever the user typed last stays recallable; presets never overwrite it.
    out.push({ ...e, from, to, open: false, custom: d.key === "custom" && t !== e.custom ? t : e.custom });
  }
  out.sort((a, b) => a.from - b.from || a.id - b.id);
  return { entries: out, parse, nextId };
}

function entryAt(entries: readonly Entry[], pos: number): Entry | null {
  for (const e of entries) {
    if ((pos >= e.from && pos < e.to) || (e.from === e.to && pos === e.from)) return e;
  }
  return null;
}

class OpenLabelWidget extends WidgetType {
  constructor(readonly side: SideName) {
    super();
  }
  eq(o: OpenLabelWidget): boolean {
    return o.side.role === this.side.role && o.side.label === this.side.label && o.side.name === this.side.name;
  }
  toDOM(): HTMLElement {
    const s = document.createElement("span");
    s.className = `gh-cf-label gh-cf-role--${this.side.role}`;
    s.textContent = this.side.name ? `${capitalize(this.side.short)} · ${this.side.name}` : capitalize(this.side.short);
    s.setAttribute("aria-hidden", "true");
    return s;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

interface LensData {
  id: number;
  n: number;
  total: number;
  open: boolean;
  stray: boolean;
  choice: ChipKey | "none";
  order: BothOrder;
  hasCustom: boolean;
  current: boolean;
  empty: boolean;
  names: SideNames;
  sidesOk: boolean;
  sidesReason: string;
}

const rovingKey = new WeakMap<EditorView, Map<number, string>>();
const rv = (view: EditorView): Map<number, string> => {
  let m = rovingKey.get(view);
  if (!m) rovingKey.set(view, (m = new Map()));
  return m;
};

const SVG_NS = "http://www.w3.org/2000/svg";
function svg(path: string, cls = "gh-cf-i"): SVGElement {
  const s = document.createElementNS(SVG_NS, "svg");
  s.setAttribute("viewBox", "0 0 16 16");
  s.setAttribute("class", cls);
  s.setAttribute("aria-hidden", "true");
  s.setAttribute("focusable", "false");
  const p = document.createElementNS(SVG_NS, "path");
  p.setAttribute("d", path);
  s.appendChild(p);
  return s;
}
const P_CHECK = "m3 8.5 3.2 3.2L13 4.8";
const P_ALERT = "M8 2.2 14.4 13H1.6zM8 6.6v3M8 11.4v.1";
const P_SWAP = "M3 5.5h9.5M10 3l2.5 2.5L10 8M13 10.5H3.5M6 8l-2.5 2.5L6 13";
const P_PENCIL = "m10.5 2.5 3 3L5 14l-3.5.5L2 11z";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

type ChipId = "ours" | "theirs" | "both" | "order" | "neither" | "custom" | "reset" | "edit";

function sideChipLabel(s: SideName): { main: string; sub: string | null } {
  return s.name ? { main: s.name, sub: `(${s.short})` } : { main: capitalize(s.short), sub: null };
}

function renderLens(dom: HTMLElement, d: LensData, rvKey: string | undefined): void {
  const hadFocus = dom.contains(document.activeElement) ? (document.activeElement as HTMLElement).getAttribute("data-chip") : null;
  dom.className = `gh-cf-lens${d.open ? " gh-cf-lens--open" : ""}${d.current ? " gh-cf-lens--cur" : ""}`;
  dom.setAttribute("data-cf-id", String(d.id));
  dom.replaceChildren();
  const bar = el("div", "gh-cf-lens__b");

  const title = el("span", "gh-cf-lens__t");
  const needs = d.open || d.stray;
  title.appendChild(svg(needs ? P_ALERT : P_CHECK, needs ? "gh-cf-i gh-cf-u" : "gh-cf-i gh-cf-ok"));
  title.appendChild(document.createTextNode(`Conflict ${d.n} of ${d.total}`));
  if (needs) title.appendChild(el("span", "gh-cf-u", d.open ? " unresolved" : " stray markers"));
  bar.appendChild(title);

  const group = el("div", "gh-cf-chips");
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", `Resolution for conflict ${d.n}`);

  const roving = rvKey ?? "ours";
  const first = d.order === "rev" ? d.names.bottom : d.names.top;
  const second = first === d.names.top ? d.names.bottom : d.names.top;
  const add = (
    id: ChipId,
    cls: string,
    content: (b: HTMLButtonElement) => void,
    aria: string,
    opts: { pressed?: boolean; disabled?: boolean; title?: string } = {},
  ) => {
    const b = el("button", `gh-cf-chip ${cls}`);
    b.type = "button";
    b.setAttribute("data-chip", id);
    b.setAttribute("aria-label", aria);
    if (opts.pressed !== undefined) b.setAttribute("aria-pressed", String(opts.pressed));
    if (opts.disabled) b.setAttribute("aria-disabled", "true");
    if (opts.title) b.title = opts.title;
    b.tabIndex = id === roving ? 0 : -1;
    content(b);
    group.appendChild(b);
    return b;
  };
  const box = (b: HTMLElement) => {
    const t = el("span", "gh-cf-tbox");
    t.setAttribute("aria-hidden", "true");
    t.appendChild(svg(P_CHECK));
    b.appendChild(t);
  };
  const sideChip = (id: "ours" | "theirs", s: SideName) => {
    const lab = sideChipLabel(s);
    add(
      id,
      `gh-cf-role--${s.role}`,
      (b) => {
        box(b);
        b.appendChild(el("span", "gh-cf-tn", lab.main));
        if (lab.sub) b.appendChild(el("span", "gh-cf-ts", lab.sub));
      },
      `${capitalize(s.short)}${s.name ? `, ${s.name}` : ""}`,
      { pressed: d.choice === id, disabled: !d.sidesOk, title: d.sidesOk ? undefined : d.sidesReason },
    );
  };
  sideChip("ours", d.names.top);
  sideChip("theirs", d.names.bottom);
  add(
    "both",
    "",
    (b) => {
      box(b);
      b.appendChild(el("span", "gh-cf-tn", "Both"));
    },
    `Both sides${d.choice === "both" ? `, ${first.short} first` : ""}`,
    { pressed: d.choice === "both", disabled: !d.sidesOk, title: d.sidesOk ? undefined : d.sidesReason },
  );
  if (d.choice === "both") {
    add(
      "order",
      "gh-cf-chip--ord",
      (b) => {
        b.appendChild(svg(P_SWAP));
        b.appendChild(el("span", "", `${first.short} first`));
      },
      `Order: ${first.short} then ${second.short}. Activate to put ${second.short} first`,
      { disabled: !d.sidesOk, title: `Default is file order (${d.names.top.short} first).` },
    );
  }
  add(
    "neither",
    "",
    (b) => {
      box(b);
      b.appendChild(el("span", "gh-cf-tn", "Neither"));
    },
    "Neither, remove both sides",
    { pressed: d.choice === "neither" },
  );
  const kept = d.hasCustom && d.choice !== "custom";
  add(
    "custom",
    "",
    (b) => {
      box(b);
      b.appendChild(el("span", "gh-cf-tn", "Custom"));
      if (kept) {
        const dot = el("span", "gh-cf-kdot");
        dot.setAttribute("aria-hidden", "true");
        b.appendChild(dot);
      }
    },
    `Custom text${kept ? ", your last custom text is kept" : ""}`,
    { pressed: d.choice === "custom" },
  );
  group.appendChild(el("span", "gh-cf-sp"));
  add("reset", "gh-cf-chip--ghost", (b) => b.appendChild(document.createTextNode("Reset")), `Reset conflict ${d.n}: discard the result and the kept custom text`, {
    disabled: d.open,
    title: "Back to the unresolved conflict. Ctrl+Z undoes it.",
  });
  add(
    "edit",
    "gh-cf-chip--ghost",
    (b) => {
      b.appendChild(svg(P_PENCIL));
      b.appendChild(el("span", "gh-cf-lbl-opt", "Edit"));
    },
    `Edit the result of conflict ${d.n} by hand`,
    { title: "Edit by hand (E or Enter)" },
  );
  bar.appendChild(group);
  if (kept) {
    const hint = el("span", "gh-cf-hint");
    hint.setAttribute("role", "note");
    hint.appendChild(svg(P_PENCIL));
    hint.appendChild(document.createTextNode("custom text kept"));
    bar.appendChild(hint);
  }
  dom.appendChild(bar);

  if (d.empty) {
    const e = el("div", "gh-cf-empty", "— removed both sides —");
    dom.appendChild(e);
  }
  const pv = el("div", "gh-cf-pv");
  pv.hidden = true;
  pv.setAttribute("aria-hidden", "true");
  dom.appendChild(pv);

  if (hadFocus) dom.querySelector<HTMLElement>(`[data-chip="${hadFocus}"]`)?.focus({ preventScroll: true });
}

class LensWidget extends WidgetType {
  constructor(readonly d: LensData) {
    super();
  }
  eq(o: LensWidget): boolean {
    const a = this.d;
    const b = o.d;
    return (
      a.id === b.id && a.n === b.n && a.total === b.total && a.open === b.open && a.stray === b.stray && a.choice === b.choice &&
      a.order === b.order && a.hasCustom === b.hasCustom && a.current === b.current && a.empty === b.empty && a.sidesOk === b.sidesOk &&
      a.names === b.names
    );
  }
  toDOM(view: EditorView): HTMLElement {
    const dom = el("div", "");
    renderLens(dom, this.d, rv(view).get(this.d.id));
    attachLensHandlers(dom, view);
    return dom;
  }
  // Patching in place keeps keyboard focus on the chip the user just pressed.
  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    renderLens(dom, this.d, rv(view).get(this.d.id));
    return true;
  }
  ignoreEvent(): boolean {
    return true;
  }
  get estimatedHeight(): number {
    return 34;
  }
}

function previewFor(view: EditorView, id: number, chip: ChipId): { header: string; lines: string[] | null } | null {
  const st = view.state.field(cfField);
  const e = st.entries.find((x) => x.id === id);
  const names = view.state.facet(cfOptions)?.names;
  if (!e || !names) return null;
  if (chip === "edit") return null;
  if (chip === "reset") return { header: "Preview: back to the unresolved conflict", lines: null };
  const target = targetText(e, chip, st.derived.get(e.id) ?? { key: "custom", order: "file" });
  if (target === null) return null;
  const d = deriveChoice(target, e.ours, e.theirs);
  const count = target === "" ? 0 : target.split(/\r\n|\r|\n/).length - (/(\r\n|\r|\n)$/.test(target) ? 1 : 0);
  const header = `Preview: ${choiceLabel(d.key, names, d.order)}, ${count} line${count === 1 ? "" : "s"}`;
  return { header, lines: target === "" ? [] : target.replace(/(\r\n|\r|\n)$/, "").split(/\r\n|\r|\n/) };
}

function showPreview(view: EditorView, dom: HTMLElement, chip: HTMLElement): void {
  const pv = dom.querySelector<HTMLElement>(".gh-cf-pv");
  if (!pv) return;
  const id = Number(dom.getAttribute("data-cf-id"));
  const info = previewFor(view, id, chip.getAttribute("data-chip") as ChipId);
  if (!info) return hidePreview(dom);
  pv.replaceChildren();
  pv.appendChild(el("div", "gh-cf-pv__h", info.header));
  if (info.lines === null) pv.appendChild(el("div", "gh-cf-pv__l gh-cf-muted", "The conflict markers return; custom text is discarded."));
  else if (info.lines.length === 0) pv.appendChild(el("div", "gh-cf-pv__l gh-cf-muted", "— removed both sides —"));
  else for (const l of info.lines) pv.appendChild(el("div", "gh-cf-pv__l", l === "" ? " " : l));
  pv.hidden = false;
}
function hidePreview(dom: HTMLElement): void {
  const pv = dom.querySelector<HTMLElement>(".gh-cf-pv");
  if (pv) pv.hidden = true;
}

function attachLensHandlers(dom: HTMLElement, view: EditorView): void {
  const chipOf = (t: EventTarget | null): HTMLButtonElement | null => (t instanceof Element ? t.closest<HTMLButtonElement>("button[data-chip]") : null);
  const idOf = () => Number(dom.getAttribute("data-cf-id"));
  dom.addEventListener("click", (e) => {
    const b = chipOf(e.target);
    if (!b) return;
    if (b.getAttribute("aria-disabled") === "true") return;
    rv(view).set(idOf(), b.getAttribute("data-chip")!);
    runChip(view, idOf(), b.getAttribute("data-chip") as ChipId);
  });
  dom.addEventListener("mouseover", (e) => {
    const b = chipOf(e.target);
    if (b) showPreview(view, dom, b);
  });
  dom.addEventListener("mouseout", (e) => {
    if (chipOf(e.target) && !dom.contains(document.activeElement)) hidePreview(dom);
    else if (chipOf(e.target) && document.activeElement instanceof HTMLElement && chipOf(document.activeElement)) showPreview(view, dom, document.activeElement as HTMLElement);
  });
  dom.addEventListener("focusin", (e) => {
    const b = chipOf(e.target);
    if (!b) return;
    rv(view).set(idOf(), b.getAttribute("data-chip")!);
    for (const x of dom.querySelectorAll<HTMLElement>("[data-chip]")) x.tabIndex = x === b ? 0 : -1;
    showPreview(view, dom, b);
    if (view.state.field(cfField).currentId !== idOf()) queueMicrotask(() => view.dispatch({ effects: currentEffect.of(idOf()) }));
  });
  dom.addEventListener("focusout", (e) => {
    const next = (e as FocusEvent).relatedTarget;
    if (!(next instanceof Node) || !dom.contains(next)) hidePreview(dom);
  });
  dom.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    const b = chipOf(e.target);
    if (!b) return;
    const mod = e.ctrlKey || e.metaKey;
    // Physical key codes so the shortcuts work on the Hebrew layout (FR-527).
    if (mod && !e.altKey && e.code === "KeyZ") {
      e.preventDefault();
      e.stopPropagation();
      (e.shiftKey ? redo : undo)(view);
      return;
    }
    if (mod && !e.altKey && !e.shiftKey && e.code === "KeyY") {
      e.preventDefault();
      e.stopPropagation();
      redo(view);
      return;
    }
    if (mod || e.altKey) return;
    const items = Array.from(dom.querySelectorAll<HTMLButtonElement>("button[data-chip]"));
    const i = items.indexOf(b);
    let to = -1;
    if (e.key === "ArrowRight") to = Math.min(items.length - 1, i + 1);
    else if (e.key === "ArrowLeft") to = Math.max(0, i - 1);
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = items.length - 1;
    if (to >= 0) {
      e.preventDefault();
      e.stopPropagation();
      items[to]!.focus();
      return;
    }
    if (e.key === " " || e.code === "Space") {
      e.preventDefault();
      e.stopPropagation();
      if (b.getAttribute("aria-disabled") !== "true") b.click();
    } else if (e.key === "Enter" || e.code === "KeyE") {
      e.preventDefault();
      e.stopPropagation();
      runChip(view, idOf(), "edit");
    }
  });
}

/** The text a chip would put in the block's result; `null` = no change (edit/custom with nothing to restore). */
function targetText(e: Entry, chip: ChipId, derived: DerivedChoice): string | null {
  switch (chip) {
    case "ours":
    case "theirs":
    case "neither":
      return textForChip(chip, e.order, e.ours, e.theirs);
    case "both":
      return textForChip("both", derived.key === "both" ? derived.order : e.order, e.ours, e.theirs);
    case "order":
      return textForChip("both", derived.order === "rev" ? "file" : "rev", e.ours, e.theirs);
    case "reset":
      return e.raw;
    case "custom":
      return e.custom !== null && derived.key !== "custom" ? e.custom : null;
    default:
      return null;
  }
}

function build(state: EditorState, entries: Entry[], parse: ParsedConflictText, currentId: number | null, nextId: number, enabled: boolean): Cf {
  const doc = state.doc;
  const opts = state.facet(cfOptions);
  const derived = new Map<number, DerivedChoice>();
  if (!enabled || !opts) {
    return { enabled: false, entries, parse, currentId, nextId, derived, decos: Decoration.none, gutter: RangeSet.empty, summary: { ...EMPTY_SUMMARY } };
  }
  const names = opts.names;
  const decos: Range<Decoration>[] = [];
  const gutter: Range<GutterMarker>[] = [];
  const strayLineFroms = new Set<number>();
  for (const m of parse.strayMarkers) strayLineFroms.add(doc.lineAt(Math.min(m.from, doc.length)).from);
  const total = entries.length;
  const blocks: ConflictSummary["blocks"] = [];

  const lineAtPos = (pos: number) => doc.lineAt(Math.min(Math.max(pos, 0), doc.length));
  entries.forEach((e, idx) => {
    const n = idx + 1;
    const text = slice(doc, e.from, e.to);
    const d = e.open ? ({ key: "custom", order: "file" } as DerivedChoice) : deriveChoice(text, e.ours, e.theirs);
    derived.set(e.id, d);
    const first = lineAtPos(e.from);
    // A decided region can contain stray marker lines the user typed or kept; the row says so (FR-564).
    const stray = !e.open && parse.strayMarkers.some((m) => m.from >= e.from && m.from < Math.max(e.to, e.from + 1));
    const data: LensData = {
      id: e.id,
      n,
      total,
      open: e.open,
      stray,
      choice: e.open ? "none" : d.key,
      order: d.key === "both" ? d.order : e.order,
      hasCustom: e.custom !== null,
      current: e.id === currentId,
      empty: !e.open && text === "",
      names,
      sidesOk: opts.sidesOk,
      sidesReason: opts.sidesReason ?? "",
    };
    decos.push(Decoration.widget({ widget: new LensWidget(data), block: true, side: -1 }).range(first.from));
    blocks.push({ id: e.id, n, open: e.open, choice: e.open ? "none" : d.key, line: first.number });

    if (e.open) {
      const p = parse.blocks.find((b) => b.from === e.from);
      if (!p) return;
      for (let pos = p.from; pos <= p.to; ) {
        const ln = doc.lineAt(Math.min(pos, doc.length));
        let cls = "";
        let label: SideName | null = null;
        if (ln.from === lineAtPos(p.startMarker.from).from) {
          cls = `gh-cf-line gh-cf-mk gh-cf-role--${names.top.role}`;
          label = names.top;
        } else if (p.baseMarker && ln.from === lineAtPos(p.baseMarker.from).from) cls = "gh-cf-line gh-cf-mk gh-cf-base";
        else if (ln.from === lineAtPos(p.separatorMarker.from).from) cls = "gh-cf-line gh-cf-mk gh-cf-mid";
        else if (ln.from === lineAtPos(p.endMarker.from).from) {
          cls = `gh-cf-line gh-cf-mk gh-cf-role--${names.bottom.role}`;
          label = names.bottom;
        } else if (p.baseMarker && pos > p.baseMarker.from && pos < p.separatorMarker.from) cls = "gh-cf-line gh-cf-base";
        else if (pos < p.separatorMarker.from) cls = `gh-cf-line gh-cf-body gh-cf-role--${names.top.role}`;
        else cls = `gh-cf-line gh-cf-body gh-cf-role--${names.bottom.role}`;
        decos.push(Decoration.line({ class: `${cls} gh-cf-open` }).range(ln.from));
        gutter.push(OPEN_MARK.range(ln.from));
        if (label) decos.push(Decoration.widget({ widget: new OpenLabelWidget(label), side: 1 }).range(ln.to));
        if (ln.to >= doc.length) break;
        pos = ln.to + 1;
      }
      return;
    }
    // Decided: tint each result line by the section it came from; custom text gets the accent bar.
    const spans = roleSpans(d, e.ours, e.theirs, names);
    let span = 0;
    let used = 0;
    if (e.to > e.from) {
      for (let pos = first.from; pos < e.to; ) {
        const ln = doc.lineAt(Math.min(pos, doc.length));
        let s = spans[span];
        while (s && used >= s.lines) {
          span++;
          used = 0;
          s = spans[span];
        }
        const role = s ? s.role : "custom";
        decos.push(Decoration.line({ class: `gh-cf-line gh-cf-res ${role === "custom" ? "gh-cf-cus" : `gh-cf-role--${role}`}` }).range(ln.from));
        used++;
        if (ln.to >= doc.length) break;
        pos = ln.to + 1;
      }
    }
  });
  for (const from of strayLineFroms) {
    decos.push(Decoration.line({ class: "gh-cf-stray" }).range(from));
    gutter.push(STRAY_MARK.range(from));
  }

  const markerLines = [
    ...parse.blocks.flatMap((b) => [b.startMarker.line, ...(b.baseMarker ? [b.baseMarker.line] : []), b.separatorMarker.line, b.endMarker.line]),
    ...parse.strayMarkers.map((m) => m.line),
  ].sort((a, b) => a - b);
  const curEntry = entries.find((x) => x.id === currentId);
  const summary: ConflictSummary = {
    enabled: true,
    total,
    unresolved: entries.filter((e) => e.open).length,
    markerLines,
    strayCount: parse.strayMarkers.length,
    blocks,
    currentId,
    current: curEntry ? { n: entries.indexOf(curEntry) + 1, ours: curEntry.ours, theirs: curEntry.theirs, base: curEntry.base } : null,
  };
  return { enabled: true, entries, parse, currentId, nextId, derived, decos: Decoration.set(decos, true), gutter: RangeSet.of(gutter, true), summary };
}

const cfField: StateField<Cf> = StateField.define<Cf>({
  create(state) {
    const { entries, parse, nextId } = resync(state.doc, [], 1);
    return build(state, entries, parse, entries[0]?.id ?? null, nextId, state.facet(cfOptions) !== null);
  },
  update(prev, tr: Transaction) {
    let { entries, nextId, enabled, currentId } = prev;
    let dirty = tr.docChanged;
    for (const e of tr.effects) {
      if (e.is(enableEffect)) {
        enabled = e.value;
        dirty = true;
      } else if (e.is(resetEffect)) {
        entries = [];
        dirty = true;
      } else if (e.is(currentEffect)) {
        currentId = e.value;
        dirty = true;
      }
    }
    if (tr.docChanged) {
      entries = entries.map((en) => {
        const from = tr.changes.mapPos(en.from, -1);
        return { ...en, from, to: Math.max(from, tr.changes.mapPos(en.to, -1)) };
      });
    }
    for (const e of tr.effects) {
      if (e.is(placeEffect)) entries = entries.map((en) => (en.id === e.value.id ? { ...en, from: e.value.from, to: e.value.to } : en));
      else if (e.is(patchEffect)) {
        const v = e.value;
        entries = entries.map((en) =>
          en.id === v.id ? { ...en, ...(v.order !== undefined ? { order: v.order } : {}), ...(v.custom !== undefined ? { custom: v.custom } : {}) } : en,
        );
        dirty = true;
      }
    }
    if (!dirty && !tr.selection) return prev;
    let parse = prev.parse;
    if (tr.docChanged || tr.effects.some((e) => e.is(resetEffect) || e.is(placeEffect))) {
      const r = resync(tr.state.doc, entries, nextId);
      entries = r.entries;
      parse = r.parse;
      nextId = r.nextId;
    }
    const head = tr.state.selection.main.head;
    const at = entryAt(entries, head);
    if (at && (tr.selection || tr.docChanged)) currentId = at.id;
    if (currentId !== null && !entries.some((e) => e.id === currentId)) currentId = entries[0]?.id ?? null;
    return build(tr.state, entries, parse, currentId, nextId, enabled);
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.decos),
    lineNumberMarkers.from(f, (v) => v.gutter),
  ],
});

/** A chip action as one transaction: one undo step shared with typing (FR-557/FR-561). */
function runChip(view: EditorView, id: number, chip: ChipId): void {
  const st = view.state.field(cfField);
  const opts = view.state.facet(cfOptions);
  if (!st.enabled || !opts) return;
  const idx = st.entries.findIndex((x) => x.id === id);
  const e = st.entries[idx];
  if (!e) return;
  const derived = st.derived.get(e.id) ?? { key: "custom" as const, order: "file" as const };
  const names = opts.names;
  const total = st.entries.length;
  const wasOpen = e.open;

  if (chip === "edit" || (chip === "custom" && (derived.key === "custom" || e.custom === null))) {
    editBlock(view, e, derived);
    return;
  }
  const target = targetText(e, chip, derived);
  if (target === null) return;
  const effects: StateEffect<unknown>[] = [placeEffect.of({ id: e.id, from: e.from, to: e.from + target.length })];
  if (chip === "reset") effects.push(patchEffect.of({ id: e.id, custom: null, order: "file" }));
  else if (chip === "both" || chip === "order") effects.push(patchEffect.of({ id: e.id, order: chip === "order" ? (derived.order === "rev" ? "file" : "rev") : derived.key === "both" ? derived.order : e.order }));
  const current = slice(view.state.doc, e.from, e.to);
  if (current !== target || e.open) view.dispatch({ changes: { from: e.from, to: e.to, insert: target }, effects, userEvent: "input.conflict", scrollIntoView: false });

  const after = view.state.field(cfField);
  const left = after.entries.filter((x) => x.open).length;
  const newDerived = after.derived.get(e.id) ?? derived;
  const label = chip === "reset" ? "reset to unresolved" : choiceLabel(newDerived.key, names, newDerived.order);
  const status = decisionStatus(idx + 1, total, label, left);
  const decision = chip === "ours" || chip === "theirs" || chip === "both" || chip === "neither";
  if (decision && wasOpen && !after.entries.find((x) => x.id === e.id)?.open) {
    // FR-562: only the FIRST decision moves focus; re-deciding a block never does.
    const next = after.entries.find((x) => x.open && x.from > e.from) ?? after.entries.find((x) => x.open);
    if (next) {
      const toN = after.entries.indexOf(next) + 1;
      goToEntry(view, next.id, true);
      opts.onEvent({ type: "advance", fromN: idx + 1, toN, total, status: `${status} Moved to conflict ${toN} of ${total}, unresolved. Undo returns to conflict ${idx + 1}.` });
    } else opts.onEvent({ type: "all-decided", status: `${status} All conflicts decided. Mark as resolved is available.` });
  } else opts.onEvent({ type: "status", status });
}

function editBlock(view: EditorView, e: Entry, derived: DerivedChoice): void {
  let insert: string | null = null;
  if (e.open) insert = textForChip("both", "file", e.ours, e.theirs);
  else if (e.to === e.from) insert = "\n";
  if (insert !== null) {
    const to = e.from + insert.length;
    view.dispatch({
      changes: { from: e.from, to: e.to, insert },
      effects: [placeEffect.of({ id: e.id, from: e.from, to })],
      userEvent: "input.conflict",
    });
  }
  void derived;
  const cur = view.state.field(cfField).entries.find((x) => x.id === e.id);
  if (!cur) return;
  const doc = view.state.doc;
  const pos = cur.to > cur.from ? doc.lineAt(Math.min(doc.length, Math.max(cur.from, cur.to - 1))).to : cur.from;
  view.dispatch({ selection: { anchor: pos }, effects: [EditorView.scrollIntoView(pos, { y: "nearest", yMargin: 40 }), currentEffect.of(cur.id)] });
  view.focus();
}

function focusChip(view: EditorView, id: number, left = 10): void {
  const dom = view.dom.querySelector<HTMLElement>(`[data-cf-id="${id}"]`);
  if (dom) {
    const key = rv(view).get(id) ?? "ours";
    (dom.querySelector<HTMLElement>(`[data-chip="${key}"]`) ?? dom.querySelector<HTMLElement>("[data-chip]"))?.focus({ preventScroll: true });
    return;
  }
  if (left > 0) requestAnimationFrame(() => focusChip(view, id, left - 1));
}

function goToEntry(view: EditorView, id: number, focus: boolean): void {
  const e = view.state.field(cfField).entries.find((x) => x.id === id);
  if (!e) return;
  const pos = view.state.doc.lineAt(Math.min(e.from, view.state.doc.length)).from;
  view.dispatch({ selection: { anchor: pos }, effects: [EditorView.scrollIntoView(pos, { y: "center" }), currentEffect.of(id)] });
  if (focus) focusChip(view, id);
}

export interface ConflictApi {
  next(): void;
  prev(): void;
  nextUnresolved(): void;
  /** Focus the current conflict's chip row (Esc from its text, FR-557). */
  focusChips(): void;
  undo(): void;
  redo(): void;
  summary(): ConflictSummary;
  /** Mark as resolved went through (or the file left the unmerged state): the layer is removed, the text is untouched. */
  disable(): void;
  /** Disk reload: forget the remembered sides and Custom slots (FR-560). */
  reset(): void;
}

export function conflictApi(view: EditorView): ConflictApi {
  const cur = () => {
    const st = view.state.field(cfField);
    const i = st.entries.findIndex((x) => x.id === st.currentId);
    return { st, i };
  };
  const step = (dir: 1 | -1) => {
    const { st, i } = cur();
    if (!st.entries.length) return;
    const to = i < 0 ? (dir === 1 ? 0 : st.entries.length - 1) : (i + dir + st.entries.length) % st.entries.length;
    goToEntry(view, st.entries[to]!.id, true);
  };
  return {
    next: () => step(1),
    prev: () => step(-1),
    nextUnresolved: () => {
      const { st, i } = cur();
      const open = st.entries.filter((x) => x.open);
      if (!open.length) return;
      const from = i < 0 ? -1 : st.entries[i]!.from;
      goToEntry(view, (open.find((x) => x.from > from) ?? open[0]!).id, true);
    },
    focusChips: () => {
      const { st } = cur();
      if (st.currentId !== null) focusChip(view, st.currentId);
    },
    undo: () => {
      undo(view);
      view.focus();
    },
    redo: () => {
      redo(view);
      view.focus();
    },
    summary: () => view.state.field(cfField).summary,
    disable: () => view.dispatch({ effects: enableEffect.of(false) }),
    reset: () => view.dispatch({ effects: resetEffect.of(null) }),
  };
}

/** Dispatch-ready effect for the disk-reload path in `CodeEditor.replaceAll`. */
export const conflictResetEffect = (): StateEffect<null> => resetEffect.of(null);

export function conflictExtension(options: ConflictEditorOptions): Extension {
  let lastSig = "";
  return [
    cfOptions.of(options),
    cfField,
    // Undo of a chip must restore the block's region exactly, not rely on position mapping across a replaced range.
    invertedEffects.of((tr) => {
      const out: StateEffect<unknown>[] = [];
      for (const e of tr.effects) {
        if (!e.is(placeEffect)) continue;
        const prev = tr.startState.field(cfField).entries.find((x) => x.id === e.value.id);
        if (prev) out.push(placeEffect.of({ id: prev.id, from: prev.from, to: prev.to }));
      }
      return out;
    }),
    EditorView.updateListener.of((u) => {
      const sum = u.state.field(cfField).summary;
      const sig = JSON.stringify(sum);
      if (sig === lastSig) return;
      lastSig = sig;
      options.onSummary(sum);
    }),
    Prec.high(
      keymap.of([
        {
          // FR-557: Esc from a block's text goes back to its chip row; Esc again (from the row) leaves the editor.
          key: "Escape",
          run: (view) => {
            const st = view.state.field(cfField);
            if (!st.enabled || view.composing || view.compositionStarted) return false;
            const at = entryAt(st.entries, view.state.selection.main.head);
            if (!at) return false;
            focusChip(view, at.id);
            return true;
          },
          preventDefault: true,
          stopPropagation: true,
        },
      ]),
    ),
  ];
}

/** Initial summary for the first render, before any update has fired. */
export function initialSummary(view: EditorView): ConflictSummary {
  return view.state.field(cfField, false)?.summary ?? EMPTY_SUMMARY;
}
