#!/usr/bin/env node
// Syncs the standalone Electron app's `app/` directory from the web app's source (the repo
// root, one level up) - `app/` itself is generated (gitignored) and rebuilt from scratch
// every run, so this is the only place that copy is produced.
//
// The one thing the source doesn't have is an offline copy of MathJax: index.html pulls it
// from a CDN (fine for the hosted site, useless without a network connection), so this also
// swaps that <script> tag for the vendored copy in vendor/mathjax/ and copies that alongside.
//
// The vendored copy is the SVG combined component (tex-svg.js), not a straight copy of the
// site's own CHTML one (tex-mml-chtml.js): CHTML renders by loading external woff font files
// from a path relative to the script, which resolved to nothing once the script was served
// from vendor/mathjax/ with no matching fonts directory alongside it - the browser fell back
// to a system font for glyphs like the radical sign, whose metrics don't line up with the
// vinculum MathJax draws next to it, breaking rendering. tex-svg.js draws every glyph as
// inline SVG paths embedded in the bundle itself, so it needs no font files at all.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const APP_DIR = path.join(__dirname, 'app');
const VENDOR_MATHJAX = path.join(__dirname, 'vendor', 'mathjax', 'tex-svg.js');

const CDN_SCRIPT_RE = /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/mathjax@3\/es5\/tex-mml-chtml\.js" async><\/script>/;
const LOCAL_SCRIPT_TAG = '<script src="./vendor/mathjax/tex-svg.js" async></script>';

function main() {
  fs.rmSync(APP_DIR, { recursive: true, force: true });
  fs.mkdirSync(APP_DIR, { recursive: true });

  for (const name of ['index.html', 'src', 'public']) {
    fs.cpSync(path.join(REPO_ROOT, name), path.join(APP_DIR, name), { recursive: true });
  }

  const indexPath = path.join(APP_DIR, 'index.html');
  const html = fs.readFileSync(indexPath, 'utf8');
  if (!CDN_SCRIPT_RE.test(html)) {
    throw new Error(
      "index.html's MathJax <script> tag doesn't match what build.js expects - " +
        'it likely changed upstream. Update CDN_SCRIPT_RE in desktop/build.js to match.',
    );
  }
  fs.writeFileSync(indexPath, html.replace(CDN_SCRIPT_RE, LOCAL_SCRIPT_TAG));

  fs.mkdirSync(path.join(APP_DIR, 'vendor', 'mathjax'), { recursive: true });
  fs.cpSync(VENDOR_MATHJAX, path.join(APP_DIR, 'vendor', 'mathjax', 'tex-svg.js'));

  console.log(`Synced app/ from ${REPO_ROOT} (MathJax pinned to vendor/mathjax/tex-svg.js).`);
}

main();
