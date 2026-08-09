import React from 'react';
import { createRoot } from 'react-dom/client';

import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import 'uplot/dist/uPlot.min.css';
import './styles/tokens.css';
import './styles/app.css';

import App from './App.jsx';
import { initApi } from './lib/api.js';
import { registerGsap } from './motion/gsap.js';

registerGsap();
initApi();

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
