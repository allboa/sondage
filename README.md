# sondage

Time and depth over cloud arrays. Datasets in Icechunk, Zarr and Cloud
Optimized GeoTIFF are read by byte ranges in the browser or in Node, set on
one clock, and drawn as surfaces, ocean shells, box walls and sections, or
cut as a section and block diagram, in any CRS proj4js knows: on a globe, or
unfolded onto an azimuthal equidistant or Spilhaus map.

Working name. Extracted from hypertidy/playproj with its history (the 4D and
cutaway pages, their readers and the core they stand on); playproj keeps the
explainer pages and imports this package.

## Layout

| Path | What |
| --- | --- |
| `src/core/` | Pure modules (no DOM, canvas or three.js; checked by `test/check-pure.mjs`): axes, clock, windows, unpacking, cache and isolines (`fourd.js`); sections and blocks (`cutaway.js`, `mosaic.js`); CRS and grid inference (`storecrs.js`, `structure.js`, `grids.js`, `chunkgrid.js`); palettes, geoid, projection helpers |
| `src/scene/` | three.js stage, URL hash state, share and embed links |
| `src/read/` | Sources: one interface over Icechunk, Zarr and synthetic data (`source.js`); stores described by their own metadata (`store.js`); the per-host read ledger (`hosts.js`) |
| `fourd.html`, `cutaway.html` | The two viewers |
| `data/fourd/stores.json` | Example registry |

## A Source

Every dataset, however it is found, opens as the same thing: a description
(dims with roles t, z, y, x; coordinates; time as dates; depth with its
direction; units, scale, offset, fill) and a read by index windows that
returns physical values, rows by columns.

```js
import { openRegistry, openUrl } from "sondage/read";

// a registry entry: axes from its flat/arrays.json, chunks from Icechunk
const reg = await openRegistry("data/fourd/stores.json");
const sst = await reg.open("oisst-sst");

// or any public Zarr or Icechunk store, described from its own metadata
const t2m = await openUrl("https://example.org/era5.zarr", "2m_temperature");

const w = sst.window({ lon: [100, 180], lat: [-70, -30] });
const v = await sst.get({ t: sst.timeAt("2024-03-01").index, ...w });
```

A registry entry may name a `url` (and `var`) instead of a `path`, and is
then described from the store's own metadata; a projected CRS found there
is used as the entry's `crs`.

## Run

```sh
npm install
npm test
npm run serve   # then open http://localhost:8000/fourd.html
```

## Next

Move the frame, layer and picking code out of the page files into
`src/scene`, then publish to npm and switch playproj to import it. The 4D
page's store explorer link points at `store.html`, which stays in playproj.
