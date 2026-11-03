// Reading: Sources over Icechunk, Zarr, COG series and synthetic data, the registry,
// the shared window cache, and the per-host read ledger. Runs in a browser
// or in Node; nothing here touches the DOM or three.js.

export { openSource, openDataset, openUrl, openRegistry, describeStore, makeReader } from "./source.js";
export { openCogSeries, openCogFile, openCog, chooseLevel, levelAxes, fileAxes, itemFiles, setGeoTIFF } from "./cog.js";
export { hosts, setFetchListener, countedFetch, setRelay, relayed, fetchClient, getJson, maybeJson } from "./hosts.js";
export { openStore, openFiles, describeVariable, dataArrays, readChunk, readSlice, httpUrl, looksIcechunk, ASSUME } from "./store.js";
