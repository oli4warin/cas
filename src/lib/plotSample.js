// Turns a Giac expression in `x` into (x, y) samples by asking the *same* CAS session to
// batch-evaluate it at N points in one round trip. Because it's the same session, `x`
// stays the only free variable while any other name the user has already assigned
// (`a:=2`, `f(x):=...`) resolves exactly as it would on the command line.

import { normalizePowerCalls, reinsertableValue, parseExactRational, terminatingDecimalString, sameNumericValue } from './giac.js';
import { splitDomainRestriction, applyDomainRestriction } from './plotDomain.js';
import { substitutePlotParams } from './plotParams.js';
import { parseDiffEq, buildFieldComponents } from './plotDiffEq.js';
import { distributionDomainExpr, DISTRIBUTION_FAMILIES, resolveDistributionCdfPlan } from './distributionParams.js';
import { parseSystemLines, traceContourSegments, orientForHolds, combineInequalityGrids, buildRegionFillPolygons } from './plotSystem.js';

// Giac prints large/small magnitudes in scientific notation, sometimes with an explicit
// "+" exponent sign (e.g. "1e+20"), sometimes with none at all for positive exponents
// (e.g. "0.5102e17") - confirmed against the actual engine.
const NUMBER_RE = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i;

function formatNum(n) {
  return Number.isFinite(n) ? n.toString() : '0';
}

export function buildSampleExpr(expr, xmin, xmax, points) {
  const n = Math.max(2, Math.floor(points));
  const step = (xmax - xmin) / (n - 1);
  // seq(...) already evaluates to a Giac list on its own (confirmed against the actual
  // engine) - wrapping it in another [...] would nest it one level deeper instead of
  // flattening it.
  return `evalf(seq(subst((${expr}),x=(${formatNum(xmin)})+(k)*(${formatNum(step)})),k,0,${n - 1}))`;
}

// Splits a Giac list's raw string body on top-level commas only, so a complex number like
// `2.0+3.0*i` (no comma) or a nested `(1,2)` never gets cut in the wrong place.
function splitTopLevel(inner) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  return parts;
}

// Parses buildSampleExpr()'s output into numbers, using NaN for anything that isn't a
// plain real (undefined, +/-infinity, complex, or other symbolic leftover) - the renderer
// treats NaN as a gap in the curve rather than a plot error.
export function parseSampleList(raw) {
  const s = raw.trim();
  if (!s.startsWith('[') || !s.endsWith(']')) return null;
  const inner = s.slice(1, -1);
  if (!inner.trim()) return [];
  return splitTopLevel(inner).map((tok) => {
    const t = tok.trim();
    return NUMBER_RE.test(t) ? parseFloat(t) : NaN;
  });
}

export async function sampleFunction(evaluateRaw, expr, xmin, xmax, points, sliders) {
  const { expr: bareExpr, condition } = splitDomainRestriction(expr.trim());
  const trimmed = normalizePowerCalls(bareExpr.trim());
  if (!trimmed) return [];
  const substitutedExpr = substitutePlotParams(trimmed, sliders);
  const substitutedCondition = condition ? substitutePlotParams(condition, sliders) : null;
  const sampleExpr = applyDomainRestriction(substitutedExpr, substitutedCondition);

  const out = await evaluateRaw(buildSampleExpr(sampleExpr, xmin, xmax, points));
  if (out.startsWith('GIAC_ERROR')) {
    throw new Error(out.slice(11).trim() || 'Could not evaluate this expression.');
  }

  const ys = parseSampleList(out);
  if (!ys) throw new Error('Unexpected response from the CAS engine.');
  if (ys.length > 0 && ys.every((y) => Number.isNaN(y))) {
    throw new Error('No real output in the current view (undefined name, or complex-valued here?).');
  }

  const n = ys.length;
  const step = n > 1 ? (xmax - xmin) / (n - 1) : 0;
  return ys.map((y, i) => ({ x: xmin + i * step, y }));
}

// tmin/tmax are Giac expressions (e.g. "pi", "sqrt(2)", "-2*pi/3"), not JS numbers, so the
// endpoints - and the step built from them - are left symbolic and only evalf()'d at the
// very end, on the engine side. That's what lets the t-range fields take any expression
// the CAS can understand instead of just plain decimals.
function orZero(expr) {
  const t = expr.trim();
  return t || '0';
}

// Same idea as buildSampleExpr(), but for a parametric curve (x(t), y(t)) over t in
// [tmin, tmax]. Both components are batched into one call as [x,y] pairs - confirmed
// against the actual engine that seq() of a [.,.] literal comes back as a flat list of
// two-element lists, not nested any deeper.
export function buildParametricSampleExpr(exprX, exprY, tmin, tmax, points) {
  const n = Math.max(2, Math.floor(points));
  const tminE = orZero(tmin);
  const tmaxE = orZero(tmax);
  const tAt = `(${tminE})+(k)*(((${tmaxE})-(${tminE}))/(${n - 1}))`;
  return `evalf(seq([subst((${exprX}),t=${tAt}),subst((${exprY}),t=${tAt})],k,0,${n - 1}))`;
}

export function parseParametricList(raw) {
  const s = raw.trim();
  if (!s.startsWith('[') || !s.endsWith(']')) return null;
  const inner = s.slice(1, -1);
  if (!inner.trim()) return [];
  return splitTopLevel(inner).map((pairTok) => {
    const t = pairTok.trim();
    if (!t.startsWith('[') || !t.endsWith(']')) return { x: NaN, y: NaN };
    const [xTok = '', yTok = ''] = splitTopLevel(t.slice(1, -1));
    const x = NUMBER_RE.test(xTok.trim()) ? parseFloat(xTok) : NaN;
    const y = NUMBER_RE.test(yTok.trim()) ? parseFloat(yTok) : NaN;
    return { x, y };
  });
}

export async function sampleParametric(evaluateRaw, exprX, exprY, tmin, tmax, points, sliders) {
  const xe0 = normalizePowerCalls(exprX.trim());
  const ye0 = normalizePowerCalls(exprY.trim());
  if (!xe0 || !ye0) return [];
  const xe = substitutePlotParams(xe0, sliders);
  const ye = substitutePlotParams(ye0, sliders);

  const out = await evaluateRaw(buildParametricSampleExpr(xe, ye, tmin, tmax, points));
  if (out.startsWith('GIAC_ERROR')) {
    throw new Error(out.slice(11).trim() || 'Could not evaluate this expression.');
  }

  const pts = parseParametricList(out);
  if (!pts) throw new Error('Unexpected response from the CAS engine.');
  if (pts.length > 0 && pts.every((p) => Number.isNaN(p.x) || Number.isNaN(p.y))) {
    throw new Error('No real output over this t range (undefined name, or complex-valued here?).');
  }

  return pts;
}

// A complex-valued curve z(t) plotted as (Re(z), Im(z)) - e.g. exp(i*t) traces the unit
// circle. re()/im() are applied on the Giac side (confirmed against the engine) so this
// reuses the exact same [x,y]-pair batching and parsing as sampleParametric().
export function buildComplexSampleExpr(exprZ, tmin, tmax, points) {
  const n = Math.max(2, Math.floor(points));
  const tminE = orZero(tmin);
  const tmaxE = orZero(tmax);
  const tAt = `(${tminE})+(k)*(((${tmaxE})-(${tminE}))/(${n - 1}))`;
  return `evalf(seq([re(subst((${exprZ}),t=${tAt})),im(subst((${exprZ}),t=${tAt}))],k,0,${n - 1}))`;
}

// A scatter plot from two independently-evaluated list-valued expressions (e.g. column
// variables from Table mode, or literal lists like [1,2,3]) - zipped locally rather than
// on the Giac side, so mismatched list lengths just plot however many pairs both sides
// have instead of erroring.
export async function sampleScatter(evaluateRaw, exprX, exprY) {
  const xe = exprX.trim();
  const ye = exprY.trim();
  if (!xe || !ye) return [];

  // Sequential, not Promise.all: the engine's bridge only tracks one in-flight
  // evaluation at a time, so firing both requests concurrently would drop the first
  // response and leave its promise hanging forever.
  const outX = await evaluateRaw(`evalf(${xe})`);
  if (outX.startsWith('GIAC_ERROR')) throw new Error(outX.slice(11).trim() || 'Could not evaluate the x data.');
  const outY = await evaluateRaw(`evalf(${ye})`);
  if (outY.startsWith('GIAC_ERROR')) throw new Error(outY.slice(11).trim() || 'Could not evaluate the y data.');

  const xs = parseSampleList(outX);
  const ys = parseSampleList(outY);
  if (!xs || !ys) throw new Error('Expected a list of numbers for each axis, e.g. [1,2,3] or a column name.');
  if (xs.length === 0 || ys.length === 0) return [];

  const n = Math.min(xs.length, ys.length);
  const pts = new Array(n);
  for (let i = 0; i < n; i++) pts[i] = { x: xs[i], y: ys[i] };
  return pts;
}

export async function sampleComplex(evaluateRaw, exprZ, tmin, tmax, points, sliders) {
  const ze0 = normalizePowerCalls(exprZ.trim());
  if (!ze0) return [];
  const ze = substitutePlotParams(ze0, sliders);

  const out = await evaluateRaw(buildComplexSampleExpr(ze, tmin, tmax, points));
  if (out.startsWith('GIAC_ERROR')) {
    throw new Error(out.slice(11).trim() || 'Could not evaluate this expression.');
  }

  const pts = parseParametricList(out);
  if (!pts) throw new Error('Unexpected response from the CAS engine.');
  if (pts.length > 0 && pts.every((p) => Number.isNaN(p.x) || Number.isNaN(p.y))) {
    throw new Error('No real output over this t range (undefined name?).');
  }

  return pts;
}

// Parses solve()'s raw list output into its (still-symbolic, not necessarily numeric)
// solution strings - unlike parseSampleList, these are Giac expressions in other variables,
// not numbers to evalf, so NUMBER_RE doesn't apply here. For a single solve variable (all this
// mode ever asks for - see sampleDiffEqField below), Giac hands back its own "list[...]" form
// (confirmed against the actual engine, and matching giac.js's own parseSolveTuples/
// formatSolveResultApprox, which accept the same two shapes for the same reason) rather than a
// bare "[...]" bracket - "[...]" is also accepted since fsolve/zeros use that flatter shape,
// and there's no reason to reject it here if Giac ever returns it for solve() too.
function parseSolveList(raw) {
  const s = raw.trim();
  let inner;
  if (s.startsWith('list[') && s.endsWith(']')) inner = s.slice(5, -1);
  else if (s.startsWith('[') && s.endsWith(']')) inner = s.slice(1, -1);
  else return null;
  if (!inner.trim()) return [];
  return splitTopLevel(inner).map((t) => t.trim());
}

// Same grid-batching idea as buildSampleExpr, generalized to two dimensions: `k` ranges over
// every cell of an nx-by-ny grid over [xmin,xmax]x[ymin,ymax], decoded back into its (gx,gy)
// coordinates via integer div/mod, and `comp1`/`comp2` (Giac expressions in the generic grid
// variables "gx"/"gy" - see buildFieldComponents in plotDiffEq.js) are evaluated there via the
// same subst() chaining plotParams.js uses for slider values. One round trip evaluates every
// arrow in the field at once.
export function buildFieldSampleExpr(comp1, comp2, xmin, xmax, ymin, ymax, nx, ny) {
  const nX = Math.max(2, Math.floor(nx));
  const nY = Math.max(2, Math.floor(ny));
  const stepX = (xmax - xmin) / (nX - 1);
  const stepY = (ymax - ymin) / (nY - 1);
  const gxAt = `(${formatNum(xmin)})+(iquo(k,${nY}))*(${formatNum(stepX)})`;
  const gyAt = `(${formatNum(ymin)})+(irem(k,${nY}))*(${formatNum(stepY)})`;
  const sub = (e) => `subst(subst((${e}),gx=(${gxAt})),gy=(${gyAt}))`;
  const n = nX * nY;
  return `evalf(seq([${gxAt},${gyAt},${sub(comp1)},${sub(comp2)}],k,0,${n - 1}))`;
}

// Parses buildFieldSampleExpr()'s output - a flat list of [gx,gy,dx,dy] quads - into arrow
// data for the plot panel's 'field' curve style. Same NaN-for-anything-not-a-plain-real
// treatment as parseSampleList; the renderer just skips a non-finite arrow instead of drawing
// a gap (there's no line to break).
export function parseFieldList(raw) {
  const s = raw.trim();
  if (!s.startsWith('[') || !s.endsWith(']')) return null;
  const inner = s.slice(1, -1);
  if (!inner.trim()) return [];
  const parseOne = (tok) => (NUMBER_RE.test(tok.trim()) ? parseFloat(tok) : NaN);
  return splitTopLevel(inner).map((tok) => {
    const t = tok.trim();
    if (!t.startsWith('[') || !t.endsWith(']')) return { x: NaN, y: NaN, dx: NaN, dy: NaN };
    const [xTok = '', yTok = '', dxTok = '', dyTok = ''] = splitTopLevel(t.slice(1, -1));
    return { x: parseOne(xTok), y: parseOne(yTok), dx: parseOne(dxTok), dy: parseOne(dyTok) };
  });
}

// Same grid-batching idea as buildFieldSampleExpr, but for a single scalar value per corner
// (an equation/inequality's own lhs-rhs, see sampleSystem below) instead of a 2-component
// vector. Unlike buildFieldSampleExpr's arrows, gx/gy aren't echoed back in the output - the
// caller already knows exactly which (gx,gy) each flat index k decodes to, since it built nx/ny
// itself - so this only costs one evaluation per grid point, not the field's four.
export function buildScalarGridExpr(expr, xmin, xmax, ymin, ymax, nx, ny) {
  const nX = Math.max(2, Math.floor(nx));
  const nY = Math.max(2, Math.floor(ny));
  const stepX = (xmax - xmin) / (nX - 1);
  const stepY = (ymax - ymin) / (nY - 1);
  const gxAt = `(${formatNum(xmin)})+(iquo(k,${nY}))*(${formatNum(stepX)})`;
  const gyAt = `(${formatNum(ymin)})+(irem(k,${nY}))*(${formatNum(stepY)})`;
  const n = nX * nY;
  return `evalf(seq(subst(subst((${expr}),x=(${gxAt})),y=(${gyAt})),k,0,${n - 1}))`;
}

// Samples every line of a 'system' row's text (see lib/plotSystem.js's parseSystemLines) over
// `view` on an nx-by-ny grid: each equation's lhs-rhs is traced into contour segments
// (traceContourSegments); every inequality's own *oriented* lhs-rhs (see orientForHolds) is
// kept as its own grid and, once every line's been sampled, combined into one merged
// "solution region" (combineInequalityGrids, then buildRegionFillPolygons for its fill and
// traceContourSegments again for its own boundary) - the system's actual feasible region (every
// inequality holding at once), not each inequality's own half-plane shown separately. Only
// when there are at least two equations (a lone equation has a whole curve of solutions, not
// isolated points - a determined system needs as many equations as unknowns) are the equations
// alone (never the inequalities - there's no single numeric point to solve a region down to)
// solved together for their real numeric intersection point(s). Sequential engine round trips
// throughout - one per line, plus (when applicable) one more for the solve - same reason
// sampleScatter's two calls are (the shared bridge only ever resolves one dependent step of a
// caller's own at a time). Propagates parseSystemLines' own Error for a line that isn't a
// relation in x/y at all, same as every other mode's own validation.
export async function sampleSystem(evaluateRaw, text, view, nx, ny, definitions) {
  const lines = parseSystemLines(text, definitions);
  if (lines.length === 0) return { equations: [], inequalityRegion: null, solutionPoints: [] };

  const { xmin, xmax, ymin, ymax } = view;
  const nX = Math.max(2, Math.floor(nx));
  const nY = Math.max(2, Math.floor(ny));

  const equations = [];
  const orientedInequalityGrids = [];
  for (const line of lines) {
    const fExpr = `(${line.lhs})-(${line.rhs})`;
    const out = await evaluateRaw(buildScalarGridExpr(fExpr, xmin, xmax, ymin, ymax, nX, nY));
    if (out.startsWith('GIAC_ERROR')) throw new Error(out.slice(11).trim() || `Could not evaluate "${line.raw}".`);
    const values = parseSampleList(out);
    if (!values) throw new Error('Unexpected response from the CAS engine.');

    const grid = [];
    for (let i = 0; i < nX; i++) grid.push(values.slice(i * nY, i * nY + nY));

    if (line.kind === 'equation') {
      equations.push(traceContourSegments(grid, xmin, xmax, ymin, ymax, nX, nY));
    } else {
      orientedInequalityGrids.push(grid.map((col) => col.map((v) => orientForHolds(line.op, v))));
    }
  }

  let inequalityRegion = null;
  if (orientedInequalityGrids.length > 0) {
    const combined = combineInequalityGrids(orientedInequalityGrids, nX, nY);
    inequalityRegion = {
      fill: buildRegionFillPolygons(combined, xmin, xmax, ymin, ymax, nX, nY),
      boundary: traceContourSegments(combined, xmin, xmax, ymin, ymax, nX, nY),
    };
  }

  const equationLines = lines.filter((l) => l.kind === 'equation');
  let solutionPoints = [];
  if (equationLines.length >= 2) {
    const eqText = equationLines.map((l) => `${l.lhs}=${l.rhs}`).join(' and ');
    const out = await evaluateRaw(`evalf(solve(${eqText},[x,y]))`);
    if (!out.startsWith('GIAC_ERROR')) {
      // solve()'s own "list[[...],...]" wrapper (see plotSample.js's own parseSolveList, and
      // parseSystemSolutionPoints's use of it) - stripping just the "list" prefix leaves
      // exactly the "[[x,y],...]" shape parseParametricList already knows how to read (an
      // empty "[]" - no real solutions - parses to an empty array the same way). A symbolic,
      // non-numeric coordinate (an under-determined system - e.g. two lines that reduce to
      // the same equation) is dropped rather than plotted as a bogus point.
      const trimmed = out.trim();
      const body = trimmed.startsWith('list[') ? trimmed.slice(4) : trimmed;
      solutionPoints = (parseParametricList(body) ?? []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    }
  }

  return { equations, inequalityRegion, solutionPoints };
}

// Samples a differential-equation row's vector field over `view` on an nx-by-ny grid: asks
// Giac to isolate the equation's highest derivative once, then batches every arrow's vector
// into the one evaluateRaw() round trip buildFieldSampleExpr builds. See plotDiffEq.js for the
// equation parsing/reduction this builds on.
export async function sampleDiffEqField(evaluateRaw, rawExpr, view, nx, ny) {
  const trimmed = rawExpr.trim();
  if (!trimmed) return [];

  const { order, solveVar, eqForSolve } = parseDiffEq(trimmed);

  const solveOut = await evaluateRaw(`solve(${eqForSolve},${solveVar})`);
  if (solveOut.startsWith('GIAC_ERROR')) {
    throw new Error(solveOut.slice(11).trim() || 'Could not solve this equation for its highest derivative.');
  }
  const solutions = parseSolveList(solveOut);
  if (!solutions || solutions.length === 0) {
    throw new Error(`Could not isolate ${solveVar === 'D2Y' ? "y''" : "y'"} - try an equation linear in the highest derivative.`);
  }

  const { comp1, comp2 } = buildFieldComponents(order, solutions[0]);
  const { xmin, xmax, ymin, ymax } = view;
  const out = await evaluateRaw(buildFieldSampleExpr(comp1, comp2, xmin, xmax, ymin, ymax, nx, ny));
  if (out.startsWith('GIAC_ERROR')) {
    throw new Error(out.slice(11).trim() || 'Could not evaluate this vector field.');
  }

  const pts = parseFieldList(out);
  if (!pts) throw new Error('Unexpected response from the CAS engine.');
  if (pts.length > 0 && pts.every((p) => !Number.isFinite(p.dx) || !Number.isFinite(p.dy))) {
    throw new Error('No real vectors in the current view (undefined name, or complex-valued here?).');
  }

  return pts;
}

// A distribution row's density (continuous family) sampled the same way an ordinary function
// row is (see sampleFunction) - `distributionDomainExpr` (distributionParams.js) already wraps
// the family's own density call in a when(...) that masks it to NaN outside its support, so
// the existing NaN-as-gap rendering just does the right thing without this needing its own
// domain logic.
export async function sampleContinuousDistribution(evaluateRaw, family, params, xmin, xmax, points) {
  const expr = distributionDomainExpr(family, params);
  if (!expr) return [];

  const out = await evaluateRaw(buildSampleExpr(expr, xmin, xmax, points));
  if (out.startsWith('GIAC_ERROR')) {
    throw new Error(out.slice(11).trim() || 'Could not evaluate this distribution.');
  }

  const ys = parseSampleList(out);
  if (!ys) throw new Error('Unexpected response from the CAS engine.');

  const n = ys.length;
  const step = n > 1 ? (xmax - xmin) / (n - 1) : 0;
  return ys.map((y, i) => ({ x: xmin + i * step, y }));
}

// Same batching idea as buildSampleExpr, but at a fixed step of 1 starting from the first
// integer >= kmin, up to the last integer <= kmax - used for a discrete distribution's bar
// chart (see sampleDiscreteDistribution), where only integer k has a meaningful probability at
// all. Returns null when the view doesn't contain any integer (kmax < kmin after rounding).
export function buildIntegerSampleExpr(expr, kmin, kmax) {
  const lo = Math.ceil(kmin);
  const hi = Math.floor(kmax);
  if (hi < lo) return null;
  const n = hi - lo + 1;
  return { expr: `evalf(seq(subst((${expr}),x=(${lo})+(k)),k,0,${n - 1}))`, lo };
}

// A discrete distribution row's probability function, sampled at every integer k currently in
// view - one bar per k (see plotPanel.js's 'bars' curve style). Points whose pmf came back
// non-finite (masked out by distributionDomainExpr's domain condition, e.g. k outside
// [0,n] for binomial) are dropped rather than kept as gaps - there's no bar to draw there at
// all, unlike a continuous curve's gap.
export async function sampleDiscreteDistribution(evaluateRaw, family, params, xmin, xmax) {
  const expr = distributionDomainExpr(family, params);
  if (!expr) return [];
  const built = buildIntegerSampleExpr(expr, xmin, xmax);
  if (!built) return [];

  const out = await evaluateRaw(built.expr);
  if (out.startsWith('GIAC_ERROR')) {
    throw new Error(out.slice(11).trim() || 'Could not evaluate this distribution.');
  }

  const ys = parseSampleList(out);
  if (!ys) throw new Error('Unexpected response from the CAS engine.');

  const pts = [];
  ys.forEach((y, i) => {
    if (Number.isFinite(y)) pts.push({ x: built.lo + i, y });
  });
  return pts;
}

const POS_INFINITY_RE = /^\+?(infinity|inf)$/i;
const NEG_INFINITY_RE = /^-(infinity|inf)$/i;

// Resolves a distribution row's lower/upper bound text (Giac expressions - "-infinity"/
// "infinity" included, same tokens giac.js's own normald_cdf handling recognizes) to plain JS
// numbers (+-Infinity allowed) - used by plotPanel.js to decide which part of the sampled
// curve/bars falls inside the shaded region. Sequential, not Promise.all - same reason
// sampleScatter's two evaluateRaw calls are sequential: the engine bridge only tracks one
// in-flight evaluation at a time.
async function resolveDistributionBound(evaluateRaw, text, fallback) {
  const t = (text ?? '').trim();
  if (!t) return fallback;
  if (POS_INFINITY_RE.test(t)) return Infinity;
  if (NEG_INFINITY_RE.test(t)) return -Infinity;
  const out = await evaluateRaw(`evalf(${t})`);
  const trimmed = out.trim();
  if (out.startsWith('GIAC_ERROR')) return fallback;
  if (NUMBER_RE.test(trimmed)) return parseFloat(trimmed);
  if (POS_INFINITY_RE.test(trimmed)) return Infinity;
  if (NEG_INFINITY_RE.test(trimmed)) return -Infinity;
  return fallback;
}

export async function resolveDistributionBounds(evaluateRaw, lower, upper) {
  const lo = await resolveDistributionBound(evaluateRaw, lower, -Infinity);
  const hi = await resolveDistributionBound(evaluateRaw, upper, Infinity);
  return { lower: lo, upper: hi };
}

// The middle 90% of a family's own mass (5th/95th percentile, via its _icdf command - the
// same command distributionMenu.js's "Probability (p)" field already builds on) - a
// distribution's default [-10,10]/1:1 view (same as every other plot row) routinely makes it
// unreadable: a Normal's density maxes out around 0.4 against a 12-unit-tall axis, a Poisson's
// bars sit invisibly close to the x-axis, and a Cauchy/Student(1)'s heavy tails would demand an
// enormous range at a stricter percentile (its own 99.8% range is +-318 units - confirmed
// against the engine - which would flatten the interesting part back into invisibility, the
// same problem this is solving). 90% is a deliberately loose target: readable for heavy-tailed
// families without meaningfully cropping the well-behaved ones (Normal's own 90% range is
// already +-2.33 sigma).
const FIT_LOWER_P = 0.05;
const FIT_UPPER_P = 0.95;

// Computes a "this distribution, clearly visible" view for lib/plotPanel.js's auto-fit (see
// its fitDistributionView) - an x-range from this family's own 5th/95th percentile (padded a
// little further for a continuous curve; rounded out to whole bars for a discrete one), and a
// y-range sized to the actual peak density/pmf sampled over that x-range (rather than a
// guessed constant), so every family gets a sensibly-scaled view regardless of its own natural
// magnitude. Returns null if the family's own _icdf/density calls error out (an invalid
// parameter mid-edit, e.g. a blank field) - the caller just leaves the view alone then.
export async function computeDistributionFitView(evaluateRaw, family, params, discrete) {
  const cfg = DISTRIBUTION_FAMILIES[family];
  if (!cfg) return null;
  const args = cfg.params.map((p) => `(${params[p.key] ?? p.default})`).join(',');

  // Sequential, not Promise.all - see resolveDistributionBound's own comment above for why.
  const loOut = await evaluateRaw(`evalf(${family}_icdf(${args},${FIT_LOWER_P}))`);
  if (loOut.startsWith('GIAC_ERROR')) return null;
  const hiOut = await evaluateRaw(`evalf(${family}_icdf(${args},${FIT_UPPER_P}))`);
  if (hiOut.startsWith('GIAC_ERROR')) return null;
  const lo = parseFloat(loOut.trim());
  const hi = parseFloat(hiOut.trim());
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;

  let xmin, xmax;
  if (discrete) {
    // A couple of bars' worth of padding on each side so the outermost bars aren't flush
    // against the plot's edge.
    xmin = Math.floor(lo) - 2;
    xmax = Math.ceil(hi) + 2;
  } else {
    const pad = (hi - lo) * 0.25 || 1;
    xmin = lo - pad;
    xmax = hi + pad;
  }

  const pts = discrete
    ? await sampleDiscreteDistribution(evaluateRaw, family, params, xmin, xmax)
    : await sampleContinuousDistribution(evaluateRaw, family, params, xmin, xmax, 200);
  const peak = pts.reduce((m, p) => (Number.isFinite(p.y) && p.y > m ? p.y : m), 0);
  const ymax = peak > 0 ? peak * 1.2 : 1;
  // A little headroom below zero too, so a bar/curve sitting right on the x-axis doesn't
  // touch the very edge of the canvas, and the x-axis's own tick labels (drawn just above it)
  // have room to sit without overlapping the curve.
  const ymin = -ymax * 0.08;

  return { xmin, xmax, ymin, ymax };
}

// The plot panel's own inline "P(lower<=X<=upper)≈value" readout, shown right next to a
// distribution row's own bound fields (see plotPanel.js) so the probability the shaded region
// represents is visible without having to separately type the matching _cdf(...) call into the
// calculator. Shares its actual computation - carefully avoiding Giac's own two-bound
// _cdf(...) form, confirmed wrong for several families even with ordinary finite bounds - with
// giac.js's own _cdf output formatting (see resolveDistributionCdfPlan's own comment in
// distributionParams.js for the full story).
//
// Unlike that calculator-facing formatting, both bounds at the family's own natural extreme
// (the default state of a freshly added row - see lib/plotRows.js's makeRow) is shown here as
// the trivial "=1" it actually is, rather than left unlabeled - resolveDistributionCdfPlan
// reports that case back via giacExpr:"1" specifically so this can do that. Returns null when
// the family is unknown or a bound doesn't evalf() to a plain real (an invalid expression
// mid-edit, say) - the caller just leaves the previous readout in place then.
export async function computeDistributionProbability(evaluateRaw, family, params, lower, upper) {
  const plan = await resolveDistributionCdfPlan(evaluateRaw, family, params, lower, upper);
  if (!plan) return null;
  const { giacExpr } = plan;

  const valueOut = await evaluateRaw(`evalf(${giacExpr})`);
  if (valueOut.startsWith('GIAC_ERROR')) return null;
  const value = valueOut.trim();

  let displayValue = value;
  let isExact = false;
  const exactOut = await evaluateRaw(`exact(${giacExpr})`);
  if (!exactOut.startsWith('GIAC_ERROR')) {
    const exactPart = reinsertableValue(exactOut);
    const rational = parseExactRational(exactPart);
    if (rational?.den === 1n) {
      displayValue = exactPart;
      isExact = true;
    } else if (rational) {
      const exactDecimal = terminatingDecimalString(rational.num, rational.den);
      if (exactDecimal && sameNumericValue(exactDecimal, value)) {
        displayValue = exactDecimal;
        isExact = true;
      }
    }
  }

  return { text: `${isExact ? '=' : '≈'}${displayValue}` };
}
