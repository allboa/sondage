// The pure core: axes and clock over array descriptions, windows, unpacking,
// caching and isolines (fourd); sections and blocks through COG sources
// (cutaway, mosaic); CRS and grid inference from store attributes (storecrs,
// structure, grids, chunkgrid); and the projection, distortion and geodesy
// helpers they use. No DOM, canvas or three.js: every module runs in Node.
//
// Each module is exported whole under its own name, since several share
// helper names (windowOf, R, describe).

export * as fourd from "./fourd.js";
export * as series from "./series.js";
export * as cutaway from "./cutaway.js";
export * as mosaic from "./mosaic.js";
export * as storecrs from "./storecrs.js";
export * as structure from "./structure.js";
export * as grids from "./grids.js";
export * as chunkgrid from "./chunkgrid.js";
export * as palette from "./palette.js";
export * as geoid from "./geoid.js";
export * as rhumb from "./rhumb.js";
export * as tissot from "./tissot.js";
export * as geo from "./geo.js";
export * as basemap from "./basemap.js";
export * as geotiffWrite from "./geotiff-write.js";
export * as spilhaus from "./families/spilhaus.js";
export * as azimuthal from "./families/azimuthal.js";
