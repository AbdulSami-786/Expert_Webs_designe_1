// Talks to the license server (license-server/Code.gs). Same request style the main dashboard uses
// for Apps Script: POST with text/plain so the browser sends no CORS preflight.
//
// The server URL comes from config.js. There is no password or sign-in: the admin dashboard connects straight away.

import { LICENSE_URL } from '../config';

export async function call(action, payload = {}) {
  if (!LICENSE_URL) throw new Error('Set LICENSE_URL in src/config.js.');

  let res;
  try {
    res = await fetch(LICENSE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, payload }),
      redirect: 'follow',
    });
  } catch {
    throw new Error('Could not reach the license server. Check your internet and the URL.');
  }

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`The license server returned an error page (HTTP ${res.status}). Check the deployment: Execute as "Me", access "Anyone".`);
  }
  if (!json.ok) throw new Error(json.error || 'Request failed');
  return json.data;
}
