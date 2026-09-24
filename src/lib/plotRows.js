// Shared row/view model for the plot panel, used by both the embedded panel's host
// (App.jsx) and a popped-out standalone window (PlotStandalone.jsx) since both now own
// this state themselves and pass it into <PlotPanel> as controlled props.

import { DISTRIBUTION_FAMILIES } from './distributionParams.js';

export const DEFAULT_VIEW = { xmin: -10, xmax: 10, ymin: -6, ymax: 6 };
// Kept as Giac expression text (not JS numbers) so the t-range fields can take anything
// the CAS understands, e.g. "pi", "sqrt(2)", "-2*pi/3".
const DEFAULT_TMIN = '0';
const DEFAULT_TMAX = '2*pi';

const DEFAULT_DISTRIBUTION_FAMILY = 'normald';
// A fresh row's lower/upper default to the whole real line - distributionDomainExpr's own
// per-family domain condition (see distributionParams.js) clamps that down to whatever the
// family's actual support is, so a fresh row shades the entire curve ("area = 1") by default.
const DEFAULT_DIST_BOUND = { lower: '-infinity', upper: 'infinity' };

// The default `params` object for a distribution row newly switched to `family` - every
// param's own configured default (see DISTRIBUTION_FAMILIES in distributionParams.js).
export function defaultDistributionParams(family) {
  const params = {};
  for (const p of DISTRIBUTION_FAMILIES[family]?.params ?? []) params[p.key] = p.default;
  return params;
}

let nextRowId = 1;
export function makeRow() {
  return {
    id: nextRowId++,
    mode: 'function', // 'function' | 'parametric' | 'complex' | 'scatter' | 'diffeq' | 'distribution'
    expr: '',
    exprX: '',
    exprY: '',
    exprZ: '',
    exprDE: '',
    tmin: DEFAULT_TMIN,
    tmax: DEFAULT_TMAX,
    family: DEFAULT_DISTRIBUTION_FAMILY,
    params: defaultDistributionParams(DEFAULT_DISTRIBUTION_FAMILY),
    lower: DEFAULT_DIST_BOUND.lower,
    upper: DEFAULT_DIST_BOUND.upper,
    visible: true,
    color: null, // null = use the palette default for this row's position (see COLORS in plotPanel.js)
    sliders: {}, // paramName -> { value, min, max, step } - see lib/plotParams.js
  };
}
