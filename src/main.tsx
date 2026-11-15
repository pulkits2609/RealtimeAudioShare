import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './components.css';
import { installDesktopBridge } from './desktop';

// The browser keeps its own media APIs. Install native IPC before device effects.
void installDesktopBridge().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode><App /></StrictMode>,
  );
}).catch(() => {
  const root = document.getElementById('root')!;
  root.textContent = 'AudioShare could not initialize its desktop bridge. Close and reopen the app.';
  root.setAttribute('role', 'alert');
});
