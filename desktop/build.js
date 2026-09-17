#!/usr/bin/env node
// Syncs the standalone Electron app's `app/` directory from the web app's source (the repo
// root, one level up) - `app/` itself is generated (gitignored) and rebuilt from scratch
// every run, so this is the only place that copy is produced.
//
// The one thing the source doesn't have is an offline copy of MathJax: index.html pulls it
// from a CDN (fine for the hosted site, useless without a network connection), so this also
// swaps that <script> tag for the vendored copy in vendor/mathjax/ and copies that alongside.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const APP_DIR = path.join(__dirname, 'app');
const VENDOR_MATHJAX = path.join(__dirname, 'vendor', 'mathjax', 'tex-mml-chtml.js');

const CDN_SCRIPT_RE = /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/mathjax@3\/es5\/tex-mml-chtml\.js" async><\/script>/;
const LOCAL_SCRIPT_TAG = '<script src="./vendor/mathjax/tex-mml-chtml.js" async></script>';

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
  fs.cpSync(VENDOR_MATHJAX, path.join(APP_DIR, 'vendor', 'mathjax', 'tex-mml-chtml.js'));

  console.log(`Synced app/ from ${REPO_ROOT} (MathJax pinned to vendor/mathjax/tex-mml-chtml.js).`);
}

main();
