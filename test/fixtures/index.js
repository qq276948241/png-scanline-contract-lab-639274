"use strict";

// Deterministic fixtures covering the colour types and sample layouts the
// suite needs, plus a seeded PRNG for the random small-image round-trip.

let builder = require("./png-builder");

// A tiny xorshift so random cases are reproducible from a run to run.
function prng(seed) {
  let state = seed >>> 0 || 0x9e3779b9;
  return function () {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

// Hand-computed samples: a 4x4 pattern whose expected RGBA is easy to state
// in a test and does not depend on any library logic.
function handPattern(x, y) {
  return [
    (x * 64 + 17) & 0xff,
    (y * 64 + 33) & 0xff,
    (x * y * 16 + 3) & 0xff,
    0xff,
  ];
}

let fixtures = {
  // 8-bit grayscale, every filter type used across the four rows.
  grayscale8: {
    width: 4,
    height: 4,
    depth: 8,
    colorType: 0,
    filterFor: function (y) {
      return y;
    },
    sampleAt: function (x, y) {
      return [(x * 16 + y * 64) & 0xff];
    },
  },

  // 16-bit grayscale: exercises the 16-bit sample path and the rescale to
  // 8 bits the public API performs by default.
  grayscale16: {
    width: 3,
    height: 2,
    depth: 16,
    colorType: 0,
    filterFor: function (y) {
      return (y + 2) % 5;
    },
    sampleAt: function (x, y) {
      return [(x * 4096 + y * 16384 + 1234) & 0xffff];
    },
  },

  // 8-bit indexed with a tRNS chunk so palette alpha is exercised.
  indexed8: {
    width: 5,
    height: 4,
    depth: 8,
    colorType: 3,
    palette: [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [16, 32, 48],
      [200, 100, 50],
    ],
    trns: Buffer.from([0, 64, 128, 255, 255]),
    filterFor: function (y) {
      return (y + 3) % 5;
    },
    sampleAt: function (x, y) {
      return [(x + y) % 5];
    },
  },

  // 4-bit indexed: sub-byte samples plus palette expansion.
  indexed4: {
    width: 9,
    height: 3,
    depth: 4,
    colorType: 3,
    palette: [
      [1, 2, 3],
      [10, 20, 30],
      [40, 50, 60],
      [70, 80, 90],
      [100, 110, 120],
      [130, 140, 150],
      [160, 170, 180],
      [190, 200, 210],
    ],
    filterFor: function (y) {
      return y;
    },
    sampleAt: function (x, y) {
      return [(x + y * 3) % 8];
    },
  },

  // 8-bit truecolour with alpha; all five filters appear.
  rgba8: {
    width: 6,
    height: 5,
    depth: 8,
    colorType: 6,
    filterFor: function (y) {
      return y % 5;
    },
    sampleAt: function (x, y) {
      return [
        (x * 40 + 7) & 0xff,
        (y * 50 + 11) & 0xff,
        (x * y * 9 + 23) & 0xff,
        (x * 13 + y * 29 + 3) & 0xff,
      ];
    },
  },

  // 16-bit RGBA, the only 16-bit alpha combination the format allows.
  rgba16: {
    width: 2,
    height: 2,
    depth: 16,
    colorType: 6,
    filterFor: function (y) {
      return y;
    },
    sampleAt: function (x, y) {
      return [
        (x * 1000 + 7) & 0xffff,
        (y * 2000 + 11) & 0xffff,
        (x * y * 3000 + 23) & 0xffff,
        (x * 13 + y * 29 + 65535) & 0xffff,
      ];
    },
  },

  // Adam7 interlaced 8-bit RGBA at an odd size so every pass contributes.
  rgbaInterlaced: {
    width: 13,
    height: 11,
    depth: 8,
    colorType: 6,
    interlace: true,
    sampleAt: function (x, y) {
      return [
        (x * 19 + 5) & 0xff,
        (y * 23 + 9) & 0xff,
        (x * y * 7) & 0xff,
        0x80 | ((x + y) & 0x7f),
      ];
    },
  },

  // Adam7 interlaced 16-bit grayscale: interlace and 16-bit at once.
  gray16Interlaced: {
    width: 10,
    height: 10,
    depth: 16,
    colorType: 0,
    interlace: true,
    sampleAt: function (x, y) {
      return [(x * 3000 + y * 700 + 5) & 0xffff];
    },
  },

  // Grayscale + alpha, 8-bit.
  grayAlpha8: {
    width: 4,
    height: 3,
    depth: 8,
    colorType: 4,
    sampleAt: function (x, y) {
      return [(x * 60 + y) & 0xff, (x * 15 + y * 40 + 20) & 0xff];
    },
  },
};

// Hand-computed 8-bit grayscale image. Samples are stated per pixel so the
// expected RGBA can be written out by hand in the spec.
let handComputed = {
  width: 8,
  height: 2,
  depth: 8,
  colorType: 0,
  sampleAt: function (x, y) {
    if (y === 0) {
      return [x * 32];
    }
    return [255 - x * 32];
  },
};

module.exports = {
  prng: prng,
  handPattern: handPattern,
  handComputed: handComputed,
  fixtures: fixtures,
  builder: builder,
};
