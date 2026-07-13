// Pure helpers for locating and rewriting Markdown footnotes.
// Kept free of Obsidian imports so the logic stays easy to test and reason about.

// A reference looks like `[^label]` used inside body text.
// A definition looks like `[^label]: text` anchored at the start of a line,
// optionally continued on following indented lines.

const REFERENCE_RE = /\[\^([^\]\s]+)\]/g;
const DEFINITION_HEAD_RE = /^\[\^([^\]\s]+)\]:[ \t]?/;

export interface FootnoteReference {
  label: string;
  from: number; // column of the opening bracket
  to: number; // column just past the closing bracket
}

export interface FootnoteDefinition {
  label: string;
  startLine: number;
  endLine: number; // inclusive; last line belonging to this definition
  content: string; // text with continuation lines de-indented and joined by "\n"
}

// Find every `[^label]` reference on a single line. Definitions are excluded
// because their bracket is immediately followed by a colon.
export function referencesOnLine(line: string): FootnoteReference[] {
  const out: FootnoteReference[] = [];
  REFERENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REFERENCE_RE.exec(line)) !== null) {
    const after = line[m.index + m[0].length];
    if (after === ":") continue; // this is a definition head, not a reference
    out.push({ label: m[1], from: m.index, to: m.index + m[0].length });
  }
  return out;
}

// If `col` sits inside a reference on `line`, return that reference.
export function referenceAt(line: string, col: number): FootnoteReference | null {
  for (const ref of referencesOnLine(line)) {
    if (col >= ref.from && col <= ref.to) return ref;
  }
  return null;
}

// Like referenceAt, but if none contains `col`, return the closest reference
// on the line (used when a click maps to a position just beside the marker).
export function nearestReference(
  line: string,
  col: number
): FootnoteReference | null {
  const refs = referencesOnLine(line);
  if (refs.length === 0) return null;
  for (const r of refs) if (col >= r.from && col <= r.to) return r;
  let best = refs[0];
  let bestDist = Infinity;
  for (const r of refs) {
    const d = col < r.from ? r.from - col : col - r.to;
    if (d < bestDist) {
      bestDist = d;
      best = r;
    }
  }
  return best;
}

// Return the label of the n-th footnote (1-based) in display order, i.e. the
// order footnotes are first referenced. Lets a reading-view click on the
// rendered number "3" resolve to the right label even when it isn't numeric.
export function nthReferencedLabel(lines: string[], n: number): string | null {
  if (n < 1) return null;
  const seen = new Set<string>();
  const order: string[] = [];
  for (const line of lines) {
    for (const ref of referencesOnLine(line)) {
      if (!seen.has(ref.label)) {
        seen.add(ref.label);
        order.push(ref.label);
      }
    }
  }
  return order[n - 1] ?? null;
}

// If `line` is a definition head, return its label, else null.
export function definitionLabelOnLine(line: string): string | null {
  const m = line.match(DEFINITION_HEAD_RE);
  return m ? m[1] : null;
}

// Locate the full definition block for `label` across all lines.
// Continuation lines are those indented with a space or tab.
export function findDefinition(
  lines: string[],
  label: string
): FootnoteDefinition | null {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(DEFINITION_HEAD_RE);
    if (!m || m[1] !== label) continue;

    const firstText = lines[i].slice(m[0].length);
    const parts = [firstText];
    let end = i;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^[ \t]+\S/.test(lines[j]) || lines[j].trim() === "") {
        // Indented continuation, or a blank line that may be followed by more.
        if (lines[j].trim() === "") {
          // Only absorb a blank line if a further indented line follows.
          const next = lines[j + 1];
          if (next && /^[ \t]+\S/.test(next)) {
            parts.push("");
            end = j;
            continue;
          }
          break;
        }
        parts.push(lines[j].replace(/^[ \t]+/, ""));
        end = j;
      } else {
        break;
      }
    }
    return { label, startLine: i, endLine: end, content: parts.join("\n") };
  }
  return null;
}

// Render a definition block back to Markdown lines.
// Continuation lines are indented four spaces so Obsidian keeps them attached.
export function renderDefinition(label: string, content: string): string {
  const [first, ...rest] = content.split("\n");
  const head = `[^${label}]: ${first}`;
  if (rest.length === 0) return head;
  return [head, ...rest.map((l) => (l.length ? `    ${l}` : ""))].join("\n");
}

// Collect all labels currently used anywhere in the document.
export function allLabels(lines: string[]): Set<string> {
  const labels = new Set<string>();
  for (const line of lines) {
    const def = definitionLabelOnLine(line);
    if (def) labels.add(def);
    for (const ref of referencesOnLine(line)) labels.add(ref.label);
  }
  return labels;
}

// Pick the next numeric label not yet used (1, 2, 3, ...).
export function nextNumericLabel(lines: string[]): string {
  const labels = allLabels(lines);
  let n = 1;
  while (labels.has(String(n))) n++;
  return String(n);
}

// ---- Word-like tidying ------------------------------------------------------
// The goal: footnotes behave like they do in Word. Deleting a definition also
// removes its in-text markers; deleting the last marker also removes the
// definition; numeric footnotes are always numbered 1, 2, 3… in reading
// order; and the definitions block stays sorted to match. Renaming a
// definition's label moves its markers along instead of orphaning them.

export interface FootnoteSnapshot {
  refs: Map<string, number>; // label → how many in-text markers
  defs: Map<string, string>; // label → definition content
}

export function snapshotFootnotes(lines: string[]): FootnoteSnapshot {
  const refs = new Map<string, number>();
  const defs = new Map<string, string>();
  for (const line of lines) {
    const d = definitionLabelOnLine(line);
    if (d && !defs.has(d)) {
      const def = findDefinition(lines, d);
      if (def) defs.set(d, def.content);
    }
    for (const r of referencesOnLine(line)) {
      refs.set(r.label, (refs.get(r.label) ?? 0) + 1);
    }
  }
  return { refs, defs };
}

export interface TidyPlan {
  removeRefLabels: Set<string>; // definition deleted → markers must go
  removeDefLabels: Set<string>; // last marker deleted → definition must go
  renameRefs: Map<string, string>; // definition label edited → markers follow
}

export function planCleanup(prev: FootnoteSnapshot, cur: FootnoteSnapshot): TidyPlan {
  const plan: TidyPlan = {
    removeRefLabels: new Set(),
    removeDefLabels: new Set(),
    renameRefs: new Map(),
  };
  for (const [label, content] of prev.defs) {
    if ((prev.refs.get(label) ?? 0) === 0) continue; // was already orphaned; not our doing
    const defNow = cur.defs.has(label);
    const refsNow = (cur.refs.get(label) ?? 0) > 0;
    if (!defNow && refsNow) {
      // The definition vanished. If an identical definition appeared under a
      // fresh label with no markers of its own, the user renamed it.
      let renamed: string | null = null;
      if (content.trim() !== "") {
        for (const [l2, c2] of cur.defs) {
          if (
            l2 !== label &&
            !prev.defs.has(l2) &&
            c2 === content &&
            (cur.refs.get(l2) ?? 0) === 0
          ) {
            renamed = l2;
            break;
          }
        }
      }
      if (renamed) plan.renameRefs.set(label, renamed);
      else plan.removeRefLabels.add(label);
    } else if (defNow && !refsNow) {
      plan.removeDefLabels.add(label);
    }
  }
  return plan;
}

// Rewrite the in-text markers on one line per the plan. Definition heads are
// untouched here (referencesOnLine already excludes them).
function rewriteLineRefs(line: string, plan: TidyPlan): string {
  const refs = referencesOnLine(line);
  let out = line;
  for (let i = refs.length - 1; i >= 0; i--) {
    const r = refs[i];
    if (plan.removeRefLabels.has(r.label)) {
      out = out.slice(0, r.from) + out.slice(r.to);
    } else {
      const to = plan.renameRefs.get(r.label);
      if (to) out = out.slice(0, r.from) + `[^${to}]` + out.slice(r.to);
    }
  }
  return out;
}

export function applyPlan(lines: string[], plan: TidyPlan): string[] {
  let out = lines.map((l) => rewriteLineRefs(l, plan));
  for (const label of plan.removeDefLabels) {
    const def = findDefinition(out, label);
    if (!def) continue;
    out.splice(def.startLine, def.endLine - def.startLine + 1);
    // Collapse a doubled blank left behind by the removal.
    const at = def.startLine;
    if (
      at > 0 &&
      out[at - 1]?.trim() === "" &&
      (at >= out.length || out[at]?.trim() === "")
    ) {
      out.splice(at - 1, 1);
    }
  }
  // Trim trailing blank lines left by deletions at the end of the note.
  while (out.length > 1 && out[out.length - 1].trim() === "" ) out.pop();
  return out;
}

const NUMERIC_RE = /^[0-9]+$/;

// First-appearance order of every referenced label, body text first.
function referenceOrder(lines: string[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const line of lines) {
    for (const r of referencesOnLine(line)) {
      if (!seen.has(r.label)) {
        seen.add(r.label);
        order.push(r.label);
      }
    }
  }
  return order;
}

// Renumber numeric footnotes 1, 2, 3… in reading order. Named labels are left
// alone. Returns the old→new mapping (identity entries omitted).
export function renumberFootnotes(lines: string[]): {
  lines: string[];
  mapping: Map<string, string>;
} {
  const snap = snapshotFootnotes(lines);
  const numbered = referenceOrder(lines).filter(
    (l) => NUMERIC_RE.test(l) && snap.defs.has(l)
  );
  const mapping = new Map<string, string>();
  numbered.forEach((label, i) => {
    const next = String(i + 1);
    if (label !== next) mapping.set(label, next);
  });
  if (mapping.size === 0) return { lines, mapping };

  const out = lines.map((line) => {
    const defLabel = definitionLabelOnLine(line);
    let next = line;
    if (defLabel && mapping.has(defLabel)) {
      next = next.replace(
        DEFINITION_HEAD_RE,
        (m, l) => m.replace(`[^${l}]`, `[^${mapping.get(l) ?? l}]`)
      );
    }
    const refs = referencesOnLine(next);
    for (let i = refs.length - 1; i >= 0; i--) {
      const r = refs[i];
      const to = mapping.get(r.label);
      if (to) next = next.slice(0, r.from) + `[^${to}]` + next.slice(r.to);
    }
    return next;
  });
  return { lines: out, mapping };
}

// Keep the trailing definitions block sorted in reading order, the way Word
// keeps its footnote area. Bails out unless every definition sits in one
// contiguous block at the end of the note (nothing else gets moved around).
export function sortDefinitionBlock(lines: string[]): string[] {
  const total = new Set<string>();
  for (const line of lines) {
    const d = definitionLabelOnLine(line);
    if (d) total.add(d);
  }
  if (total.size < 2) return lines;

  // Walk up from the end over definitions, their continuations, and blanks.
  let start = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i];
    if (t.trim() === "" || definitionLabelOnLine(t) || /^[ \t]+\S/.test(t)) {
      start = i;
      continue;
    }
    break;
  }
  // Trim leading blanks of the region.
  while (start < lines.length && lines[start].trim() === "") start++;
  if (start >= lines.length || !definitionLabelOnLine(lines[start])) return lines;

  const region = lines.slice(start);
  const inBlock = new Set<string>();
  for (const line of region) {
    const d = definitionLabelOnLine(line);
    if (d) inBlock.add(d);
  }
  if (inBlock.size !== total.size) return lines; // definitions elsewhere; leave

  const defs = new Map<string, FootnoteDefinition>();
  for (const label of inBlock) {
    const def = findDefinition(lines, label);
    if (!def || def.startLine < start) return lines;
    defs.set(label, def);
  }

  const order = referenceOrder(lines.slice(0, start)).filter((l) => defs.has(l));
  for (const label of inBlock) {
    if (!order.includes(label)) order.push(label); // unreferenced defs keep the tail
  }

  const rendered = order.map((l) => renderDefinition(l, defs.get(l)?.content ?? ""));
  const body = lines.slice(0, start);
  while (body.length > 0 && body[body.length - 1].trim() === "") body.pop();
  const next = body.length > 0 ? [...body, "", ...rendered] : rendered;
  return next.join("\n") === lines.join("\n") ? lines : next;
}

// Insert a new auto-numbered footnote as ONE text transformation: marker at
// `offset`, empty definition in the block, everything renumbered and sorted.
// The returned text never contains an intermediate label, so the editor can
// go from old to final in a single atomic edit — no flash of a wrong number.
export function insertFootnoteAt(
  text: string,
  offset: number
): { text: string; label: string; mapping: Map<string, string> } {
  const tmp = nextNumericLabel(text.split("\n"));
  let withRef = text.slice(0, offset) + `[^${tmp}]` + text.slice(offset);

  // Append the empty definition the same way appendDefinition used to,
  // then let the tidy pass place and number everything properly.
  const endsInDefBlock = (() => {
    const lines = withRef.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i];
      if (definitionLabelOnLine(t)) return true;
      if (t.trim() === "" || /^[ \t]+\S/.test(t)) continue;
      return false;
    }
    return false;
  })();
  const trimmed = withRef.replace(/\n+$/, "");
  withRef = trimmed + (endsInDefBlock ? "\n" : "\n\n") + `[^${tmp}]: `;

  const tidied = tidyFootnotes(null, withRef);
  return {
    text: tidied.text,
    label: tidied.mapping.get(tmp) ?? tmp,
    mapping: tidied.mapping,
  };
}

export interface TidyResult {
  text: string;
  changed: boolean;
  mapping: Map<string, string>;
  removedRefs: string[];
  removedDefs: string[];
}

// One pass of the whole Word-like discipline. `prev` is the snapshot from
// before the user's edit; pass null to skip cleanup and only renumber/sort.
export function tidyFootnotes(prev: FootnoteSnapshot | null, text: string): TidyResult {
  let lines = text.split("\n");
  let removedRefs: string[] = [];
  let removedDefs: string[] = [];
  if (prev) {
    const plan = planCleanup(prev, snapshotFootnotes(lines));
    if (
      plan.removeRefLabels.size ||
      plan.removeDefLabels.size ||
      plan.renameRefs.size
    ) {
      removedRefs = [...plan.removeRefLabels];
      removedDefs = [...plan.removeDefLabels];
      lines = applyPlan(lines, plan);
    }
  }
  const renumbered = renumberFootnotes(lines);
  lines = sortDefinitionBlock(renumbered.lines);
  const out = lines.join("\n");
  return {
    text: out,
    changed: out !== text,
    mapping: renumbered.mapping,
    removedRefs,
    removedDefs,
  };
}
