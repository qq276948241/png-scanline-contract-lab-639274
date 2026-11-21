"use strict";

// Regenerates the offline PNG fixtures in this directory from the
// specification-only builder in png-builder.js. Run with:
//
//   node test/fixtures/generate.js
//
// The generated files are committed so the tests never depend on the
// generator, zlib version or a network connection. Each fixture is
// deliberately tiny (mostly < 200 bytes).

let fs = require("fs");
let path = require("path");
let builder = require("./png-builder");
let fixtures = require("./definitions");

let outDir = __dirname;
let names = Object.keys(fixtures);

for (let i = 0; i < names.length; i++) {
  let name = names[i];
  let buffer = builder.build(fixtures[name]);
  fs.writeFileSync(path.join(outDir, name), buffer);
  process.stdout.write(name + " " + buffer.length + " bytes\n");
}

// A manifest with the non-function parameters used, so the spec can report
// what each fixture is meant to cover.
let manifest = {};
names.forEach(function (name) {
  let opts = fixtures[name];
  manifest[name] = {
    width: opts.width,
    height: opts.height,
    depth: opts.depth,
    colorType: opts.colorType,
    interlace: Boolean(opts.interlace),
    paletteEntries: opts.palette ? opts.palette.length : 0,
    hasTrns: Boolean(opts.trns),
    gamma: opts.gamma || 0,
    idatSplit: opts.idatSplit || 0,
  };
});
fs.writeFileSync(
  path.join(outDir, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n"
);
process.stdout.write("manifest.json written\n");
