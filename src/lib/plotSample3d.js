// Turns a Giac expression in x/y (or a parametric surface in u/v, or a system of
// equations/inequalities in x/y/z) into data Plotly can render - the 3D sibling of
// lib/plotSample.js, reusing its list-parsing helpers (parseSampleList, splitTopLevel,
// NUMBER_RE) since the underlying "batch every sample point into one seq() round trip, parse
// the flat Giac list back into numbers" idea is exactly the same, just over one more dimension.

import { normalizePowerCalls } from './giac.js';
import { parseSampleList, splitTopLevel, NUMBER_RE } from './plotSample.js';
import { splitDomainRestriction, applyDomainRestriction } from './plotDomain.js';
import { parseSystemLines, orientForHolds } from './plotSystem.js';
import { t } from './i18n.js';

function formatNum(n) {
  return Number.isFinite(n) ? n.toString() : '0';
}

function orZero(expr) {
  const t = (expr ?? '').trim();
  return t || '0';
}

// ---------- surface: z = f(x,y) ----------

// Same grid-batching idea as lib/plotSample.js's buildScalarGridExpr (itself built for a
// 'system' row's own grid) - k decodes to (gx,gy) via integer div/mod over an nX-by-nY grid,
// substituted into `expr` and evaluated in one round trip.
export function buildSurfaceGridExpr(expr, xmin, xmax, ymin, ymax, nx, ny) {
  const nX = Math.max(2, Math.floor(nx));
  const nY = Math.max(2, Math.floor(ny));
  const stepX = (xmax - xmin) / (nX - 1);
  const stepY = (ymax - ymin) / (nY - 1);
  const gxAt = `(${formatNum(xmin)})+(iquo(k,${nY}))*(${formatNum(stepX)})`;
  const gyAt = `(${formatNum(ymin)})+(irem(k,${nY}))*(${formatNum(stepY)})`;
  const n = nX * nY;
  return `evalf(seq(subst(subst((${expr}),x=(${gxAt})),y=(${gyAt})),k,0,${n - 1}))`;
}

// Samples a 'surface' row's z=f(x,y) over an nx-by-ny grid, returned already reshaped into the
// {x,y,z} Plotly's own 'surface' trace expects: x/y as plain 1D axis arrays, z as a 2D array
// with z[iy][ix] at (x[ix], y[iy]) - the transpose of how the flat grid comes back (x varies
// slower than y there, see buildSurfaceGridExpr's own gx/gy decoding). A point outside the
// function's domain (non-finite) becomes `null`, Plotly's own "gap here" convention for a
// surface (mirrors the 2D panel's NaN-as-gap convention, just spelled differently since a
// canvas 2D path and a Plotly trace don't share a renderer). A top-level "|" domain restriction
// (e.g. "sin(x*y)|x>0 and y>0" - see lib/plotDomain.js, already variable-agnostic so this needs
// no changes to reuse it) masks the surface outside its condition the same way.
export async function sampleSurface(evaluateRaw, expr, xmin, xmax, ymin, ymax, nx, ny) {
  const { expr: bareExpr, condition } = splitDomainRestriction(expr.trim());
  const trimmed = normalizePowerCalls(bareExpr.trim());
  if (!trimmed) return null;
  const sampleExpr = applyDomainRestriction(trimmed, condition);
  const nX = Math.max(2, Math.floor(nx));
  const nY = Math.max(2, Math.floor(ny));

  const out = await evaluateRaw(buildSurfaceGridExpr(sampleExpr, xmin, xmax, ymin, ymax, nX, nY));
  if (out.startsWith('GIAC_ERROR')) {
    throw new Error(out.slice(11).trim() || t('Could not evaluate this expression.'));
  }
  const values = parseSampleList(out);
  if (!values) throw new Error(t('Unexpected response from the CAS engine.'));
  if (values.length > 0 && values.every((v) => Number.isNaN(v))) {
    throw new Error(t('No real output in the current view (undefined name, or complex-valued here?).'));
  }

  const xs = Array.from({ length: nX }, (_, i) => xmin + (i * (xmax - xmin)) / (nX - 1));
  const ys = Array.from({ length: nY }, (_, j) => ymin + (j * (ymax - ymin)) / (nY - 1));
  const z = Array.from({ length: nY }, (_, iy) =>
    Array.from({ length: nX }, (_, ix) => {
      const v = values[ix * nY + iy];
      return Number.isFinite(v) ? v : null;
    }),
  );
  return { x: xs, y: ys, z };
}

// ---------- parametric surface: x(u,v), y(u,v), z(u,v) ----------

// Same batching idea as lib/plotSample.js's buildParametricSampleExpr (x(t),y(t)), generalized
// to two parameters and three components - one seq() call, each grid point's [x,y,z] triple
// evaluated at its own (u,v). umin/umax/vmin/vmax stay symbolic Giac expressions (not JS
// numbers) for the same reason tmin/tmax do there - only evalf()'d engine-side.
export function buildParametricSurfaceExpr(exprX, exprY, exprZ, umin, umax, vmin, vmax, nu, nv) {
  const nU = Math.max(2, Math.floor(nu));
  const nV = Math.max(2, Math.floor(nv));
  const uminE = orZero(umin);
  const umaxE = orZero(umax);
  const vminE = orZero(vmin);
  const vmaxE = orZero(vmax);
  const uAt = `(${uminE})+(iquo(k,${nV}))*(((${umaxE})-(${uminE}))/(${nU - 1}))`;
  const vAt = `(${vminE})+(irem(k,${nV}))*(((${vmaxE})-(${vminE}))/(${nV - 1}))`;
  const sub = (e) => `subst(subst((${e}),u=${uAt}),v=${vAt})`;
  const n = nU * nV;
  return `evalf(seq([${sub(exprX)},${sub(exprY)},${sub(exprZ)}],k,0,${n - 1}))`;
}

// Parses buildParametricSurfaceExpr()'s output - a flat list of [x,y,z] triples - the same way
// lib/plotSample.js's parseParametricList reads its own [x,y] pairs, just one component wider.
function parseTripleList(raw) {
  const s = raw.trim();
  if (!s.startsWith('[') || !s.endsWith(']')) return null;
  const inner = s.slice(1, -1);
  if (!inner.trim()) return [];
  const num = (tok) => (NUMBER_RE.test(tok.trim()) ? parseFloat(tok) : NaN);
  return splitTopLevel(inner).map((tripleTok) => {
    const t = tripleTok.trim();
    if (!t.startsWith('[') || !t.endsWith(']')) return { x: NaN, y: NaN, z: NaN };
    const [xTok = '', yTok = '', zTok = ''] = splitTopLevel(t.slice(1, -1));
    return { x: num(xTok), y: num(yTok), z: num(zTok) };
  });
}

// Samples a 'parametric' row's x(u,v)/y(u,v)/z(u,v) over an nu-by-nv grid, reshaped into the
// {x,y,z} shape Plotly's own 'surface' trace also accepts for a *non*-axis-aligned surface -
// x/y/z each a 2D array of the same shape (indexed [iv][iu]), rather than 1D axis arrays -
// which is what actually lets a surface like a torus or a sphere (not a single-valued height
// map over x/y) render at all.
export async function sampleParametricSurface(evaluateRaw, exprX, exprY, exprZ, umin, umax, vmin, vmax, nu, nv) {
  const xe = normalizePowerCalls(exprX.trim());
  const ye = normalizePowerCalls(exprY.trim());
  const ze = normalizePowerCalls(exprZ.trim());
  if (!xe || !ye || !ze) return null;
  const nU = Math.max(2, Math.floor(nu));
  const nV = Math.max(2, Math.floor(nv));

  const out = await evaluateRaw(buildParametricSurfaceExpr(xe, ye, ze, umin, umax, vmin, vmax, nU, nV));
  if (out.startsWith('GIAC_ERROR')) {
    throw new Error(out.slice(11).trim() || t('Could not evaluate this expression.'));
  }
  const pts = parseTripleList(out);
  if (!pts) throw new Error(t('Unexpected response from the CAS engine.'));
  if (pts.length > 0 && pts.every((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z))) {
    throw new Error(t('No real output over this u/v range (undefined name, or complex-valued here?).'));
  }

  const at = (iu, iv, key) => {
    const p = pts[iu * nV + iv];
    return p && Number.isFinite(p[key]) ? p[key] : null;
  };
  const grid = (key) => Array.from({ length: nV }, (_, iv) => Array.from({ length: nU }, (_, iu) => at(iu, iv, key)));
  return { x: grid('x'), y: grid('y'), z: grid('z') };
}

// ---------- system of equations/inequalities in x, y, z ----------

// Same grid-batching idea as buildSurfaceGridExpr above, one dimension further: idx decodes to
// (gx,gy,gz) over an nX-by-nY-by-nZ box, x slowest-varying and z fastest - matching the flat
// coordinate arrays buildGridCoords3d builds locally below, so values[idx] and
// {xs,ys,zs}[idx] always describe the same grid point without either side needing to send the
// other its own coordinates.
function buildScalarGrid3dExpr(expr, xmin, xmax, ymin, ymax, zmin, zmax, nX, nY, nZ) {
  const stepX = (xmax - xmin) / (nX - 1);
  const stepY = (ymax - ymin) / (nY - 1);
  const stepZ = (zmax - zmin) / (nZ - 1);
  const nYZ = nY * nZ;
  const gxAt = `(${formatNum(xmin)})+(iquo(k,${nYZ}))*(${formatNum(stepX)})`;
  const gyAt = `(${formatNum(ymin)})+(iquo(irem(k,${nYZ}),${nZ}))*(${formatNum(stepY)})`;
  const gzAt = `(${formatNum(zmin)})+(irem(k,${nZ}))*(${formatNum(stepZ)})`;
  const n = nX * nY * nZ;
  return `evalf(seq(subst(subst(subst((${expr}),x=(${gxAt})),y=(${gyAt})),z=(${gzAt})),k,0,${n - 1}))`;
}

// The flat x/y/z coordinate of every grid point, built locally (never round-tripped through
// Giac - the caller already knows the box and resolution, same reasoning buildScalarGridExpr's
// 2D sibling never echoes gx/gy back either) in the exact same x-slowest/z-fastest order
// buildScalarGrid3dExpr's own idx decoding uses, so values[idx] lines up with
// (xs[idx],ys[idx],zs[idx]) with no further bookkeeping.
function buildGridCoords3d(xmin, xmax, ymin, ymax, zmin, zmax, nX, nY, nZ) {
  const n = nX * nY * nZ;
  const xs = new Array(n);
  const ys = new Array(n);
  const zs = new Array(n);
  let idx = 0;
  for (let i = 0; i < nX; i++) {
    const xv = xmin + (i * (xmax - xmin)) / (nX - 1);
    for (let j = 0; j < nY; j++) {
      const yv = ymin + (j * (ymax - ymin)) / (nY - 1);
      for (let k = 0; k < nZ; k++) {
        const zv = zmin + (k * (zmax - zmin)) / (nZ - 1);
        xs[idx] = xv;
        ys[idx] = yv;
        zs[idx] = zv;
        idx++;
      }
    }
  }
  return { xs, ys, zs };
}

// A grid point outside a line's own domain (non-finite lhs-rhs there) is remapped to this
// sentinel rather than left NaN/left out - Plotly's isosurface/volume traces need every point
// of the rectangular grid present with a real number (there's no "gap" convention for them the
// way a 2D canvas path or a surface's `null` height provides). Far enough past any value a real
// equation/inequality's own lhs-rhs would plausibly take within a sane view that it never gets
// mistaken for a genuine crossing, while still being *some* finite number so interpolation near
// the domain's edge only ever biases a traced surface a hair short of that edge rather than
// producing NaN-propagated garbage.
const OUT_OF_DOMAIN = -1e6;

// Same idea as sampleSystem's own point-solving in lib/plotSample.js, generalized to three
// unknowns: only once there are at least as many equation lines as unknowns (x, y and z - fewer
// leaves a whole curve/surface of solutions, not isolated points) are the equations alone (never
// the inequalities - there's no single numeric point to solve a region down to) solved together
// for their real numeric intersection point(s), one more engine round trip on top of the
// per-line grid sampling above. A symbolic/non-numeric coordinate (an under-determined system)
// is dropped rather than plotted as a bogus point, same as the 2D version.
async function solveSystem3dPoints(evaluateRaw, equationLines) {
  if (equationLines.length < 3) return [];
  const eqText = equationLines.map((l) => `${l.lhs}=${l.rhs}`).join(' and ');
  const out = await evaluateRaw(`evalf(solve(${eqText},[x,y,z]))`);
  if (out.startsWith('GIAC_ERROR')) return [];
  const trimmed = out.trim();
  const body = trimmed.startsWith('list[') ? trimmed.slice(4) : trimmed;
  return (parseTripleList(body) ?? []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
}

// Samples every line of a 'system' row's text (equations/inequalities in x, y and z - see
// lib/plotSystem.js's parseSystemLines, called here with the 3-variable allowlist) over an
// nX-by-nY-by-nZ box. Unlike the 2D 'system' row (marching squares traced by hand - see
// lib/plotSystem.js), the actual isosurface/volume extraction happens in components/
// plot3dPanel.js via Plotly's own 'isosurface'/'volume' trace types - this just hands back each
// equation line's own raw value grid (for its own isosurface at 0), every inequality line's
// oriented grid combined via the same elementwise-min "AND" lib/plotSystem.js's
// combineInequalityGrids uses for its 2D region (>=0 exactly where every inequality holds at
// once), and - once there are 3 or more equation lines - their solved intersection point(s) (see
// solveSystem3dPoints above), drawn as markers on top of the surfaces (see plot3dPanel.js's own
// 'system' trace building).
export async function sampleSystem3d(evaluateRaw, text, view, n, definitions) {
  const lines = parseSystemLines(text, definitions, ['x', 'y', 'z']);
  if (lines.length === 0) return null;

  const { xmin, xmax, ymin, ymax, zmin, zmax } = view;
  const nX = Math.max(2, Math.floor(n));
  const nY = nX;
  const nZ = nX;
  const { xs, ys, zs } = buildGridCoords3d(xmin, xmax, ymin, ymax, zmin, zmax, nX, nY, nZ);

  const equationValues = [];
  const orientedInequalityValues = [];
  for (const line of lines) {
    const fExpr = `(${line.lhs})-(${line.rhs})`;
    const out = await evaluateRaw(buildScalarGrid3dExpr(fExpr, xmin, xmax, ymin, ymax, zmin, zmax, nX, nY, nZ));
    if (out.startsWith('GIAC_ERROR')) throw new Error(out.slice(11).trim() || t('Could not evaluate "{line}".', { line: line.raw }));
    const values = parseSampleList(out);
    if (!values) throw new Error(t('Unexpected response from the CAS engine.'));

    if (line.kind === 'equation') {
      equationValues.push(values.map((v) => (Number.isFinite(v) ? v : OUT_OF_DOMAIN)));
    } else {
      orientedInequalityValues.push(values.map((v) => (Number.isFinite(v) ? orientForHolds(line.op, v) : OUT_OF_DOMAIN)));
    }
  }

  let inequalityValues = null;
  if (orientedInequalityValues.length > 0) {
    inequalityValues = xs.map((_, idx) => {
      let m = Infinity;
      for (const arr of orientedInequalityValues) if (arr[idx] < m) m = arr[idx];
      return m;
    });
  }

  const solutionPoints = await solveSystem3dPoints(
    evaluateRaw,
    lines.filter((l) => l.kind === 'equation'),
  );

  return { xs, ys, zs, equationValues, inequalityValues, solutionPoints };
}
