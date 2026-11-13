import './lib/migrate';   // must run first: moves old "jh_" storage keys to "ewd_"
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/global.css';
import './styles/desktop.css';
import './styles/mobile-billing.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
