import { mountApp } from './app.js';
import { mountPlotStandalone } from './plotStandalone.js';
import { mountPlot3dStandalone } from './plot3dStandalone.js';

const params = new URLSearchParams(window.location.search);
const popout = params.get('session') ? params.get('popout') : null;

const root = document.getElementById('root');

if (popout === 'plot') {
  mountPlotStandalone(root, { sessionId: params.get('session'), mode: params.get('mode') });
} else if (popout === 'plot3d') {
  mountPlot3dStandalone(root, { sessionId: params.get('session'), mode: params.get('mode') });
} else {
  mountApp(root);
}
