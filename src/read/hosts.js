// One fetch for every read: it counts reads, bytes and failures per host,
// so a page can say which hosts a browser can read (a host that sends no
// CORS header fails with a bare TypeError, with no status to show). It runs
// in Node too. Icechunk takes it as its fetchClient, zarrita's FetchStore
// as its fetch, and plain JSON reads go through getJson.

// Per host: { ok, fail, bytes, ms, error }.
export const hosts = new Map();
// Every read so far, all hosts: { reads, bytes, ms } (ms summed over reads,
// so with reads in parallel it exceeds the wall time).
export const totals = { reads: 0, bytes: 0, ms: 0 };

// What a read cost, by the values it returned: { ms, reads, bytes, shared }
// and, for a COG series, open, fetch, decode and unpack ms (cog.js). When
// shared is true, reads and bytes are what every host served while it ran,
// so reads in parallel share them; a COG series counts its own exactly. A
// page reads it with readStats.get(values).
export const readStats = new WeakMap();
const hostOf = (url) => { try { return new URL(url).host; } catch (e) { return String(url); } };
function note(url, fields) {
  const h = hostOf(url), s = hosts.get(h) || { ok: 0, fail: 0, bytes: 0, ms: 0, error: "" };
  if (fields.ok) { s.ok++; s.bytes += fields.bytes || 0; s.ms = fields.ms; totals.reads++; totals.bytes += fields.bytes || 0; totals.ms += fields.ms || 0; }
  else { s.fail++; s.error = fields.error; }
  hosts.set(h, s);
}
let onFetch = null;
// Called after every read, ok or not (a page redraws its host table).
export const setFetchListener = (fn) => { onFetch = fn; };

// A relay for hosts a browser cannot read directly (no CORS header): reads
// of a listed host go to the relay instead, and are still counted under
// the host itself. template names the relay URL: "{url}" in it is the
// original URL, "{encoded}" the same URL encoded as a query value, and a
// template with neither has the original URL appended. The relay must pass
// Range headers through (COG and chunk reads are byte ranges).
let relay = { template: null, hosts: new Set() };
export function setRelay({ template = null, hosts = [] } = {}) {
  relay = { template: template || null, hosts: new Set(hosts) };
}
// url as it is fetched: through the relay when its host is listed.
export function relayed(url) {
  if (!relay.template || !relay.hosts.has(hostOf(url))) return url;
  const t = relay.template;
  if (t.includes("{url}")) return t.replace("{url}", url);
  if (t.includes("{encoded}")) return t.replace("{encoded}", encodeURIComponent(url));
  return t + url;
}

// fetch(url or Request, init), counted. A 404 counts as a read that
// worked: stores probe for files that need not exist.
export async function countedFetch(req, init) {
  const url = typeof req === "string" ? req : req.url;
  const via = relayed(url);
  if (via !== url) req = typeof req === "string" ? via : new Request(via, req);
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
