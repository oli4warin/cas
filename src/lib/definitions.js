// Tracks the variables and functions the user has defined in the CAS session (via
// `name:=expr` / `f(x):=expr`, and `purge(name)` to undo one) so the plot panel can list
// what's available to graph. This mirrors state the Giac worker already holds internally -
// we don't query the engine for it because Giac has no simple "list user identifiers" call,
// so we infer it from the same input lines the user already submitted successfully.

const IDENT = '[A-Za-z_][A-Za-z0-9_]*';
const FUNC_DEF_RE = new RegExp(`^(${IDENT})\\s*\\(\\s*(${IDENT}(?:\\s*,\\s*${IDENT})*)\\s*\\)\\s*:=\\s*(.+)$`);
const VAR_DEF_RE = new RegExp(`^(${IDENT})\\s*:=\\s*(.+)$`);
const PURGE_RE = new RegExp(`^purge\\s*\\(\\s*(${IDENT}(?:\\s*,\\s*${IDENT})*)\\s*\\)\\s*$`);

export function parseDefinition(expr) {
  const s = expr.trim();
  let m = s.match(FUNC_DEF_RE);
  if (m) {
    return { kind: 'function', name: m[1], params: m[2].split(',').map((p) => p.trim()), body: m[3].trim() };
  }
  m = s.match(VAR_DEF_RE);
  if (m) {
    return { kind: 'variable', name: m[1], body: m[2].trim() };
  }
  return null;
}

function parsePurge(expr) {
  const m = expr.trim().match(PURGE_RE);
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
