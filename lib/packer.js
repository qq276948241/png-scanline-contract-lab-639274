"use strict";

let constants = require("./constants");
let CrcStream = require("./crc");
let bitPacker = require("./bitpacker");
let filter = require("./filter-pack");
let errors = require("./errors");
let geometry = require("./geometry");
let zlib = require("zlib");

let SUPPORTED_OUTPUT_COLOR_TYPES = [
  constants.COLORTYPE_GRAYSCALE,
  constants.COLORTYPE_COLOR,
  constants.COLORTYPE_COLOR_ALPHA,
  constants.COLORTYPE_ALPHA,
];

let SUPPORTED_INPUT_COLOR_TYPES = [
  constants.COLORTYPE_GRAYSCALE,
  constants.COLORTYPE_COLOR,
  constants.COLORTYPE_COLOR_ALPHA,
  constants.COLORTYPE_ALPHA,
];

function optionError(message) {
  return errors.create(errors.CODES.OPTIONS, message);
}

let Packer = (module.exports = function (options) {
  // Work on a copy: the defaults filled in below (and any normalisation)
  // must not leak back into the caller's options object, which may be reused
  // for a later image.
  options = Object.assign({}, options);
  this._options = options;

  options.deflateChunkSize = options.deflateChunkSize || 32 * 1024;
  options.deflateLevel =
    options.deflateLevel != null ? options.deflateLevel : 9;
  options.deflateStrategy =
    options.deflateStrategy != null ? options.deflateStrategy : 3;
  options.inputHasAlpha =
    options.inputHasAlpha != null ? options.inputHasAlpha : true;
  options.deflateFactory = options.deflateFactory || zlib.createDeflate;
  options.bitDepth = options.bitDepth || 8;
  // This is outputColorType
  options.colorType =
    typeof options.colorType === "number"
      ? options.colorType
      : constants.COLORTYPE_COLOR_ALPHA;
  options.inputColorType =
    typeof options.inputColorType === "number"
      ? options.inputColorType
      : constants.COLORTYPE_COLOR_ALPHA;

  if (SUPPORTED_OUTPUT_COLOR_TYPES.indexOf(options.colorType) === -1) {
    throw optionError(
      "option color type:" + options.colorType + " is not supported at present"
    );
  }
  if (SUPPORTED_INPUT_COLOR_TYPES.indexOf(options.inputColorType) === -1) {
    throw optionError(
      "option input color type:" +
        options.inputColorType +
        " is not supported at present"
    );
  }
  if (options.bitDepth !== 8 && options.bitDepth !== 16) {
    throw optionError(
      "option bit depth:" + options.bitDepth + " is not supported at present"
    );
  }

  // Deflate knobs are validated here so an invalid level/strategy/chunk size
  // fails before any bytes are written, with a pngjs error code rather than a
  // raw RangeError from zlib.
  if (
    !Number.isInteger(options.deflateLevel) ||
    options.deflateLevel < 0 ||
    options.deflateLevel > 9
  ) {
    throw optionError(
      "option deflate level:" +
        options.deflateLevel +
        " must be an integer between 0 and 9"
    );
  }
  if (
    !Number.isInteger(options.deflateStrategy) ||
    options.deflateStrategy < 0 ||
    options.deflateStrategy > 4
  ) {
    throw optionError(
      "option deflate strategy:" +
        options.deflateStrategy +
        " must be an integer between 0 and 4"
    );
  }
  if (
    !Number.isInteger(options.deflateChunkSize) ||
    options.deflateChunkSize < 64
  ) {
    throw optionError(
      "option deflate chunk size:" +
        options.deflateChunkSize +
        " must be an integer of at least 64"
    );
  }

  // Filter selection is shared by the sync and stream writers so both reject
  // the same choices, and the same choice always produces the same bytes.
  if ("filterType" in options && options.filterType !== undefined) {
    if (options.filterType === -1) {
      // automatic
    } else if (typeof options.filterType === "number") {
      if (options.filterType < 0 || options.filterType > 4) {
        throw optionError(
          "option filter type:" +
            options.filterType +
            " is not supported at present"
        );
      }
    } else {
      throw optionError("unrecognised filter types");
    }
  }
});

Packer.prototype.getDeflateOptions = function () {
  return {
    chunkSize: this._options.deflateChunkSize,
    level: this._options.deflateLevel,
    strategy: this._options.deflateStrategy,
  };
};

Packer.prototype.createDeflate = function () {
  return this._options.deflateFactory(this.getDeflateOptions());
};

Packer.prototype.filterData = function (data, width, height) {
  // convert to correct format for filtering (e.g. right bpp and bit depth)
  let packedData = bitPacker(data, width, height, this._options);

  // filter pixel data
  let bpp = constants.COLORTYPE_TO_BPP_MAP[this._options.colorType];
  let filteredData = filter(packedData, width, height, this._options, bpp);
  return filteredData;
};

// Validates everything needed to write a PNG before a single byte is emitted
// or allocated: dimensions, sample geometry, and that the caller supplied
// exactly the pixel bytes the chosen input format requires.
Packer.prototype.validate = function (data, width, height) {
  if (!data || !data.length) {
    throw errors.create(errors.CODES.NO_DATA, "No data provided");
  }
  if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array)) {
    throw optionError("Image data must be a Buffer");
  }
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw errors.create(
      errors.CODES.DIMENSIONS,
      "Image width and height must be integers"
    );
  }
  if (width <= 0 || height <= 0) {
    throw errors.create(
      errors.CODES.DIMENSIONS,
      "Image width and height must be non zero"
    );
  }
  if (width > geometry.MAX_DIMENSION || height > geometry.MAX_DIMENSION) {
    throw errors.create(
      errors.CODES.DIMENSIONS,
      "Image dimensions exceed the PNG limit"
    );
  }

  let bytesPerSample = this._options.bitDepth === 16 ? 2 : 1;
  let inBpp = constants.COLORTYPE_TO_BPP_MAP[this._options.inputColorType];
  if (
    this._options.inputColorType === constants.COLORTYPE_COLOR_ALPHA &&
    !this._options.inputHasAlpha
  ) {
    inBpp = 3;
  }
  let expected = width * height * inBpp * bytesPerSample;

  // Width * height * channels can overflow before it reaches the buffer
  // limit check, so verify the arithmetic stayed exact and in range.
  if (!Number.isSafeInteger(expected)) {
    throw errors.create(
      errors.CODES.DIMENSIONS,
      "Image is too large to encode: pixel data exceeds the buffer limit"
    );
  }
  geometry.checkSize(
    expected,
    errors.CODES.DIMENSIONS,
    "Image is too large to encode: pixel data exceeds the buffer limit"
  );

  if (data.length !== expected) {
    throw errors.create(
      errors.CODES.DATA_SIZE,
      "Image data is " +
        data.length +
        " bytes, expected " +
        expected +
        " for a " +
        width +
        "x" +
        height +
        " image"
    );
  }

  let outBpp = constants.COLORTYPE_TO_BPP_MAP[this._options.colorType];
  if (this._options.bitDepth === 16) {
    outBpp *= 2;
  }
  let rowByteWidth = width * outBpp;
  geometry.checkSize(
    (rowByteWidth + 1) * height,
    errors.CODES.DIMENSIONS,
    "Image is too large to encode: filtered data exceeds the buffer limit"
  );
};

Packer.prototype._packChunk = function (type, data) {
  let len = data ? data.length : 0;
  let buf = Buffer.alloc(len + 12);

  buf.writeUInt32BE(len, 0);
  buf.writeUInt32BE(type, 4);

  if (data) {
    data.copy(buf, 8);
  }

  buf.writeInt32BE(
    CrcStream.crc32(buf.slice(4, buf.length - 4)),
    buf.length - 4
  );
  return buf;
};

Packer.prototype.packGAMA = function (gamma) {
  let buf = Buffer.alloc(4);
  buf.writeUInt32BE(Math.floor(gamma * constants.GAMMA_DIVISION), 0);
  return this._packChunk(constants.TYPE_gAMA, buf);
};

Packer.prototype.packIHDR = function (width, height) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > geometry.MAX_DIMENSION ||
    height > geometry.MAX_DIMENSION
  ) {
    throw errors.create(
      errors.CODES.DIMENSIONS,
      "Image width and height must be integers between 1 and 2^31-1"
    );
  }

  let buf = Buffer.alloc(13);
  buf.writeUInt32BE(width, 0);
  buf.writeUInt32BE(height, 4);
  buf[8] = this._options.bitDepth; // Bit depth
  buf[9] = this._options.colorType; // colorType
  buf[10] = 0; // compression
  buf[11] = 0; // filter
  buf[12] = 0; // interlace

  return this._packChunk(constants.TYPE_IHDR, buf);
};

Packer.prototype.packIDAT = function (data) {
  return this._packChunk(constants.TYPE_IDAT, data);
};

Packer.prototype.packIEND = function () {
  return this._packChunk(constants.TYPE_IEND, null);
};
