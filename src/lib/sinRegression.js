// Sinusoidal ("SinReg") least-squares fit: finds a, b, c, d minimizing
// sum((y_i - (a*sin(b*x_i+c)+d))^2) over a set of (x_i, y_i) points. Giac has native
// linear/exponential/logarithmic/power/polynomial/logistic regressions (see
// cascmd_en658-663 in its docs) but nothing sinusoidal, so this is implemented directly in
// JS and wired into giac.js as a new sinusoidal_regression(xcoords,ycoords) call.
//
// The frequency b enters the model nonlinearly, but for any *fixed* b the model
// y = p*sin(b*x) + q*cos(b*x) + d is linear in (p,q,d) - the standard trick for this kind
// of fit. So the search only has to be one-dimensional: grid-search b over a plausible
// range, keep the grid point with the lowest residual, then polish it with a golden-section
// search nearby. The final (p,q,d) at the winning b converts back to amplitude/phase via
// a=hypot(p,q), c=atan2(q,p).

// Solves the 3x3 linear system M*[p,q,d]=v via Cramer's rule. Returns null if M is (near)
// singular - not expected for real data with >=3 points spread across at least two x
// values, but a defensive fallback rather than dividing by ~0.
function solve3x3(M, v) {
  const det3 = (m) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det3(M);
  const scale = Math.abs(M[0][0]) + Math.abs(M[1][1]) + Math.abs(M[2][2]) + 1;
  if (!Number.isFinite(D) || Math.abs(D) < 1e-12 * scale) return null;
  const withCol = (col, vals) => M.map((row, i) => row.map((val, j) => (j === col ? vals[i] : val)));
  return [det3(withCol(0, v)) / D, det3(withCol(1, v)) / D, det3(withCol(2, v)) / D];
}

// For a fixed angular frequency b, solves the linear least-squares sub-problem for
// (p,q,d) in y = p*sin(b*x)+q*cos(b*x)+d and reports its residual sum of squares - the
// quantity the outer frequency search (below) is trying to minimize.
function fitAtFrequency(b, xs, ys) {
  let Sss = 0,
    Scc = 0,
    Ssc = 0,
    Ss = 0,
    Sc = 0,
    Ssy = 0,
    Scy = 0,
    Sy = 0;
  const n = xs.length;
  for (let i = 0; i < n; i++) {
    const s = Math.sin(b * xs[i]);
    const c = Math.cos(b * xs[i]);
    Sss += s * s;
    Scc += c * c;
    Ssc += s * c;
    Ss += s;
    Sc += c;
    Ssy += s * ys[i];
    Scy += c * ys[i];
    Sy += ys[i];
  }
  const sol = solve3x3(
    [
      [Sss, Ssc, Ss],
      [Ssc, Scc, Sc],
      [Ss, Sc, n],
    ],
    [Ssy, Scy, Sy],
  );
  if (!sol) return null;
  const [p, q, d] = sol;
  let rss = 0;
  for (let i = 0; i < n; i++) {
    const residual = ys[i] - (p * Math.sin(b * xs[i]) + q * Math.cos(b * xs[i]) + d);
    rss += residual * residual;
  }
  return { p, q, d, rss };
}

// Minimizes a unimodal-ish f(b) over [lo,hi] via golden-section search - used to polish the
// grid search's winning frequency (below) within its own neighboring grid cell, where the
// residual surface is smooth and effectively single-peaked.
function goldenSectionMin(f, lo, hi, iterations) {
  const phi = (Math.sqrt(5) - 1) / 2;
  let a = lo,
    b = hi;
  let c = b - phi * (b - a);
  let d = a + phi * (b - a);
  let fc = f(c);
  let fd = f(d);
  for (let i = 0; i < iterations; i++) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - phi * (b - a);
      fc = f(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + phi * (b - a);
      fd = f(d);
    }
  }
  return (a + b) / 2;
}

// How finely to grid-search the frequency range below - the residual surface has features
// on the scale of the "Fourier resolution" 2*pi/xSpan, so this oversamples well past that to
// avoid stepping over the true global minimum before golden-section search polishes it.
const GRID_STEPS = 500;

// Fits y = a*sin(b*x+c)+d to a set of (x,y) points by least squares. Throws a
// user-facing Error when there isn't enough usable data to estimate a frequency from (fewer
// than 4 finite points, or every x-value identical).
export function fitSinusoid(xsIn, ysIn) {
  const pts = xsIn
    .map((x, i) => ({ x, y: ysIn[i] }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length < 4) throw new Error('Need at least 4 numeric (x,y) points to fit a sinusoid.');
  pts.sort((p, q) => p.x - q.x);
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const n = xs.length;

  const xSpan = xs[n - 1] - xs[0];
  if (!(xSpan > 0)) throw new Error('All x-values are identical - cannot estimate a frequency.');
  const spacing = xSpan / (n - 1);

  // Allow detecting a period up to twice the data span (a bit under one full cycle across
  // all the data) at the low end, and stop just short of the Nyquist limit implied by the
  // average spacing at the high end, where a fit becomes unreliable/aliased.
  const bMin = (2 * Math.PI) / (xSpan * 4);
  const bMax = ((Math.PI / spacing) * 9) / 10;
  if (!(bMax > bMin)) throw new Error('Not enough distinct x-values to estimate a frequency.');

  let best = null;
  for (let i = 0; i <= GRID_STEPS; i++) {
    const b = bMin + ((bMax - bMin) * i) / GRID_STEPS;
    const fit = fitAtFrequency(b, xs, ys);
    if (fit && (!best || fit.rss < best.rss)) best = { ...fit, b };
  }
  if (!best) throw new Error('Could not fit a sinusoid to this data.');

  const gridStep = (bMax - bMin) / GRID_STEPS;
  const refinedB = goldenSectionMin(
    (b) => fitAtFrequency(b, xs, ys)?.rss ?? Infinity,
    Math.max(bMin, best.b - gridStep),
    Math.min(bMax, best.b + gridStep),
    60,
  );
  const refined = fitAtFrequency(refinedB, xs, ys);
  const winner = refined && refined.rss <= best.rss ? { ...refined, b: refinedB } : best;

  return { a: Math.hypot(winner.p, winner.q), b: winner.b, c: Math.atan2(winner.q, winner.p), d: winner.d };
}
