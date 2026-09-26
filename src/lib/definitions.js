// Tracks the variables and functions the user has defined in the CAS session (via
// `name:=expr` / `f(x):=expr`, and `purge(name)` to undo one) so the plot panel can list
// what's available to graph. This mirrors state the Giac worker already holds internally -
// we don't query the engine for it because Giac has no simple "list user identifiers" call,
// so we infer it from the same input lines the user already submitted successfully.

import { isVectorLiteral } from './giacToLatex.js';

const IDENT = '[A-Za-z_][A-Za-z0-9_]*';
const FUNC_DEF_RE = new RegExp(`^(${IDENT})\\s*\\(\\s*(${IDENT}(?:\\s*,\\s*${IDENT})*)\\s*\\)\\s*:=\\s*(.+)$`);
const VAR_DEF_RE = new RegExp(`^(${IDENT})\\s*:=\\s*(.+)$`);
const MULTI_VAR_DEF_RE = new RegExp(`^(${IDENT}(?:\\s*,\\s*${IDENT})+)\\s*:=\\s*(.+)$`);
const PURGE_RE = new RegExp(`^purge\\s*\\(\\s*(${IDENT}(?:\\s*,\\s*${IDENT})*)\\s*\\)\\s*$`);

// Xcas statements are conventionally allowed a trailing ";" (Giac itself strips it before
// evaluating - see stripTrailingSemicolon in giac.js) - strip it here too before matching so
// e.g. "purge(a);" is recognized the same as "purge(a)" instead of silently falling through
// to "no definition/purge found here".
function stripTrailingSemicolon(s) {
  return s.endsWith(';') ? s.slice(0, -1).trim() : s;
}

// Splits a bracketed list's inner text on top-level commas only (ignoring commas nested
// inside further brackets/parens/braces), e.g. "1,[2,3],4" -> ["1", "[2,3]", "4"].
function splitTopLevelCommas(s) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

export function parseDefinition(expr) {
  const s = stripTrailingSemicolon(expr.trim());
  let m = s.match(FUNC_DEF_RE);
  if (m) {
    return { kind: 'function', name: m[1], params: m[2].split(',').map((p) => p.trim()), body: m[3].trim() };
  }
  m = s.match(VAR_DEF_RE);
  if (m) {
    const body = m[2].trim();
    return { kind: 'variable', name: m[1], body, isVector: isVectorLiteral(body) };
  }
  return null;
}

// Xcas's simultaneous-assignment form, e.g. "a,b:=[1,2]" - binds every name on the left at
// once, so each one has to count as "defined" (for plotParams.js's slider-exclusion check)
// just like a plain "a:=1" does. The exact per-name value isn't read anywhere else in the app
// (only whether a name `.has()` a definition matters - see collectFreeVariables in giac.js),
// so a best-effort pairing with the right-hand list's elements is enough; a shape that doesn't
// line up 1:1 just falls back to giving every name the whole right-hand text as a placeholder.
export function parseMultiDefinition(expr) {
  const s = stripTrailingSemicolon(expr.trim());
  const m = s.match(MULTI_VAR_DEF_RE);
  if (!m) return null;
  const names = m[1].split(',').map((n) => n.trim());
  let rhs = m[2].trim();
  if (rhs.startsWith('[') && rhs.endsWith(']')) rhs = rhs.slice(1, -1);
  const values = splitTopLevelCommas(rhs).map((v) => v.trim());
  return names.map((name, i) => {
    const body = values.length === names.length ? values[i] : rhs;
    return { kind: 'variable', name, body, isVector: isVectorLiteral(body) };
  });
}

function parsePurge(expr) {
  const m = stripTrailingSemicolon(expr.trim()).match(PURGE_RE);
  return m ? m[1].split(',').map((p) => p.trim()) : null;
}

// Folds one successfully-evaluated history entry into a definitions map. Returns the same
// map reference when nothing changed, so callers can skip re-renders/broadcasts on plain
// evaluations like `2+2`.
export function applyEntryToDefinitions(definitions, expr, result) {
  if (result.isError) return definitions;

  const def = parseDefinition(expr);
  if (def) {
    const next = new Map(definitions);
    next.set(def.name, def);
    return next;
  }

  const multiDefs = parseMultiDefinition(expr);
  if (multiDefs) {
    const next = new Map(definitions);
    for (const d of multiDefs) next.set(d.name, d);
    return next;
  }

  const purged = parsePurge(expr);
  if (purged && purged.length) {
    let changed = false;
    const next = new Map(definitions);
    for (const name of purged) {
      if (next.delete(name)) changed = true;
    }
    return changed ? next : definitions;
  }

  return definitions;
}

export function definitionLabel(def) {
  return def.kind === 'function' ? `${def.name}(${def.params.join(',')})` : def.name;
}

// Names of every currently-defined variable whose saved value is a vector literal (see
// isVectorLiteral/lib/giacToLatex.js) - passed to giacToLatex()/linesToGatheredLatex() so a
// bare reference to one of these names renders with an overhead arrow, everywhere it's typed
// afterwards, matching how the name was originally saved (e.g. "a:=[1,2,3]" -> every later "a"
// renders as "\vec{a}").
export function vectorNames(definitions) {
  const names = new Set();
  for (const def of definitions.values()) {
    if (def.kind === 'variable' && def.isVector) names.add(def.name);
  }
  return names;
}
