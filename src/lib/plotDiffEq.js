// Turns a differential-equation plot row (e.g. "y''-y'-y=0", or just "y'=x-y") into the two
// Giac expressions for the vector it draws at each grid point - see plotSample.js's
// sampleDiffEqField, which asks the CAS to isolate the highest derivative and then batches the
// grid evaluation exactly like every other plot mode.
//
// Only 1st- and 2nd-order equations in a single unknown "y" are supported. A 1st-order
// equation y'=f(x,y) draws an ordinary direction field over the plot's own (x,y) axes. A
// 2nd-order equation y''=g(x,y,y') is reduced to the first-order system y'=v, v'=g and drawn
// as a phase-plane vector field over (y,v) instead - the standard way to visualize a 2nd-order
// ODE in two dimensions. Because that phase plane has no axis left for x, any explicit x in a
// 2nd-order equation is evaluated at x=0 (i.e. only the autonomous case, g(y,v), is fully
// accurate - matching the equations this mode is meant for, like "y''-y'-y=0").

// Giac has no derivative-shorthand identifier of its own to solve for, so "y''"/"y'"/"y" are
// renamed to plain identifiers before anything reaches the engine - longest match first, so
// "y''" is consumed whole before the "y'" pass ever sees it. A "'" still left afterwards means
// an order this mode doesn't support (3rd+) or a malformed prime run.
function renameDerivatives(text) {
  return text.replace(/y''/g, 'D2Y').replace(/y'/g, 'D1Y').replace(/(?<![A-Za-z0-9_])y(?![A-Za-z0-9_'])/g, 'D0Y');
}

// Index of the first top-level "=" in `s` (outside any (), [], {} nesting) that means "this is
// an equation" - not ":=", "==", "!=", "<=", ">=". Mirrors hasTopLevelRelation's own "=" check
// in giac.js.
function findTopLevelEquals(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === '=' && depth === 0) {
      const prev = s[i - 1];
      const next = s[i + 1];
      if (prev !== '=' && prev !== '!' && prev !== '<' && prev !== '>' && prev !== ':' && next !== '=') return i;
    }
  }
  return -1;
}

// Parses a row's raw ODE text into what's needed to ask Giac for the highest derivative:
// which order it is, and the Giac expression `eqForSolve` (meaning "eqForSolve = 0") to
// solve for `solveVar`. Throws a user-facing Error for anything this mode can't handle.
export function parseDiffEq(rawText) {
  const renamed = renameDerivatives(rawText.trim());
  if (renamed.includes("'")) {
    throw new Error("Only 1st- and 2nd-order derivatives (y', y'') are supported.");
  }
  const order = renamed.includes('D2Y') ? 2 : renamed.includes('D1Y') ? 1 : 0;
  if (order === 0) {
    throw new Error("Enter a differential equation in y, e.g. y'=x-y or y''-y'-y=0.");
  }

  const eqIdx = findTopLevelEquals(renamed);
  const lhs = eqIdx === -1 ? renamed : renamed.slice(0, eqIdx);
  const rhs = eqIdx === -1 ? '0' : renamed.slice(eqIdx + 1);

  return { order, solveVar: order === 2 ? 'D2Y' : 'D1Y', eqForSolve: `(${lhs})-(${rhs})` };
}

// Builds the (comp1, comp2) vector-field components as Giac expressions in the two generic
// grid variables "gx"/"gy" (see buildFieldSampleExpr in plotSample.js, which substitutes the
// actual grid coordinates in). `solvedRhs` is Giac's own solution for the highest derivative,
// still in terms of D0Y (the function value "y"), D1Y (its derivative "y'", 2nd-order only)
// and, for a 1st-order equation, "x".
//
// 1st order: y'=f(x,y). The grid *is* the ordinary (x,y) plane, so gx=x, gy=D0Y, and the
// vector is (1, f) - "move right at unit speed, up/down at the equation's own slope".
//
// 2nd order: y''=g(x,y,y'), reduced to the system y'=v, v'=g. The grid is the phase plane
// (y,v), so gx=D0Y, gy=D1Y, and the vector is (v, g) = (gy, g) - x is pinned to 0 first (see
// module comment).
export function buildFieldComponents(order, solvedRhs) {
  if (order === 1) {
    const withGy = solvedRhs.replace(/D0Y/g, 'gy');
    const comp2 = withGy.replace(/\bx\b/g, 'gx');
    return { comp1: '1', comp2 };
  }
  const fixedX = `subst((${solvedRhs}),x=(0))`;
  const comp2 = fixedX.replace(/D0Y/g, 'gx').replace(/D1Y/g, 'gy');
  return { comp1: 'gy', comp2 };
}
