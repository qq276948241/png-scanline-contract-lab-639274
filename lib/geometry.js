"use strict";

let errors = require("./errors");
let constants = require("./constants");
let interlaceUtils = require("./interlace");

let kMaxLength = require("buffer").kMaxLength;
if (!kMaxLength || kMaxLength > Number.MAX_SAFE_INTEGER) {
  kMaxLength = Number.MAX_SAFE_INTEGER;
}

// PNG chunk lengths are unsigned 32 bit, but the spec caps them at 2^31-1.
// Anything above that is treated as a corrupt/overflowing length instead of
// being fed to Buffer.alloc.
let MAX_CHUNK_LENGTH = 0x7fffffff;
let MAX_DIMENSION = 0x7fffffff;

function bppFor(colorType) {
  return constants.COLORTYPE_TO_BPP_MAP[colorType];
}

function validDepthsFor(colorType) {
  return constants.COLORTYPE_TO_DEPTHS_MAP[colorType];
}

// Bytes needed for one scanline, without the leading filter byte.
// Uses plain arithmetic (not `>> 3`) because the intermediate value can
// exceed 2^31 for legitimate-but-large headers.
function rowBytes(width, bpp, depth) {
  return Math.ceil((width * bpp * depth) / 8);
}

function passesFor(width, height, interlace) {
  if (interlace) {
    return interlaceUtils.getImagePasses(width, height);
  }
  return [{ width: width, height: height }];
}

// Size of the inflated IDAT stream, i.e. every scanline plus its filter byte.
function filteredSize(bitmapInfo) {
  let bpp = bitmapInfo.bpp;
  let depth = bitmapInfo.depth;
  let passes = passesFor(
    bitmapInfo.width,
    bitmapInfo.height,
    bitmapInfo.interlace
  );
  let size = 0;
  for (let i = 0; i < passes.length; i++) {
    size += (rowBytes(passes[i].width, bpp, depth) + 1) * passes[i].height;
  }
  return size;
}

// Size of the unfiltered image data (no filter bytes) handed to the bitmapper.
function unfilteredSize(bitmapInfo) {
  let bpp = bitmapInfo.bpp;
  let depth = bitmapInfo.depth;
  let passes = passesFor(
    bitmapInfo.width,
    bitmapInfo.height,
    bitmapInfo.interlace
  );
  let size = 0;
  for (let i = 0; i < passes.length; i++) {
    size += rowBytes(passes[i].width, bpp, depth) * passes[i].height;
  }
  return size;
}

// Bytes the decoder needs for the final RGBA bitmap (4 samples of either
// 8 bits or 16 bits per pixel).
function decodedPixelBytes(width, height, depth) {
  let bytesPerSample = depth === 16 ? 2 : 1;
  return width * height * 4 * bytesPerSample;
}

function checkSize(bytes, code, message) {
  if (!(bytes >= 0) || bytes > kMaxLength) {
    throw errors.create(code, message);
  }
  return bytes;
}

// Validates the IHDR fields and the sizes derived from them without
// allocating anything. Every check is deliberately independent so callers
// can tell a bad bit depth from a bad colour type, an unsupported method
// from an image that would not fit in memory.
function validateHeader(width, height, depth, colorType) {
  if (width === 0 || height === 0) {
    throw errors.create(
      errors.CODES.DIMENSIONS,
      "Image width and height must be non zero"
    );
  }
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw errors.create(
      errors.CODES.DIMENSIONS,
      "Image dimensions exceed the PNG limit"
    );
  }

  let depths = validDepthsFor(colorType);
  if (!depths) {
    throw errors.create(
      errors.CODES.COLOR_TYPE,
      "Unsupported color type " + colorType
    );
  }
  if (depths.indexOf(depth) === -1) {
    throw errors.create(
      errors.CODES.BIT_DEPTH,
      "Unsupported bit depth " + depth + " for color type " + colorType
    );
  }

  let bpp = bppFor(colorType);
  let filtered = rowBytes(width, bpp, depth) + 1;
  let raw = filtered * height;
  let pixels = decodedPixelBytes(width, height, depth);

  checkSize(
    raw,
    errors.CODES.DIMENSIONS,
    "Image is too large to decode: filtered data exceeds the buffer limit"
  );
  checkSize(
    pixels,
    errors.CODES.DIMENSIONS,
    "Image is too large to decode: pixel data exceeds the buffer limit"
  );

  return { bpp: bpp, rawSize: raw, pixelSize: pixels };
}

// Validates the dimensions and checks the interlaced sizes too, once the
// interlace flag is known.
function validateImageSize(bitmapInfo) {
  let filtered = randomAccessibleSize(bitmapInfo);
  checkSize(
    filtered,
    errors.CODES.DIMENSIONS,
    "Image is too large to decode: filtered data exceeds the buffer limit"
  );
  checkSize(
    decodedPixelBytes(bitmapInfo.width, bitmapInfo.height, bitmapInfo.depth),
    errors.CODES.DIMENSIONS,
    "Image is too large to decode: pixel data exceeds the buffer limit"
  );
  return filtered;
}

function randomAccessibleSize(bitmapInfo) {
  return filteredSize(bitmapInfo);
}

module.exports = {
  MAX_CHUNK_LENGTH: MAX_CHUNK_LENGTH,
  MAX_DIMENSION: MAX_DIMENSION,
  MAX_BUFFER_LENGTH: kMaxLength,
  bppFor: bppFor,
  validDepthsFor: validDepthsFor,
  rowBytes: rowBytes,
  passesFor: passesFor,
  filteredSize: filteredSize,
  unfilteredSize: unfilteredSize,
  decodedPixelBytes: decodedPixelBytes,
  validateHeader: validateHeader,
  validateImageSize: validateImageSize,
  checkSize: checkSize,
};
