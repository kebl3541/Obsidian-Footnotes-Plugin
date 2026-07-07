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
