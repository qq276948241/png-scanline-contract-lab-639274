"use strict";

let constants = require("./constants");
let CrcStream = require("./crc");
let bitPacker = require("./bitpacker");
let filter = require("./filter-pack");
let zlib = require("zlib");
let PNGError = require("./png-error");
let validation = require("./validation");

let Packer = (module.exports = function (options) {
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

  if (
    [
      constants.COLORTYPE_GRAYSCALE,
      constants.COLORTYPE_COLOR,
      constants.COLORTYPE_COLOR_ALPHA,
      constants.COLORTYPE_ALPHA,
    ].indexOf(options.colorType) === -1
  ) {
    throw PNGError(
      PNGError.codes.ERR_PNG_COLOR_TYPE,
      "option color type:" + options.colorType + " is not supported at present"
    );
  }
  if (
    [
      constants.COLORTYPE_GRAYSCALE,
      constants.COLORTYPE_COLOR,
      constants.COLORTYPE_COLOR_ALPHA,
      constants.COLORTYPE_ALPHA,
    ].indexOf(options.inputColorType) === -1
  ) {
    throw PNGError(
      PNGError.codes.ERR_PNG_COLOR_TYPE,
      "option input color type:" +
        options.inputColorType +
        " is not supported at present"
    );
  }
  if (options.bitDepth !== 8 && options.bitDepth !== 16) {
    throw PNGError(
      PNGError.codes.ERR_PNG_BIT_DEPTH,
      "option bit depth:" + options.bitDepth + " is not supported at present"
    );
  }

  if (
    options.deflateLevel != null &&
    (typeof options.deflateLevel !== "number" ||
      options.deflateLevel < zlib.Z_MIN_LEVEL ||
      options.deflateLevel > zlib.Z_MAX_LEVEL)
  ) {
    throw PNGError(
      PNGError.codes.ERR_PNG_DEFLATE_LEVEL,
      "option deflateLevel must be an integer between " +
        zlib.Z_MIN_LEVEL +
        " and " +
        zlib.Z_MAX_LEVEL
    );
  }

  if ("filterType" in options && typeof options.filterType !== "number") {
    throw PNGError(
      PNGError.codes.ERR_PNG_FILTER_TYPE,
      "unrecognised filter types"
    );
  }
  if (
    typeof options.filterType === "number" &&
    options.filterType !== -1 &&
    (options.filterType < 0 || options.filterType > 4)
  ) {
    throw PNGError(
      PNGError.codes.ERR_PNG_FILTER_TYPE,
      "option filterType must be -1 or one of 0..4"
    );
  }
});

// Validate encoder inputs before any byte (or large buffer) is produced.
Packer.prototype.validateInput = function (data, width, height) {
  if (!data || !Buffer.isBuffer(data) || data.length === 0) {
    throw PNGError(PNGError.codes.ERR_PNG_ENCODER_INPUT, "No data provided");
  }

  validation.validateDimensions(width, height, this._options);

  let inputBpp = constants.COLORTYPE_TO_BPP_MAP[this._options.inputColorType];
  if (inputBpp === 4 && !this._options.inputHasAlpha) {
    inputBpp = 3;
  }
  let bytesPerSample = this._options.bitDepth === 16 ? 2 : 1;
  let expectedLength = width * height * inputBpp * bytesPerSample;

  if (data.length < expectedLength) {
    throw PNGError(
      PNGError.codes.ERR_PNG_ENCODER_INPUT,
      "Data length " +
        data.length +
        " is smaller than the " +
        expectedLength +
        " bytes required for a " +
        width +
        "x" +
        height +
        " image"
    );
  }

  // The bit packer walks exactly expectedLength bytes; oversized input is
  // almost always a width/height mistake and would silently drop pixels.
  if (data.length !== expectedLength) {
    throw PNGError(
      PNGError.codes.ERR_PNG_ENCODER_INPUT,
      "Data length " +
        data.length +
        " does not match the " +
        expectedLength +
        " bytes required for a " +
        width +
        "x" +
        height +
        " image"
    );
  }
};

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
  this.validateInput(data, width, height);

  // convert to correct format for filtering (e.g. right bpp and bit depth)
  let packedData = bitPacker(data, width, height, this._options);

  // filter pixel data
  let bpp = constants.COLORTYPE_TO_BPP_MAP[this._options.colorType];
  let filteredData = filter(packedData, width, height, this._options, bpp);
  return filteredData;
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
