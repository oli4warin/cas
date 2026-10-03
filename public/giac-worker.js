// Runs the Giac/Xcas WASM engine off the main thread. Some malformed expressions can
// send the engine's parser into a very long (possibly unbounded) synchronous computation;
// isolating it in a worker means that only stalls this worker, not the page - the app can
// detect it via a timeout and terminate+respawn this worker to recover.
//
// This intentionally does NOT use the vendored giacsimple.js loader: that file assumes a
// `document` (for status/canvas elements) which doesn't exist in a worker. Giac's actual
// WASM build (giacwasm.js) has no such requirement, so it's loaded directly here.

// Giac narrates what it's doing on stdout/stderr ("Trying integration by part", "Warning
// adding 1 ) at end of input", ...) - notes about a computation whose actual result or error
// already reaches the app through caseval's return value, so by default they're dropped rather
// than filling the page's console. Opening the app with "?giaclog" in its URL turns them back
// on (the page passes that on in this worker's own URL - see WORKER_URL in src/lib/giac.js).
const VERBOSE = new URLSearchParams(self.location.search).has('giaclog');

// Printed once on startup by the Emscripten legacy-OpenGL layer the official Giac build is
// compiled with. It's about Giac's own GL renderer, which this app never calls (plots are
// drawn by the app itself), so it isn't worth showing even then.
const IGNORED = [/^WARNING: using emscripten GL emulation\./];

function logFromGiac(log, text) {
  if (!VERBOSE || IGNORED.some((re) => re.test(text))) return;
  log('[giac]', text);
}

self.Module = {
  print: function (text) {
    logFromGiac(console.log, text);
  },
  printErr: function (text) {
    logFromGiac(console.error, text);
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
