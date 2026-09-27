// Shared row/view model for the 3D plot panel (components/plot3dPanel.js) - the 3D sibling of
// lib/plotRows.js, kept as its own separate mode entirely (its own header button, own state,
// own panel) rather than a mode of the 2D plot panel, since a surface/isosurface has nothing in
// common with that panel's canvas-based drawing.

// Unlike the 2D panel's per-pixel view (xmin/xmax/ymin/ymax, resampled on every pan/zoom - see
// lib/plotRows.js), a 3D view is only ever the *sampling* box: Plotly's own scene owns the
// camera (orbit/zoom/pan are its built-in mouse controls, never redriving a resample), so this
// only needs to change when the user actually wants to sample a different region - typing new
// bounds or hitting "reset", not every time they spin the view around.
export const DEFAULT_VIEW_3D = { xmin: -5, xmax: 5, ymin: -5, ymax: 5, zmin: -5, zmax: 5 };

// Kept as Giac expression text, not JS numbers, same reasoning as the 2D panel's own tmin/tmax
// (lib/plotRows.js) - a parametric surface's u/v range can be any expression the CAS
// understands (e.g. "pi", "2*pi"), not just a plain decimal.
const DEFAULT_UMIN = '0';
const DEFAULT_UMAX = '2*pi';
const DEFAULT_VMIN = '0';
const DEFAULT_VMAX = 'pi';

let nextRowId3d = 1;
export function makeRow3d() {
  return {
    id: nextRowId3d++,
    mode: 'surface', // 'surface' (z=f(x,y)) | 'parametric' (x(u,v),y(u,v),z(u,v)) | 'system' (x,y,z)
    expr: '', // 'surface' row's own z=f(x,y)
    exprX: '',
    exprY: '',
    exprZ: '', // 'parametric' row's own x(u,v)/y(u,v)/z(u,v)
    umin: DEFAULT_UMIN,
    umax: DEFAULT_UMAX,
    vmin: DEFAULT_VMIN,
    vmax: DEFAULT_VMAX,
    exprSystem: '', // 'system' row: one equation/inequality per line, in x, y and z - see lib/plotSystem.js
    visible: true,
    color: null, // null = use the palette default for this row's position
  };
}
