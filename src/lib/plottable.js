// Decides whether a history entry's output can be offered as y = f(x) in the plot panel -
// shared by the entry's own "plot" button (see components/historyEntry.js) and the "p"
// keyboard shortcut on a selected output (see app.js), so both agree on exactly the same
// entries.

import { parseDefinition } from './definitions.js';
import { isPlottableInX, reinsertableValue } from './giac.js';

// Two shapes count as plottable: a function this session just defined with exactly one
// parameter (f(x):=..., or even f(t):=... - calling it back as "f(x)" always comes out as
// an expression in x regardless of what the definition itself calls its own parameter,
// since Giac substitutes whatever's actually passed), or a plain result that's free in "x"
// (e.g. expand((x+1)^2) => "x^2+2*x+1", or "a*x+b" - "a" and "b" just pick up sliders in the
// plot panel, see lib/plotParams.js). Returns the Giac expression to hand the plot panel, or
// null if this entry isn't offerable at all (an error, an equation, or a result that doesn't
// actually mention x).
export function plottableExprForEntry(entry) {
  if (!entry || entry.isError) return null;

  const def = parseDefinition(entry.input);
  if (def && def.kind === 'function' && def.params.length === 1) {
    return `${def.name}(x)`;
  }

  const raw = reinsertableValue(entry.raw ?? '');
  return isPlottableInX(raw) ? raw : null;
}
