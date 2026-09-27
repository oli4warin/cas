// Decides whether a history entry's *input* or *output* can be offered to the 3D plot panel -
// the 3D sibling of lib/plottable.js, used the same way by the entry's own two "3d" buttons
// (see components/historyEntry.js) and the "3" keyboard shortcut (see app.js's handleKeyDown,
// where "p"/"3" are each other's exact 2D/3D siblings). The two *input* checks below never
// overlap with lib/plottable.js's own plottableInputForEntry - a 2-variable function definition
// or a system that actually mentions z (see parseSystemLines' own allowedVars check) isn't
// something the 2D checks match either. The *output* check is different: plottable3dOutputForEntry
// and plottable.js's plottableOutputForEntry deliberately DO both match a result free in both x
// and y (e.g. "sin(x*y)") - that's a surface to the 3D panel and, just as validly, a curve in x
// (with y along for the ride, same as any other extra free identifier - see plotParams.js) to
// the 2D one, so both the "plot" and "3d" buttons/keys are offered for it at once rather than
// one silently winning.

import { parseDefinition } from './definitions.js';
import { isPlottableInX, reinsertableValue } from './giac.js';
import { parseSystemLines } from './plotSystem.js';

const XYZ = ['x', 'y', 'z'];

// Two shapes count as plottable from an entry's *input*: a function this session just defined
// with exactly two parameters (f(x,y):=..., or f(u,v):=... - calling it back as "f(x,y)" always
// comes out as an expression in x and y regardless of what the definition itself calls its own
// parameters, same reasoning lib/plottable.js's own single-parameter check relies on), offered
// as a 'surface' row - or a system of one or more equations/inequalities in x, y and z (see
// lib/plotSystem.js's parseSystemLines, called here with the 3-variable allowlist), offered as
// that whole system verbatim, the same "one per line" shape the 3D panel's own 'system' row
// takes (see lib/plotSample3d.js's sampleSystem3d).
export function plottable3dInputForEntry(entry, definitions = new Map()) {
  if (!entry || entry.isError) return null;

  const def = parseDefinition(entry.input);
  if (def && def.kind === 'function' && def.params.length === 2) {
    return { mode: 'surface', patch: { expr: `${def.name}(x,y)` } };
  }

  try {
    if (parseSystemLines(entry.input, definitions, XYZ).length > 0) {
      return { mode: 'system', patch: { exprSystem: entry.input } };
    }
  } catch {
    // Not a system of equations/inequalities in x, y and z either - nothing to offer.
  }
  return null;
}

// A plain result free in *both* "x" and "y" (e.g. "sin(x*y)", or "x^2+y^2-z" is rejected since
// it isn't free in z's own axis at all here - this only ever offers the 'surface' shape, a
// height z=f(x,y)) - checked the same way lib/plottable.js's own plottableOutputForEntry checks
// a 2D output is free in "x" (isPlottableInX already takes any variable name, not just its own
// "x" default).
export function plottable3dOutputForEntry(entry) {
  if (!entry || entry.isError) return null;
  const raw = reinsertableValue(entry.raw ?? '');
  return isPlottableInX(raw, 'x') && isPlottableInX(raw, 'y') ? { mode: 'surface', patch: { expr: raw } } : null;
}
