// Parameter menus for the distribution _cdf/_icdf commands in xcasCommands.js - each family's
// own parameters (e.g. n/p for binomial, mu/sigma for normald), in the order Giac expects them.
// A _cdf call is built as <family>_cdf(<params...>, lower, upper) - the two-bound form, which
// Giac also accepts as a plain P(X<=upper) when lower is -infinity, so that's the default an
// empty "lower bound" field falls back to. A _icdf call is built as <family>_icdf(<params...>, p).
//
// Also doubles as the family registry for the plot panel's "Probability distribution" row (see
// components/plotPanel.js/lib/plotSample.js) and for giac.js's own _cdf output formatting (see
// evaluateOtherDistributionCdf there) - `discrete`/`bounds`/`symbol`/`symbolText` below aren't
// needed by the _cdf/_icdf menu itself, only by those two.

import { XCAS_COMMAND_ALIASES } from './xcasCommands.js';

// `bounds` returns this family's own natural support {min, max} as Giac-expression text (in
// terms of the family's own param names, e.g. uniformd's own "a"/"b") - 'infinity'/'-infinity'
// literal for an unbounded side. Serves two purposes:
// - distributionDomainExpr below derives a `when(...)` guard from it, because several of
//   Giac's own density commands don't return 0 outside their support - they extrapolate the
//   formula instead (confirmed against the actual engine: exponentiald(2,-1) = 14.78,
//   betad(2,3,1.5) = 4.5, uniformd(0,1,-0.5) = 1, gammad(2,1,-1) = -2.7, chisquare(3,-1) = a
//   complex number).
// - giac.js's own _cdf output formatting (see evaluateOtherDistributionCdf there) compares a
//   typed lower/upper bound against these to recognize e.g. "binomial_cdf(10,0.5,0,6)" as
//   exactly "P(X<=6)" (0 is Binomial's own natural minimum, so showing it is redundant).
//
// `symbol`/`symbolText` give this family's own standard mathematical notation for its own
// random variable (e.g. "Bin(n,p)"/"\mathrm{Bin}(n,\,p)", or a subscript form like
// "t(n)"/"t_{n}" for the handful of families with a traditional single-letter symbol) - also
// only consumed by giac.js's _cdf formatting, given the already-rendered LaTeX/plain-text of
// each param in FAMILY_CONFIG order.
const FAMILY_CONFIG = {
  binomial: {
    label: 'Binomial',
    discrete: true,
    params: [
      { key: 'n', label: 'Number of trials (n)', default: '10' },
      { key: 'p', label: 'Probability of success (p)', default: '0.5' },
    ],
    bounds: (p) => ({ min: '0', max: `(${p.n})` }),
    symbol: ([n, p]) => `\\mathrm{Bin}(${n},\\,${p})`,
    symbolText: ([n, p]) => `Bin(${n},${p})`,
  },
  negbinomial: {
    label: 'Negative binomial',
    discrete: true,
    params: [
      { key: 'n', label: 'Number of successes needed (n)', default: '5' },
      { key: 'p', label: 'Probability of success (p)', default: '0.5' },
    ],
    bounds: () => ({ min: '0', max: 'infinity' }),
    symbol: ([n, p]) => `\\mathrm{NB}(${n},\\,${p})`,
    symbolText: ([n, p]) => `NB(${n},${p})`,
  },
  poisson: {
    label: 'Poisson',
    discrete: true,
    params: [{ key: 'mu', label: 'Mean (λ)', default: '3' }],
    bounds: () => ({ min: '0', max: 'infinity' }),
    symbol: ([mu]) => `\\mathrm{Pois}(${mu})`,
    symbolText: ([mu]) => `Pois(${mu})`,
  },
  geometric: {
    label: 'Geometric',
    discrete: true,
    params: [{ key: 'p', label: 'Probability of success (p)', default: '0.5' }],
    // Giac's own geometric(p,k) errors outright for k=0 (confirmed against the engine) -
    // its support starts at k=1 (number of trials up to and including the first success).
    bounds: () => ({ min: '1', max: 'infinity' }),
    symbol: ([p]) => `\\mathrm{Geom}(${p})`,
    symbolText: ([p]) => `Geom(${p})`,
  },
  normald: {
    label: 'Normal',
    discrete: false,
    params: [
      { key: 'mu', label: 'Mean (μ)', default: '0' },
      { key: 'sigma', label: 'Standard deviation (σ)', default: '1' },
    ],
    bounds: () => ({ min: '-infinity', max: 'infinity' }),
    // Unused by giac.js, which has its own dedicated normald_cdf formatting (see
    // parseNormalCdfCall/formatNormalCdfResult there) - kept here only for this table's own
    // completeness/symmetry across every family.
    symbol: ([mu, sigma]) => `\\mathcal{N}(${mu},\\,${sigma})`,
    symbolText: ([mu, sigma]) => `N(${mu},${sigma})`,
  },
  student: {
    label: 'Student t',
    discrete: false,
    params: [{ key: 'n', label: 'Degrees of freedom (ν)', default: '5' }],
    bounds: () => ({ min: '-infinity', max: 'infinity' }),
    symbol: ([n]) => `t_{${n}}`,
    symbolText: ([n]) => `t(${n})`,
  },
  chisquare: {
    label: 'Chi-square',
    discrete: false,
    params: [{ key: 'n', label: 'Degrees of freedom (k)', default: '3' }],
    bounds: () => ({ min: '0', max: 'infinity' }),
    symbol: ([n]) => `\\chi^2_{${n}}`,
    symbolText: ([n]) => `ChiSq(${n})`,
  },
  fisher: {
    label: 'Fisher',
    discrete: false,
    params: [
      { key: 'n', label: 'Numerator degrees of freedom (d₁)', default: '3' },
      { key: 'd', label: 'Denominator degrees of freedom (d₂)', default: '5' },
    ],
    bounds: () => ({ min: '0', max: 'infinity' }),
    symbol: ([n, d]) => `F_{${n},\\,${d}}`,
    symbolText: ([n, d]) => `F(${n},${d})`,
  },
  exponentiald: {
    label: 'Exponential',
    discrete: false,
    params: [{ key: 'lambda', label: 'Rate (λ)', default: '1' }],
    bounds: () => ({ min: '0', max: 'infinity' }),
    symbol: ([lambda]) => `\\mathrm{Exp}(${lambda})`,
    symbolText: ([lambda]) => `Exp(${lambda})`,
  },
  gammad: {
    label: 'Gamma',
    discrete: false,
    params: [
      { key: 'a', label: 'Shape (α)', default: '2' },
      { key: 'b', label: 'Scale (β)', default: '1' },
    ],
    bounds: () => ({ min: '0', max: 'infinity' }),
    symbol: ([a, b]) => `\\Gamma(${a},\\,${b})`,
    symbolText: ([a, b]) => `Gamma(${a},${b})`,
  },
  betad: {
    label: 'Beta',
    discrete: false,
    params: [
      { key: 'a', label: 'Alpha (α)', default: '2' },
      { key: 'b', label: 'Beta (β)', default: '2' },
    ],
    bounds: () => ({ min: '0', max: '1' }),
    symbol: ([a, b]) => `\\mathrm{Beta}(${a},\\,${b})`,
    symbolText: ([a, b]) => `Beta(${a},${b})`,
  },
  cauchyd: {
    label: 'Cauchy',
    discrete: false,
    params: [
      { key: 'a', label: 'Location (x₀)', default: '0' },
      { key: 'b', label: 'Scale (γ)', default: '1' },
    ],
    bounds: () => ({ min: '-infinity', max: 'infinity' }),
    symbol: ([a, b]) => `\\mathrm{Cauchy}(${a},\\,${b})`,
    symbolText: ([a, b]) => `Cauchy(${a},${b})`,
  },
  weibull: {
    label: 'Weibull',
    discrete: false,
    params: [
      { key: 'k', label: 'Shape (k)', default: '1.5' },
      { key: 'lambda', label: 'Scale (λ)', default: '1' },
    ],
    bounds: () => ({ min: '0', max: 'infinity' }),
    symbol: ([k, lambda]) => `\\mathrm{Weibull}(${k},\\,${lambda})`,
    symbolText: ([k, lambda]) => `Weibull(${k},${lambda})`,
  },
  uniformd: {
    label: 'Uniform',
    discrete: false,
    params: [
      { key: 'a', label: 'Lower limit (a)', default: '0' },
      { key: 'b', label: 'Upper limit (b)', default: '1' },
    ],
    bounds: (p) => ({ min: `(${p.a})`, max: `(${p.b})` }),
    symbol: ([a, b]) => `\\mathcal{U}(${a},\\,${b})`,
    symbolText: ([a, b]) => `U(${a},${b})`,
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

// Builds the Giac boolean condition (in terms of "x") a family's own {min,max} (see
// FAMILY_CONFIG's `bounds`) describes, or null when neither side is actually bounded.
function domainFromBounds({ min, max }) {
  const parts = [];
  if (min !== '-infinity') parts.push(`x>=${min}`);
  if (max !== 'infinity') parts.push(`x<=${max}`);
  return parts.length ? parts.join(' and ') : null;
}

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
  const condition = domainFromBounds(cfg.bounds(paramExprs));
  return condition ? `when(${condition},${call},undef)` : call;
}

// This family's own natural support {min, max}, as Giac-expression text - see FAMILY_CONFIG's
// own comment on `bounds` above for what consumes this.
export function distributionBounds(family, paramExprs) {
  return FAMILY_CONFIG[family]?.bounds(paramExprs) ?? null;
}

// This family's standard mathematical notation for its own random variable, given its params'
// already-rendered LaTeX (`symbol`) or plain text (`symbolText`), in FAMILY_CONFIG order - see
// FAMILY_CONFIG's own comment above for examples. Returns null for an unknown family.
export function distributionSymbolLatex(family, paramLatexArr) {
  return FAMILY_CONFIG[family]?.symbol(paramLatexArr) ?? null;
}
export function distributionSymbolText(family, paramTextArr) {
  return FAMILY_CONFIG[family]?.symbolText(paramTextArr) ?? null;
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

// Same "+infinity"/"-infinity" token spellings giac.js's own isPositiveInfinityToken/
// isNegativeInfinityToken recognize, generalized to any plain finite decimal too - duplicated
// here (rather than imported) for the same reason splitTopLevelArgs above is: this module
// shouldn't depend on giac.js's own private helpers. Returns null for anything else (an
// invalid expression mid-edit, a complex/symbolic leftover, ...).
const PLAIN_NUMBER_RE = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i;
function parseNumericBoundToken(trimmed) {
  if (/^\+?(infinity|inf)$/i.test(trimmed)) return Infinity;
  if (/^-(infinity|inf)$/i.test(trimmed)) return -Infinity;
  return PLAIN_NUMBER_RE.test(trimmed) ? parseFloat(trimmed) : null;
}

// Shared by giac.js's evaluateOtherDistributionCdf (the calculator's own `_cdf` output
// formatting) and lib/plotSample.js's computeDistributionProbability (the plot panel's inline
// "P(...)≈..." readout) - decides how to compute P(lower<=X<=upper) for `family` without ever
// using Giac's own two-bound `<family>_cdf(params,lower,upper)` form, which is confirmed wrong
// for several families even with two perfectly ordinary *finite* bounds (e.g.
// weibull_cdf(1.5,1,0.5,2) = 0.8407... where the correct value, confirmed by subtracting the
// *single*-bound form instead, is 0.6431...; negbinomial_cdf's two-bound form is similarly
// wrong even for an interior range). The single-bound form (family_cdf(params,x), meaning
// exactly P(X<=x)) is the one shape confirmed reliable for every family - so every plan here
// is built purely from single-bound calls: P(X<=upper) directly, a complement of one such call
// for P(X>=lower), or their difference for a genuine two-sided range.
//
// `lower`/`upper` are dropped from the comparison (and so from the eventual P(...) label) not
// just for a literal +-infinity but whenever they numerically equal this family's own natural
// support extreme (see FAMILY_CONFIG's own `bounds`) - e.g. a Binomial's own lower bound of 0
// is exactly as redundant as -infinity would be, since it can never go lower anyway. `lower`
// and `upper` both dropped (asking for the whole distribution, probability 1) is handled too -
// as the trivial literal "1" - the two callers differ on what to do with that (see their own
// comments), which is why this reports it back via `lowerDropped`/`upperDropped` rather than
// just returning null itself.
//
// `evaluateRaw` is `(expr) => Promise<string>` - either giac.js's own rawEvalAsync or the plot
// panel's evaluateRaw prop, both matching this shape. Returns null when the family is unknown
// or any of the four bound-like values (the call's own lower/upper, the family's own min/max)
// doesn't evalf() to a plain real (an invalid expression mid-edit, say).
export async function resolveDistributionCdfPlan(evaluateRaw, family, params, lower, upper) {
  const cfg = FAMILY_CONFIG[family];
  if (!cfg) return null;
  const bounds = cfg.bounds(params);

  // One round trip for all four bound-like values: the call's own lower/upper, and its
  // family's own natural min/max (possibly in terms of this same call's own params, e.g.
  // Binomial's own max is its "n").
  const listOut = await evaluateRaw(`evalf([${lower},${upper},${bounds.min},${bounds.max}])`);
  if (listOut.startsWith('GIAC_ERROR')) return null;
  const trimmed = listOut.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  const tokens = splitTopLevelArgs(trimmed.slice(1, -1)).map((t) => parseNumericBoundToken(t.trim()));
  if (tokens.length !== 4 || tokens.some((n) => n == null)) return null;
  const [lowerNum, upperNum, minNum, maxNum] = tokens;

  const lowerDropped = lowerNum <= minNum;
  const upperDropped = upperNum >= maxNum;

  const argsText = cfg.params.map((p) => `(${params[p.key] ?? p.default})`).join(',');
  // A discrete family's own P(X>=lower)/P(lower<=X<=upper) needs "X<lower" - i.e. "X<=lower-1"
  // for an integer-valued X - built from the same single-bound form P(X<=upper) already uses.
  const lowerBelow = cfg.discrete ? `(${lower})-1` : lower;

  const giacExpr =
    lowerDropped && upperDropped
      ? '1'
      : lowerDropped
        ? `${family}_cdf(${argsText},${upper})`
        : upperDropped
          ? `1-${family}_cdf(${argsText},${lowerBelow})`
          : `${family}_cdf(${argsText},${upper})-${family}_cdf(${argsText},${lowerBelow})`;

  return { giacExpr, lowerDropped, upperDropped };
}
