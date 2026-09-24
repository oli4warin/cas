// Parameter menus for the distribution _cdf/_icdf commands in xcasCommands.js - each family's
// own parameters (e.g. n/p for binomial, mu/sigma for normald), in the order Giac expects them.
// A _cdf call is built as <family>_cdf(<params...>, lower, upper) - the two-bound form, which
// Giac also accepts as a plain P(X<=upper) when lower is -infinity, so that's the default an
// empty "lower bound" field falls back to. A _icdf call is built as <family>_icdf(<params...>, p).
//
// Also doubles as the family registry for the plot panel's "Probability distribution" row (see
// components/plotPanel.js/lib/plotSample.js): `discrete` and `domain` below aren't needed by
// the _cdf/_icdf menu, only by that row.

import { XCAS_COMMAND_ALIASES } from './xcasCommands.js';

// `domain` returns a Giac boolean condition (in terms of "x" and the family's own param names)
// describing where the density/pmf is actually defined, or null when it's defined everywhere -
// see distributionDomainExpr below. Needed because several of Giac's own density commands don't
// return 0 outside their support - they extrapolate the formula instead (confirmed against the
// actual engine: exponentiald(2,-1) = 14.78, betad(2,3,1.5) = 4.5, uniformd(0,1,-0.5) = 1,
// gammad(2,1,-1) = -2.7, chisquare(3,-1) = a complex number).
const FAMILY_CONFIG = {
  binomial: {
    label: 'Binomial',
    discrete: true,
    params: [
      { key: 'n', label: 'Number of trials (n)', default: '10' },
      { key: 'p', label: 'Probability of success (p)', default: '0.5' },
    ],
    domain: (p) => `x>=0 and x<=(${p.n})`,
  },
  negbinomial: {
    label: 'Negative binomial',
    discrete: true,
    params: [
      { key: 'n', label: 'Number of successes needed (n)', default: '5' },
      { key: 'p', label: 'Probability of success (p)', default: '0.5' },
    ],
    domain: () => 'x>=0',
  },
  poisson: {
    label: 'Poisson',
    discrete: true,
    params: [{ key: 'mu', label: 'Mean (λ)', default: '3' }],
    domain: () => 'x>=0',
  },
  geometric: {
    label: 'Geometric',
    discrete: true,
    params: [{ key: 'p', label: 'Probability of success (p)', default: '0.5' }],
    // Giac's own geometric(p,k) errors outright for k=0 (confirmed against the engine) -
    // its support starts at k=1 (number of trials up to and including the first success).
    domain: () => 'x>=1',
  },
  normald: {
    label: 'Normal',
    discrete: false,
    params: [
      { key: 'mu', label: 'Mean (μ)', default: '0' },
      { key: 'sigma', label: 'Standard deviation (σ)', default: '1' },
    ],
    domain: () => null,
  },
  student: {
    label: 'Student t',
    discrete: false,
    params: [{ key: 'n', label: 'Degrees of freedom (ν)', default: '5' }],
    domain: () => null,
  },
  chisquare: {
    label: 'Chi-square',
    discrete: false,
    params: [{ key: 'n', label: 'Degrees of freedom (k)', default: '3' }],
    domain: () => 'x>=0',
  },
  fisher: {
    label: 'Fisher',
    discrete: false,
    params: [
      { key: 'n', label: 'Numerator degrees of freedom (d₁)', default: '3' },
      { key: 'd', label: 'Denominator degrees of freedom (d₂)', default: '5' },
    ],
    domain: () => 'x>=0',
  },
  exponentiald: {
    label: 'Exponential',
    discrete: false,
    params: [{ key: 'lambda', label: 'Rate (λ)', default: '1' }],
    domain: () => 'x>=0',
  },
  gammad: {
    label: 'Gamma',
    discrete: false,
    params: [
      { key: 'a', label: 'Shape (α)', default: '2' },
      { key: 'b', label: 'Scale (β)', default: '1' },
    ],
    domain: () => 'x>=0',
  },
  betad: {
    label: 'Beta',
    discrete: false,
    params: [
      { key: 'a', label: 'Alpha (α)', default: '2' },
      { key: 'b', label: 'Beta (β)', default: '2' },
    ],
    domain: () => 'x>=0 and x<=1',
  },
  cauchyd: {
    label: 'Cauchy',
    discrete: false,
    params: [
      { key: 'a', label: 'Location (x₀)', default: '0' },
      { key: 'b', label: 'Scale (γ)', default: '1' },
    ],
    domain: () => null,
  },
  weibull: {
    label: 'Weibull',
    discrete: false,
    params: [
      { key: 'k', label: 'Shape (k)', default: '1.5' },
      { key: 'lambda', label: 'Scale (λ)', default: '1' },
    ],
    domain: () => 'x>=0',
  },
  uniformd: {
    label: 'Uniform',
    discrete: false,
    params: [
      { key: 'a', label: 'Lower limit (a)', default: '0' },
      { key: 'b', label: 'Upper limit (b)', default: '1' },
    ],
    domain: (p) => `x>=(${p.a}) and x<=(${p.b})`,
  },
};

// Params-only view of FAMILY_CONFIG, for the existing _cdf/_icdf menu build loop below (same
// shape the menu code has always worked with).
const FAMILY_PARAMS = Object.fromEntries(Object.entries(FAMILY_CONFIG).map(([family, cfg]) => [family, cfg.params]));

// The plot panel's family registry: label + discreteness + params, keyed by family - see
// components/plotPanel.js (family <select> + per-family param fields) and lib/plotSample.js
// (which also needs `discrete` to know whether to sample a curve or integer bars).
export const DISTRIBUTION_FAMILIES = Object.fromEntries(
  Object.entries(FAMILY_CONFIG).map(([family, { label, discrete, params }]) => [family, { label, discrete, params }]),
);

// Wraps a family's density/pmf call in `when(domain,...,undef)` so it evaluates to Giac's own
// "undef" (-> NaN, see plotSample.js's existing NaN-as-gap/NaN-skip handling) outside its
// support, rather than the wrong extrapolated value several of Giac's own density commands
// return there (see FAMILY_CONFIG's own comment above). `paramExprs` is `{key: exprText}` for
// this family's own params (Giac expressions, e.g. "2*pi" is fine) - order is taken from
// FAMILY_CONFIG so the call is built positionally the way Giac expects.
export function distributionDomainExpr(family, paramExprs) {
  const cfg = FAMILY_CONFIG[family];
  if (!cfg) return null;
  const args = cfg.params.map((p) => `(${paramExprs[p.key] ?? p.default})`);
  const call = `${family}(${args.join(',')},x)`;
  const condition = cfg.domain(paramExprs);
  return condition ? `when(${condition},${call},undef)` : call;
}

// Overrides the "Lower bound" field's default value (see distributionMenu.js) for a _cdf
// menu whose family isn't supported down to -infinity - binomial(n,p) has no mass below 0,
// so a lower bound of -infinity, while numerically harmless (see isDefaultLowerBound there),
// is a confusing thing to show as the default.
const CDF_LOWER_DEFAULTS = {
  binomial: '0',
};

// Keyed by the exact command name (matches xcasCommands.js casing) so DISTRIBUTION_MENUS can
// double as the canonical-casing source for findDistributionMenu below.
export const DISTRIBUTION_MENUS = {};
for (const [family, params] of Object.entries(FAMILY_PARAMS)) {
  DISTRIBUTION_MENUS[`${family}_cdf`] = { kind: 'cdf', params, lowerDefault: CDF_LOWER_DEFAULTS[family] ?? '-infinity' };
  DISTRIBUTION_MENUS[`${family}_icdf`] = { kind: 'icdf', params };
}

// Case-insensitive lookup (the input field doesn't enforce casing) - returns the config plus
// its canonical command name, or null when `name` isn't one of the configured commands.
// `name` may also be one of XCAS_COMMAND_ALIASES's calculator-familiar spellings (e.g.
// "normcdf", "binomcdf") - those resolve to their canonical command first, so a bare alias
// opens the same parameter menu its canonical name would.
export function findDistributionMenu(name) {
  if (!name) return null;
  const canonical = XCAS_COMMAND_ALIASES[name.toLowerCase()] || name;
  const key = Object.keys(DISTRIBUTION_MENUS).find((k) => k.toLowerCase() === canonical.toLowerCase());
  return key ? { name: key, ...DISTRIBUTION_MENUS[key] } : null;
}

// Splits `s` on top-level commas only (not nested inside parens) - same idea as giac.js's own
// splitTopLevel, duplicated here (rather than imported) since that one's a private helper in a
// module this one shouldn't otherwise need to depend on.
function splitTopLevelArgs(s) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

function findMatchingParenLocal(s, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Recognizes a top-level "<family>_cdf(...)" call (any calculator-familiar alias from
// XCAS_COMMAND_ALIASES included, e.g. "normcdf"/"binomcdf") in a raw, hand-typed input line -
// used to offer the history entry's "plot" button (see lib/plottable.js) a ready-made
// {family, params, lower, upper} for the plot panel's "Probability distribution" row. Pure text
// parsing, no engine round trip - deliberately kept separate from giac.js's own
// parseNormalCdfCall (which backs normald_cdf's specially-formatted P(...) output and already
// has its own engine-verified infinity-bound workaround) rather than generalizing that one, so
// this addition can't destabilize it.
//
// Accepts either the single-bound form (<family>_cdf(<params...>, upper), meaning
// P(X<=upper)) or the two-bound form (<family>_cdf(<params...>, lower, upper)) - same two
// shapes findDistributionMenu's own menu can submit (see distributionMenu.js). The
// single-bound form's implied lower bound is whatever findDistributionMenu already uses as
// this family's own default (e.g. "0" for binomial, "-infinity" otherwise). Returns
// { family, params: {key: valueText}, lower, upper }, or null if `rawInput` isn't shaped like
// one of these calls.
export function parseDistributionCdfCall(rawInput) {
  if (!rawInput) return null;
  const s = rawInput.trim();
  const body = s.endsWith(';') ? s.slice(0, -1).trim() : s;
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(body);
  if (!m || !body.endsWith(')')) return null;
  const typedName = m[1];
  const canonical = (XCAS_COMMAND_ALIASES[typedName.toLowerCase()] || typedName).toLowerCase();
  if (!canonical.endsWith('_cdf')) return null;
  const family = canonical.slice(0, -'_cdf'.length);
  const cfg = FAMILY_CONFIG[family];
  if (!cfg) return null;

  const openIdx = body.indexOf('(');
  if (findMatchingParenLocal(body, openIdx) !== body.length - 1) return null;
  const args = splitTopLevelArgs(body.slice(openIdx + 1, -1)).map((a) => a.trim());
  const paramCount = cfg.params.length;

  let lower, upper;
  if (args.length === paramCount + 1) {
    lower = CDF_LOWER_DEFAULTS[family] ?? '-infinity';
    upper = args[paramCount];
  } else if (args.length === paramCount + 2) {
    lower = args[paramCount];
    upper = args[paramCount + 1];
  } else {
    return null;
  }

  const params = {};
  cfg.params.forEach((p, i) => {
    params[p.key] = args[i];
  });
  return { family, params, lower, upper };
}
