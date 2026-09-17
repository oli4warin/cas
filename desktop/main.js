// The app (see ../src/lib/giac.js and README.md) needs to be served over HTTP: it uses
// `<script type="module">`, `import.meta.url`-relative Worker URLs, and a classic Worker
// loaded via importScripts - none of which reliably work over a bare file:// origin. So
// rather than loading app/index.html directly, this spins up a tiny static file server on
// 127.0.0.1 (loopback only, random free port) and points the window at that - identical to
// `npx serve .` in spirit, just built in so the packaged app needs no separate process.

const { app, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, 'app');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const filePath = path.join(APP_DIR, urlPath === '/' ? 'index.html' : urlPath);

      // Keep requests confined to app/ (defense in depth - this server only ever hears from
      // the app's own same-origin requests, but a stray '../' should still go nowhere).
      if (!filePath.startsWith(APP_DIR + path.sep) && filePath !== APP_DIR) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
          'Content-Length': stats.size,
        });
        fs.createReadStream(filePath).pipe(res);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

let server;

async function createWindow() {
  if (!server) server = await startServer();
  const { port } = server.address();

  const win = new BrowserWindow({
    width: 1200,
    height: 850,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // The plot panel's "pop out" button (see ../src/plotStandalone.js) opens a second window
  // via window.open() at the same origin and talks to it over BroadcastChannel - letting
  // Electron's default handling create that window (rather than denying it) is what makes
  // that feature work here too.
  win.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: {
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    },
  }));

  win.loadURL(`http://127.0.0.1:${port}/index.html`);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('will-quit', () => {
  if (server) server.close();
});
