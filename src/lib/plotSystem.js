// Parsing/geometry for the plot panel's 'system' row (see components/plotPanel.js) - a
// multiline text field, one equation or inequality per line, restricted to the two names
// "x"/"y" (session-defined names - see giac.js's own collectFreeVariables - are fine, since
// they're resolved values by the time this reaches the CAS, not genuinely free unknowns).
// Pure parsing/math only - no engine calls here; see lib/plotSample.js's sampleSystem for the
// actual grid evaluation and solve() round trips this builds on.

import { collectFreeVariables } from './giac.js';

// Index/operator/length of the first top-level relational operator in `s` (outside any
// (),[],{} nesting) - "<=", ">=", "!=", "<", ">", or a plain "=" (not ":=", "==", already
// excluded the same way giac.js's own hasTopLevelRelation is). Mirrors plotDiffEq.js's
// findTopLevelEquals, generalized to the four ordering relations an inequality can use.
function findTopLevelRelation(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0) {
      if (c === '!' && s[i + 1] === '=') return { index: i, op: '!=', length: 2 };
      if (c === '<' || c === '>') {
        const hasEq = s[i + 1] === '=';
        return { index: i, op: c + (hasEq ? '=' : ''), length: hasEq ? 2 : 1 };
      }
      if (c === '=') {
        const prev = s[i - 1];
        const next = s[i + 1];
        if (prev !== '=' && prev !== '!' && prev !== '<' && prev !== '>' && prev !== ':' && next !== '=') {
          return { index: i, op: '=', length: 1 };
        }
      }
    }
  }
  return null;
}

// Parses one line into {raw, lhs, rhs, op, kind} - kind 'equation' for "=", 'inequality' for
// the four ordering relations. Throws a user-facing Error (surfaced as the row's own error,
// same as every other mode's sampling error - see plotPanel.js) when the line isn't a
// relation at all, is a "!=" (no sensible curve or shaded region), or names any variable
// besides x/y.
export function parseSystemLine(rawLine, definitions = new Map()) {
  const line = rawLine.trim().replace(/;\s*$/, '').trim();
  const rel = findTopLevelRelation(line);
  if (!rel) throw new Error(`"${line}" is not an equation or inequality in x and y.`);
  if (rel.op === '!=') throw new Error(`"${line}": "!=" can't be plotted as a curve or region.`);
  const lhs = line.slice(0, rel.index).trim();
  const rhs = line.slice(rel.index + rel.length).trim();
  const extra = collectFreeVariables(`(${lhs})-(${rhs})`, definitions).filter((v) => v !== 'x' && v !== 'y');
  if (extra.length > 0) throw new Error(`Only x and y are allowed here (found "${extra[0]}").`);
  return { raw: line, lhs, rhs, op: rel.op, kind: rel.op === '=' ? 'equation' : 'inequality' };
}

// Parses every non-blank line of a system row's text, in order - throws on the first line
// that fails parseSystemLine (blank text/no lines just yields an empty array, same as every
// other mode's "nothing typed yet" case).
export function parseSystemLines(text, definitions = new Map()) {
  return (text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => parseSystemLine(l, definitions));
}

// Linear-interpolated fraction of the way from `v0` to `v1` where the value crosses zero -
// used for both edges below. `v0`/`v1` are assumed to already be finite and of opposite sign
// (or one exactly zero) by the caller.
function zeroCrossingT(v0, v1) {
  return v0 === v1 ? 0.5 : v0 / (v0 - v1);
}

// Traces F(x,y)=0 through a sampled (nX by nY) grid of F values via marching squares: for
// each cell, linearly interpolates a crossing point on any of its 4 edges where the sign
// flips, then pairs those crossings into line segments. A cell with any non-finite corner
// (outside the function's domain) is skipped entirely - no segment drawn through a gap. The
// ambiguous 4-crossing "saddle" case (both diagonals disagree) just pairs crossings in
// scan order rather than resolving via the cell's center value - a rare enough artifact
// (exact saddle alignment) not worth the extra complexity here.
export function traceContourSegments(grid, xmin, xmax, ymin, ymax, nX, nY) {
  const segments = [];
  const stepX = (xmax - xmin) / (nX - 1);
  const stepY = (ymax - ymin) / (nY - 1);

  for (let i = 0; i < nX - 1; i++) {
    for (let j = 0; j < nY - 1; j++) {
      const v00 = grid[i][j];
      const v10 = grid[i + 1][j];
      const v01 = grid[i][j + 1];
      const v11 = grid[i + 1][j + 1];
      if (![v00, v10, v01, v11].every(Number.isFinite)) continue;

      const x0 = xmin + i * stepX;
      const x1 = xmin + (i + 1) * stepX;
      const y0 = ymin + j * stepY;
      const y1 = ymin + (j + 1) * stepY;

      const crossings = [];
      if ((v00 >= 0) !== (v10 >= 0)) crossings.push({ x: x0 + zeroCrossingT(v00, v10) * (x1 - x0), y: y0 });
      if ((v10 >= 0) !== (v11 >= 0)) crossings.push({ x: x1, y: y0 + zeroCrossingT(v10, v11) * (y1 - y0) });
      if ((v01 >= 0) !== (v11 >= 0)) crossings.push({ x: x0 + zeroCrossingT(v01, v11) * (x1 - x0), y: y1 });
      if ((v00 >= 0) !== (v01 >= 0)) crossings.push({ x: x0, y: y0 + zeroCrossingT(v00, v01) * (y1 - y0) });

      if (crossings.length === 2) segments.push([crossings[0], crossings[1]]);
      else if (crossings.length === 4) segments.push([crossings[0], crossings[1]], [crossings[2], crossings[3]]);
    }
  }
  return segments;
}

// Flips an inequality's own lhs-rhs value so that "the inequality holds" always means "this
// value is >= 0", regardless of which of the four ordering relations it originally used -
// e.g. lhs<rhs (v<0) becomes -v (>=0 exactly when the original held). Letting every
// inequality line share this one sign convention is what makes combineInequalityGrids below
// possible: several inequalities' oriented grids can be combined with a plain elementwise
// min(), since "every one holds" is then just "the smallest of them is still >= 0". Strict vs
// non-strict (< vs <=) aren't distinguished (a boundary is a measure-zero set either way,
// invisible at plotting resolution - same reason traceContourSegments treats a zero corner as
// "inside" either way).
export function orientForHolds(op, v) {
  return op === '<' || op === '<=' ? -v : v;
}

// Combines several inequality lines' own oriented grids (see orientForHolds) into the single
// grid of "how far inside the *combined* region (all of them at once)" - the elementwise
// min() across lines, which is >= 0 at a point exactly when every single inequality's own
// oriented value is (the standard implicit-function way to build the intersection/AND of
// several regions as one scalar field, so the exact same marching-squares machinery already
// built for a single equation/inequality - traceContourSegments, buildRegionFillPolygons -
// draws the *system's* combined region, not each inequality's own half-plane separately). A
// point outside any one line's own domain (its grid value non-finite there) makes the
// combined value non-finite too, so the merged region stays skipped there the same way a
// single line's own gap would be.
export function combineInequalityGrids(orientedGrids, nX, nY) {
  const combined = [];
  for (let i = 0; i < nX; i++) {
    const col = new Array(nY);
    for (let j = 0; j < nY; j++) {
      let m = Infinity;
      for (const grid of orientedGrids) {
        const v = grid[i][j];
        if (!Number.isFinite(v)) {
          m = NaN;
          break;
        }
        if (v < m) m = v;
      }
      col[j] = m;
    }
    combined.push(col);
  }
  return combined;
}

// Builds each cell's own fill polygon (the part of the cell where the grid's value is >= 0)
// via the same corner/edge case analysis traceContourSegments uses for the boundary alone -
// a corner that's inside contributes its own point, and each edge whose two corners disagree
// contributes its interpolated crossing point, walked once around the cell in a fixed order
// (bottom-left -> bottom-right -> top-right -> top-left) so the result is always a single
// simple polygon: the full cell square (all 4 corners inside), empty (none), a corner
// triangle/pentagon (1 or 3 inside), or a band spanning the cell (2 adjacent inside). The
// ambiguous "saddle" case (2 *opposite* corners inside) still walks the boundary in this same
// fixed order rather than splitting along a diagonal - a connected hexagon rather than two
// disconnected triangles, a deliberate (and rare) over-fill matching the same tradeoff
// traceContourSegments makes for its own saddle case. Filling every returned polygon as one
// single path (see plotPanel.js's 'system' style) rather than one fillRect/fill() per polygon
// is what keeps neighboring cells' shared edges seamless - two separate semi-transparent fills
// meeting at an edge would double up their opacity right on the seam.
export function buildRegionFillPolygons(grid, xmin, xmax, ymin, ymax, nX, nY) {
  const polygons = [];
  const stepX = (xmax - xmin) / (nX - 1);
  const stepY = (ymax - ymin) / (nY - 1);
  const inside = (v) => Number.isFinite(v) && v >= 0;

  for (let i = 0; i < nX - 1; i++) {
    for (let j = 0; j < nY - 1; j++) {
      const v00 = grid[i][j];
      const v10 = grid[i + 1][j];
      const v01 = grid[i][j + 1];
      const v11 = grid[i + 1][j + 1];
      if (![v00, v10, v01, v11].every(Number.isFinite)) continue;

      const x0 = xmin + i * stepX;
      const x1 = xmin + (i + 1) * stepX;
      const y0 = ymin + j * stepY;
      const y1 = ymin + (j + 1) * stepY;

      const corners = [
        { x: x0, y: y0, v: v00 },
        { x: x1, y: y0, v: v10 },
        { x: x1, y: y1, v: v11 },
        { x: x0, y: y1, v: v01 },
      ];
      const poly = [];
      for (let k = 0; k < 4; k++) {
        const cur = corners[k];
        const next = corners[(k + 1) % 4];
        const curIn = inside(cur.v);
        if (curIn) poly.push({ x: cur.x, y: cur.y });
        if (curIn !== inside(next.v)) {
          const t = zeroCrossingT(cur.v, next.v);
          poly.push({ x: cur.x + t * (next.x - cur.x), y: cur.y + t * (next.y - cur.y) });
        }
      }
      if (poly.length >= 3) polygons.push(poly);
    }
  }
  return polygons;
}
