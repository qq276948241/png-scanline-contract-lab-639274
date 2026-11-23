"use strict";

let PNGError = require("./png-error");
let constants = require("./constants");

// PNG stores dimensions as unsigned 32 bit integers, so zero and values above
// 2^32 - 1 can never describe a legal image.
exports.MAX_UINT32 = 0xffffffff;

// A 100 megapixel image needs roughly 400 MB once normalised to RGBA. The
// limit can be overridden via options.maxDimension / options.maxPixels for
// callers that genuinely need larger inputs; it exists so a hostile header
// can never induce a multi-gigabyte allocation by itself.
exports.DEFAULT_MAX_DIMENSION = 100000;
exports.DEFAULT_MAX_PIXELS = 100000000;

// A PNG chunk length field is an unsigned 32 bit integer. Values above
// 2^31 - 1 are forbidden by the PNG specification (chunk lengths must fit in
// 31 bits).
exports.MAX_CHUNK_LENGTH = 0x7fffffff;

// Allowed bit depths per colour type, straight from the PNG specification.
let ALLOWED_BIT_DEPTHS = {
  [constants.COLORTYPE_GRAYSCALE]: [1, 2, 4, 8, 16],
  [constants.COLORTYPE_PALETTE_COLOR]: [1, 2, 4, 8],
  [constants.COLORTYPE_COLOR]: [8, 16],
  [constants.COLORTYPE_ALPHA]: [8, 16],
  [constants.COLORTYPE_COLOR_ALPHA]: [8, 16],
};

exports.getAllowedBitDepths = function (colorType) {
  return ALLOWED_BIT_DEPTHS[colorType] || null;
};

// Number of bytes in one filtered scan line, including the leading filter
// type byte. Math is done with safe integer checks so crafted headers cannot
// overflow into a small allocation.
exports.getRowSize = function (width, bpp, depth) {
  let bitsPerPixel = width * bpp * depth;
  let byteWidth = Math.ceil(bitsPerPixel / 8);
  return byteWidth + 1;
};

exports.getImageSize = function (width, height, bpp, depth) {
  let rowSize = exports.getRowSize(width, bpp, depth);
  let imageSize = rowSize * height;
  if (!Number.isSafeInteger(imageSize)) {
    throw PNGError(
      PNGError.codes.ERR_PNG_TOO_LARGE,
      "Image dimensions produce an overflowing byte count"
    );
  }
  return imageSize;
};

// Total size of every Adam7 pass (each scan line carries its own filter
// byte). Used to cap inflate output for interlaced images.
exports.getInterlacedImageSize = function (width, height, bpp, depth) {
  let interlace = require("./interlace");
  let passes = interlace.getImagePasses(width, height);
  let total = 0;
  for (let i = 0; i < passes.length; i++) {
    total += exports.getImageSize(
      passes[i].width,
      passes[i].height,
      bpp,
      depth
    );
  }
  return total;
};

exports.validateDimensions = function (width, height, options) {
  options = options || {};
  let maxDimension =
    options.maxDimension != null
      ? options.maxDimension
      : exports.DEFAULT_MAX_DIMENSION;
  let maxPixels =
    options.maxPixels != null ? options.maxPixels : exports.DEFAULT_MAX_PIXELS;

  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw PNGError(
      PNGError.codes.ERR_PNG_DIMENSIONS,
      "Image width and height must be positive integers"
    );
  }

  if (width > exports.MAX_UINT32 || height > exports.MAX_UINT32) {
    throw PNGError(
      PNGError.codes.ERR_PNG_DIMENSIONS,
      "Image dimensions exceed the PNG 32 bit limit"
    );
  }

  if (width > maxDimension || height > maxDimension) {
    throw PNGError(
      PNGError.codes.ERR_PNG_TOO_LARGE,
      "Image dimension " +
        width +
        "x" +
        height +
        " exceeds maximum of " +
        maxDimension
    );
  }

  let pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > maxPixels) {
    throw PNGError(
      PNGError.codes.ERR_PNG_TOO_LARGE,
      "Image of " +
        pixels +
        " pixels exceeds maximum of " +
        maxPixels +
        " pixels"
    );
  }

  // RGBA output buffer must be allocatable.
  let rgbaLength = width * height * 4;
  if (!Number.isSafeInteger(rgbaLength)) {
    throw PNGError(
      PNGError.codes.ERR_PNG_TOO_LARGE,
      "Image produces an overflowing RGBA buffer"
    );
  }
};

// Full IHDR validation. Throws a coded PNGError for the first violation.
exports.validateIHDR = function (fields, options) {
  let width = fields.width;
  let height = fields.height;
  let depth = fields.depth;
  let colorType = fields.colorType;
  let compression = fields.compression;
  let filterMethod = fields.filterMethod;
  let interlace = fields.interlace;

  exports.validateDimensions(width, height, options);

  let allowedDepths = ALLOWED_BIT_DEPTHS[colorType];
  if (!allowedDepths) {
    throw PNGError(PNGError.codes.ERR_PNG_COLOR_TYPE, "Unsupported color type");
  }

  if (allowedDepths.indexOf(depth) === -1) {
    throw PNGError(
      PNGError.codes.ERR_PNG_BIT_DEPTH,
      "Unsupported bit depth " + depth + " for color type " + colorType
    );
  }

  if (compression !== 0) {
    throw PNGError(
      PNGError.codes.ERR_PNG_COMPRESSION,
      "Unsupported compression method"
    );
  }
  if (filterMethod !== 0) {
    throw PNGError(
      PNGError.codes.ERR_PNG_FILTER_METHOD,
      "Unsupported filter method"
    );
  }
  if (interlace !== 0 && interlace !== 1) {
    throw PNGError(
      PNGError.codes.ERR_PNG_INTERLACE,
      "Unsupported interlace method"
    );
  }
};

exports.validateChunkLength = function (length) {
  if (
    !Number.isInteger(length) ||
    length < 0 ||
    length > exports.MAX_CHUNK_LENGTH
  ) {
    throw PNGError(
      PNGError.codes.ERR_PNG_CHUNK_LENGTH,
      "Invalid chunk length " + length
    );
  }
};
