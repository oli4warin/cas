import { h, clear, reconcileOrder } from '../lib/dom.js';
import { definitionLabel } from '../lib/definitions.js';
import { giacToLatex } from '../lib/giacToLatex.js';
import {
  sampleFunction,
  sampleParametric,
  sampleComplex,
  sampleScatter,
  sampleDiffEqField,
  sampleSystem,
  sampleComplexSystem,
  sampleContinuousDistribution,
  sampleDiscreteDistribution,
  resolveDistributionBounds,
  computeDistributionFitView,
  computeDistributionProbability,
} from '../lib/plotSample.js';
import { DEFAULT_VIEW, makeRow, defaultDistributionParams } from '../lib/plotRows.js';
import { collectRowParams, reconcileSliders } from '../lib/plotParams.js';
import { DISTRIBUTION_FAMILIES } from '../lib/distributionParams.js';
import { FormulaPreview } from './formulaPreview.js';

const COLORS = ['#7c3aed', '#0ea5e9', '#f59e0b', '#dc2626', '#16a34a', '#db2777'];
const SAMPLE_DEBOUNCE_MS = 150;
// Opacity for a distribution row's shaded area/bars (see the 'area'/'bars' curve styles in
// draw() below) - low enough that the grid lines and curve stroke underneath/on top still
// read clearly through the fill.
const DISTRIBUTION_FILL_OPACITY = 0.35;
// Opacity for a system row's shaded inequality region (see the 'system' curve style below) -
// the exact value asked for, distinct from DISTRIBUTION_FILL_OPACITY since a system row can
// stack several inequalities' fills on top of each other (deliberately: their overlap reading
// darker is how the combined feasible region shows through).
const SYSTEM_FILL_OPACITY = 0.3;

// A row's curve color: whatever the user picked manually, or - same as before that was
// possible - the palette color for its position.
function rowColor(row, index) {
  return row.color || COLORS[index % COLORS.length];
}

// A system (or complexSystem) row's own preview text: every non-blank line joined with "and"
// into one line ("x>5 and y>-x+4") and run through giacToLatex as a single expression -
// giacToLatex already renders "and" as a spaced-out \text{and} between its operands (see
// LOGICAL_WORDS in lib/giacToLatex.js), which is exactly the right reading here since that's
// also how the rows actually get combined for solve()/the merged region (see sampleSystem/
// sampleComplexSystem in lib/plotSample.js) - variable-agnostic, so this same function serves
// both rows without caring whether the lines are in x/y or z.
function systemPreviewLatex(text) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? giacToLatex(lines.join(' and ')) || '' : '';
}

// The text fields a row has, in the order you'd naturally tab through them - used both to
// find a row's "is it empty" field and to know where Enter should go next (see
// handleFieldKeyDown).
function fieldOrder(row) {
  if (row.mode === 'complex') return ['exprZ'];
  if (row.mode === 'diffeq') return ['exprDE'];
  if (row.mode === 'parametric' || row.mode === 'scatter') return ['exprX', 'exprY'];
  if (row.mode === 'system') return ['exprSystem'];
  if (row.mode === 'complexSystem') return ['exprComplexSystem'];
  // No ordinary text field to Enter-tab through here - the family <select> and its param/bound
  // inputs are all rendered by buildFields('distribution') below and wired directly, rather
  // than through the field-order/makeField machinery the other modes share.
  if (row.mode === 'distribution') return [];
  return ['expr'];
}

// A hex color (as stored on a row/produced by COLORS above) plus an alpha, as an rgba() CSS
// color string - used for the 50%-opacity area/bar fill under a distribution's density/pmf
// (see the 'area'/'bars' curve styles in draw() below).
function hexToRgba(hex, alpha) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const [, r, g, b] = m;
  return `rgba(${parseInt(r, 16)},${parseInt(g, 16)},${parseInt(b, 16)},${alpha})`;
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

// A slider's current value, trimmed to 2 decimal places with no trailing zeros - just for
// the little readout next to each parameter's range input.
function formatSliderValue(v) {
  return v.toFixed(2).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
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
    if (!curve.visible || !curve.points) continue;

    // A system row's `points` isn't a flat array like every other style's - it's the compound
    // {equations, inequalityRegion, solutionPoints} shape sampleSystem (plotSample.js)
    // returns, so it's handled entirely on its own here rather than falling into the
    // array-shaped styles below (whose own `curve.points.length === 0` guard just below would
    // always be true for it, since a plain object has no .length).
    if (curve.style === 'system') {
      const { equations = [], inequalityRegion = null, solutionPoints = [] } = curve.points;

      // The system's *combined* feasible region (every inequality holding at once - see
      // combineInequalityGrids in lib/plotSystem.js, which is what makes this one merged shape
      // rather than each inequality's own half-plane overlapping the others), drawn first so
      // the equations' curves and the system's solution points both sit visibly on top of it.
      // Every polygon is added to one single path and filled once (rather than one fill() per
      // polygon) so neighboring cells' shared edges never double up their own antialiasing -
      // that seam is what made the old per-cell fillRect version look "pixelig" up close. The
      // region's own boundary is then stroked at full opacity right on top of the fill, so the
      // solution area actually reads as a bounded region rather than just a haze.
      if (inequalityRegion && inequalityRegion.fill.length) {
        ctx.fillStyle = hexToRgba(curve.color, SYSTEM_FILL_OPACITY);
        ctx.beginPath();
        for (const poly of inequalityRegion.fill) {
          if (poly.length < 3) continue;
          ctx.moveTo(toPx(poly[0].x), toPy(poly[0].y));
          for (let k = 1; k < poly.length; k++) ctx.lineTo(toPx(poly[k].x), toPy(poly[k].y));
          ctx.closePath();
        }
        ctx.fill();

        if (inequalityRegion.boundary.length) {
          ctx.strokeStyle = curve.color;
          ctx.lineWidth = 2;
          ctx.beginPath();
          for (const [a, b] of inequalityRegion.boundary) {
            ctx.moveTo(toPx(a.x), toPy(a.y));
            ctx.lineTo(toPx(b.x), toPy(b.y));
          }
          ctx.stroke();
        }
      }

      // Each equation's own implicit-curve contour (marching squares - see
      // traceContourSegments in lib/plotSystem.js), one independent set of segments per line
      // so a gap in one equation's domain never bridges into another's.
      if (equations.length) {
        ctx.strokeStyle = curve.color;
        ctx.lineWidth = 2;
        for (const segments of equations) {
          ctx.beginPath();
          for (const [a, b] of segments) {
            ctx.moveTo(toPx(a.x), toPy(a.y));
            ctx.lineTo(toPx(b.x), toPy(b.y));
          }
          ctx.stroke();
        }
      }

      // The system's own solution point(s) - only ever populated when there are 2+ equation
      // lines (see sampleSystem) - drawn last, on top of both the curves and the fills.
      if (solutionPoints.length) {
        ctx.fillStyle = curve.color;
        for (const { x, y } of solutionPoints) {
          if (x < xmin || x > xmax || y < ymin || y > ymax) continue;
          ctx.beginPath();
          ctx.arc(toPx(x), toPy(y), 4.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      continue;
    }

    if (curve.points.length === 0) continue;

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

    if (curve.style === 'field') {
      ctx.strokeStyle = curve.color;
      ctx.fillStyle = curve.color;
      ctx.lineWidth = 1.5;
      const ARROW_LEN = 12;
      const HEAD_LEN = 4;
      for (const { x, y, dx, dy } of curve.points) {
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(dx) || !Number.isFinite(dy)) continue;
        if (x < xmin || x > xmax || y < ymin || y > ymax) continue;
        const mag = Math.hypot(dx, dy);
        if (!(mag > 0)) continue;
        // Direction only - a vector/slope field is about where it points, not how long the
        // raw (x',y') happens to be, which can range from ~0 near an equilibrium to huge near
        // a singularity. Normalized in data space first, then re-normalized after the
        // to-pixel transform so it still reads as "a direction" even with independent x/y
        // scaling (aspect unlocked).
        let vx = (dx / mag) * pxPerX;
        let vy = -(dy / mag) * pxPerY;
        const vmag = Math.hypot(vx, vy) || 1;
        vx /= vmag;
        vy /= vmag;
        const cx = toPx(x);
        const cy = toPy(y);
        const x1 = cx - (ARROW_LEN / 2) * vx;
        const y1 = cy - (ARROW_LEN / 2) * vy;
        const x2 = cx + (ARROW_LEN / 2) * vx;
        const y2 = cy + (ARROW_LEN / 2) * vy;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        const ang = Math.atan2(vy, vx);
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - HEAD_LEN * Math.cos(ang - Math.PI / 6), y2 - HEAD_LEN * Math.sin(ang - Math.PI / 6));
        ctx.lineTo(x2 - HEAD_LEN * Math.cos(ang + Math.PI / 6), y2 - HEAD_LEN * Math.sin(ang + Math.PI / 6));
        ctx.closePath();
        ctx.fill();
      }
      continue;
    }

    if (curve.style === 'bars') {
      // A discrete distribution's probability function - one bar per integer k, ~0.8 data
      // units wide so neighboring bars read as separate columns with a visible gap between
      // them. Every bar gets an outline in the row color; a bar whose k falls inside the
      // shaded [lower,upper] region (see resolveDistributionBounds/resample()) is additionally
      // filled at DISTRIBUTION_FILL_OPACITY - a bar chart's own rectangle already reads as
      // "the area", so no separate fill-vs-curve pass is needed the way the continuous 'area'
      // style below needs.
      const barHalfWidth = (0.4 * width) / (xmax - xmin);
      const zeroPy = toPy(0);
      ctx.strokeStyle = curve.color;
      ctx.lineWidth = 1.5;
      for (const { x, y, filled } of curve.points) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (x < xmin || x > xmax) continue;
        const px = toPx(x);
        const topPy = toPy(y);
        const rectX = px - barHalfWidth;
        const rectY = Math.min(topPy, zeroPy);
        const rectW = barHalfWidth * 2;
        const rectH = Math.abs(zeroPy - topPy);
        if (filled) {
          ctx.fillStyle = hexToRgba(curve.color, DISTRIBUTION_FILL_OPACITY);
          ctx.fillRect(rectX, rectY, rectW, rectH);
        }
        ctx.strokeRect(rectX, rectY, rectW, rectH);
      }
      continue;
    }

    if (curve.style === 'area' && curve.fillFrom != null && curve.fillTo != null) {
      // The shaded region under a continuous distribution's density, for x in
      // [fillFrom,fillTo] (already clamped to the drawn range and to the family's own support -
      // see resample()'s distribution branch) - filled *underneath* the curve stroke drawn
      // below, in separate sub-paths across any NaN gap (mirrors the stroke loop's own
      // `started` handling), so a domain-masked gap never gets bridged by a fill.
      ctx.fillStyle = hexToRgba(curve.color, DISTRIBUTION_FILL_OPACITY);
      const zeroPy = toPy(0);
      let path = null;
      const closePath = () => {
        if (path && path.length > 1) {
          ctx.beginPath();
          ctx.moveTo(toPx(path[0].x), zeroPy);
          for (const { x, y } of path) ctx.lineTo(toPx(x), toPy(y));
          ctx.lineTo(toPx(path[path.length - 1].x), zeroPy);
          ctx.closePath();
          ctx.fill();
        }
        path = null;
      };
      for (const { x, y } of curve.points) {
        const inRange = Number.isFinite(x) && Number.isFinite(y) && x >= curve.fillFrom && x <= curve.fillTo;
        if (!inRange) {
          closePath();
          continue;
        }
        (path ??= []).push({ x, y });
      }
      closePath();
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
function createRowView({
  onModeChange,
  onFieldInput,
  onFieldKeyDown,
  onFieldFocus,
  onTChange,
  onToggle,
  onColorChange,
  onRemove,
  onSliderChange,
  onSliderRangeChange,
  onFamilyChange,
  onParamInput,
  onBoundChange,
}) {
  let currentMode = null;
  const fieldEls = {};
  const previews = {};
  let tminEl = null;
  let tmaxEl = null;
  let sliderKey = null;
  const sliderEls = {}; // paramName -> { root, rangeEl, valueEl, minEl, maxEl }
  let familySelectEl = null;
  let paramsWrapEl = null;
  let lowerEl = null;
  let upperEl = null;
  let probResultEl = null;
  let paramFamilyKey = null; // which family paramEls was last built for - rebuilt only when this changes
  const paramEls = {}; // paramKey -> input

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
    h('option', { value: 'diffeq' }, 'differential equation'),
    h('option', { value: 'distribution' }, 'probability distribution'),
    h('option', { value: 'system' }, 'system of equations (x,y)'),
    h('option', { value: 'complexSystem' }, 'complex equations (z)'),
  );
  const fieldsWrap = h('span');
  const toggleBtn = h('button', { type: 'button', class: 'plot-row__toggle', onclick: onToggle }, '●');
  const removeBtn = h('button', { type: 'button', class: 'plot-row__remove', title: 'Remove', onclick: onRemove }, '×');
  const errorSpan = h('span', { class: 'plot-row__error' });
  errorSpan.style.display = 'none';
  const slidersWrap = h('div', { class: 'plot-row__sliders' });
  slidersWrap.style.display = 'none';

  const root = h('div', { class: 'plot-row' }, swatch, modeSelect, fieldsWrap, toggleBtn, removeBtn, slidersWrap, errorSpan);

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

  // Same idea as makeField above, but a <textarea> so a system of several equations/
  // inequalities can be typed one per line (see lib/plotSystem.js) - Shift+Enter inserts a
  // literal newline here instead of tabbing to the next field/row, the same convention the
  // main calculator input uses for its own multiline systems (see app.js), so typing one is
  // the same gesture in both places. Its preview (see update() below, systemPreviewLatex)
  // joins every line with "and" into one line - "x>5 and y>-x+4" - rather than stacking them,
  // since that's how the system is actually evaluated (every line already gets "and"-joined
  // the same way for solve()/the combined region, see sampleSystem in lib/plotSample.js) and
  // reads more naturally for a run of inequalities than a bare vertical stack with no
  // connecting word would.
  function makeMultilineField(field, placeholder) {
    const input = h('textarea', {
      class: 'plot-row__input plot-row__systemInput',
      rows: 3,
      placeholder,
      onfocus: () => onFieldFocus(field),
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

  // The family <select> plus its two always-present pieces (the params container, rebuilt
  // only when the family itself changes - see updateDistParams - and the lower/upper bound
  // inputs, which every family shares since they just shade whatever region of that family's
  // own curve/bars falls between them).
  function makeDistributionFields() {
    familySelectEl = h(
      'select',
      { class: 'plot-row__modeSelect', title: 'Distribution', onchange: (e) => onFamilyChange(e.target.value) },
      ...Object.entries(DISTRIBUTION_FAMILIES).map(([key, cfg]) => h('option', { value: key }, cfg.label)),
    );
    paramsWrapEl = h('span', { class: 'plot-row__paramFields' });
    paramFamilyKey = null;
    lowerEl = h('input', {
      class: 'plot-row__tInput',
      type: 'text',
      placeholder: '-infinity',
      oninput: (e) => onBoundChange('lower', e.target.value),
    });
    upperEl = h('input', {
      class: 'plot-row__tInput',
      type: 'text',
      placeholder: 'infinity',
      oninput: (e) => onBoundChange('upper', e.target.value),
    });
    // The probability that region actually represents - filled in once resample() has
    // computed it for the row's current family/params/bounds (see resample()'s distribution
    // branch and computeDistributionProbability in plotSample.js); left empty until then, and
    // whenever that computation doesn't apply at all (an invalid expression mid-edit).
    probResultEl = h('span', { class: 'plot-row__distProb' });
    const bounds = h('span', { class: 'plot-row__tRange' }, 'P(', lowerEl, '≤ X ≤', upperEl, ')', probResultEl);
    return h('span', {}, familySelectEl, paramsWrapEl, bounds);
  }

  // Rebuilds the per-family param inputs only when `family` itself changed (same
  // rebuild-only-on-key-change idea as updateSliders below) - a value tick (typing into an
  // already-built field) never tears the inputs down and loses focus/caret position.
  function updateDistParams(family, params) {
    if (family !== paramFamilyKey) {
      paramFamilyKey = family;
      clear(paramsWrapEl);
      for (const key of Object.keys(paramEls)) delete paramEls[key];
      for (const p of DISTRIBUTION_FAMILIES[family]?.params ?? []) {
        const input = h('input', {
          class: 'plot-row__input plot-row__distParam',
          type: 'text',
          placeholder: p.label,
          oninput: (e) => onParamInput(p.key, e.target.value),
        });
        paramEls[p.key] = input;
        paramsWrapEl.append(h('label', { class: 'plot-row__distParamLabel' }, p.label, input));
      }
    }
    for (const [key, input] of Object.entries(paramEls)) {
      const value = params?.[key] ?? '';
      if (input.value !== value) input.value = value;
    }
  }

  function buildFields(mode) {
    clear(fieldsWrap);
    for (const key of Object.keys(fieldEls)) delete fieldEls[key];
    for (const key of Object.keys(previews)) delete previews[key];
    tminEl = null;
    tmaxEl = null;
    familySelectEl = null;
    paramsWrapEl = null;
    lowerEl = null;
    upperEl = null;
    probResultEl = null;

    if (mode === 'distribution') {
      fieldsWrap.append(makeDistributionFields());
    } else if (mode === 'parametric') {
      fieldsWrap.append(makeField('exprX', 'x(t), e.g. cos(t)', 'x(t)'), makeField('exprY', 'y(t), e.g. sin(t)', 'y(t)'), makeTRange());
    } else if (mode === 'complex') {
      fieldsWrap.append(makeField('exprZ', 'z(t), e.g. exp(i*t)', 'z(t)'), makeTRange());
    } else if (mode === 'scatter') {
      fieldsWrap.append(
        makeField('exprX', 'x data, e.g. [1,2,3] or a column name', 'x data'),
        makeField('exprY', 'y data, e.g. [4,5,6] or a column name', 'y data'),
      );
    } else if (mode === 'diffeq') {
      const field = makeField('exprDE', "y'=f(x,y) or y''-y'-y=0", 'ODE');
      field.title =
        "1st order (y'=...): direction field over the x/y axes. " +
        "2nd order (y''=...): phase-plane vector field over y/y' instead (autonomous equations only).";
      fieldsWrap.append(field);
    } else if (mode === 'system') {
      const field = makeMultilineField('exprSystem', 'x+y=5\nx-y=1\ny<3');
      field.title =
        'One equation or inequality per line, in x and y only - Shift+Enter for a new line. ' +
        'Equations are traced as curves and (with 2+ of them) solved for their intersection ' +
        'point(s); inequalities are shaded at 30% opacity.';
      fieldsWrap.append(field);
    } else if (mode === 'complexSystem') {
      const field = makeMultilineField('exprComplexSystem', 'abs(z)<2\nRe(z)>0');
      field.title =
        'One equation or inequality per line, in z only - Shift+Enter for a new line. Plotted ' +
        'over the real/imaginary plane (z=x+i*y): equations are traced as curves, inequalities ' +
        'shaded at 30% opacity.';
      fieldsWrap.append(field);
    } else {
      fieldsWrap.append(makeField('expr', 'e.g. sin(x), f(x), a*x+b, sin(x)|0<x<7', undefined));
    }
  }

  // Builds one labeled range input per detected parameter (see lib/plotParams.js) - only
  // rebuilt when the *set* of parameters changes (a param typed in or out, or resolved by a
  // CAS definition), not on every value tick, so dragging a slider doesn't fight its own
  // rebuild for focus.
  function makeSliderControl(name) {
    const nameEl = h('span', { class: 'plot-row__sliderName' }, name);
    const valueEl = h('span', { class: 'plot-row__sliderValue' });
    const minEl = h('input', {
      type: 'number',
      class: 'plot-row__sliderBound',
      title: 'Minimum',
      oninput: (e) => onSliderRangeChange(name, 'min', e.target.value),
    });
    const maxEl = h('input', {
      type: 'number',
      class: 'plot-row__sliderBound',
      title: 'Maximum',
      oninput: (e) => onSliderRangeChange(name, 'max', e.target.value),
    });
    const rangeEl = h('input', {
      type: 'range',
      class: 'plot-row__sliderRange',
      oninput: (e) => onSliderChange(name, parseFloat(e.target.value)),
    });
    const root = h('span', { class: 'plot-row__slider' }, nameEl, minEl, rangeEl, maxEl, valueEl);
    return { root, rangeEl, valueEl, minEl, maxEl };
  }

  function updateSliders(sliders) {
    const names = Object.keys(sliders);
    const key = names.join(',');
    if (key !== sliderKey) {
      sliderKey = key;
      clear(slidersWrap);
      for (const k of Object.keys(sliderEls)) delete sliderEls[k];
      for (const name of names) {
        const ctrl = makeSliderControl(name);
        sliderEls[name] = ctrl;
        slidersWrap.appendChild(ctrl.root);
      }
      slidersWrap.style.display = names.length ? '' : 'none';
    }
    for (const name of names) {
      const { value, min, max, step } = sliders[name];
      const { rangeEl, valueEl, minEl, maxEl } = sliderEls[name];
      if (rangeEl.min !== String(min)) rangeEl.min = min;
      if (rangeEl.max !== String(max)) rangeEl.max = max;
      if (rangeEl.step !== String(step)) rangeEl.step = step;
      if (document.activeElement !== rangeEl) rangeEl.value = value;
      if (document.activeElement !== minEl) minEl.value = min;
      if (document.activeElement !== maxEl) maxEl.value = max;
      valueEl.textContent = formatSliderValue(value);
    }
  }

  function update(row, index, errorMessage, probText) {
    const color = rowColor(row, index);
    if (swatch.value !== color) swatch.value = color;
    if (modeSelect.value !== row.mode) modeSelect.value = row.mode;

    if (row.mode !== currentMode) {
      currentMode = row.mode;
      buildFields(row.mode);
    }
    for (const field of fieldOrder(row)) {
      if (fieldEls[field] && fieldEls[field].value !== row[field]) fieldEls[field].value = row[field];
      // A system/complexSystem row's field holds several lines at once - preview them
      // "and"-joined into one line (see systemPreviewLatex) rather than as one run-on
      // expression.
      const isMultiline = row.mode === 'system' || row.mode === 'complexSystem';
      previews[field]?.update(isMultiline ? systemPreviewLatex(row[field]) : giacToLatex(row[field]) || '');
    }
    if (tminEl && tminEl.value !== row.tmin) tminEl.value = row.tmin;
    if (tmaxEl && tmaxEl.value !== row.tmax) tmaxEl.value = row.tmax;

    if (familySelectEl) {
      if (familySelectEl.value !== row.family) familySelectEl.value = row.family;
      updateDistParams(row.family, row.params);
      if (lowerEl.value !== row.lower) lowerEl.value = row.lower;
      if (upperEl.value !== row.upper) upperEl.value = row.upper;
      probResultEl.textContent = probText ?? '';
    }

    updateSliders(row.sliders ?? {});

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
  let immediateResampleHandle = null;
  let requestId = 0;
  let dragState = null;
  const rowViews = new Map(); // rowId -> RowView
  let pendingFocusRowId = null;
  // rowId -> "family|JSON(params)" already fitted (see fitDistributionView) - lets
  // renderRows() below tell "the user edited this row's shape" apart from every other reason
  // it re-renders (typing elsewhere, a slider drag, toggling visibility, ...), so the view
  // only auto-adjusts when there's actually something new to fit.
  const distFitSignatures = new Map();
  let distFitTimer = null;

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
  function setAspectLocked(value) {
    aspectLocked = value;
    aspectBtn.classList.toggle('plot-panel__aspectBtn--active', aspectLocked);
    aspectBtn.title = aspectLocked
      ? 'Equidistant units (click for independent x/y scaling)'
      : 'Independent x/y scaling (click for equidistant units)';
  }
  aspectBtn.addEventListener('click', () => {
    setAspectLocked(!aspectLocked);
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

  // Dragging a slider goes through its own path rather than updateRow()/emitRows() so it can
  // resample immediately (see scheduleResampleImmediate) instead of waiting out the typing
  // debounce.
  function setSliderValue(id, name, value) {
    const row = rows.find((r) => r.id === id);
    if (!row || !row.sliders[name]) return;
    rows = rows.map((r) => (r.id === id ? { ...r, sliders: { ...r.sliders, [name]: { ...r.sliders[name], value } } } : r));
    onRowsChange(rows);
    renderRows();
    scheduleResampleImmediate();
  }

  // Edits a slider's min/max bound. Rejects a bound that would make min >= max (silently
  // ignored - the input just doesn't take the keystroke; harmless while the user's mid-type,
  // e.g. typing "-10" briefly passes through "-1") and clamps the current value into the new
  // range so an out-of-range value can't linger once its bound has moved past it.
  function setSliderRange(id, name, field, rawValue) {
    const row = rows.find((r) => r.id === id);
    const slider = row?.sliders[name];
    if (!slider) return;
    const num = parseFloat(rawValue);
    if (Number.isNaN(num)) return;
    const min = field === 'min' ? num : slider.min;
    const max = field === 'max' ? num : slider.max;
    if (min >= max) return;
    const value = Math.min(Math.max(slider.value, min), max);
    rows = rows.map((r) => (r.id === id ? { ...r, sliders: { ...r.sliders, [name]: { ...r.sliders[name], min, max, value } } } : r));
    onRowsChange(rows);
    renderRows();
    scheduleResample();
  }

  // Switching a distribution row's family resets its params to that family's own defaults
  // (the old family's param keys wouldn't mean anything to the new one, e.g. "n"/"p" for
  // Binomial vs "mu"/"sigma" for Normal) and its shaded region back to the whole curve, same
  // as a freshly added row (see lib/plotRows.js's makeRow).
  function setDistFamily(id, family) {
    updateRow(id, { family, params: defaultDistributionParams(family), lower: '-infinity', upper: 'infinity' });
  }
  function setDistParam(id, key, value) {
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    updateRow(id, { params: { ...row.params, [key]: value } });
  }
  function setDistBound(id, which, value) {
    updateRow(id, { [which]: value });
  }

  // Debounced the same way typing into any other field is (see SAMPLE_DEBOUNCE_MS) - a
  // family/param edit fires this on every keystroke (see renderRows()'s signature check
  // above), and re-fitting on every one of those would mean an extra couple of engine round
  // trips per keystroke on top of the ordinary resample. Only the most recently touched row
  // actually drives the shared view when several would otherwise want to fit at once.
  function scheduleDistFit(rowId) {
    clearTimeout(distFitTimer);
    distFitTimer = setTimeout(() => fitDistributionView(rowId), SAMPLE_DEBOUNCE_MS);
  }

  // Auto-fits the shared view to a distribution row's own shape - its 90% mass on the x-axis
  // (see computeDistributionFitView), its actual peak height on the y-axis - since the panel's
  // ordinary default view (same [-10,10]x[-6,6], 1:1 aspect as every other plot mode) routinely
  // makes a distribution unreadable (a Normal's density maxes out around 0.4; a Binomial's bars
  // sit invisibly close to the x-axis). 1:1 is turned off at the same time - locking the two
  // axes to the same scale would undo the y-axis half of this fit.
  async function fitDistributionView(rowId) {
    const row = rows.find((r) => r.id === rowId);
    if (!row || row.mode !== 'distribution') return;
    const cfg = DISTRIBUTION_FAMILIES[row.family];
    if (!cfg) return;
    const fit = await computeDistributionFitView(evaluateRaw, row.family, row.params, cfg.discrete);
    if (!fit) return;
    // The row may have moved on to a different family/params (or been removed) while the fit
    // was in flight - stale results are dropped rather than yanking the view out from under
    // whatever the user's doing now.
    const current = rows.find((r) => r.id === rowId);
    if (!current || current.family !== row.family || JSON.stringify(current.params) !== JSON.stringify(row.params)) return;
    setAspectLocked(false);
    onViewChange(fit);
  }

  // Adds/drops sliders to match each row's currently-detected plot parameters (see
  // lib/plotParams.js) - run at the top of every renderRows() so it stays in sync whether
  // rows changed (a param typed in or out) or `definitions` did (a param just got assigned in
  // the CAS, or purged back out of it). Returns whether anything actually changed, so the
  // caller knows whether a resample is owed.
  function reconcileRowSliders() {
    let changed = false;
    rows = rows.map((row) => {
      const sliders = reconcileSliders(row.sliders, collectRowParams(row, definitions));
      if (sliders === row.sliders) return row;
      changed = true;
      return { ...row, sliders };
    });
    if (changed) onRowsChange(rows);
    return changed;
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
    distFitSignatures.delete(id);
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
    const slidersChanged = reconcileRowSliders();

    const seen = new Set();
    const desired = [];
    rows.forEach((row, i) => {
      seen.add(row.id);
      if (row.mode === 'distribution') {
        const sig = `${row.family}|${JSON.stringify(row.params)}`;
        if (distFitSignatures.get(row.id) !== sig) {
          distFitSignatures.set(row.id, sig);
          scheduleDistFit(row.id);
        }
      } else {
        distFitSignatures.delete(row.id);
      }
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
          onSliderChange: (name, value) => setSliderValue(row.id, name, value),
          onSliderRangeChange: (name, field, value) => setSliderRange(row.id, name, field, value),
          onFamilyChange: (family) => setDistFamily(row.id, family),
          onParamInput: (key, value) => setDistParam(row.id, key, value),
          onBoundChange: (which, value) => setDistBound(row.id, which, value),
        });
        rowViews.set(row.id, view);
      }
      view.update(row, i, curves[row.id]?.error, curves[row.id]?.prob?.text);
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
    if (slidersChanged) scheduleResample();
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
    return rows.map((row, i) => {
      const isDistribution = row.mode === 'distribution';
      const discrete = isDistribution && DISTRIBUTION_FAMILIES[row.family]?.discrete;
      const stored = curves[row.id];
      if (row.mode === 'system' || row.mode === 'complexSystem') {
        // stored.points is here the compound {equations, inequalityRegion, solutionPoints}
        // shape sampleSystem/sampleComplexSystem returns, not a flat array - see draw()'s own
        // 'system' style, which is the only one that ever reads it. Both modes share this same
        // style since sampleComplexSystem's own output is already in the real x/y plane by the
        // time it gets here (see its own comment in lib/plotSample.js) - nothing about drawing
        // it differs from a real 'system' row's.
        return { id: row.id, color: rowColor(row, i), visible: row.visible, points: stored?.points, style: 'system' };
      }
      return {
        id: row.id,
        color: rowColor(row, i),
        visible: row.visible,
        points: discrete
          ? stored?.points?.map((p) => ({ ...p, filled: p.x >= stored.lower && p.x <= stored.upper }))
          : stored?.points,
        style: row.mode === 'scatter' ? 'points' : row.mode === 'diffeq' ? 'field' : discrete ? 'bars' : isDistribution ? 'area' : 'line',
        fillFrom: isDistribution && !discrete ? stored?.lower : undefined,
        fillTo: isDistribution && !discrete ? stored?.upper : undefined,
      };
    });
  }

  function redraw() {
    draw(canvas, view, curveList(), aspectLocked);
  }

  function scheduleResample() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(resample, SAMPLE_DEBOUNCE_MS);
  }

  // Used while a slider is actively being dragged, where the usual debounce (needed for
  // typing, which passes through plenty of momentarily-invalid expressions) would just read
  // as lag - a range input's own "input" event already fires at most once per animation
  // frame's worth of movement, so coalescing onto the next frame (rather than firing once per
  // event, or waiting out the typing debounce) keeps the curve tracking the handle with no
  // perceptible delay while never queueing more than one resample per frame. Stale
  // in-flight evaluations are still discarded by resample()'s own requestId check, so a slow
  // engine round trip can never show a curve older than the slider's current position.
  function scheduleResampleImmediate() {
    clearTimeout(debounceTimer);
    if (immediateResampleHandle != null) return;
    immediateResampleHandle = requestAnimationFrame(() => {
      immediateResampleHandle = null;
      resample();
    });
  }

  function resample() {
    const myRequest = ++requestId;
    const width = canvas.clientWidth || 600;
    const height = canvas.clientHeight || 400;
    const effView = aspectLocked ? equalAspectView(view, width, height) : view;
    const { xmin, xmax } = effView;
    const points = Math.max(120, Math.min(700, Math.round(width / 2)));
    // Aiming for roughly one arrow per ~32px keeps the field dense enough to actually read
    // as a flow, without so many arrows they blur into a solid smear.
    const fieldNx = Math.max(10, Math.min(40, Math.round(width / 32)));
    const fieldNy = Math.max(8, Math.min(30, Math.round(height / 32)));
    // Denser than the vector field above - a system/complexSystem row's grid has to resolve
    // both a smooth implicit-curve contour (marching squares - see traceContourSegments in
    // lib/plotSystem.js) and an inequality's own region fill (buildRegionFillPolygons already
    // interpolates each cell's own boundary sub-pixel-precisely, but a curved boundary like a
    // circle still reads faceted at too coarse a grid - this resolution is chosen to keep that
    // unnoticeable at a typical zoom level without costing more than roughly half a second per
    // line).
    const sysNx = Math.max(70, Math.min(180, Math.round(width / 3.5)));
    const sysNy = Math.max(50, Math.min(130, Math.round(height / 3.5)));

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
        sampleParametric(evaluateRaw, row.exprX, row.exprY, row.tmin, row.tmax, points, row.sliders).then(applyResult, applyError);
      } else if (row.mode === 'complex') {
        if (!row.exprZ.trim()) {
          delete curves[row.id];
          continue;
        }
        sampleComplex(evaluateRaw, row.exprZ, row.tmin, row.tmax, points, row.sliders).then(applyResult, applyError);
      } else if (row.mode === 'scatter') {
        if (!row.exprX.trim() || !row.exprY.trim()) {
          delete curves[row.id];
          continue;
        }
        sampleScatter(evaluateRaw, row.exprX, row.exprY).then(applyResult, applyError);
      } else if (row.mode === 'diffeq') {
        if (!row.exprDE.trim()) {
          delete curves[row.id];
          continue;
        }
        sampleDiffEqField(evaluateRaw, row.exprDE, effView, fieldNx, fieldNy).then(applyResult, applyError);
      } else if (row.mode === 'system') {
        if (!row.exprSystem.trim()) {
          delete curves[row.id];
          continue;
        }
        sampleSystem(evaluateRaw, row.exprSystem, effView, sysNx, sysNy, definitions).then(applyResult, applyError);
      } else if (row.mode === 'complexSystem') {
        if (!row.exprComplexSystem.trim()) {
          delete curves[row.id];
          continue;
        }
        sampleComplexSystem(evaluateRaw, row.exprComplexSystem, effView, sysNx, sysNy, definitions).then(applyResult, applyError);
      } else if (row.mode === 'distribution') {
        const cfg = DISTRIBUTION_FAMILIES[row.family];
        if (!cfg) {
          delete curves[row.id];
          continue;
        }
        const sample = cfg.discrete
          ? sampleDiscreteDistribution(evaluateRaw, row.family, row.params, xmin, xmax)
          : sampleContinuousDistribution(evaluateRaw, row.family, row.params, xmin, xmax, points);
        // Sequential, not Promise.all - same reason sampleScatter's two evaluateRaw calls are
        // (see its own comment in plotSample.js): the shared bridge is only ever asked to
        // resolve one dependent step at a time here. The probability readout (see
        // computeDistributionProbability) is independent of the sampled points/bounds above -
        // it re-derives what it needs from row.lower/row.upper itself - but still has to wait
        // its turn on the same bridge.
        sample
          .then((pts) => resolveDistributionBounds(evaluateRaw, row.lower, row.upper).then((bounds) => ({ pts, bounds })))
          .then(({ pts, bounds }) =>
            computeDistributionProbability(evaluateRaw, row.family, row.params, row.lower, row.upper).then((prob) => ({ pts, bounds, prob })),
          )
          .then(({ pts, bounds, prob }) => {
            if (requestId !== myRequest) return;
            curves = { ...curves, [row.id]: { points: pts, error: null, lower: bounds.lower, upper: bounds.upper, prob } };
            renderRows();
            redraw();
          }, applyError);
      } else {
        if (!row.expr.trim()) {
          delete curves[row.id];
          continue;
        }
        sampleFunction(evaluateRaw, row.expr, xmin, xmax, points, row.sliders).then(applyResult, applyError);
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
    clearTimeout(distFitTimer);
    if (immediateResampleHandle != null) cancelAnimationFrame(immediateResampleHandle);
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
      // A definition changing (a new one assigned, or one purged) can change which of a
      // row's free names still need a slider - e.g. typing "a:=3" should make "a"'s slider
      // disappear and start using that value instead. renderRows() reconciles that (see
      // reconcileRowSliders) and schedules a resample itself, but only when the slider set
      // itself changed. A *value* changing for a name that was already excluded from sliders
      // (e.g. "a:=1" followed by "a:=2") doesn't touch the slider set, so it wouldn't otherwise
      // trigger a resample even though the plotted curve depends on it - schedule one here
      // unconditionally instead (app.js only calls setDefinitions when the map actually changed).
      renderRows();
      renderChips();
      scheduleResample();
    },
    setConnectionStatus(status) {
      statusEl.style.display = status === false ? '' : 'none';
    },
    destroy,
  };
}
