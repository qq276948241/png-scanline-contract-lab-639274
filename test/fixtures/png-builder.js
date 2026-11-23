"use strict";

// Minimal, self-contained PNG fixture builder used ONLY by the test suite.
// It deliberately does not require anything from lib/, so fixtures stay
// independent of the code under test.
let zlib = require("zlib");

let SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let crcTable = (function () {
  let table = [];
  for (let i = 0; i < 256; i++) {
    let current = i;
    for (let j = 0; j < 8; j++) {
      current = current & 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
    }
    table[i] = current >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  let typeBuf = Buffer.from(type, "ascii");
  let len = data ? data.length : 0;
  let out = Buffer.alloc(len + 12);
  out.writeUInt32BE(len, 0);
  typeBuf.copy(out, 4);
  if (data) {
    data.copy(out, 8);
  }
  out.writeUInt32BE(
    crc32(Buffer.concat([typeBuf, data || Buffer.alloc(0)])),
    len + 8
  );
  return out;
}

function u32(value) {
  let b = Buffer.alloc(4);
  b.writeUInt32BE(value >>> 0, 0);
  return b;
}

let ADAM7_PATTERN = [
  { x: [0], y: [0] },
  { x: [4], y: [0] },
  { x: [0, 4], y: [4] },
  { x: [2, 6], y: [0, 4] },
  { x: [0, 2, 4, 6], y: [2, 6] },
  { x: [1, 3, 5, 7], y: [0, 2, 4, 6] },
  { x: [0, 1, 2, 3, 4, 5, 6, 7], y: [1, 3, 5, 7] },
];

function getPasses(width, height) {
  let passes = [];
  for (let p = 0; p < ADAM7_PATTERN.length; p++) {
    let pattern = ADAM7_PATTERN[p];
    let xs = [];
    let ys = [];
    for (let base = 0; base < width; base += 8) {
      for (let j = 0; j < pattern.x.length; j++) {
        if (base + pattern.x[j] < width) {
          xs.push(base + pattern.x[j]);
        }
      }
    }
    for (let base = 0; base < height; base += 8) {
      for (let j = 0; j < pattern.y.length; j++) {
        if (base + pattern.y[j] < height) {
          ys.push(base + pattern.y[j]);
        }
      }
    }
    if (xs.length && ys.length) {
      passes.push({ xs: xs, ys: ys });
    }
  }
  return passes;
}

// Convert an RGBA byte array (4 bytes per pixel, values 0..255) into packed
// scan-line bytes for the requested color type / depth.
function channelCount(colorType) {
  switch (colorType) {
    case 0:
    case 3:
      return 1;
    case 4:
      return 2;
    case 2:
      return 3;
    case 6:
      return 4;
    default:
      throw new Error("unsupported color type " + colorType);
  }
}

function makeSampler(rgba, width, colorType, palette) {
  return function sample(x, y, channel) {
    let px = (y * width + x) * 4;
    if (colorType === 0 || colorType === 4) {
      // grayscale: average RGB
      let gray = Math.round((rgba[px] + rgba[px + 1] + rgba[px + 2]) / 3);
      return channel === 0 ? gray : rgba[px + 3];
    }
    if (colorType === 3) {
      return findPaletteIndex(rgba, px, palette);
    }
    return rgba[px + channel];
  };
}

// Pack one ordered list of pixels (each pixel is an array of channel values)
// into a single scan line.
function packLine(pixels, channels, depth) {
  let lineBytes = [];
  let bitBuffer = [];
  function flushBits() {
    while (bitBuffer.length % 8 !== 0) {
      bitBuffer.push(0);
    }
    while (bitBuffer.length) {
      let byte = 0;
      for (let i = 0; i < 8; i++) {
        byte = (byte << 1) | (bitBuffer.shift() || 0);
      }
      lineBytes.push(byte);
    }
  }
  for (let p = 0; p < pixels.length; p++) {
    for (let c = 0; c < channels; c++) {
      let value = pixels[p][c];
      if (depth === 16) {
        // 8-bit source values are scaled to 16 bit the same way the
        // library's format-normaliser reverses them (value * 257).
        value = value * 257;
        lineBytes.push((value >> 8) & 0xff, value & 0xff);
      } else if (depth === 8) {
        lineBytes.push(value & 0xff);
      } else {
        for (let bit = depth - 1; bit >= 0; bit--) {
          bitBuffer.push((value >> bit) & 1);
        }
      }
    }
  }
  if (depth < 8) {
    flushBits();
  }
  return Buffer.from(lineBytes);
}

function packPixels(rgba, width, height, colorType, depth, palette) {
  let channels = channelCount(colorType);
  let sample = makeSampler(rgba, width, colorType, palette);
  let lines = [];
  for (let y = 0; y < height; y++) {
    let pixels = [];
    for (let x = 0; x < width; x++) {
      let pixel = [];
      for (let c = 0; c < channels; c++) {
        pixel.push(sample(x, y, c));
      }
      pixels.push(pixel);
    }
    lines.push(packLine(pixels, channels, depth));
  }
  return lines;
}

function findPaletteIndex(rgba, px, palette) {
  for (let i = 0; i < palette.length; i++) {
    if (
      palette[i][0] === rgba[px] &&
      palette[i][1] === rgba[px + 1] &&
      palette[i][2] === rgba[px + 2]
    ) {
      return i;
    }
  }
  throw new Error("pixel has no matching palette entry");
}

function getBytesPerPixel(colorType, depth) {
  let channels;
  if (colorType === 0 || colorType === 3) {
    channels = 1;
  } else if (colorType === 4) {
    channels = 2;
  } else if (colorType === 2) {
    channels = 3;
  } else {
    channels = 4;
  }
  // For sub-byte depths the PNG spec sets the predictor stride to one byte.
  return depth < 8 ? 1 : (channels * depth) / 8;
}

function applyFilter(rawLines, filterType, bpp) {
  let out = [];
  for (let y = 0; y < rawLines.length; y++) {
    let line = rawLines[y];
    let prev = rawLines[y - 1];
    let type = typeof filterType === "function" ? filterType(y) : filterType;
    let filtered = Buffer.alloc(line.length + 1);
    filtered[0] = type;
    for (let x = 0; x < line.length; x++) {
      let raw = line[x];
      let left = x >= bpp ? line[x - bpp] : 0;
      let up = prev ? prev[x] : 0;
      let upLeft = prev && x >= bpp ? prev[x - bpp] : 0;
      let value;
      switch (type) {
        case 0:
          value = raw;
          break;
        case 1:
          value = raw - left;
          break;
        case 2:
          value = raw - up;
          break;
        case 3:
          value = raw - ((left + up) >> 1);
          break;
        case 4:
          value = raw - paeth(left, up, upLeft);
          break;
        default:
          throw new Error("bad filter type " + type);
      }
      filtered[1 + x] = value & 0xff;
    }
    out.push(filtered);
  }
  return Buffer.concat(out);
}

function paeth(left, up, upLeft) {
  let p = left + up - upLeft;
  let pa = Math.abs(p - left);
  let pb = Math.abs(p - up);
  let pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) {
    return left;
  }
  if (pb <= pc) {
    return up;
  }
  return upLeft;
}

// options:
// width, height, depth, colorType, interlace, rgba (Buffer), palette
// (array of [r,g,b,a]), trns (Buffer), filterType (number or fn(y)),
// deflateLevel
function buildPNG(options) {
  let width = options.width;
  let height = options.height;
  let depth = options.depth;
  let colorType = options.colorType;
  let interlace = options.interlace ? 1 : 0;
  let palette = options.palette || [];
  let rgba = options.rgba;
  let filterType = options.filterType == null ? 0 : options.filterType;

  let chunks = [SIGNATURE];

  let ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = interlace;
  chunks.push(chunk("IHDR", ihdr));

  if (options.gamma) {
    chunks.push(chunk("gAMA", u32(Math.round(options.gamma * 100000))));
  }

  if (palette.length) {
    let plte = Buffer.alloc(palette.length * 3);
    for (let i = 0; i < palette.length; i++) {
      plte[i * 3] = palette[i][0];
      plte[i * 3 + 1] = palette[i][1];
      plte[i * 3 + 2] = palette[i][2];
    }
    chunks.push(chunk("PLTE", plte));
  }

  if (options.trns) {
    chunks.push(chunk("tRNS", options.trns));
  }

  let channels = channelCount(colorType);
  let sample = makeSampler(rgba, width, colorType, palette);
  let rawLines = packPixels(rgba, width, height, colorType, depth, palette);
  let bpp = getBytesPerPixel(colorType, depth);
  let imageData;
  if (interlace) {
    let passes = getPasses(width, height);
    let passBuffers = [];
    for (let p = 0; p < passes.length; p++) {
      let pass = passes[p];
      let passLines = [];
      for (let yIndex = 0; yIndex < pass.ys.length; yIndex++) {
        let y = pass.ys[yIndex];
        let pixels = [];
        for (let xIndex = 0; xIndex < pass.xs.length; xIndex++) {
          let x = pass.xs[xIndex];
          let pixel = [];
          for (let c = 0; c < channels; c++) {
            pixel.push(sample(x, y, c));
          }
          pixels.push(pixel);
        }
        passLines.push(packLine(pixels, channels, depth));
      }
      passBuffers.push(applyFilter(passLines, filterType, bpp));
    }
    imageData = Buffer.concat(passBuffers);
  } else {
    imageData = applyFilter(rawLines, filterType, bpp);
  }

  let deflated = zlib.deflateSync(imageData, {
    level: options.deflateLevel == null ? 9 : options.deflateLevel,
  });
  chunks.push(chunk("IDAT", deflated));
  chunks.push(chunk("IEND"));

  return Buffer.concat(chunks);
}

module.exports = {
  SIGNATURE: SIGNATURE,
  chunk: chunk,
  crc32: crc32,
  buildPNG: buildPNG,
  getPasses: getPasses,
};
