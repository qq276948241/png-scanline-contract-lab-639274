"use strict";

// Generates the minimal offline PNG fixtures used by the test suite and a
// JSON manifest describing the exact expected pixels / metadata.
// Run with: node test/fixtures/generate-fixtures.js
let fs = require("fs");
let path = require("path");
let builder = require("./png-builder");

let OUT_DIR = path.join(__dirname, "files");
fs.mkdirSync(OUT_DIR, { recursive: true });

let WIDTH = 9;
let HEIGHT = 7;

function makeRGBA(w, h, fn) {
  let b = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let i = (y * w + x) * 4;
      let c = fn(x, y);
      b[i] = c[0];
      b[i + 1] = c[1];
      b[i + 2] = c[2];
      b[i + 3] = c[3];
    }
  }
  return b;
}

// Deterministic, non-uniform pixels so ordering mistakes are visible.
let rgba = makeRGBA(WIDTH, HEIGHT, (x, y) => [
  (x * 23 + y * 7) % 256,
  (y * 37 + x * 11) % 256,
  (x * y * 13 + 5) % 256,
  64 + ((x * 11 + y * 5) % 192),
]);

let palette = [
  [255, 0, 0, 255],
  [0, 255, 0, 255],
  [0, 0, 255, 128],
  [255, 255, 0, 0],
];
let indexedRGBA = makeRGBA(WIDTH, HEIGHT, (x, y) => palette[(x + y) % 4]);
let trns = Buffer.from([255, 255, 128, 0]);

let fixtures = [
  {
    name: "grayscale-8bit",
    options: { width: WIDTH, height: HEIGHT, depth: 8, colorType: 0, rgba },
    expect: { depth: 8, colorType: 0, interlace: false },
  },
  {
    name: "indexed-2bit",
    options: {
      width: WIDTH,
      height: HEIGHT,
      depth: 2,
      colorType: 3,
      rgba: indexedRGBA,
      palette,
      trns,
    },
    expect: { depth: 2, colorType: 3, interlace: false },
  },
  {
    name: "truecolor-16bit",
    options: { width: WIDTH, height: HEIGHT, depth: 16, colorType: 2, rgba },
    expect: { depth: 16, colorType: 2, interlace: false },
  },
  {
    name: "adam7-rgba",
    options: {
      width: WIDTH,
      height: HEIGHT,
      depth: 8,
      colorType: 6,
      rgba,
      interlace: true,
      filterType: (y) => y % 5,
    },
    expect: { depth: 8, colorType: 6, interlace: true },
  },
  {
    name: "gray-alpha-8bit",
    options: { width: WIDTH, height: HEIGHT, depth: 8, colorType: 4, rgba },
    expect: { depth: 8, colorType: 4, interlace: false },
  },
  {
    name: "rgba-8bit",
    options: { width: WIDTH, height: HEIGHT, depth: 8, colorType: 6, rgba },
    expect: { depth: 8, colorType: 6, interlace: false },
  },
];

let manifest = {
  width: WIDTH,
  height: HEIGHT,
  sourceRGBA: Array.from(rgba),
  indexedRGBA: Array.from(indexedRGBA),
  fixtures: [],
};

for (let fixture of fixtures) {
  let png = builder.buildPNG(fixture.options);
  let file = path.join(OUT_DIR, fixture.name + ".png");
  fs.writeFileSync(file, png);
  manifest.fixtures.push({
    name: fixture.name,
    file: fixture.name + ".png",
    bytes: png.length,
    expect: fixture.expect,
  });
}

fs.writeFileSync(
  path.join(OUT_DIR, "manifest.json"),
  JSON.stringify(manifest, null, 2)
);

console.log("wrote", fixtures.length, "fixtures to", OUT_DIR);
