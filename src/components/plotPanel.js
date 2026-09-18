import { h, clear, reconcileOrder } from '../lib/dom.js';
import { definitionLabel } from '../lib/definitions.js';
import { giacToLatex } from '../lib/giacToLatex.js';
import { sampleFunction, sampleParametric, sampleComplex, sampleScatter } from '../lib/plotSample.js';
import { DEFAULT_VIEW, makeRow } from '../lib/plotRows.js';
import { FormulaPreview } from './formulaPreview.js';

const COLORS = ['#7c3aed', '#0ea5e9', '#f59e0b', '#dc2626', '#16a34a', '#db2777'];
const SAMPLE_DEBOUNCE_MS = 150;

// A row's curve color: whatever the user picked manually, or - same as before that was
// possible - the palette color for its position.
function rowColor(row, index) {
  return row.color || COLORS[index % COLORS.length];
}

// The text fields a row has, in the order you'd naturally tab through them - used both to
// find a row's "is it empty" field and to know where Enter should go next (see
// handleFieldKeyDown).
function fieldOrder(row) {
  if (row.mode === 'complex') return ['exprZ'];
  if (row.mode === 'parametric' || row.mode === 'scatter') return ['exprX', 'exprY'];
  return ['expr'];
}

function niceStep(rawStep) {
  const exp = Math.floor(Math.log10(rawStep));
  const base = rawStep / 10 ** exp;
  const niceBase = base < 1.5 ? 1 : base < 3 ? 2 : base < 7 ? 5 : 10;
  return niceBase * 10 ** exp;
}

function formatTick(v, step) {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  const s = v.toFixed(Math.min(6, decimals));
  return s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

// Expands whichever axis is "too tight" for the container so pixels-per-unit matches on
// both axes (so e.g. exp(i*t) draws as a circle, not an ellipse) - center-preserving, so
// it only ever shows *more* than the stored view asked for, never less.
function equalAspectView(view, width, height) {
  const { xmin, xmax, ymin, ymax } = view;
  const xRange = xmax - xmin;
  const yRange = ymax - ymin;
  if (!width || !height || xRange <= 0 || yRange <= 0) return view;
  const scale = Math.min(width / xRange, height / yRange);
  const newXRange = width / scale;
  const newYRange = height / scale;
  const cx = (xmin + xmax) / 2;
  const cy = (ymin + ymax) / 2;
  return { xmin: cx - newXRange / 2, xmax: cx + newXRange / 2, ymin: cy - newYRange / 2, ymax: cy + newYRange / 2 };
}

function draw(canvas, rawView, curves, aspectLocked) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const styles = getComputedStyle(canvas);
  const border = styles.getPropertyValue('--plot-grid').trim() || '#e2e0ea';
  const axis = styles.getPropertyValue('--plot-axis').trim() || '#8a8698';
  const text = styles.getPropertyValue('--plot-tick-text').trim() || '#8a8698';

  ctx.clearRect(0, 0, width, height);

  const view = aspectLocked ? equalAspectView(rawView, width, height) : rawView;
  const { xmin, xmax, ymin, ymax } = view;
  const pxPerX = width / (xmax - xmin);
  const pxPerY = height / (ymax - ymin);
  const toPx = (x) => (x - xmin) * pxPerX;
  const toPy = (y) => height - (y - ymin) * pxPerY;

  // With equal-scale axes, use one grid step for both directions so cells are square;
  // independent scales keep the previous per-axis target spacing.
  let xStep, yStep;
  if (aspectLocked) {
    xStep = yStep = niceStep(70 / pxPerX);
  } else {
    xStep = niceStep((xmax - xmin) / Math.max(1, Math.floor(width / 90)));
    yStep = niceStep((ymax - ymin) / Math.max(1, Math.floor(height / 60)));
  }

  ctx.strokeStyle = border;
  ctx.fillStyle = text;
  ctx.font = '11px var(--mono, monospace)';
  ctx.lineWidth = 1;

  ctx.beginPath();
  for (let x = Math.ceil(xmin / xStep) * xStep; x <= xmax; x += xStep) {
    const px = Math.round(toPx(x)) + 0.5;
    ctx.moveTo(px, 0);
    ctx.lineTo(px, height);
  }
  for (let y = Math.ceil(ymin / yStep) * yStep; y <= ymax; y += yStep) {
    const py = Math.round(toPy(y)) + 0.5;
    ctx.moveTo(0, py);
    ctx.lineTo(width, py);
  }
  ctx.stroke();

  const axisYPx = ymin <= 0 && ymax >= 0 ? toPy(0) : ymin > 0 ? height - 14 : 14;
  const axisXPx = xmin <= 0 && xmax >= 0 ? toPx(0) : xmin > 0 ? 4 : width - 4;

  ctx.strokeStyle = axis;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, axisYPx);
  ctx.lineTo(width, axisYPx);
  ctx.moveTo(axisXPx, 0);
  ctx.lineTo(axisXPx, height);
  ctx.stroke();

  ctx.fillStyle = text;
  for (let x = Math.ceil(xmin / xStep) * xStep; x <= xmax; x += xStep) {
    if (Math.abs(x) < xStep / 1e6) continue;
    ctx.fillText(formatTick(x, xStep), toPx(x) + 3, Math.min(height - 4, Math.max(12, axisYPx - 3)));
  }
  for (let y = Math.ceil(ymin / yStep) * yStep; y <= ymax; y += yStep) {
    if (Math.abs(y) < yStep / 1e6) continue;
    ctx.fillText(formatTick(y, yStep), Math.min(width - 28, Math.max(2, axisXPx + 3)), toPy(y) - 3);
  }

  for (const curve of curves) {
    if (!curve.visible || !curve.points || curve.points.length === 0) continue;

    if (curve.style === 'points') {
      ctx.fillStyle = curve.color;
      for (const { x, y } of curve.points) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (x < xmin - (xmax - xmin) || x > xmax + (xmax - xmin)) continue;
        if (y < ymin - (ymax - ymin) || y > ymax + (ymax - ymin)) continue;
        ctx.beginPath();
        ctx.arc(toPx(x), toPy(y), 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
      continue;
    }

    ctx.strokeStyle = curve.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;
    for (const { x, y } of curve.points) {
      const validY = Number.isFinite(y) && y >= ymin - (ymax - ymin) && y <= ymax + (ymax - ymin);
      const validX = Number.isFinite(x) && x >= xmin - (xmax - xmin) && x <= xmax + (xmax - xmin);
      if (!validX || !validY) {
        started = false;
        continue;
      }
      const px = toPx(x);
      const py = toPy(y);
      if (!started) {
        ctx.moveTo(px, py);
        started = true;
      } else {
        ctx.lineTo(px, py);
      }
    }
    ctx.stroke();
  }
}

// One plot row's DOM, built once and reconciled in place on every update() - this is what
// keeps a focused input field from losing focus (and its caret position) on every
// keystroke, the way a naive full-teardown-and-rebuild would.
function createRowView({ onModeChange, onFieldInput, onFieldKeyDown, onFieldFocus, onTChange, onToggle, onColorChange, onRemove }) {
  let currentMode = null;
  const fieldEls = {};
  const previews = {};
  let tminEl = null;
  let tmaxEl = null;

  const swatch = h('input', {
    type: 'color',
    class: 'plot-row__swatch',
    title: 'Curve color',
    onchange: (e) => onColorChange(e.target.value),
  });
  const modeSelect = h(
    'select',
    { class: 'plot-row__modeSelect', title: 'Plot type', onchange: (e) => onModeChange(e.target.value) },
    h('option', { value: 'function' }, 'y = f(x)'),
    h('option', { value: 'parametric' }, 'x(t), y(t)'),
    h('option', { value: 'complex' }, 'z(t) complex'),
    h('option', { value: 'scatter' }, 'scatter (x,y) data'),
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
      onfocus: () => onFieldFocus(field),
      oninput: (e) => onFieldInput(field, e.target.value),
      onkeydown: (e) => onFieldKeyDown(e, field),
    });
    fieldEls[field] = input;
    const preview = FormulaPreview({ className: 'plot-row__preview', placeholder: previewPlaceholder });
    previews[field] = preview;
    return h('span', { class: 'plot-row__field' }, input, preview.root);
  }

  function makeTRange() {
    tminEl = h('input', {
      class: 'plot-row__tInput',
      type: 'text',
      placeholder: '0',
      oninput: (e) => onTChange('tmin', e.target.value),
    });
    tmaxEl = h('input', {
      class: 'plot-row__tInput',
      type: 'text',
      placeholder: '2*pi',
      oninput: (e) => onTChange('tmax', e.target.value),
    });
    return h('span', { class: 'plot-row__tRange' }, 't:', tminEl, 'to', tmaxEl);
  }

  function buildFields(mode) {
    clear(fieldsWrap);
    for (const key of Object.keys(fieldEls)) delete fieldEls[key];
    for (const key of Object.keys(previews)) delete previews[key];
    tminEl = null;
    tmaxEl = null;

    if (mode === 'parametric') {
      fieldsWrap.append(makeField('exprX', 'x(t), e.g. cos(t)', 'x(t)'), makeField('exprY', 'y(t), e.g. sin(t)', 'y(t)'), makeTRange());
    } else if (mode === 'complex') {
      fieldsWrap.append(makeField('exprZ', 'z(t), e.g. exp(i*t)', 'z(t)'), makeTRange());
    } else if (mode === 'scatter') {
      fieldsWrap.append(
        makeField('exprX', 'x data, e.g. [1,2,3] or a column name', 'x data'),
        makeField('exprY', 'y data, e.g. [4,5,6] or a column name', 'y data'),
      );
    } else {
      fieldsWrap.append(makeField('expr', 'e.g. sin(x), f(x), a*x+b, sin(x)|0<x<7', undefined));
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
      previews[field]?.update(giacToLatex(row[field]) || '');
    }
    if (tminEl && tminEl.value !== row.tmin) tminEl.value = row.tmin;
    if (tmaxEl && tmaxEl.value !== row.tmax) tmaxEl.value = row.tmax;

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

// evaluateRaw: (expr) => Promise<string>
// onRowsChange(rows), onViewChange(view | (view) => view)
export function PlotPanel({
  evaluateRaw,
  rows: initialRows,
  view,
  onRowsChange,
  onViewChange,
  standalone = false,
  onPopOut,
  onClose,
}) {
  let rows = initialRows;
  let definitions = new Map();
  let curves = {}; // rowId -> { points, error }
  let focused = null; // { rowId, field }
  let aspectLocked = true;
  let debounceTimer = null;
  let requestId = 0;
  let dragState = null;
  const rowViews = new Map(); // rowId -> RowView
  let pendingFocusRowId = null;

  const statusEl = h('span', { class: 'plot-panel__status plot-panel__status--bad' }, 'Reconnecting to calculator…');
  statusEl.style.display = 'none';

  const popOutBtn = h(
    'button',
    {
      type: 'button',
      class: 'plot-panel__iconBtn',
      title: standalone ? 'Open another plot window' : 'Move this plot to a new window',
      onclick: () => onPopOut?.(),
    },
    '⧉',
  );
  if (!onPopOut) popOutBtn.style.display = 'none';

  const closeBtn = h('button', { type: 'button', class: 'plot-panel__iconBtn', title: 'Close plot', onclick: () => onClose?.() }, '×');
  if (standalone || !onClose) closeBtn.style.display = 'none';

  const header = h(
    'div',
    { class: 'plot-panel__header' },
    h('span', { class: 'plot-panel__title' }, 'Plot'),
    statusEl,
    h('div', { class: 'plot-panel__headerActions' }, popOutBtn, closeBtn),
  );

  const rowsContainer = h('div', { class: 'plot-panel__rows' });
  const addRowBtn = h('button', { type: 'button', class: 'plot-panel__addRow', onclick: () => addRow() }, '+ Add function');
  const rowsHint = h(
    'span',
    { class: 'plot-panel__hint' },
    'Enter moves to the next field (adding a row past the bottom) · Esc returns to the input.',
  );
  rowsContainer.append(addRowBtn, rowsHint);

  const chipsWrap = h('div', { class: 'plot-panel__chips' });
  chipsWrap.style.display = 'none';

  const canvas = h('canvas', { class: 'plot-panel__canvas' });
  const aspectBtn = h(
    'button',
    { type: 'button', class: 'plot-panel__aspectBtn plot-panel__aspectBtn--active', title: 'Equidistant units (click for independent x/y scaling)' },
    '1:1',
  );
  aspectBtn.addEventListener('click', () => {
    aspectLocked = !aspectLocked;
    aspectBtn.classList.toggle('plot-panel__aspectBtn--active', aspectLocked);
    aspectBtn.title = aspectLocked
      ? 'Equidistant units (click for independent x/y scaling)'
      : 'Independent x/y scaling (click for equidistant units)';
    scheduleResample();
    redraw();
  });
  const zoomControls = h(
    'div',
    { class: 'plot-panel__zoomControls' },
    h('button', { type: 'button', title: 'Zoom in', onclick: () => zoom(1 / 1.4) }, '+'),
    h('button', { type: 'button', title: 'Zoom out', onclick: () => zoom(1.4) }, '−'),
    h('button', { type: 'button', title: 'Reset view', onclick: () => onViewChange(DEFAULT_VIEW) }, '⟲'),
    aspectBtn,
  );

  const canvasWrap = h('div', { class: 'plot-panel__canvasWrap' }, canvas, zoomControls);

  const root = h('div', { class: 'plot-panel' }, header, rowsContainer, chipsWrap, canvasWrap);

  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerUp);

  let resizeObserver = null;
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => redraw());
    resizeObserver.observe(canvasWrap);
  }

  function zoom(factor) {
    onViewChange((v) => {
      const cx = (v.xmin + v.xmax) / 2;
      const cy = (v.ymin + v.ymax) / 2;
      const hw = ((v.xmax - v.xmin) / 2) * factor;
      const hh = ((v.ymax - v.ymin) / 2) * factor;
      return { xmin: cx - hw, xmax: cx + hw, ymin: cy - hh, ymax: cy + hh };
    });
  }

  function onWheel(e) {
    e.preventDefault();
    zoom(e.deltaY > 0 ? 1.15 : 1 / 1.15);
  }

  function onPointerDown(e) {
    canvas.setPointerCapture(e.pointerId);
    dragState = { x: e.clientX, y: e.clientY, view };
  }

  function onPointerMove(e) {
    if (!dragState) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const baseView = dragState.view;
    const eff = aspectLocked ? equalAspectView(baseView, width, height) : baseView;
    const dxPx = e.clientX - dragState.x;
    const dyPx = e.clientY - dragState.y;
    const dx = (-dxPx / width) * (eff.xmax - eff.xmin);
    const dy = (dyPx / height) * (eff.ymax - eff.ymin);
    const { xmin, xmax, ymin, ymax } = baseView;
    onViewChange({ xmin: xmin + dx, xmax: xmax + dx, ymin: ymin + dy, ymax: ymax + dy });
  }

  function onPointerUp(e) {
    canvas.releasePointerCapture(e.pointerId);
    dragState = null;
  }

  function emitRows(next) {
    rows = next;
    onRowsChange(rows);
    renderRows();
    scheduleResample();
  }

  function addRow() {
    emitRows([...rows, makeRow()]);
  }

  function updateRow(id, patch) {
    emitRows(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  // Visibility and color are purely draw-time concerns - the curve's sampled points don't
  // change - so unlike updateRow() these redraw straight from what's already in `curves`
  // instead of going through emitRows()/scheduleResample(), which would debounce a fresh
  // round trip to the Giac engine *for every row* before the canvas caught up. That made
  // the show/hide toggle feel unreliable (occasionally needing the whole panel reopened to
  // "unstick" it): toggling one row waited on every row's evaluation to finish, so a slow
  // or queued-up request for an unrelated row could hold up a change that never needed the
  // engine at all.
  function setRowDrawOnly(id, patch) {
    rows = rows.map((r) => (r.id === id ? { ...r, ...patch } : r));
    onRowsChange(rows);
    renderRows();
    redraw();
  }
  const toggleVisible = (id) => setRowDrawOnly(id, { visible: !rows.find((r) => r.id === id).visible });
  const setColor = (id, color) => setRowDrawOnly(id, { color });

  function removeRow(id) {
    if (rows.length > 1) emitRows(rows.filter((r) => r.id !== id));
    delete curves[id];
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
    const newRow = makeRow();
    pendingFocusRowId = newRow.id;
    emitRows([...rows, newRow]);
  }

  function renderRows() {
    const seen = new Set();
    const desired = [];
    rows.forEach((row, i) => {
      seen.add(row.id);
      let view = rowViews.get(row.id);
      if (!view) {
        view = createRowView({
          onModeChange: (mode) => updateRow(row.id, { mode }),
          onFieldInput: (field, value) => updateRow(row.id, { [field]: value }),
          onFieldKeyDown: (e, field) => handleFieldKeyDown(e, row, field),
          onFieldFocus: (field) => {
            focused = { rowId: row.id, field };
          },
          onTChange: (which, value) => updateRow(row.id, { [which]: value }),
          onToggle: () => toggleVisible(row.id),
          onColorChange: (color) => setColor(row.id, color),
          onRemove: () => removeRow(row.id),
        });
        rowViews.set(row.id, view);
      }
      view.update(row, i, curves[row.id]?.error);
      desired.push(view.root);
    });
    for (const [id, view] of rowViews) {
      if (!seen.has(id)) {
        view.root.remove();
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

  function renderChips() {
    clear(chipsWrap);
    const entries = Array.from(definitions.entries());
    chipsWrap.style.display = entries.length ? '' : 'none';
    for (const [, def] of entries) {
      const label = definitionLabel(def);
      chipsWrap.appendChild(h('button', { type: 'button', class: 'plot-chip', onclick: () => insertIntoFocusedRow(label) }, label));
    }
  }

  function insertIntoFocusedRow(text) {
    const target = focused ?? (rows[0] ? { rowId: rows[0].id, field: 'expr' } : null);
    if (!target) return;
    emitRows(rows.map((r) => (r.id === target.rowId ? { ...r, [target.field]: r[target.field] + text } : r)));
  }

  function curveList() {
    return rows.map((row, i) => ({
      id: row.id,
      color: rowColor(row, i),
      visible: row.visible,
      points: curves[row.id]?.points,
      style: row.mode === 'scatter' ? 'points' : 'line',
    }));
  }

  function redraw() {
    draw(canvas, view, curveList(), aspectLocked);
  }

  function scheduleResample() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(resample, SAMPLE_DEBOUNCE_MS);
  }

  function resample() {
    const myRequest = ++requestId;
    const width = canvas.clientWidth || 600;
    const height = canvas.clientHeight || 400;
    const { xmin, xmax } = aspectLocked ? equalAspectView(view, width, height) : view;
    const points = Math.max(120, Math.min(700, Math.round(width / 2)));

    for (const row of rows) {
      const applyResult = (pts) => {
        if (requestId !== myRequest) return;
        curves = { ...curves, [row.id]: { points: pts, error: null } };
        renderRows();
        redraw();
      };
      const applyError = (err) => {
        if (requestId !== myRequest) return;
        curves = { ...curves, [row.id]: { points: [], error: err.message } };
        renderRows();
        redraw();
      };

      if (row.mode === 'parametric') {
        if (!row.exprX.trim() || !row.exprY.trim()) {
          delete curves[row.id];
          continue;
        }
        sampleParametric(evaluateRaw, row.exprX, row.exprY, row.tmin, row.tmax, points).then(applyResult, applyError);
      } else if (row.mode === 'complex') {
        if (!row.exprZ.trim()) {
          delete curves[row.id];
          continue;
        }
        sampleComplex(evaluateRaw, row.exprZ, row.tmin, row.tmax, points).then(applyResult, applyError);
      } else if (row.mode === 'scatter') {
        if (!row.exprX.trim() || !row.exprY.trim()) {
          delete curves[row.id];
          continue;
        }
        sampleScatter(evaluateRaw, row.exprX, row.exprY).then(applyResult, applyError);
      } else {
        if (!row.expr.trim()) {
          delete curves[row.id];
          continue;
        }
        sampleFunction(evaluateRaw, row.expr, xmin, xmax, points).then(applyResult, applyError);
      }
    }
  }

  // Panel mounts fresh each time it's opened (see app.js) - so focusing an empty row's
  // expression field here on mount is exactly "focus when the panel opens", letting you
  // start typing right away. When every row is already filled in, add a fresh one instead
  // of leaving focus nowhere.
  function focusOnMount() {
    const emptyRow = rows.find((r) => !r[fieldOrder(r)[0]].trim());
    if (emptyRow) {
      focusField(emptyRow.id, fieldOrder(emptyRow)[0]);
    } else {
      const newRow = makeRow();
      pendingFocusRowId = newRow.id;
      emitRows([...rows, newRow]);
    }
  }

  renderRows();
  renderChips();
  redraw();
  scheduleResample();
  // Deferred so the panel is attached to the DOM (and has real layout) before focusing -
  // matches the original's "mount effect" timing.
  setTimeout(focusOnMount, 0);

  function destroy() {
    resizeObserver?.disconnect();
    clearTimeout(debounceTimer);
  }

  return {
    root,
    // External replace (not routed back through onRowsChange) - used when a popped-out
    // window adopts rows handed off from the tab that owns the live Giac session.
    setRows(next) {
      rows = next;
      renderRows();
      redraw();
      scheduleResample();
    },
    setView(next) {
      view = next;
      renderRows();
      redraw();
      scheduleResample();
    },
    setDefinitions(next) {
      definitions = next;
      renderChips();
    },
    setConnectionStatus(status) {
      statusEl.style.display = status === false ? '' : 'none';
    },
    destroy,
  };
}
