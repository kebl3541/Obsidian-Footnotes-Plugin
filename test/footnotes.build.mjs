const REFERENCE_RE = /\[\^([^\]\s]+)\]/g;
const DEFINITION_HEAD_RE = /^\[\^([^\]\s]+)\]:[ \t]?/;
function referencesOnLine(line) {
  const out = [];
  REFERENCE_RE.lastIndex = 0;
  let m;
  while ((m = REFERENCE_RE.exec(line)) !== null) {
    const after = line[m.index + m[0].length];
    if (after === ":")
      continue;
    out.push({ label: m[1], from: m.index, to: m.index + m[0].length });
  }
  return out;
}
function referenceAt(line, col) {
  for (const ref of referencesOnLine(line)) {
    if (col >= ref.from && col <= ref.to)
      return ref;
  }
  return null;
}
function nearestReference(line, col) {
  const refs = referencesOnLine(line);
  if (refs.length === 0)
    return null;
  for (const r of refs)
    if (col >= r.from && col <= r.to)
      return r;
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
function nthReferencedLabel(lines, n) {
  if (n < 1)
    return null;
  const seen = /* @__PURE__ */ new Set();
  const order = [];
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
function definitionLabelOnLine(line) {
  const m = line.match(DEFINITION_HEAD_RE);
  return m ? m[1] : null;
}
function findDefinition(lines, label) {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(DEFINITION_HEAD_RE);
    if (!m || m[1] !== label)
      continue;
    const firstText = lines[i].slice(m[0].length);
    const parts = [firstText];
    let end = i;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^[ \t]+\S/.test(lines[j]) || lines[j].trim() === "") {
        if (lines[j].trim() === "") {
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
function renderDefinition(label, content) {
  const [first, ...rest] = content.split("\n");
  const head = `[^${label}]: ${first}`;
  if (rest.length === 0)
    return head;
  return [head, ...rest.map((l) => l.length ? `    ${l}` : "")].join("\n");
}
function allLabels(lines) {
  const labels = /* @__PURE__ */ new Set();
  for (const line of lines) {
    const def = definitionLabelOnLine(line);
    if (def)
      labels.add(def);
    for (const ref of referencesOnLine(line))
      labels.add(ref.label);
  }
  return labels;
}
function nextNumericLabel(lines) {
  const labels = allLabels(lines);
  let n = 1;
  while (labels.has(String(n)))
    n++;
  return String(n);
}
function snapshotFootnotes(lines) {
  const refs = /* @__PURE__ */ new Map();
  const defs = /* @__PURE__ */ new Map();
  for (const line of lines) {
    const d = definitionLabelOnLine(line);
    if (d && !defs.has(d)) {
      const def = findDefinition(lines, d);
      if (def)
        defs.set(d, def.content);
    }
    for (const r of referencesOnLine(line)) {
      refs.set(r.label, (refs.get(r.label) ?? 0) + 1);
    }
  }
  return { refs, defs };
}
function planCleanup(prev, cur) {
  const plan = {
    removeRefLabels: /* @__PURE__ */ new Set(),
    removeDefLabels: /* @__PURE__ */ new Set(),
    renameRefs: /* @__PURE__ */ new Map()
  };
  for (const [label, content] of prev.defs) {
    if ((prev.refs.get(label) ?? 0) === 0)
      continue;
    const defNow = cur.defs.has(label);
    const refsNow = (cur.refs.get(label) ?? 0) > 0;
    if (!defNow && refsNow) {
      let renamed = null;
      if (content.trim() !== "") {
        for (const [l2, c2] of cur.defs) {
          if (l2 !== label && !prev.defs.has(l2) && c2 === content && (cur.refs.get(l2) ?? 0) === 0) {
            renamed = l2;
            break;
          }
        }
      }
      if (renamed)
        plan.renameRefs.set(label, renamed);
      else
        plan.removeRefLabels.add(label);
    } else if (defNow && !refsNow) {
      plan.removeDefLabels.add(label);
    }
  }
  return plan;
}
function rewriteLineRefs(line, plan) {
  const refs = referencesOnLine(line);
  let out = line;
  for (let i = refs.length - 1; i >= 0; i--) {
    const r = refs[i];
    if (plan.removeRefLabels.has(r.label)) {
      out = out.slice(0, r.from) + out.slice(r.to);
    } else {
      const to = plan.renameRefs.get(r.label);
      if (to)
        out = out.slice(0, r.from) + `[^${to}]` + out.slice(r.to);
    }
  }
  return out;
}
function applyPlan(lines, plan) {
  let out = lines.map((l) => rewriteLineRefs(l, plan));
  for (const label of plan.removeDefLabels) {
    const def = findDefinition(out, label);
    if (!def)
      continue;
    out.splice(def.startLine, def.endLine - def.startLine + 1);
    const at = def.startLine;
    if (at > 0 && out[at - 1]?.trim() === "" && (at >= out.length || out[at]?.trim() === "")) {
      out.splice(at - 1, 1);
    }
  }
  while (out.length > 1 && out[out.length - 1].trim() === "")
    out.pop();
  return out;
}
const NUMERIC_RE = /^[0-9]+$/;
function referenceOrder(lines) {
  const seen = /* @__PURE__ */ new Set();
  const order = [];
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
function renumberFootnotes(lines) {
  const snap = snapshotFootnotes(lines);
  const numbered = referenceOrder(lines).filter(
    (l) => NUMERIC_RE.test(l) && snap.defs.has(l)
  );
  const mapping = /* @__PURE__ */ new Map();
  numbered.forEach((label, i) => {
    const next = String(i + 1);
    if (label !== next)
      mapping.set(label, next);
  });
  if (mapping.size === 0)
    return { lines, mapping };
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
      if (to)
        next = next.slice(0, r.from) + `[^${to}]` + next.slice(r.to);
    }
    return next;
  });
  return { lines: out, mapping };
}
function sortDefinitionBlock(lines) {
  const total = /* @__PURE__ */ new Set();
  for (const line of lines) {
    const d = definitionLabelOnLine(line);
    if (d)
      total.add(d);
  }
  if (total.size < 2)
    return lines;
  let start = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i];
    if (t.trim() === "" || definitionLabelOnLine(t) || /^[ \t]+\S/.test(t)) {
      start = i;
      continue;
    }
    break;
  }
  while (start < lines.length && lines[start].trim() === "")
    start++;
  if (start >= lines.length || !definitionLabelOnLine(lines[start]))
    return lines;
  const region = lines.slice(start);
  const inBlock = /* @__PURE__ */ new Set();
  for (const line of region) {
    const d = definitionLabelOnLine(line);
    if (d)
      inBlock.add(d);
  }
  if (inBlock.size !== total.size)
    return lines;
  const defs = /* @__PURE__ */ new Map();
  for (const label of inBlock) {
    const def = findDefinition(lines, label);
    if (!def || def.startLine < start)
      return lines;
    defs.set(label, def);
  }
  const order = referenceOrder(lines.slice(0, start)).filter((l) => defs.has(l));
  for (const label of inBlock) {
    if (!order.includes(label))
      order.push(label);
  }
  const rendered = order.map((l) => renderDefinition(l, defs.get(l)?.content ?? ""));
  const body = lines.slice(0, start);
  while (body.length > 0 && body[body.length - 1].trim() === "")
    body.pop();
  const next = body.length > 0 ? [...body, "", ...rendered] : rendered;
  return next.join("\n") === lines.join("\n") ? lines : next;
}
function tidyFootnotes(prev, text) {
  let lines = text.split("\n");
  let removedRefs = [];
  let removedDefs = [];
  if (prev) {
    const plan = planCleanup(prev, snapshotFootnotes(lines));
    if (plan.removeRefLabels.size || plan.removeDefLabels.size || plan.renameRefs.size) {
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
    removedDefs
  };
}
export {
  allLabels,
  applyPlan,
  definitionLabelOnLine,
  findDefinition,
  nearestReference,
  nextNumericLabel,
  nthReferencedLabel,
  planCleanup,
  referenceAt,
  referencesOnLine,
  renderDefinition,
  renumberFootnotes,
  snapshotFootnotes,
  sortDefinitionBlock,
  tidyFootnotes
};
