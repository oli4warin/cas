import { h, clear, reconcileOrder } from '../lib/dom.js';
import { giacToLatex } from '../lib/giacToLatex.js';
import { loadPlotly } from '../lib/plotly.js';
import { sampleSurface, sampleParametricSurface, sampleSystem3d } from '../lib/plotSample3d.js';
import { DEFAULT_VIEW_3D, makeRow3d } from '../lib/plotRows3d.js';
import { FormulaPreview } from './formulaPreview.js';

const COLORS = ['#7c3aed', '#0ea5e9', '#f59e0b', '#dc2626', '#16a34a', '#db2777'];
const SAMPLE_DEBOUNCE_MS = 150;
// Per-axis sample resolution. 'surface'/'parametric' rows cost O(n^2); 'system' rows sample a
// full 3D box so their own cost is O(n^3) - a much smaller n keeps a system row's engine round
// trip and Plotly's isosurface/volume extraction from both crawling (24^3 = 13824 grid points,
// comparable in order of magnitude to the 2D panel's own 'system' row grid - see plotPanel.js's
// sysNx/sysNy).
const SURFACE_N = 55;
const SYSTEM3D_N = 24;
// Volume trace opacity for a system row's shaded inequality region, and the crisper isosurface
// shell drawn on top of it at value=0 - the same "translucent fill + solid boundary" split the
// 2D panel's own 'system' row draws (see plotPanel.js's SYSTEM_FILL_OPACITY), just spelled as
// two separate Plotly traces instead of one fill()+stroke() canvas pass.
const SYSTEM3D_FILL_OPACITY = 0.15;
const SYSTEM3D_BOUNDARY_OPACITY = 0.55;
const SURFACE_OPACITY = 0.92;

function rowColor(row, index) {
  return row.color || COLORS[index % COLORS.length];
}

function systemPreviewLatex(text) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? giacToLatex(lines.join(' and ')) || '' : '';
}

function fieldOrder(row) {
  if (row.mode === 'parametric') return ['exprX', 'exprY', 'exprZ'];
  if (row.mode === 'system') return ['exprSystem'];
  return ['expr'];
}

// A hex color plus an alpha as a flat 2-stop Plotly colorscale - every isosurface/volume/surface
// trace here is a single solid color (never a gradient over its own value range, unlike Plotly's
// usual data-driven coloring), so a flat colorscale plus showscale:false is the standard way to
// force that.
function flatColorscale(hex) {
  return [
    [0, hex],
    [1, hex],
  ];
}

// One 3D plot row's DOM - same reconcile-in-place approach as the 2D panel's own createRowView
// (components/plotPanel.js), for the same reason: rebuilding the row's fields from scratch on
// every keystroke would drop focus/caret position.
function createRowView({ onModeChange, onFieldInput, onFieldKeyDown, onUVChange, onToggle, onColorChange, onRemove }) {
  let currentMode = null;
  const fieldEls = {};
  const previews = {};
  let uminEl = null;
  let umaxEl = null;
  let vminEl = null;
  let vmaxEl = null;

  const swatch = h('input', {
    type: 'color',
    class: 'plot-row__swatch',
    title: 'Surface color',
    onchange: (e) => onColorChange(e.target.value),
  });
  const modeSelect = h(
    'select',
    { class: 'plot-row__modeSelect', title: 'Plot type', onchange: (e) => onModeChange(e.target.value) },
    h('option', { value: 'surface' }, 'z = f(x,y)'),
    h('option', { value: 'parametric' }, 'x(u,v), y(u,v), z(u,v)'),
    h('option', { value: 'system' }, 'system of equations (x,y,z)'),
  );
  const fieldsWrap = h('span');
  const toggleBtn = h('button', { type: 'button', class: 'plot-row__toggle', onclick: onToggle }, '●');
  const removeBtn = h('button', { type: 'button', class: 'plot-row__remove', title: 'Remove', onclick: onRemove }, '×');
  const errorSpan = h('span', { class: 'plot-row__error' });
  errorSpan.style.display = 'none';

  const root = h('div', { class: 'plot-row' }, swatch, modeSelect, fieldsWrap, toggleBtn, removeBtn, errorSpan);

  function makeField(field, placeholder, previewPlaceholder) {
    const input = h('input', {
      class: 'plot-row__input',
      type: 'text',
      placeholder,
      oninput: (e) => onFieldInput(field, e.target.value),
      onkeydown: (e) => onFieldKeyDown(e, field),
    });
    fieldEls[field] = input;
    const preview = FormulaPreview({ className: 'plot-row__preview', placeholder: previewPlaceholder });
    previews[field] = preview;
    return h('span', { class: 'plot-row__field' }, input, preview.root);
  }

  function makeMultilineField(field, placeholder) {
    const input = h('textarea', {
      class: 'plot-row__input plot-row__systemInput',
      rows: 3,
      placeholder,
      oninput: (e) => onFieldInput(field, e.target.value),
      onkeydown: (e) => {
        if (e.key === 'Enter' && e.shiftKey) return;
        onFieldKeyDown(e, field);
      },
    });
    fieldEls[field] = input;
    const preview = FormulaPreview({ className: 'plot-row__preview', placeholder: 'system preview' });
    previews[field] = preview;
    return h('span', { class: 'plot-row__field plot-row__field--system' }, input, preview.root);
  }

  function makeUVRange() {
    uminEl = h('input', { class: 'plot-row__tInput', type: 'text', placeholder: '0', oninput: (e) => onUVChange('umin', e.target.value) });
    umaxEl = h('input', { class: 'plot-row__tInput', type: 'text', placeholder: '2*pi', oninput: (e) => onUVChange('umax', e.target.value) });
    vminEl = h('input', { class: 'plot-row__tInput', type: 'text', placeholder: '0', oninput: (e) => onUVChange('vmin', e.target.value) });
    vmaxEl = h('input', { class: 'plot-row__tInput', type: 'text', placeholder: 'pi', oninput: (e) => onUVChange('vmax', e.target.value) });
    return h(
      'span',
      { class: 'plot-row__tRange' },
      'u:',
      uminEl,
      'to',
      umaxEl,
      'v:',
      vminEl,
      'to',
      vmaxEl,
    );
  }

  function buildFields(mode) {
    clear(fieldsWrap);
    for (const key of Object.keys(fieldEls)) delete fieldEls[key];
    for (const key of Object.keys(previews)) delete previews[key];
    uminEl = umaxEl = vminEl = vmaxEl = null;

    if (mode === 'parametric') {
      fieldsWrap.append(
        makeField('exprX', 'x(u,v), e.g. cos(u)*sin(v)', 'x(u,v)'),
        makeField('exprY', 'y(u,v), e.g. sin(u)*sin(v)', 'y(u,v)'),
        makeField('exprZ', 'z(u,v), e.g. cos(v)', 'z(u,v)'),
        makeUVRange(),
      );
    } else if (mode === 'system') {
      const field = makeMultilineField('exprSystem', 'x^2+y^2+z^2=4\nz>0');
      field.title =
        'One equation or inequality per line, in x, y and z - Shift+Enter for a new line. ' +
        'Equations are drawn as isosurfaces (with 3+ of them, solved for their intersection ' +
        "point(s), marked with dots); inequalities are combined into one shaded region.";
      fieldsWrap.append(field);
    } else {
      fieldsWrap.append(makeField('expr', 'f(x,y), e.g. sin(x*y)', 'f(x,y)'));
    }
  }

  function update(row, index, errorMessage) {
    const color = rowColor(row, index);
    if (swatch.value !== color) swatch.value = color;
    if (modeSelect.value !== row.mode) modeSelect.value = row.mode;

    if (row.mode !== currentMode) {
      currentMode = row.mode;
      buildFields(row.mode);
    }
    for (const field of fieldOrder(row)) {
      if (fieldEls[field] && fieldEls[field].value !== row[field]) fieldEls[field].value = row[field];
      const isMultiline = row.mode === 'system';
      previews[field]?.update(isMultiline ? systemPreviewLatex(row[field]) : giacToLatex(row[field]) || '');
    }
    if (uminEl && uminEl.value !== row.umin) uminEl.value = row.umin;
    if (umaxEl && umaxEl.value !== row.umax) umaxEl.value = row.umax;
    if (vminEl && vminEl.value !== row.vmin) vminEl.value = row.vmin;
    if (vmaxEl && vmaxEl.value !== row.vmax) vmaxEl.value = row.vmax;

    toggleBtn.textContent = row.visible ? '●' : '○';
    toggleBtn.title = row.visible ? 'Hide' : 'Show';

    if (errorMessage) {
      errorSpan.textContent = errorMessage;
      errorSpan.style.display = '';
    } else {
      errorSpan.style.display = 'none';
    }
  }

  function focusField(field) {
    fieldEls[field]?.focus();
  }

  return { root, update, focusField };
}

// Builds this row's Plotly trace(s) from its last-sampled data (see resample() below) - null
// (nothing drawn) when there's nothing sampled yet, an error, or a still-blank row.
function tracesForRow(row, index, sampled) {
  if (!sampled) return [];
  const color = rowColor(row, index);
  const base = { showscale: false, hoverinfo: 'x+y+z', visible: row.visible };

  if (row.mode === 'surface' || row.mode === 'parametric') {
    return [
      {
        ...base,
        type: 'surface',
        x: sampled.x,
        y: sampled.y,
        z: sampled.z,
        colorscale: flatColorscale(color),
        opacity: SURFACE_OPACITY,
        lighting: { ambient: 0.65, diffuse: 0.75, roughness: 0.9 },
        contours: { x: { highlight: false }, y: { highlight: false }, z: { highlight: false } },
      },
    ];
  }

  // 'system': one isosurface per equation line, plus (when there's at least one inequality
  // line) a translucent volume for the combined region and a crisp isosurface shell at its own
  // boundary, plus (with 3+ equation lines) their solved intersection point(s) as markers - see
  // lib/plotSample3d.js's sampleSystem3d for how these values were derived.
  const traces = [];
  const { xs, ys, zs, equationValues, inequalityValues, solutionPoints } = sampled;
  for (const values of equationValues) {
    traces.push({
      ...base,
      type: 'isosurface',
      x: xs,
      y: ys,
      z: zs,
      value: values,
      isomin: 0,
      isomax: 0,
      surface: { show: true, count: 1 },
      caps: { x: { show: false }, y: { show: false }, z: { show: false } },
      colorscale: flatColorscale(color),
      opacity: SYSTEM3D_BOUNDARY_OPACITY,
    });
  }
  if (inequalityValues) {
    const isomax = inequalityValues.reduce((m, v) => (v > m ? v : m), 1e-6);
    traces.push({
      ...base,
      type: 'volume',
      x: xs,
      y: ys,
      z: zs,
      value: inequalityValues,
      isomin: 0,
      isomax,
      opacity: SYSTEM3D_FILL_OPACITY,
      surface: { count: 14, fill: 1 },
      caps: { x: { show: false }, y: { show: false }, z: { show: false } },
      colorscale: flatColorscale(color),
    });
    traces.push({
      ...base,
      type: 'isosurface',
      x: xs,
      y: ys,
      z: zs,
      value: inequalityValues,
      isomin: 0,
      isomax: 0,
      surface: { show: true, count: 1 },
      caps: { x: { show: false }, y: { show: false }, z: { show: false } },
      colorscale: flatColorscale(color),
      opacity: SYSTEM3D_BOUNDARY_OPACITY,
    });
  }
  if (solutionPoints && solutionPoints.length) {
    traces.push({
      ...base,
      type: 'scatter3d',
      mode: 'markers',
      x: solutionPoints.map((p) => p.x),
      y: solutionPoints.map((p) => p.y),
      z: solutionPoints.map((p) => p.z),
      marker: { size: 5, color, line: { color: '#fff', width: 1 } },
    });
  }
  return traces;
}

// evaluateRaw: (expr) => Promise<string>
// onRowsChange(rows), onViewChange(view | (view) => view)
// standalone/onPopOut/onClose: same meaning as the 2D panel's own (see plotPanel.js) - standalone
// hides the close button and relabels the popout one ("open another window" vs. "move this plot
// to a new window"), used the same way by app.js (embedded, onPopOut: popOutPlot3d) and
// plot3dStandalone.js (standalone: true, onPopOut: popOutNewSession).
export function Plot3DPanel({ evaluateRaw, rows: initialRows, view, onRowsChange, onViewChange, standalone = false, onPopOut, onClose }) {
  let rows = initialRows;
  let definitions = new Map();
  let sampled = {}; // rowId -> { data, error }
  let debounceTimer = null;
  let requestId = 0;
  const rowViews = new Map();
  let pendingFocusRowId = null;
  let plotly = null;
  let plotInitialized = false;
  let rowsHidden = false;

  // The "reconnecting to the calculator tab" warning shown when standalone (popped out into
  // its own window - see plot3dStandalone.js) and the bridge connection drops - same
  // element/class/wording as the 2D panel's own statusEl (see plotPanel.js), toggled the same
  // way via setConnectionStatus below. Distinct from loadingEl's own text just below, which
  // instead reports the Plotly library itself failing to load.
  const statusEl = h('span', { class: 'plot-panel__status plot-panel__status--bad' }, 'Reconnecting to calculator…');
  statusEl.style.display = 'none';

  const popOutBtn = h(
    'button',
    {
      type: 'button',
      class: 'plot-panel__iconBtn',
      title: standalone ? 'Open another 3D plot window' : 'Move this plot to a new window',
      onclick: () => onPopOut?.(),
    },
    '⧉',
  );
  if (!onPopOut) popOutBtn.style.display = 'none';

  const closeBtn = h('button', { type: 'button', class: 'plot-panel__iconBtn', title: 'Close plot', onclick: () => onClose?.() }, '×');
  if (standalone || !onClose) closeBtn.style.display = 'none';

  const rowsContainer = h('div', { class: 'plot-panel__rows' });
  const addRowBtn = h('button', { type: 'button', class: 'plot-panel__addRow', onclick: () => addRow() }, '+ Add surface');
  const rowsHint = h(
    'span',
    { class: 'plot-panel__hint' },
    'Enter moves to the next field (adding a row past the bottom) · Esc returns to the input.',
  );
  rowsContainer.append(addRowBtn, rowsHint);

  // Collapses the equation/function rows above the plot - same idea, same class, as the 2D
  // panel's own rowsToggleBtn (see plotPanel.js) - frees up vertical space for the plot
  // itself without losing anything already typed. Resets to visible every time the panel
  // mounts, same as every other piece of this panel's purely-local UI state (plotly/
  // plotInitialized above included) - none of it is lifted to app.js.
  const rowsToggleBtn = h(
    'button',
    { type: 'button', class: 'plot-panel__iconBtn', title: 'Hide equations', onclick: () => setRowsHidden(!rowsHidden) },
    '▾',
  );
  function setRowsHidden(value) {
    rowsHidden = value;
    rowsContainer.style.display = rowsHidden ? 'none' : '';
    rowsToggleBtn.textContent = rowsHidden ? '▸' : '▾';
    rowsToggleBtn.title = rowsHidden ? 'Show equations' : 'Hide equations';
  }

  const header = h(
    'div',
    { class: 'plot-panel__header' },
    h('span', { class: 'plot-panel__title' }, '3D Plot'),
    statusEl,
    h('div', { class: 'plot-panel__headerActions' }, rowsToggleBtn, popOutBtn, closeBtn),
  );

  // The sampling box every row draws inside - unlike the 2D panel's view, this never changes on
  // its own from mouse interaction (Plotly's own scene owns orbit/zoom/pan - see the module
  // comment in lib/plotRows3d.js), only when the user types new bounds or hits reset.
  function makeBoundInput(axis, which) {
    return h('input', {
      class: 'plot-row__tInput',
      type: 'number',
      value: String(view[`${axis}${which}`]),
      onchange: (e) => setViewBound(axis, which, e.target.value),
    });
  }
  const boundEls = {
    xmin: makeBoundInput('x', 'min'),
    xmax: makeBoundInput('x', 'max'),
    ymin: makeBoundInput('y', 'min'),
    ymax: makeBoundInput('y', 'max'),
    zmin: makeBoundInput('z', 'min'),
    zmax: makeBoundInput('z', 'max'),
  };
  const resetViewBtn = h('button', { type: 'button', class: 'plot-panel__iconBtn', title: 'Reset view box', onclick: () => onViewChange(DEFAULT_VIEW_3D) }, '⟲');
  const viewBar = h(
    'div',
    { class: 'plot3d-panel__viewBar' },
    'x:',
    boundEls.xmin,
    'to',
    boundEls.xmax,
    'y:',
    boundEls.ymin,
    'to',
    boundEls.ymax,
    'z:',
    boundEls.zmin,
    'to',
    boundEls.zmax,
    resetViewBtn,
  );

  const plotDiv = h('div', { class: 'plot3d-panel__plot' });
  const loadingEl = h('div', { class: 'plot3d-panel__loading' }, 'Loading 3D plotting library…');
  const plotWrap = h('div', { class: 'plot-panel__canvasWrap plot3d-panel__plotWrap' }, plotDiv, loadingEl);

  const root = h('div', { class: 'plot-panel' }, header, rowsContainer, viewBar, plotWrap);

  let resizeObserver = null;
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      if (plotly && plotInitialized) plotly.Plots.resize(plotDiv);
    });
    resizeObserver.observe(plotWrap);
  }

  function setViewBound(axis, which, rawValue) {
    const num = parseFloat(rawValue);
    if (!Number.isFinite(num)) return;
    const min = which === 'min' ? num : view[`${axis}min`];
    const max = which === 'max' ? num : view[`${axis}max`];
    if (min >= max) return;
    onViewChange({ ...view, [`${axis}min`]: min, [`${axis}max`]: max });
  }

  function emitRows(next) {
    rows = next;
    onRowsChange(rows);
    renderRows();
    scheduleResample();
  }

  function addRow() {
    emitRows([...rows, makeRow3d()]);
  }

  function updateRow(id, patch) {
    emitRows(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  const setRowDrawOnly = (id, patch) => {
    rows = rows.map((r) => (r.id === id ? { ...r, ...patch } : r));
    onRowsChange(rows);
    renderRows();
    redraw();
  };
  const toggleVisible = (id) => setRowDrawOnly(id, { visible: !rows.find((r) => r.id === id).visible });
  const setColor = (id, color) => setRowDrawOnly(id, { color });

  function removeRow(id) {
    if (rows.length > 1) emitRows(rows.filter((r) => r.id !== id));
    delete sampled[id];
  }

  function focusField(rowId, field) {
    rowViews.get(rowId)?.focusField(field);
  }

  function handleFieldKeyDown(e, row, field) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const order = fieldOrder(row);
    const idx = order.indexOf(field);
    if (idx < order.length - 1) {
      focusField(row.id, order[idx + 1]);
      return;
    }
    const rowIdx = rows.findIndex((r) => r.id === row.id);
    const nextRow = rows[rowIdx + 1];
    if (nextRow) {
      focusField(nextRow.id, fieldOrder(nextRow)[0]);
      return;
    }
    const newRow = makeRow3d();
    pendingFocusRowId = newRow.id;
    emitRows([...rows, newRow]);
  }

  function renderRows() {
    const seen = new Set();
    const desired = [];
    rows.forEach((row, i) => {
      seen.add(row.id);
      let rv = rowViews.get(row.id);
      if (!rv) {
        rv = createRowView({
          onModeChange: (mode) => updateRow(row.id, { mode }),
          onFieldInput: (field, value) => updateRow(row.id, { [field]: value }),
          onFieldKeyDown: (e, field) => handleFieldKeyDown(e, row, field),
          onUVChange: (which, value) => updateRow(row.id, { [which]: value }),
          onToggle: () => toggleVisible(row.id),
          onColorChange: (color) => setColor(row.id, color),
          onRemove: () => removeRow(row.id),
        });
        rowViews.set(row.id, rv);
      }
      rv.update(row, i, sampled[row.id]?.error);
      desired.push(rv.root);
    });
    for (const [id, rv] of rowViews) {
      if (!seen.has(id)) {
        rv.root.remove();
        rowViews.delete(id);
      }
    }
    const current = Array.from(rowsContainer.children).filter((el) => el !== addRowBtn && el !== rowsHint);
    reconcileOrder(rowsContainer, current, desired, addRowBtn);
    if (pendingFocusRowId != null) {
      const id = pendingFocusRowId;
      pendingFocusRowId = null;
      const row = rows.find((r) => r.id === id);
      if (row) focusField(id, fieldOrder(row)[0]);
    }
  }

  function sceneLayout() {
    const styles = getComputedStyle(root);
    const gridColor = styles.getPropertyValue('--plot-grid').trim() || '#e2e0ea';
    const axisColor = styles.getPropertyValue('--plot-axis').trim() || '#8a8698';
    const textColor = styles.getPropertyValue('--plot-tick-text').trim() || '#8a8698';
    const axis = (range) => ({
      range,
      gridcolor: gridColor,
      zerolinecolor: axisColor,
      linecolor: axisColor,
      tickfont: { color: textColor, size: 10 },
    });
    return {
      autosize: true,
      margin: { l: 0, r: 0, t: 10, b: 0 },
      paper_bgcolor: 'rgba(0,0,0,0)',
      showlegend: false,
      scene: {
        xaxis: axis([view.xmin, view.xmax]),
        yaxis: axis([view.ymin, view.ymax]),
        zaxis: axis([view.zmin, view.zmax]),
        aspectmode: 'cube',
        bgcolor: 'rgba(0,0,0,0)',
      },
    };
  }

  function redraw() {
    if (!plotly) return;
    const allTraces = rows.flatMap((row, i) => tracesForRow(row, i, sampled[row.id]?.data));
    if (!plotInitialized) {
      plotly.newPlot(plotDiv, allTraces, sceneLayout(), { displaylogo: false, responsive: true });
      plotInitialized = true;
    } else {
      plotly.react(plotDiv, allTraces, sceneLayout(), { displaylogo: false, responsive: true });
    }
  }

  function scheduleResample() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(resample, SAMPLE_DEBOUNCE_MS);
  }

  function resample() {
    if (!plotly) return;
    const myRequest = ++requestId;
    const { xmin, xmax, ymin, ymax, zmin, zmax } = view;

    for (const row of rows) {
      const applyResult = (data) => {
        if (requestId !== myRequest) return;
        sampled = { ...sampled, [row.id]: { data, error: null } };
        renderRows();
        redraw();
      };
      const applyError = (err) => {
        if (requestId !== myRequest) return;
        sampled = { ...sampled, [row.id]: { data: null, error: err.message } };
        renderRows();
        redraw();
      };

      if (row.mode === 'parametric') {
        if (!row.exprX.trim() || !row.exprY.trim() || !row.exprZ.trim()) {
          delete sampled[row.id];
          continue;
        }
        sampleParametricSurface(evaluateRaw, row.exprX, row.exprY, row.exprZ, row.umin, row.umax, row.vmin, row.vmax, SURFACE_N, SURFACE_N).then(
          applyResult,
          applyError,
        );
      } else if (row.mode === 'system') {
        if (!row.exprSystem.trim()) {
          delete sampled[row.id];
          continue;
        }
        sampleSystem3d(evaluateRaw, row.exprSystem, { xmin, xmax, ymin, ymax, zmin, zmax }, SYSTEM3D_N, definitions).then(applyResult, applyError);
      } else {
        if (!row.expr.trim()) {
          delete sampled[row.id];
          continue;
        }
        sampleSurface(evaluateRaw, row.expr, xmin, xmax, ymin, ymax, SURFACE_N, SURFACE_N).then(applyResult, applyError);
      }
    }
  }

  function focusOnMount() {
    const emptyRow = rows.find((r) => !r[fieldOrder(r)[0]].trim());
    if (emptyRow) {
      focusField(emptyRow.id, fieldOrder(emptyRow)[0]);
    } else {
      const newRow = makeRow3d();
      pendingFocusRowId = newRow.id;
      emitRows([...rows, newRow]);
    }
  }

  // The library load is asynchronous (see lib/plotly.js) and can easily still be in flight
  // when the panel closes (~4.5MB download) - `destroyed` guards both callbacks below so a
  // load that resolves after destroy() never touches the by-then-detached plotDiv, nor mutates
  // rows/state via focusOnMount's own emitRows() for a panel nobody's looking at anymore.
  // `ready` resolves once this initial load has settled and focusOnMount has had its one
  // chance to steal focus (win or lose) - app.js's addExpressionToPlot3d chains its own
  // input.focus() after it instead of racing it with a fixed setTimeout, since the library
  // is a genuine network fetch the first time a session opens this panel (near-instant every
  // time after, once cached - see lib/plotly.js) and a fixed delay can't span both.
  let destroyed = false;
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  renderRows();
  loadPlotly().then(
    (P) => {
      if (destroyed) {
        resolveReady();
        return;
      }
      plotly = P;
      loadingEl.style.display = 'none';
      redraw();
      scheduleResample();
      setTimeout(() => {
        focusOnMount();
        resolveReady();
      }, 0);
    },
    (err) => {
      if (destroyed) {
        resolveReady();
        return;
      }
      loadingEl.textContent = err.message;
      resolveReady();
    },
  );

  function destroy() {
    destroyed = true;
    resizeObserver?.disconnect();
    clearTimeout(debounceTimer);
    if (plotly && plotInitialized) plotly.purge(plotDiv);
  }

  return {
    root,
    ready,
    setRows(next) {
      rows = next;
      renderRows();
      scheduleResample();
    },
    setView(next) {
      view = next;
      for (const [key, el] of Object.entries(boundEls)) {
        if (document.activeElement !== el) el.value = String(view[key]);
      }
      redraw();
      scheduleResample();
    },
    setDefinitions(next) {
      definitions = next;
      renderRows();
      scheduleResample();
    },
    setConnectionStatus(status) {
      statusEl.style.display = status === false ? '' : 'none';
    },
    destroy,
  };
}
