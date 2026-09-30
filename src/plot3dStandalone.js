import { h, clear } from './lib/dom.js';
import { connectBridgeClient } from './lib/plotBridge.js';
import { DEFAULT_VIEW_3D, makeRow3d } from './lib/plotRows3d.js';
import { Plot3DPanel } from './components/plot3dPanel.js';
import { Credits } from './components/credits.js';

// The exact 3D sibling of plotStandalone.js's mountPlotStandalone - see there for the shared
// reasoning (bridged over BroadcastChannel to the calculator tab's live Giac worker, never
// loading a second one of its own). Mounted instead of the calculator when opened as a
// popped-out 3D plot window (?popout=plot3d&session=...&mode=move|new).
export function mountPlot3dStandalone(root, { sessionId, mode }) {
  let rows = [makeRow3d()];
  let view = DEFAULT_VIEW_3D;

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
    const url = `${window.location.origin}${window.location.pathname}?popout=plot3d&session=${sessionId}`;
    window.open(url, `onlinecas-plot3d-${sessionId}-${Math.random().toString(36).slice(2)}`, 'width=1000,height=700');
  }

  const panel = Plot3DPanel({
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

  // Only a panel that was "moved" out of the calculator tab (see app.js's popOutPlot3d)
  // adopts its rows/view - an ordinary new popout window starts blank on purpose.
  if (mode === 'move') {
    bridge.requestPlotState('plot3d').then(
      (state) => {
        if (state && Array.isArray(state.rows) && state.rows.length > 0) {
          rows = state.rows;
          view = state.view || DEFAULT_VIEW_3D;
          panel.setRows(rows);
          panel.setView(view);
        }
      },
      () => {},
    );
  }

  window.addEventListener('beforeunload', () => bridge.close());
}
