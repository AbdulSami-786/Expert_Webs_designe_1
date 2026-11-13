// Does the backend (the Google Sheet's script) know a given action yet?
//
// A script left on an older version answers "Unknown action", and for some actions it is worse
// than an error: addReturn on an old script silently IGNORES the refund fields, so a return
// looks recorded with its refund when no refund exists. Screens ask first, with a call that can
// never write anything (no id is given, so a script that knows the action refuses it at once).

import { useCallback, useEffect, useState } from 'react';
import api from './api';

const PROBES = {
  addRefund: () => api.addRefund({}),
  adoptPurchases: () => api.adoptPurchases({}),
};

// 'ok' | 'old'. An outage is not remembered: it says nothing about the script.
const known = new Map();

export async function backendSupports(action) {
  if (known.has(action)) return known.get(action);
  try {
    await PROBES[action]();           // never succeeds: nothing is named to act on
    known.set(action, 'ok');
    return 'ok';
  } catch (err) {
    if (err?.outdatedBackend) { known.set(action, 'old'); return 'old'; }
    if (err?.isNetworkError) return 'offline';
    known.set(action, 'ok');          // any other refusal means the action exists
    return 'ok';
  }
}

/** { state: 'checking' | 'ok' | 'old' | 'offline', recheck } for one action; asks only while `active`. */
export function useBackendFeature(action, active = true) {
  const [state, setState] = useState(known.get(action) || 'checking');

  useEffect(() => {
    if (!active) return undefined;
    let live = true;
    backendSupports(action).then((s) => { if (live) setState(s); });
    return () => { live = false; };
  }, [action, active]);

  const recheck = useCallback(async () => {
    known.delete(action);
    setState('checking');
    setState(await backendSupports(action));
  }, [action]);

  return { state, recheck };
}
