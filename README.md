# sondage

Time and depth over cloud arrays. Datasets in Icechunk, Zarr and Cloud
Optimized GeoTIFF are read by byte ranges in the browser or in Node, set on
one clock, and drawn as surfaces, ocean shells, box walls and sections, or
cut as a section and block diagram, in any CRS proj4js knows: on a globe, or
unfolded onto an azimuthal equidistant or Spilhaus map.

Part of [allboa](https://github.com/allboa): the org's design record and
agent brief are in [allboa/design](https://github.com/allboa/design) (start
with its [`AGENTS.md`](https://github.com/allboa/design/blob/main/AGENTS.md)),
and the scene spec is [allboa/scenespec](https://github.com/allboa/scenespec).
Extracted from hypertidy/playproj with its history (the 4D and cutaway pages,
their readers and the core they stand on); playproj keeps the explainer pages
and imports this package.

## Layout

| Path | What |
| --- | --- |
| `src/core/` | Pure modules (no DOM, canvas or three.js; checked by `test/check-pure.mjs`): axes, clock, windows, unpacking, cache and isolines (`fourd.js`); sections and blocks (`cutaway.js`, `mosaic.js`); CRS and grid inference (`storecrs.js`, `structure.js`, `grids.js`, `chunkgrid.js`); palettes, geoid, projection helpers |
| `src/scene/` | three.js: the frame every layer is placed in (globe, azimuthal equidistant or Spilhaus map, unfold between them, range, cuts, picking back to the Earth; `frame.js`), the layers (a surface over a whole grid; an ocean box as shell, walls, sections and rim; contour lines through the same cells; `layers.js`), the cutaway's section bands and block diagram (`block.js`), textures painted through palettes (`paint.js`), stage, URL hash state, share and embed links |
| `src/read/` | Sources: one interface over Icechunk, Zarr and synthetic data (`source.js`); stores described by their own metadata (`store.js`); the per-host read ledger (`hosts.js`) |
| `fourd.html`, `cutaway.html` | The two viewers |
| `data/fourd/stores.json` | Example registry |
| `examples/block.html` | A block diagram from made-up layers, with no data: `drawBlock()` on its own |

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

## Within allboa

- **The shared axis description.** A Source's description (above) is where
  allboa's design record for a shared description of a grid's axes starts:
  the record lines up ndr, mdim-refs (the `flat/arrays.json` this package
  reads) and wxy-domain against it, field by field. Changes to the
  description's shape go through that record in
  [allboa/design](https://github.com/allboa/design/tree/main/decisions).
- **Time.** scenespec takes a time axis with the browser-resolved layer
  ([decision 0011](https://github.com/allboa/design/blob/main/decisions/0011-input-surface-and-currencies.md),
  from [0010](https://github.com/allboa/design/blob/main/decisions/0010-input-layer-stance.md)
  item 3). The Source's clock (dates on `t`, `timeAt()`) is the working
  model for it.
- **Reprojection.** Every vertex here goes through proj4js, densified on
  the way (grids are meshed, lines are stepped), and drawn in the view's
  frame. allboa's gate probe found densified proj4js within 1 px of PROJ,
  which is the footing for drawing this way; the renderer contract is
  [decision 0012](https://github.com/allboa/design/blob/main/decisions/0012-renderer-reprojection.md).
- **Views.** scenespec's views (projected, cartesian, globe) and this
  package's frame (globe, azimuthal equidistant, Spilhaus, with unfold and
  depth) are to meet in the spec; mesh layers (scenespec 0.7) are the
  nearest shared ground.

## Run

```sh
npm install
npm test
npm run serve   # then open http://localhost:8000/fourd.html
```

## Next

Publish to npm and switch playproj to import the package. The 4D page's
store explorer link points at `store.html`, which stays in playproj.
