# Calculator

A browser-based scientific calculator with a computer algebra system: symbolic
simplification, equation solving, calculus, function plotting, and spreadsheet-style
tables, all evaluated locally in the browser. Plain HTML/CSS/JS, no build step, no
bundler, no dependencies.

## Credits

The math is done by [Xcas/Giac](https://xcas.univ-grenoble-alpes.fr/en.html), the CAS
engine by Bernard Parisse (Institut Fourier, Université Grenoble Alpes), via its
[JavaScript/WebAssembly build](https://www-fourier.univ-grenoble-alpes.fr/~parisse/giacjs/simple.html).
Giac/Xcas is licensed under the [GNU GPL v3](https://www.gnu.org/licenses/gpl-3.0.html);
this app links to the unmodified official build unchanged.

Math rendering is done by [MathJax](https://www.mathjax.org/) and its contributors,
licensed under the [Apache License 2.0](https://github.com/mathjax/MathJax/blob/master/LICENSE).

## Running it

Because it uses ES modules (`<script type="module">`) and a Web Worker, it must be served
over HTTP - opening `index.html` directly via `file://` will not work. Any static file
server works, e.g. from this directory:

```sh
npx serve .
# or
python3 -m http.server 8000
```

Then open the printed URL. First load pulls the ~18MB Giac WebAssembly build; the browser
caches it afterwards.

## Structure

```
index.html            entry page (loads MathJax, then src/main.js as a module)
src/main.js            picks between the main app and the plot pop-out window
src/app.js              main application controller (state + DOM wiring)
src/plotStandalone.js   controller for a popped-out plot window
src/components/         one file per UI component (vanilla DOM, using a tiny h() helper)
src/lib/                CAS engine bridge, LaTeX conversion, plotting math
src/styles/             plain CSS
public/                 favicon, the Giac worker, and its own copy of the wasm build
```
