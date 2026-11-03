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
| `js/fourd-read.js` | Registry entries opened from their `flat/arrays.json` description and Icechunk store, with a per-host read ledger |
| `js/store-read.js` | Any Zarr or Icechunk store opened by probing its own metadata |
| `fourd.html`, `cutaway.html` | The two viewers |
| `data/fourd/stores.json` | Example registry |

## Run

```sh
npm install
npm test
npm run serve   # then open http://localhost:8000/fourd.html
```

## Next

See the plan: merge the two readers into one Source interface, move the
frame, layer and picking code out of the page files into `src/scene`, then
publish to npm and switch playproj to import it.
