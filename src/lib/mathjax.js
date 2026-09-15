// MathJax v3 is loaded globally via a <script> tag in index.html (config there disables
// automatic startup typesetting so we can drive it ourselves as new results come in).

export function typesetNode(node) {
  if (!node) return;
  const mj = window.MathJax;
  if (!mj) return;
  const run = () => (mj.typesetPromise ? mj.typesetPromise([node]).catch(() => {}) : undefined);
  if (mj.startup && mj.startup.promise) {
    mj.startup.promise.then(run).catch(() => {});
  } else {
    run();
  }
}
