// Shared row/view model for the plot panel, used by both the embedded panel's host
// (App.jsx) and a popped-out standalone window (PlotStandalone.jsx) since both now own
// this state themselves and pass it into <PlotPanel> as controlled props.

export const DEFAULT_VIEW = { xmin: -10, xmax: 10, ymin: -6, ymax: 6 };
// Kept as Giac expression text (not JS numbers) so the t-range fields can take anything
// the CAS understands, e.g. "pi", "sqrt(2)", "-2*pi/3".
const DEFAULT_TMIN = '0';
const DEFAULT_TMAX = '2*pi';

let nextRowId = 1;
export function makeRow() {
  return {
    id: nextRowId++,
    mode: 'function', // 'function' | 'parametric' | 'complex' | 'scatter' | 'diffeq'
    expr: '',
    exprX: '',
    exprY: '',
    exprZ: '',
    exprDE: '',
    tmin: DEFAULT_TMIN,
    tmax: DEFAULT_TMAX,
    visible: true,
    color: null, // null = use the palette default for this row's position (see COLORS in plotPanel.js)
    sliders: {}, // paramName -> { value, min, max, step } - see lib/plotParams.js
  };
}
