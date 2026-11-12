// Downloads the web fonts a documentation theme uses, the first time they're
// needed, and keeps them on this device. Every file is checked against the
// SHA-256 in the catalogue (src/js/docgen/fonts.js); anything that doesn't
// match is thrown away, and that family falls back to its system stack.

import { fontFiles, fontLicenses } from '../docgen/theme.js';
import { WEB_FONTS } from '../docgen/fonts.js';

const DB = 'dispatch-fonts';
const STORE = 'files';
let dbPromise = null;

function open() {
  if (!globalThis.indexedDB) return Promise.resolve(null);
  dbPromise = dbPromise || new Promise((resolve) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return dbPromise;
}

async function cached(key) {
  const db = await open();
  if (!db) return null;
  return new Promise((resolve) => {
    const req = db.transaction(STORE).objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => resolve(null);
  });
}

async function keep(key, value) {
  const db = await open();
  if (!db) return;
  await new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** One file, from the cache or the network, only if its SHA-256 matches. Resolves to its bytes. */
async function fetchChecked({ url, sha256, size }) {
  const hit = await cached(sha256);
  if (hit) return hit;
  const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length !== size || hex(await crypto.subtle.digest('SHA-256', bytes)) !== sha256) throw new Error('the download didn\'t match its checksum');
  await keep(sha256, bytes);
  return bytes;
}

/**
 * Everything a theme's web fonts need for buildSite: { data: { "id:weight": base64 },
 * licenses: { id: text } }, plus `missing`: [{ name, reason }] for families that
 * couldn't be downloaded, which fall back to their system stack.
 */
export async function loadFonts(theme) {
  const data = {};
  const licenses = {};
  const missing = new Map();
  await Promise.all(fontFiles(theme).map(async (f) => {
    try { data[`${f.id}:${f.weight}`] = toBase64(await fetchChecked(f)); } catch (e) { missing.set(f.id, String(e.message || e)); }
  }));
  await Promise.all(fontLicenses(theme).map(async (f) => {
    try { licenses[f.id] = new TextDecoder().decode(await fetchChecked(f)); } catch { /* the build writes the licence's name and link instead */ }
  }));
  // A family is only published whole, so a partial download doesn't mix real and fallback weights.
  for (const id of missing.keys()) for (const k of Object.keys(data)) if (k.startsWith(`${id}:`)) delete data[k];
  return { data, licenses, missing: [...missing].map(([id, reason]) => ({ name: WEB_FONTS[id].name, reason })) };
}
