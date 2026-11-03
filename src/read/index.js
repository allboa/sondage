// Reading: Sources over Icechunk, Zarr and synthetic data, the registry,
// the shared window cache, and the per-host read ledger. Runs in a browser
// or in Node; nothing here touches the DOM or three.js.

export { openSource, openDataset, openUrl, openRegistry, describeStore, makeReader } from "./source.js";
export { hosts, setFetchListener, countedFetch, fetchClient, getJson, maybeJson } from "./hosts.js";
export { openStore, openFiles, describeVariable, dataArrays, readChunk, readSlice, httpUrl, looksIcechunk, ASSUME } from "./store.js";
