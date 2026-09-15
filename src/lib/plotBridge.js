// Lets a popped-out plot window (a separate browsing context, so it has no access to the
// main window's JS heap or its Giac worker) reach the CAS session that opened it. A
// BroadcastChannel is used instead of window.opener/postMessage because it doesn't depend
// on the popup keeping a live reference back to its opener, and works the same way
// regardless of how the window was created.
//
// Messages carry a sessionId (generated once per app load, passed to the popup via the
// URL) so multiple onlinecas tabs open at once don't cross-talk on the shared channel name.

const CHANNEL_NAME = 'onlinecas-plot-bridge';
const HELLO_INTERVAL_MS = 3000;
const EVAL_TIMEOUT_MS = 8000;

// Runs in the window that owns the live Giac engine. Answers eval requests from any
// popped-out plot window for this session, pushes definitions whenever they change, and
// (when getPlotState is given) hands over this window's current plot rows/view once to a
// new window that asks for them - used to "move" an embedded plot panel into a popup
// instead of that popup starting from a blank session.
export function startBridgeHost({ sessionId, evaluateRaw, getDefinitions, getPlotState }) {
  const channel = new BroadcastChannel(CHANNEL_NAME);

  const broadcastDefinitions = () => {
    channel.postMessage({ type: 'definitions', sessionId, entries: Array.from(getDefinitions()) });
  };

  channel.onmessage = (e) => {
    const msg = e.data;
    if (!msg || msg.sessionId !== sessionId) return;

    if (msg.type === 'eval-request') {
      evaluateRaw(msg.expr).then(
        (out) => channel.postMessage({ type: 'eval-response', sessionId, id: msg.id, ok: true, out }),
        (err) =>
          channel.postMessage({
            type: 'eval-response',
            sessionId,
            id: msg.id,
            ok: false,
            out: (err && err.message) || String(err),
          }),
      );
    } else if (msg.type === 'hello') {
      broadcastDefinitions();
    } else if (msg.type === 'request-plot-state') {
      channel.postMessage({
        type: 'plot-state',
        sessionId,
        id: msg.id,
        state: getPlotState ? getPlotState() : null,
      });
    }
  };

  return {
    notifyDefinitionsChanged: broadcastDefinitions,
    close: () => channel.close(),
  };
}

// Runs in the popped-out plot window. Proxies evaluateRaw() calls to the host over the
// channel and surfaces its definitions + connection state.
export function connectBridgeClient({ sessionId, onDefinitions, onConnectionChange }) {
  const channel = new BroadcastChannel(CHANNEL_NAME);
  const pending = new Map();
  let nextId = 1;
  let connected = false;

  const setConnected = (v) => {
    if (connected === v) return;
    connected = v;
    onConnectionChange?.(v);
  };

  channel.onmessage = (e) => {
    const msg = e.data;
    if (!msg || msg.sessionId !== sessionId) return;

    if (msg.type === 'eval-response') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      setConnected(true);
      if (msg.ok) p.resolve(msg.out);
      else p.reject(new Error(msg.out));
    } else if (msg.type === 'definitions') {
      setConnected(true);
      onDefinitions?.(new Map(msg.entries));
    } else if (msg.type === 'plot-state') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      setConnected(true);
      p.resolve(msg.state);
    }
  };

  const helloTimer = setInterval(() => channel.postMessage({ type: 'hello', sessionId }), HELLO_INTERVAL_MS);
  channel.postMessage({ type: 'hello', sessionId });

  function evaluateRaw(expr) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        setConnected(false);
        reject(new Error('The calculator tab is not responding. Is it still open?'));
      }, EVAL_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      channel.postMessage({ type: 'eval-request', sessionId, id, expr });
    });
  }

  // One-shot: asks the host for its current plot rows/view (used only when this window was
  // opened to take over an embedded panel, not for an ordinary fresh popout).
  function requestPlotState() {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Timed out waiting for the calculator tab to hand over its plot.'));
      }, EVAL_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      channel.postMessage({ type: 'request-plot-state', sessionId, id });
    });
  }

  return {
    evaluateRaw,
    requestPlotState,
    close: () => {
      clearInterval(helloTimer);
      for (const p of pending.values()) clearTimeout(p.timer);
      pending.clear();
      channel.close();
    },
  };
}
