// Parameter menus for the distribution _cdf/_icdf commands in xcasCommands.js - each family's
// own parameters (e.g. n/p for binomial, mu/sigma for normald), in the order Giac expects them.
// A _cdf call is built as <family>_cdf(<params...>, lower, upper) - the two-bound form, which
// Giac also accepts as a plain P(X<=upper) when lower is -infinity, so that's the default an
// empty "lower bound" field falls back to. A _icdf call is built as <family>_icdf(<params...>, p).

import { XCAS_COMMAND_ALIASES } from './xcasCommands.js';

const FAMILY_PARAMS = {
  binomial: [
    { key: 'n', label: 'Number of trials (n)' },
    { key: 'p', label: 'Probability of success (p)' },
  ],
  negbinomial: [
    { key: 'n', label: 'Number of successes needed (n)' },
    { key: 'p', label: 'Probability of success (p)' },
  ],
  poisson: [{ key: 'mu', label: 'Mean (λ)' }],
  geometric: [{ key: 'p', label: 'Probability of success (p)' }],
  normald: [
    { key: 'mu', label: 'Mean (μ)', default: '0' },
    { key: 'sigma', label: 'Standard deviation (σ)', default: '1' },
  ],
  student: [{ key: 'n', label: 'Degrees of freedom (ν)' }],
  chisquare: [{ key: 'n', label: 'Degrees of freedom (k)' }],
  fisher: [
    { key: 'n', label: 'Numerator degrees of freedom (d₁)' },
    { key: 'd', label: 'Denominator degrees of freedom (d₂)' },
  ],
  exponentiald: [{ key: 'lambda', label: 'Rate (λ)' }],
  gammad: [
    { key: 'a', label: 'Shape (α)' },
    { key: 'b', label: 'Scale (β)' },
  ],
  betad: [
    { key: 'a', label: 'Alpha (α)' },
    { key: 'b', label: 'Beta (β)' },
  ],
  cauchyd: [
    { key: 'a', label: 'Location (x₀)' },
    { key: 'b', label: 'Scale (γ)' },
  ],
  weibull: [
    { key: 'k', label: 'Shape (k)' },
    { key: 'lambda', label: 'Scale (λ)' },
  ],
  uniformd: [
    { key: 'a', label: 'Lower limit (a)' },
    { key: 'b', label: 'Upper limit (b)' },
  ],
};

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
