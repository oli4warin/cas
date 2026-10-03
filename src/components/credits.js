import { h } from '../lib/dom.js';

// Attribution for the third-party engines/libraries this app is built on. Giac/Xcas is
// GPLv3 - this app links to its unmodified official WebAssembly build (see the vendored
// public/giacwasm.js and public/giac-worker.js) rather than a private fork, and credits it
// here with links to the project's own site, its JS/WASM build, and the GPLv3 text. Plotly.js
// (used for the 3D plot panel, see lib/plotly.js) and Jspreadsheet CE (the Table panel's grid,
// see lib/jspreadsheet.js) are credited the same way, with their MIT licenses.
export function Credits() {
  const link = (href, text) => h('a', { href, target: '_blank', rel: 'noreferrer' }, text);

  return h(
    'div',
    { class: 'credits-bar' },
    h(
      'span',
      null,
      'CAS engine: ',
      link('https://xcas.univ-grenoble-alpes.fr/en.html', 'Xcas/Giac'),
      ' by Bernard Parisse (Institut Fourier, Université Grenoble Alpes) - ',
      link('https://www-fourier.univ-grenoble-alpes.fr/~parisse/giacjs/simple.html', 'JavaScript/WebAssembly build'),
      ', licensed under the ',
      link('https://www.gnu.org/licenses/gpl-3.0.html', 'GNU GPL v3'),
      '. 3D plots: ',
      link('https://plotly.com/javascript/', 'Plotly.js'),
      ', licensed under the ',
      link('https://github.com/plotly/plotly.js/blob/master/LICENSE', 'MIT License'),
      '. Table: ',
      link('https://bossanova.uk/jspreadsheet/', 'Jspreadsheet CE'),
      ', licensed under the ',
      link('https://github.com/jspreadsheet/ce/blob/master/LICENSE', 'MIT License'),
      '.',
    ),
  );
}
