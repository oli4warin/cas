// Least-squares curve fits for the "regression" command's non-sinusoidal curve types (see
// sinRegression.js for the sinusoidal fit, which needs its own nonlinear frequency search).
// Every fit here reduces to ordinary linear least squares: fitPolynomial solves it directly
// via the normal equations, and the power/exponential/logarithmic fits get there by
// log-transforming one or both axes first (the standard linearization trick for those
// models). Only the logistic fit is genuinely nonlinear in its parameters, so it's seeded by
// linearizing at an estimated asymptote and then polished with a damped Gauss-Newton
// (Levenberg-Marquardt) refinement - see fitLogistic below.

function cleanPoints(xsIn, ysIn) {
  return xsIn.map((x, i) => ({ x, y: ysIn[i] })).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
}

// Solves an n x n linear system A*x=b via Gaussian elimination with partial pivoting.
// Returns null if A is (near) singular - not expected for well-conditioned regression data,
// but a defensive fallback rather than dividing by ~0.
function solveLinear(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    if (Math.abs(M[pivot][col]) < 1e-12) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col] / M[col][col];
      if (factor !== 0) for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// Fits y = c[0] + c[1]*x + ... + c[degree]*x^degree by ordinary least squares, via the
// normal equations over the Vandermonde basis. Throws when there aren't enough usable points
// to determine a degree-`degree` curve.
export function fitPolynomial(xsIn, ysIn, degree) {
  const pts = cleanPoints(xsIn, ysIn);
  if (pts.length < degree + 1) throw new Error(`Need at least ${degree + 1} numeric (x,y) points for a degree-${degree} fit.`);
  const n = pts.length;
  const powers = pts.map((p) => {
    const row = [1];
    for (let k = 1; k <= 2 * degree; k++) row.push(row[k - 1] * p.x);
    return row;
  });
  const A = [];
  const b = [];
  for (let i = 0; i <= degree; i++) {
    const row = [];
    for (let j = 0; j <= degree; j++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += powers[k][i + j];
      row.push(s);
    }
    A.push(row);
    let sb = 0;
    for (let k = 0; k < n; k++) sb += powers[k][i] * pts[k].y;
    b.push(sb);
  }
  const sol = solveLinear(A, b);
  if (!sol) throw new Error('Could not fit a curve to this data - the x-values may not vary enough.');
  return sol;
}

// Fits y = a*x^b by linear least squares on (ln x, ln y). Requires every x and y to be
// strictly positive - inherent to the power-law model itself, not an implementation limit.
export function fitPower(xsIn, ysIn) {
  const pts = cleanPoints(xsIn, ysIn);
  if (pts.length < 2) throw new Error('Need at least 2 numeric (x,y) points for a power fit.');
  if (pts.some((p) => !(p.x > 0) || !(p.y > 0))) throw new Error('Power regression requires every x and y value to be positive.');
  const [c0, c1] = fitPolynomial(
    pts.map((p) => Math.log(p.x)),
    pts.map((p) => Math.log(p.y)),
    1,
  );
  return { a: Math.exp(c0), b: c1 };
}

// Fits y = a*e^(b*x) by linear least squares on (x, ln y). Requires every y to be positive.
export function fitExponential(xsIn, ysIn) {
  const pts = cleanPoints(xsIn, ysIn);
  if (pts.length < 2) throw new Error('Need at least 2 numeric (x,y) points for an exponential fit.');
  if (pts.some((p) => !(p.y > 0))) throw new Error('Exponential regression requires every y value to be positive.');
  const [c0, c1] = fitPolynomial(
    pts.map((p) => p.x),
    pts.map((p) => Math.log(p.y)),
    1,
  );
  return { a: Math.exp(c0), b: c1 };
}

// Fits y = a*ln(x) + b by linear least squares on (ln x, y). Requires every x to be positive.
export function fitLogarithmic(xsIn, ysIn) {
  const pts = cleanPoints(xsIn, ysIn);
  if (pts.length < 2) throw new Error('Need at least 2 numeric (x,y) points for a logarithmic fit.');
  if (pts.some((p) => !(p.x > 0))) throw new Error('Logarithmic regression requires every x value to be positive.');
  const [c0, c1] = fitPolynomial(
    pts.map((p) => Math.log(p.x)),
    pts.map((p) => p.y),
    1,
  );
  return { a: c1, b: c0 };
}

// How many Levenberg-Marquardt iterations fitLogistic below gets to polish its linearized
// seed - the model converges quickly (a handful of iterations) whenever the seed is
// reasonable, so this is generous headroom rather than a tuned minimum.
const LOGISTIC_MAX_ITERATIONS = 200;

// Fits y = c/(1+a*e^(-b*x)) by nonlinear least squares. The model is linear in none of its
// three parameters, so this seeds c from the data's own maximum (assuming the data doesn't
// exceed its own asymptote) and a,b from linearizing ln(c/y-1)=ln(a)-b*x at that fixed c,
// then polishes all three together with a damped Gauss-Newton (Levenberg-Marquardt)
// refinement - the standard approach here, since no closed-form fit exists.
export function fitLogistic(xsIn, ysIn) {
  const pts = cleanPoints(xsIn, ysIn);
  if (pts.length < 4) throw new Error('Need at least 4 numeric (x,y) points to fit a logistic curve.');
  if (pts.some((p) => !(p.y > 0))) throw new Error('Logistic regression requires every y value to be positive.');
  const maxY = Math.max(...pts.map((p) => p.y));

  let c = maxY * 1.05;
  const sub = pts.filter((p) => p.y < c);
  if (sub.length < 2) throw new Error('Could not estimate a starting logistic fit from this data.');
  const [lnA, negB] = fitPolynomial(
    sub.map((p) => p.x),
    sub.map((p) => Math.log(c / p.y - 1)),
    1,
  );
  let a = Math.exp(lnA);
  let b = -negB;

  const residuals = (a, b, c) => pts.map((p) => p.y - c / (1 + a * Math.exp(-b * p.x)));
  const sse = (r) => r.reduce((s, v) => s + v * v, 0);
  let curSse = sse(residuals(a, b, c));

  let lambda = 1e-2;
  for (let iter = 0; iter < LOGISTIC_MAX_ITERATIONS; iter++) {
    // Jacobian of the model f=c/(1+a*e^{-bx}) w.r.t. (a,b,c) at the current estimate.
    const Jf = pts.map((p) => {
      const E = Math.exp(-b * p.x);
      const denom = 1 + a * E;
      return [(-c * E) / (denom * denom), (c * a * p.x * E) / (denom * denom), 1 / denom];
    });
    const r = residuals(a, b, c);
    const JTJ = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    const JTr = [0, 0, 0];
    for (let i = 0; i < pts.length; i++) {
      for (let row = 0; row < 3; row++) {
        JTr[row] += Jf[i][row] * r[i];
        for (let col = 0; col < 3; col++) JTJ[row][col] += Jf[i][row] * Jf[i][col];
      }
    }
    let improved = false;
    for (let tries = 0; tries < 10 && !improved; tries++) {
      const A = JTJ.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) : v)));
      const delta = solveLinear(A, JTr);
      if (!delta) break;
      const trial = { a: a + delta[0], b: b + delta[1], c: c + delta[2] };
      if (!(trial.c > 0) || !Number.isFinite(trial.a) || !Number.isFinite(trial.b)) {
        lambda *= 10;
        continue;
      }
      const trialSse = sse(residuals(trial.a, trial.b, trial.c));
      if (Number.isFinite(trialSse) && trialSse <= curSse) {
        const converged = Math.abs(curSse - trialSse) < 1e-12 * (curSse + 1e-12);
        ({ a, b, c } = trial);
        curSse = trialSse;
        lambda = Math.max(lambda / 10, 1e-12);
        improved = true;
        if (converged) return { a, b, c };
      } else {
        lambda *= 10;
      }
    }
    if (!improved) break;
  }
  return { a, b, c };
}
