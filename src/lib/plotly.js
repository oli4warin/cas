import { t } from './i18n.js';
// Plotly.js powers the 3D plot panel (surfaces, parametric surfaces, isosurfaces/volumes for
// systems in x/y/z - see components/plot3dPanel.js) but is a large library (~4.5MB minified)
// most sessions never touch, unlike MathJax (loaded unconditionally in index.html since every
// result needs it). Loaded on demand instead - the first time the 3D plot panel is opened -
// via a plain injected <script> tag (there's no bundler here to import it through, same
// reasoning as MathJax's own <script> tag in index.html) rather than paying for it on every
// page load.
const PLOTLY_SRC = 'https://cdn.jsdelivr.net/npm/plotly.js-dist-min@2.35.3/plotly.min.js';

let loadPromise = null;

export function loadPlotly() {
  if (window.Plotly) return Promise.resolve(window.Plotly);
  if (loadPromise) return loadPromise;
  loadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = PLOTLY_SRC;
    script.onload = () => resolve(window.Plotly);
    script.onerror = () => {
      loadPromise = null;
      reject(new Error(t('Could not load the 3D plotting library.')));
    };
    document.head.appendChild(script);
  });
  return loadPromise;
}
