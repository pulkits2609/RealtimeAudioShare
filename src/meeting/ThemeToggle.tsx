import { useEffect, useState } from 'react';

export function ThemeToggle() {
  const [dark, setDark] = useState(() => {
    try { const saved = localStorage.getItem('audioshare.theme'); if (saved === 'dark' || saved === 'light') return saved === 'dark'; } catch { /* Preferences are optional. */ }
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  });
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    try { localStorage.setItem('audioshare.theme', dark ? 'dark' : 'light'); } catch { /* Private mode may deny persistence. */ }
  }, [dark]);
  return <button className="theme-toggle" type="button" role="switch" aria-label="Dark mode" aria-checked={dark} onClick={() => setDark(value => !value)}><span aria-hidden="true">{dark ? '☀' : '☾'}</span>{dark ? 'Light mode' : 'Dark mode'}</button>;
}
