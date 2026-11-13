// One-time move of browser storage from the old "jh_" key names to "ewd_".
//
// The app's saved data (bills, parties, the signed-in session, drafts, sync
// state) lives in localStorage under these keys. Renaming them without moving
// what is already stored would make every existing browser look empty and sign
// everyone out. Imported first in main.jsx so it runs before anything reads.
//
// Old keys are copied, never overwritten onto a new key that already exists,
// and removed only after the copy. Safe to run on every load.

const OLD = 'jh_';
const NEW = 'ewd_';

export function migrateStorageKeys() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(OLD)) keys.push(k);
    }
    keys.forEach((oldKey) => {
      const newKey = NEW + oldKey.slice(OLD.length);
      if (localStorage.getItem(newKey) === null) {
        localStorage.setItem(newKey, localStorage.getItem(oldKey));
      }
      localStorage.removeItem(oldKey);
    });
  } catch {
    // Storage blocked or full: the app then starts fresh, as it always would.
  }
}

migrateStorageKeys();
