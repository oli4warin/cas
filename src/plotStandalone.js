import { h, clear } from './lib/dom.js';
import { connectBridgeClient } from './lib/plotBridge.js';
import { DEFAULT_VIEW, makeRow } from './lib/plotRows.js';
import { PlotPanel } from './components/plotPanel.js';
import { Credits } from './components/credits.js';

// Mounted instead of the calculator when opened as a popped-out plot window
// (?popout=plot&session=...&mode=move|new). It never touches the Giac worker itself - all
// evaluation is proxied over BroadcastChannel to the calculator tab that opened it, so it
// shares that tab's variables/functions and doesn't pay for a second ~18MB WASM engine load.
export function mountPlotStandalone(root, { sessionId, mode }) {
  let rows = [makeRow()];
  let view = DEFAULT_VIEW;

  const panelWrap = h('div', { style: { flex: '1', minHeight: '0' } });
  const page = h('div', { style: { display: 'flex', flexDirection: 'column', height: '100svh', padding: '12px' } }, panelWrap, Credits());
  clear(root);
  root.appendChild(page);

  const bridge = connectBridgeClient({
    sessionId,
    onDefinitions: (defs) => panel.setDefinitions(defs),
    onConnectionChange: (connected) => panel.setConnectionStatus(connected),
  });

  function popOutNewSession() {
    const url = `${window.location.origin}${window.location.pathname}?popout=plot&session=${sessionId}`;
    window.open(url, `onlinecas-plot-${sessionId}-${Math.random().toString(36).slice(2)}`, 'width=1000,height=700');
  }

  const panel = PlotPanel({
    evaluateRaw: (expr) => bridge.evaluateRaw(expr),
    rows,
    view,
    onRowsChange: (next) => {
      rows = next;
    },
    onViewChange: (next) => {
      view = typeof next === 'function' ? next(view) : next;
      panel.setView(view);
    },
    standalone: true,
    onPopOut: popOutNewSession,
  });
  panelWrap.appendChild(panel.root);

  // Only a panel that was "moved" out of the calculator tab (see app.js's popOutPlot)
  // adopts its rows/view - an ordinary new popout window starts blank on purpose.
  if (mode === 'move') {
    bridge.requestPlotState().then(
      (state) => {
        if (state && Array.isArray(state.rows) && state.rows.length > 0) {
          rows = state.rows;
          view = state.view || DEFAULT_VIEW;
          panel.setRows(rows);
          panel.setView(view);
        }
      },
      () => {},
    );
  }

  window.addEventListener('beforeunload', () => bridge.close());
}
