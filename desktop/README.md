# Calculator (desktop)

Offline Electron build of the calculator web app in the repo root. Everything runs locally -
the Giac/Xcas WASM engine, MathJax, all app code - no network access needed after install.

## Usage

```sh
npm install     # first time only
npm start        # sync app/ from ../ and launch
```

## Building an installer

```sh
npm run dist
```

Output lands in `dist/`. See `package.json`'s `build` key for per-platform targets.

## How it's put together

- `build.js` copies `index.html`, `src/`, and `public/` from the repo root into `app/`
  (regenerated from scratch every run - never edit anything under `app/` directly, edit the
  source in the repo root instead) and swaps the CDN MathJax `<script>` tag for the vendored
  copy in `vendor/mathjax/`.
- `main.js` is the Electron main process. The app needs to be served over HTTP (ES modules,
  a `Worker` built from an `import.meta.url`-relative URL, and BroadcastChannel between the
  main window and the pop-out plot window all need a real origin, not bare `file://`), so it
  starts a small static file server on `127.0.0.1` at a random free port and loads the app
  from there.
- `vendor/mathjax/tex-svg.js` is a pinned copy of MathJax's SVG combined component (from
  jsDelivr, `mathjax@3/es5/tex-svg.js`), vendored so the app works with no network connection.
  It's the SVG output component rather than a straight copy of the site's own CHTML one
  (`tex-mml-chtml.js`) because CHTML loads its glyphs from external woff font files at a path
  relative to the script - fine on the hosted site (resolved against the jsDelivr CDN), but
  those files aren't vendored here, so offline it silently fell back to a system font with
  mismatched metrics (e.g. a radical sign's bar not lining up with the sign itself). SVG draws
  every glyph as inline paths embedded in the bundle, so it needs no font files at all. Update
  it by re-downloading `https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js` when the site's
  own script tag in `../index.html` changes to point at a newer MathJax version.

`app/` and `dist/` are both generated and gitignored - only `main.js`, `build.js`,
`package.json`, and `vendor/` are checked in.
