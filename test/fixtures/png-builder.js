"use strict";

// Small, self-contained PNG writer used only by the tests. It is deliberately
// independent of pngjs' own encoder so fixtures exercise the decoder against
// bytes built from the specification rather than from the code under test.

let zlib = require("zlib");
let crc = require("../../lib/crc");
let interlace = require("../../lib/interlace");

let SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  let payload = data || Buffer.alloc(0);
  let out = Buffer.alloc(payload.length + 12);
  out.writeUInt32BE(payload.length, 0);
  out.write(type, 4, "latin1");
  payload.copy(out, 8);
  out.writeInt32BE(crc.crc32(out.slice(4, out.length - 4)), out.length - 4);
  return out;
}

function ihdr(width, height, depth, colorType, interlaceMethod) {
  let data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = depth;
  data[9] = colorType;
  data[10] = 0;
  data[11] = 0;
  data[12] = interlaceMethod || 0;
  return chunk("IHDR", data);
}

let CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function rowBytes(width, depth, colorType) {
  return Math.ceil((width * CHANNELS[colorType] * depth) / 8);
}

// Packs one scanline of raw samples into PNG's big-endian, sub-byte layout.
function packRow(samples, depth, colorType) {
  let channels = CHANNELS[colorType];
  let byteWidth = rowBytes(samples.length / channels, depth, colorType);
  let out = Buffer.alloc(byteWidth);
  if (depth === 16) {
    for (let i = 0; i < samples.length; i++) {
      out.writeUInt16BE(samples[i] & 0xffff, i * 2);
    }
    return out;
  }
  if (depth === 8) {
    for (let i = 0; i < samples.length; i++) {
      out[i] = samples[i] & 0xff;
    }
    return out;
  }
  // 1, 2 or 4 bits per sample, most significant bits first.
  let perByte = 8 / depth;
  for (let i = 0; i < samples.length; i++) {
    let byteIndex = Math.floor(i / perByte);
    let shift = 8 - depth * ((i % perByte) + 1);
    out[byteIndex] |= (samples[i] & ((1 << depth) - 1)) << shift;
  }
  return out;
}

// Raw (filter byte + samples) stream for a full image. `sampleAt(x, y)`
// returns an array of channel values. Filter type is fixed per row so the
// decoder's unfiltering has real work to do for every supported filter.
function rawImage(opts) {
  let width = opts.width;
  let height = opts.height;
  let depth = opts.depth;
  let colorType = opts.colorType;
  let filterFor =
    opts.filterFor ||
    function () {
      return 0;
    };
  let sampleAt = opts.sampleAt;
  let buffers = [];
  let previousRow = null;
  for (let y = 0; y < height; y++) {
    let samples = [];
    for (let x = 0; x < width; x++) {
      samples = samples.concat(sampleAt(x, y));
    }
    let packed = packRow(samples, depth, colorType);
    let filter = filterFor(y) % 5;
    buffers.push(Buffer.from([filter]));
    buffers.push(applyFilter(filter, packed, previousRow, depth, colorType));
    previousRow = packed;
  }
  return Buffer.concat(buffers);
}

// Applies a PNG filter to a packed scanline. `previous` is the *unfiltered*
// previous scanline, as the PNG spec requires for filters 2..4.
function applyFilter(filter, packed, previous, depth, colorType) {
  let bpp = CHANNELS[colorType];
  let bytesPerPixel = depth === 16 ? bpp * 2 : depth === 8 ? bpp : 1;
  let prev = previous;
  let out = Buffer.alloc(packed.length);

  function paeth(left, above, upLeft) {
    let p = left + above - upLeft;
    let pLeft = Math.abs(p - left);
    let pAbove = Math.abs(p - above);
    let pUpLeft = Math.abs(p - upLeft);
    if (pLeft <= pAbove && pLeft <= pUpLeft) return left;
    if (pAbove <= pUpLeft) return above;
    return upLeft;
  }

  for (let x = 0; x < packed.length; x++) {
    let raw = packed[x];
    let left = x >= bytesPerPixel ? packed[x - bytesPerPixel] : 0;
    let above = prev ? prev[x] : 0;
    let upLeft = prev && x >= bytesPerPixel ? prev[x - bytesPerPixel] : 0;
    switch (filter) {
      case 0:
        out[x] = raw;
        break;
      case 1:
        out[x] = (raw - left) & 0xff;
        break;
      case 2:
        out[x] = (raw - above) & 0xff;
        break;
      case 3:
        out[x] = (raw - ((left + above) >> 1)) & 0xff;
        break;
      case 4:
        out[x] = (raw - paeth(left, above, upLeft)) & 0xff;
        break;
      default:
        throw new Error("bad filter " + filter);
    }
  }
  return out;
}

// Splits a full image into Adam7 passes and returns the concatenated raw
// stream (filter byte per pass scanline, all filter 0).
function rawInterlaced(opts) {
  let passes = interlace.getImagePasses(opts.width, opts.height);
  let buffers = [];
  for (let p = 0; p < passes.length; p++) {
    let pass = passes[p];
    let passIndex = pass.index;
    for (let y = 0; y < pass.height; y++) {
      let samples = [];
      for (let x = 0; x < pass.width; x++) {
        let outer = interlaceOuter(passIndex, x, y);
        samples = samples.concat(opts.sampleAt(outer.x, outer.y));
      }
      buffers.push(Buffer.from([0]));
      buffers.push(packRow(samples, opts.depth, opts.colorType));
    }
  }
  return Buffer.concat(buffers);
}

let adam7 = [
  { x: [0], y: [0] },
  { x: [4], y: [0] },
  { x: [0, 4], y: [4] },
  { x: [2, 6], y: [0, 4] },
  { x: [0, 2, 4, 6], y: [2, 6] },
  { x: [1, 3, 5, 7], y: [0, 2, 4, 6] },
  { x: [0, 1, 2, 3, 4, 5, 6, 7], y: [1, 3, 5, 7] },
];

function interlaceOuter(passIndex, x, y) {
  let pass = adam7[passIndex];
  let outerX = Math.floor(x / pass.x.length) * 8 + pass.x[x % pass.x.length];
  let outerY = Math.floor(y / pass.y.length) * 8 + pass.y[y % pass.y.length];
  return { x: outerX, y: outerY };
}

function deflate(raw, level) {
  return zlib.deflateSync(raw, { level: level == null ? 9 : level });
}

// Assembles a PNG from parts. `parts` may include extra ancillary chunks and
// may override the IDAT payload(s) to build the malformed fixtures.
function assemble(chunks) {
  return Buffer.concat([SIGNATURE].concat(chunks));
}

function build(opts) {
  let raw = opts.interlace ? rawInterlaced(opts) : rawImage(opts);
  let chunks = [
    ihdr(
      opts.width,
      opts.height,
      opts.depth,
      opts.colorType,
      opts.interlace ? 1 : 0
    ),
  ];

  if (opts.palette) {
    chunks.push(chunk("PLTE", paletteBytes(opts.palette)));
  }
  if (opts.trns !== undefined) {
    chunks.push(chunk("tRNS", opts.trns));
  }
  if (opts.gamma !== undefined) {
    let g = Buffer.alloc(4);
    g.writeUInt32BE(opts.gamma, 0);
    chunks.push(chunk("gAMA", g));
  }
  if (opts.beforeIdat) {
    chunks = chunks.concat(opts.beforeIdat);
  }

  let compressed = opts.idatBytes || deflate(raw, opts.level);
  let split = opts.idatSplit || 0;
  if (split > 0) {
    for (let i = 0; i < compressed.length; i += split) {
      chunks.push(chunk("IDAT", compressed.slice(i, i + split)));
    }
  } else {
    chunks.push(chunk("IDAT", compressed));
  }

  if (opts.afterIdat) {
    chunks = chunks.concat(opts.afterIdat);
  }
  if (opts.iend !== false) {
    chunks.push(chunk("IEND", null));
  }

  return assemble(chunks);
}

function paletteBytes(palette) {
  let out = Buffer.alloc(palette.length * 3);
  for (let i = 0; i < palette.length; i++) {
    out[i * 3] = palette[i][0];
    out[i * 3 + 1] = palette[i][1];
    out[i * 3 + 2] = palette[i][2];
  }
  return out;
}

// Reference decoder for the fixtures' expected RGBA output, written from the
// spec. Samples are scaled to 8 bits, palettes expanded, and a tRNS colour
// key (grayscale / truecolour) rendered fully transparent as pngjs does.
function expectedRgba(opts) {
  let out = Buffer.alloc(opts.width * opts.height * 4);
  let maxSample = Math.pow(2, opts.depth) - 1;
  let scale = function (value) {
    return Math.floor((value * 255) / maxSample + 0.5);
  };
  // A tRNS payload is a colour key for non-palette images: 2 bytes for
  // grayscale, 6 bytes (three 16-bit samples) for truecolour.
  let key =
    opts.trns && opts.colorType !== 3
      ? {
          gray: opts.colorType === 0 ? opts.trns.readUInt16BE(0) : null,
          red: opts.colorType === 2 ? opts.trns.readUInt16BE(0) : null,
          green: opts.colorType === 2 ? opts.trns.readUInt16BE(2) : null,
          blue: opts.colorType === 2 ? opts.trns.readUInt16BE(4) : null,
        }
      : null;

  function keyMatches(samples) {
    if (!key) {
      return false;
    }
    if (opts.colorType === 0) {
      return samples[0] === key.gray;
    }
    return (
      samples[0] === key.red &&
      samples[1] === key.green &&
      samples[2] === key.blue
    );
  }

  for (let y = 0; y < opts.height; y++) {
    for (let x = 0; x < opts.width; x++) {
      let samples = opts.sampleAt(x, y);
      let idx = (y * opts.width + x) * 4;
      if (opts.colorType === 3) {
        let entry = opts.palette[samples[0]];
        out[idx] = entry[0];
        out[idx + 1] = entry[1];
        out[idx + 2] = entry[2];
        out[idx + 3] =
          opts.trns && samples[0] < opts.trns.length
            ? opts.trns[samples[0]]
            : 255;
        continue;
      }

      // A colour key makes the matching pixel fully transparent (all four
      // channels zero, which is what pngjs produces).
      if (keyMatches(samples)) {
        out[idx] = out[idx + 1] = out[idx + 2] = out[idx + 3] = 0;
        continue;
      }

      if (opts.colorType === 0) {
        let v = scale(samples[0]);
        out[idx] = out[idx + 1] = out[idx + 2] = v;
        out[idx + 3] = 255;
      } else if (opts.colorType === 2) {
        out[idx] = scale(samples[0]);
        out[idx + 1] = scale(samples[1]);
        out[idx + 2] = scale(samples[2]);
        out[idx + 3] = 255;
      } else if (opts.colorType === 4) {
        let v = scale(samples[0]);
        out[idx] = out[idx + 1] = out[idx + 2] = v;
        out[idx + 3] = scale(samples[1]);
      } else {
        out[idx] = scale(samples[0]);
        out[idx + 1] = scale(samples[1]);
        out[idx + 2] = scale(samples[2]);
        out[idx + 3] = scale(samples[3]);
      }
    }
  }
  return out;
}

module.exports = {
  SIGNATURE: SIGNATURE,
  chunk: chunk,
  ihdr: ihdr,
  build: build,
  assemble: assemble,
  deflate: deflate,
  rawImage: rawImage,
  rawInterlaced: rawInterlaced,
  expectedRgba: expectedRgba,
  rowBytes: rowBytes,
  CHANNELS: CHANNELS,
};
