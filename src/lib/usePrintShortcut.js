// Ctrl+P (Cmd+P on a Mac) prints the page's own report or bill, the same as its Print / PDF button,
// instead of the browser printing the whole screen with its menus.
//
// Each page that has a print button calls this once with that button's handler. Pages without one
// do nothing here, so Ctrl+P keeps its normal behaviour on them.

import { useEffect, useRef } from 'react';

export function usePrintShortcut(print) {
  const latest = useRef(print);
  latest.current = print;

  useEffect(() => {
    const onKey = (e) => {
      // e.code is the physical key: e.key can differ on other keyboard layouts.
      if (e.code !== 'KeyP' || !(e.ctrlKey || e.metaKey)) return;
      if (e.shiftKey || e.altKey || e.repeat) return;
      e.preventDefault();
      latest.current?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
