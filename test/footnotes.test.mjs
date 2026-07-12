// Tests for the Word-like tidying engine. Run via `npm test`.
import {
  insertFootnoteAt,
  snapshotFootnotes,
  tidyFootnotes,
  renumberFootnotes,
  sortDefinitionBlock,
} from "./footnotes.build.mjs";

let failures = 0;
let checks = 0;
function eq(actual, expected, name) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`FAIL ${name}\n  actual:   ${a}\n  expected: ${e}`);
  }
}

const snap = (text) => snapshotFootnotes(text.split("\n"));

// 1. Deleting a definition at the end removes the marker and renumbers.
{
  const before = "One[^1] two[^2] three[^3].\n\n[^1]: a\n[^2]: b\n[^3]: c";
  const after = "One[^1] two[^2] three[^3].\n\n[^1]: a\n[^3]: c"; // user deleted [^2]
  const r = tidyFootnotes(snap(before), after);
  eq(r.text, "One[^1] two three[^2].\n\n[^1]: a\n[^2]: c", "delete definition → marker gone, renumbered");
  eq(r.removedRefs, ["2"], "delete definition → reports removed marker");
}

// 2. Deleting the last in-text marker removes the definition.
{
  const before = "One[^1] two[^2].\n\n[^1]: a\n[^2]: b";
  const after = "One[^1] two.\n\n[^1]: a\n[^2]: b"; // user deleted the [^2] marker
  const r = tidyFootnotes(snap(before), after);
  eq(r.text, "One[^1] two.\n\n[^1]: a", "delete marker → definition gone");
  eq(r.removedDefs, ["2"], "delete marker → reports removed definition");
}

// 3. Renaming a definition label moves the markers along.
{
  const before = "Kant said[^1].\n\n[^1]: Critique, B132.";
  const after = "Kant said[^1].\n\n[^kant]: Critique, B132."; // user renamed
  const r = tidyFootnotes(snap(before), after);
  eq(r.text, "Kant said[^kant].\n\n[^kant]: Critique, B132.", "rename definition → markers follow");
}

// 4. Inserting mid-text renumbers positionally (Word order).
{
  const text = "Alpha[^2] beta[^1].\n\n[^1]: first written\n[^2]: second written";
  const r = tidyFootnotes(null, text);
  eq(
    r.text,
    "Alpha[^1] beta[^2].\n\n[^1]: second written\n[^2]: first written",
    "renumber by reading order and sort definitions"
  );
  eq([...r.mapping.entries()], [["2", "1"], ["1", "2"]], "mapping reported");
}

// 5. Named footnotes keep their labels and are not renumbered.
{
  const text = "See[^note] and[^2].\n\n[^note]: named\n[^2]: numbered";
  const r = tidyFootnotes(null, text);
  eq(
    r.text,
    "See[^note] and[^1].\n\n[^note]: named\n[^1]: numbered",
    "named labels untouched, numeric renumbered around them"
  );
}

// 6. No-op documents stay byte-identical.
{
  const text = "Plain[^1] text[^2].\n\n[^1]: a\n[^2]: b";
  const r = tidyFootnotes(snap(text), text);
  eq(r.changed, false, "clean document unchanged");
}

// 7. Multi-line definitions survive sorting intact.
{
  const text = "A[^2] B[^1].\n\n[^1]: first line\n    second line\n[^2]: other";
  const r = tidyFootnotes(null, text);
  eq(
    r.text,
    "A[^1] B[^2].\n\n[^1]: other\n[^2]: first line\n    second line",
    "multi-line definition sorted whole"
  );
}

// 8. Definitions scattered mid-document are not reordered (only relabeled).
{
  const text = "A[^2].\n\n[^2]: early def\n\nMore body text.\n";
  const r = tidyFootnotes(null, text);
  eq(r.text.includes("[^1]: early def"), true, "mid-doc def relabeled");
  eq(r.text.includes("More body text."), true, "body preserved");
}

// 9. A reference typed before its definition exists is left alone.
{
  const before = "Text[^1].\n\n[^1]: a";
  const after = "Text[^1] new[^2].\n\n[^1]: a"; // [^2] typed, def not written yet
  const r = tidyFootnotes(snap(before), after);
  eq(r.text, after, "half-written footnote untouched");
}

// 10. Deleting one of two markers keeps definition and the other marker.
{
  const before = "A[^1] B[^1].\n\n[^1]: shared";
  const after = "A[^1] B.\n\n[^1]: shared";
  const r = tidyFootnotes(snap(before), after);
  eq(r.text, after, "definition kept while a marker remains");
}

// 11. renumberFootnotes alone: gap closes.
{
  const { lines } = renumberFootnotes("X[^1] Y[^3].\n\n[^1]: a\n[^3]: c".split("\n"));
  eq(lines.join("\n"), "X[^1] Y[^2].\n\n[^1]: a\n[^2]: c", "gap in numbering closes");
}

// 12. sortDefinitionBlock bails when a definition sits mid-document.
{
  const text = "A[^1].\n\n[^2]: mid def\n\nB[^2].\n\n[^1]: end def";
  const sorted = sortDefinitionBlock(text.split("\n"));
  eq(sorted.join("\n"), text, "scattered definitions not reordered");
}

// 13. Atomic insert at the top of a 4-footnote note: born as [^1], one text.
{
  const text =
    "Top line here.\n\nBody[^1] b[^2] c[^3] d[^4].\n\n[^1]: one\n[^2]: two\n[^3]: three\n[^4]: four";
  const r = insertFootnoteAt(text, 8); // inside "Top line|"
  eq(r.label, "1", "insert at top → label 1 immediately, never 5");
  eq(r.text.startsWith("Top line[^1] here."), true, "marker carries its final number");
  const defs = [...r.text.matchAll(/^\[\^(\d+)\]:/gm)].map((m) => m[1]);
  eq(defs, ["1", "2", "3", "4", "5"], "definition block sorted 1..5");
  const newDefLine = r.text.split("\n").find((l) => l.startsWith("[^1]:"));
  eq(newDefLine, "[^1]: ", "the new definition is [^1] and empty");
  eq(r.text.includes("[^5]: four"), true, "old fourth footnote becomes 5");
}

// 14. Atomic insert after all existing refs gets the last number.
{
  const text = "A[^1] B[^2].\n\n[^1]: a\n[^2]: b";
  const r = insertFootnoteAt(text, text.indexOf(".") + 1);
  eq(r.label, "3", "insert at end → label 3");
}

// 15. An orphan reference doesn't disturb insert numbering.
{
  const text = "X[^1] orphan[^9].\n\n[^1]: a";
  const r = insertFootnoteAt(text, 1);
  eq(r.label, "1", "orphan [^9] ignored; new footnote is 1");
  eq(r.text.includes("orphan[^9]"), true, "orphan marker untouched");
}

if (failures > 0) {
  console.error(`${failures}/${checks} checks failed`);
  process.exit(1);
}
console.log(`footnote tidy: ${checks} checks passed`);
