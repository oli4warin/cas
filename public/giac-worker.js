// Runs the Giac/Xcas WASM engine off the main thread. Some malformed expressions can
// send the engine's parser into a very long (possibly unbounded) synchronous computation;
// isolating it in a worker means that only stalls this worker, not the page - the app can
// detect it via a timeout and terminate+respawn this worker to recover.
//
// This intentionally does NOT use the vendored giacsimple.js loader: that file assumes a
// `document` (for status/canvas elements) which doesn't exist in a worker. Giac's actual
// WASM build (giacwasm.js) has no such requirement, so it's loaded directly here.

self.Module = {
  print: function (text) {
    console.log('[giac]', text);
  },
  printErr: function (text) {
    console.error('[giac]', text);
  },
  setStatus: function () {},
  monitorRunDependencies: function () {},
  onRuntimeInitialized: function () {
    self.Module.ready = true;
    postMessage({ type: 'ready' });
  },
};

let casevalFn = null;

self.onmessage = function (e) {
  const msg = e.data;
  if (msg.type !== 'eval') return;
  if (!casevalFn) {
    casevalFn = self.Module.cwrap('caseval', 'string', ['string']);
  }
  let out;
  try {
    out = casevalFn(msg.expr);
    if (typeof out !== 'string') out = String(out);
  } catch (err) {
    out = 'GIAC_ERROR ' + ((err && err.message) || String(err));
  }
  postMessage({ type: 'result', id: msg.id, out });
};

try {
  importScripts('./giacwasm.js');
} catch (err) {
  postMessage({ type: 'load-error', message: String((err && err.message) || err) });
}
