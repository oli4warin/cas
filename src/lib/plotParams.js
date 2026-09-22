// Detects "plot parameters" - free letters in a plotted expression (e.g. the "a"/"b" in
// "a*x+b") that aren't the row's own bound variable and haven't been assigned in the CAS
// session - and lets the plot panel offer a slider for each one instead of the row just
// erroring out on an undefined name.
//
// This deliberately never touches the CAS session: a slider's value is substituted straight
// into the Giac expression text (via subst(), the same mechanism plotSample.js already uses
// for x/t) only at the moment a row is sampled for drawing - it's never assigned with ":="
// and never appears in `definitions`. That's what makes the "disappears once saved" behavior
// automatic: collectRowParams below excludes any name already in `definitions`, so the
// instant the user types e.g. "a:=3" themselves, "a" drops out of the detected params on the
// next render and its slider goes away on its own.

import { collectFreeVariables, expandKnownFunctionCalls } from './giac.js';

// diffeq gets no sliders of its own: its axes are already spoken for (x/y, or the phase
// plane y/y' for a 2nd-order equation - see plotDiffEq.js), and any other name it mentions
// resolves the same way any bare CAS expression's would - through a value the user has
// already assigned this session (e.g. "a:=2"), same as typing it at the prompt.
const BOUND_VARS = { function: ['x'], parametric: ['t'], complex: ['t'], scatter: [], diffeq: [] };
const PARAM_FIELDS = { function: ['expr'], parametric: ['exprX', 'exprY'], complex: ['exprZ'], scatter: [], diffeq: [] };

const DEFAULT_SLIDER = { value: 1, min: -10, max: 10, step: 0.1 };

// The plot parameters referenced by a row, across whichever of its fields actually get sent
// to the engine for sampling (for a function row, this includes any domain-restriction
// condition after "|" too, e.g. "a*x|x>a" still finds "a" - collectFreeVariables just walks
// identifiers in the raw text, restriction syntax included) - deduped, first-appearance
// order, with the row's own bound variable (x, or t for parametric/complex) and anything
// already defined in the CAS session excluded.
//
// A call to a function the user already defined this session (e.g. plotting "f(x)" for
// f(x):=a*x+b) is expanded to its body first (same expansion giac.js's own solve()-variable
// detection uses), so the parameters hiding inside a saved function's definition are found
// too, not just ones typed directly into the row - "f" itself is never a parameter (it's
// excluded either way, since collectFreeVariables skips any name followed by "(").
export function collectRowParams(row, definitions) {
  const bound = new Set(BOUND_VARS[row.mode] ?? []);
  const seen = new Set();
  const result = [];
  for (const field of PARAM_FIELDS[row.mode] ?? []) {
    const text = row[field];
    if (!text || !text.trim()) continue;
    const expanded = expandKnownFunctionCalls(text, definitions);
    for (const name of collectFreeVariables(expanded, definitions)) {
      if (bound.has(name) || seen.has(name)) continue;
      seen.add(name);
      result.push(name);
    }
  }
  return result;
}

// Reconciles a row's stored slider settings against its currently-detected params: keeps
// whatever's already there for a param still present, drops one that's no longer free (typed
// out of the expression, or now assigned in the CAS), and seeds a fresh default for a newly
// typed one. Returns the same object back (by reference) when nothing actually changed, so
// callers can tell "did this row's slider set change" with a plain `!==` check.
export function reconcileSliders(sliders, params) {
  const current = sliders ?? {};
  if (params.length === Object.keys(current).length && params.every((name) => name in current)) {
    return current;
  }
  const next = {};
  for (const name of params) next[name] = current[name] ?? { ...DEFAULT_SLIDER };
  return next;
}

// Wraps `expr` in a chain of subst() calls binding each slider's current value - a purely
// plotting-time substitution (see module comment above). Letting Giac's own subst() do the
// substitution (rather than a textual replace here) means it's real identifier-aware parsing
// on the engine side, so a param named "a" can't accidentally match inside a longer
// identifier such as "abc".
export function substitutePlotParams(expr, sliders) {
  const names = Object.keys(sliders ?? {});
  if (!names.length) return expr;
  return names.reduce((acc, name) => `subst((${acc}),${name}=(${sliders[name].value}))`, expr);
}
