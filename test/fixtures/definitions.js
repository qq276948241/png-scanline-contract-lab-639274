"use strict";

// Definitions for the committed offline fixtures. Kept in their own module so
// both the generator (generate.js) and the specs can rebuild the exact same
// bytes; the committed PNGs remain the thing under test.

let fixtures = {
  // 8-bit grayscale, filters 0..3, 8x2.
  "gray8.png": {
    width: 8,
    height: 2,
    depth: 8,
    colorType: 0,
    filterFor: function (y) {
      return y;
    },
    sampleAt: function (x, y) {
      return [y === 0 ? x * 32 : 255 - x * 32];
    },
  },

  // 4-bit grayscale, sub-byte samples.
  "gray4.png": {
    width: 9,
    height: 3,
    depth: 4,
    colorType: 0,
    sampleAt: function (x, y) {
      return [(x + y) % 16];
    },
  },

  // 1-bit grayscale.
  "gray1.png": {
    width: 17,
    height: 5,
    depth: 1,
    colorType: 0,
    sampleAt: function (x, y) {
      return [(x + y) & 1];
    },
  },

  // 16-bit grayscale with a non-trivial low byte.
  "gray16.png": {
    width: 4,
    height: 3,
    depth: 16,
    colorType: 0,
    filterFor: function (y) {
      return (y + 2) % 5;
    },
    sampleAt: function (x, y) {
      return [(x * 4096 + y * 16384 + 1234) & 0xffff];
    },
  },

  // Indexed colour with a tRNS chunk (palette alpha).
  "indexed8-trns.png": {
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

  // 4-bit indexed colour, no alpha.
  "indexed4.png": {
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

  // 8-bit truecolour (no alpha) with a tRNS colour key.
  "rgb8-trns.png": {
    width: 4,
    height: 3,
    depth: 8,
    colorType: 2,
    trns: Buffer.from([0, 16, 0, 32, 0, 48]),
    filterFor: function (y) {
      return y % 5;
    },
    sampleAt: function (x, y) {
      return [x * 16, y * 32, (x + y) * 16];
    },
  },

  // 16-bit truecolour.
  "rgb16.png": {
    width: 3,
    height: 2,
    depth: 16,
    colorType: 2,
    sampleAt: function (x, y) {
      return [x * 8000 + 3, y * 9000 + 7, (x + y) * 7000 + 11];
    },
  },

  // 8-bit grayscale + alpha.
  "gray-alpha8.png": {
    width: 4,
    height: 3,
    depth: 8,
    colorType: 4,
    sampleAt: function (x, y) {
      return [(x * 60 + y) & 0xff, (x * 15 + y * 40 + 20) & 0xff];
    },
  },

  // 8-bit RGBA, every filter type across the rows.
  "rgba8-filters.png": {
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

  // 16-bit RGBA.
  "rgba16.png": {
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

  // Adam7 interlaced 8-bit RGBA at an odd size (every pass is non-empty).
  "rgba8-interlaced.png": {
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

  // Adam7 interlaced 16-bit grayscale.
  "gray16-interlaced.png": {
    width: 10,
    height: 10,
    depth: 16,
    colorType: 0,
    interlace: true,
    sampleAt: function (x, y) {
      return [(x * 3000 + y * 700 + 5) & 0xffff];
    },
  },

  // Adam7 interlaced 1-bit palette image: interlace + sub-byte + palette.
  "indexed1-interlaced.png": {
    width: 11,
    height: 9,
    depth: 1,
    colorType: 3,
    interlace: true,
    palette: [
      [10, 20, 30],
      [200, 210, 220],
    ],
    sampleAt: function (x, y) {
      return [(x + y) & 1];
    },
  },

  // IDAT split across several chunks.
  "rgba8-split-idat.png": {
    width: 7,
    height: 7,
    depth: 8,
    colorType: 6,
    idatSplit: 7,
    sampleAt: function (x, y) {
      return [(x * 31) & 0xff, (y * 37) & 0xff, (x * y) & 0xff, 255];
    },
  },

  // Grayscale with a tRNS colour key.
  "gray8-trns.png": {
    width: 4,
    height: 2,
    depth: 8,
    colorType: 0,
    trns: Buffer.from([0, 128]),
    sampleAt: function (x, y) {
      return [(x + y) * 64];
    },
  },

  // 8-bit grayscale carrying a gAMA chunk (exercises the gamma event).
  "gray8-gamma.png": {
    width: 4,
    height: 2,
    depth: 8,
    colorType: 0,
    gamma: 45455,
    sampleAt: function (x, y) {
      return [(x * 32 + y * 16) & 0xff];
    },
  },
};

module.exports = fixtures;
