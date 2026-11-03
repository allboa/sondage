# Agent brief for sondage

sondage is part of the [allboa](https://github.com/allboa) org. Read the
org's brief first:
[allboa/design `AGENTS.md`](https://github.com/allboa/design/blob/main/AGENTS.md).
Its principles hold here (ASCII only in sources and shipped files, polar
first, primitives first) and its decision records in
[allboa/design `decisions/`](https://github.com/allboa/design/tree/main/decisions)
apply. Cross-reference allboa repos directly (allboa/design,
allboa/scenespec) rather than restating them.

What is particular to this repo:

- `src/core/` stays pure: no DOM, canvas or three.js.
  `test/check-pure.mjs` enforces it.
- `npm test` runs every check and must pass before a push.
- Pages (`fourd.html`, `cutaway.html`, `examples/`) are checked in a
  headless browser with no console errors; say in the PR what could not be
  reached from the sandbox (COG hosts, CDNs).
- A change to the Source description's shape goes through allboa's
  shared axis description record in allboa/design, since scenespec and
  other producers line up against it.
