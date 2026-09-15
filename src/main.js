import { mountApp } from './app.js';
import { mountPlotStandalone } from './plotStandalone.js';

const params = new URLSearchParams(window.location.search);
const isPlotPopout = params.get('popout') === 'plot' && params.get('session');

const root = document.getElementById('root');

if (isPlotPopout) {
  mountPlotStandalone(root, { sessionId: params.get('session'), mode: params.get('mode') });
} else {
  mountApp(root);
}
