// Turns a Giac expression in `x` into (x, y) samples by asking the *same* CAS session to
// batch-evaluate it at N points in one round trip. Because it's the same session, `x`
// stays the only free variable while any other name the user has already assigned
// (`a:=2`, `f(x):=...`) resolves exactly as it would on the command line.

import { normalizePowerCalls } from './giac.js';
import { splitDomainRestriction, applyDomainRestriction } from './plotDomain.js';

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

export async function sampleFunction(evaluateRaw, expr, xmin, xmax, points) {
  const { expr: bareExpr, condition } = splitDomainRestriction(expr.trim());
  const trimmed = normalizePowerCalls(bareExpr.trim());
  if (!trimmed) return [];
  const sampleExpr = applyDomainRestriction(trimmed, condition);

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

export async function sampleParametric(evaluateRaw, exprX, exprY, tmin, tmax, points) {
  const xe = normalizePowerCalls(exprX.trim());
  const ye = normalizePowerCalls(exprY.trim());
  if (!xe || !ye) return [];

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

export async function sampleComplex(evaluateRaw, exprZ, tmin, tmax, points) {
  const ze = normalizePowerCalls(exprZ.trim());
  if (!ze) return [];

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
