// One fetch for every read: it counts reads, bytes and failures per host,
// so a page can say which hosts a browser can read (a host that sends no
// CORS header fails with a bare TypeError, with no status to show). It runs
// in Node too. Icechunk takes it as its fetchClient, zarrita's FetchStore
// as its fetch, and plain JSON reads go through getJson.

// Per host: { ok, fail, bytes, ms, error }.
export const hosts = new Map();
const hostOf = (url) => { try { return new URL(url).host; } catch (e) { return String(url); } };
function note(url, fields) {
  const h = hostOf(url), s = hosts.get(h) || { ok: 0, fail: 0, bytes: 0, ms: 0, error: "" };
  if (fields.ok) { s.ok++; s.bytes += fields.bytes || 0; s.ms = fields.ms; } else { s.fail++; s.error = fields.error; }
  hosts.set(h, s);
}
let onFetch = null;
// Called after every read, ok or not (a page redraws its host table).
export const setFetchListener = (fn) => { onFetch = fn; };

// fetch(url or Request, init), counted. A 404 counts as a read that
// worked: stores probe for files that need not exist.
export async function countedFetch(req, init) {
  const url = typeof req === "string" ? req : req.url;
  const t0 = Date.now();
  try {
    const r = await globalThis.fetch(req, init);
    if (!r.ok && r.status !== 206 && r.status !== 404) note(url, { ok: false, error: `HTTP ${r.status}` });
    else note(url, { ok: true, bytes: +(r.headers.get("content-length") || 0), ms: Date.now() - t0 });
    if (onFetch) onFetch();
    return r;
  } catch (e) {
    note(url, { ok: false, error: "no response (blocked, unreachable, or no CORS header)" });
    if (onFetch) onFetch();
    throw e;
  }
}

// The form icechunk-js takes.
export const fetchClient = { fetch: countedFetch };

// JSON at url, read once per url; rejects on a failed read.
const metaCache = new Map();
export function getJson(url) {
  if (!metaCache.has(url)) {
    metaCache.set(url, (async () => {
      const r = await countedFetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
      return r.json();
    })());
    metaCache.get(url).catch(() => metaCache.delete(url));
  }
  return metaCache.get(url);
}

// JSON at url, or null when it is missing, unreadable or not JSON (for
// probing what a store holds).
export async function maybeJson(url) {
  let r;
  try { r = await countedFetch(url); } catch (e) { return null; }
  if (!r.ok) return null;
  try { return await r.json(); } catch (e) { return null; }
}
