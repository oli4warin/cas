// Decides whether a history entry's *input* or *output* can be offered to the plot panel -
// shared by the entry's own two "plot" buttons (see components/historyEntry.js) and the "p"
// keyboard shortcut (see app.js), so both agree on exactly the same entries. Kept as two
// separate checks (rather than one that falls input back to output) because they can each be
// true independently and mean different things to plot: an entry for "y'=x-y" has a plottable
// *input* (the differential equation itself - see plottableInputForEntry) and, once solved, a
// plottable *output* (the solution curve - see plottableOutputForEntry) - pressing "p" on
// whichever half is selected should plot exactly that one, never the other.

import { parseDefinition } from './definitions.js';
import { isPlottableInX, reinsertableValue } from './giac.js';
import { parseDiffEq } from './plotDiffEq.js';
import { parseDistributionCdfCall } from './distributionParams.js';

// Three shapes count as plottable from an entry's *input*: a function this session just
// defined with exactly one parameter (f(x):=..., or even f(t):=... - calling it back as
// "f(x)" always comes out as an expression in x regardless of what the definition itself calls
// its own parameter, since Giac substitutes whatever's actually passed), a differential
// equation in y (checked with the exact same parser the plot panel's own diffeq row uses - see
// lib/plotDiffEq.js - so both agree on exactly which equations are offerable), or a
// distribution `_cdf` call (normald_cdf, binomial_cdf, ... and their calculator-familiar
// aliases like normcdf/binomcdf - see lib/distributionParams.js's parseDistributionCdfCall) -
// offered as that distribution's own density/pmf with [lower,upper] shaded, directly
// visualizing the probability the command just computed. Checked one line at a time so a
// multi-line initial-value problem (the ODE on one line, "y(0)=3" on the next - see
// wrapBareEquation in giac.js) still finds the ODE line; a line that isn't shaped like any of
// these (no derivative, or a 3rd-order+ one) just falls through to the next. Returns
// `{mode, patch}` ready to spread onto the plot panel's row shape, or null if nothing in this
// input is offerable this way.
export function plottableInputForEntry(entry) {
  if (!entry || entry.isError) return null;

  const def = parseDefinition(entry.input);
  if (def && def.kind === 'function' && def.params.length === 1) {
    return { mode: 'function', patch: { expr: `${def.name}(x)` } };
  }

  for (const rawLine of entry.input.split('\n')) {
    const line = rawLine.trim().replace(/;\s*$/, '').trim();
    if (!line) continue;
    const dist = parseDistributionCdfCall(line);
    if (dist) {
      return { mode: 'distribution', patch: { family: dist.family, params: dist.params, lower: dist.lower, upper: dist.upper } };
    }
    try {
      parseDiffEq(line);
      return { mode: 'diffeq', patch: { exprDE: line } };
    } catch {
      // Not itself a 1st-/2nd-order equation in y (e.g. an initial condition like "y(0)=3"
      // sitting on its own line alongside the actual ODE) - keep looking.
    }
  }
  return null;
}

// A plain result that's free in "x" (e.g. expand((x+1)^2) => "x^2+2*x+1", or "a*x+b" - "a"
// and "b" just pick up sliders in the plot panel, see lib/plotParams.js) - checked against an
// entry's *output* regardless of what shape its input was, so e.g. "y'=x-y"'s solution
// (desolve() strips its "y=" label before this ever sees it - see reinsertableValue/
// formatDesolveResult in giac.js) is offered as the plain function it is, not the equation
// that produced it. Returns `{mode, patch}`, or null if this entry's output isn't offerable at
// all (an error, an equation, or a result that doesn't actually mention x).
export function plottableOutputForEntry(entry) {
  if (!entry || entry.isError) return null;
  const raw = reinsertableValue(entry.raw ?? '');
  return isPlottableInX(raw) ? { mode: 'function', patch: { expr: raw } } : null;
}
