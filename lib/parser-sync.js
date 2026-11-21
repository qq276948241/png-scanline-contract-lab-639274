"use strict";

let hasSyncZlib = true;
let zlib = require("zlib");
if (!zlib.deflateSync) {
  hasSyncZlib = false;
}
let SyncReader = require("./sync-reader");
let FilterSync = require("./filter-parse-sync");
let Parser = require("./parser");
let bitmapper = require("./bitmapper");
let formatNormaliser = require("./format-normaliser");
let errors = require("./errors");
let geometry = require("./geometry");

// Accepts Buffers and any byte array, regardless of which realm's Buffer
// implementation created it (relevant for the browser bundle).
function isByteArray(value) {
  return (
    Buffer.isBuffer(value) ||
    value instanceof Uint8Array ||
    (value != null &&
      typeof value === "object" &&
      typeof value.length === "number" &&
      typeof value.readUInt32BE === "function")
  );
}

module.exports = function (buffer, options) {
  if (!hasSyncZlib) {
    throw new Error(
      "To use the sync capability of this library in old node versions, please pin pngjs to v2.3.0"
    );
  }

  if (!isByteArray(buffer)) {
    throw errors.create(
      errors.CODES.OPTIONS,
      "A Buffer is required to read a PNG synchronously"
    );
  }
  // In the browser bundle `Buffer` is a polyfill, so a Uint8Array coming from
  // another realm (or a plain typed array) is not an instance of this copy of
  // Buffer. Wrap it once so the rest of the decoder can rely on Buffer APIs.
  if (!Buffer.isBuffer(buffer)) {
    buffer = Buffer.from(buffer);
  }

  let err;
  function handleError(_err_) {
    err = _err_;
  }

  let metaData;
  function handleMetaData(_metaData_) {
    metaData = _metaData_;
  }

  function handleTransColor(transColor) {
    metaData.transColor = transColor;
  }

  function handlePalette(palette) {
    metaData.palette = palette;
  }

  function handleSimpleTransparency() {
    metaData.alpha = true;
  }

  let gamma;
  function handleGamma(_gamma_) {
    gamma = _gamma_;
  }

  let inflateDataList = [];
  function handleInflateData(inflatedData) {
    inflateDataList.push(inflatedData);
  }

  let reader = new SyncReader(buffer);

  let parser = new Parser(options, {
    read: reader.read.bind(reader),
    error: handleError,
    metadata: handleMetaData,
    gamma: handleGamma,
    palette: handlePalette,
    transColor: handleTransColor,
    inflateData: handleInflateData,
    simpleTransparency: handleSimpleTransparency,
  });

  parser.start();

  // The parser reports the first error it finds and stops scheduling reads.
  // process() may then notice the (now unconsumed) tail of the input, but the
  // parser error is the meaningful one, so it always wins.
  let readerError = null;
  try {
    reader.process();
  } catch (ex) {
    readerError = ex;
  }

  if (err) {
    throw err;
  }
  if (readerError) {
    throw readerError;
  }

  if (!metaData) {
    throw errors.create(errors.CODES.IHDR, "No IHDR chunk found in PNG");
  }

  // join together the inflate datas
  let inflateData = Buffer.concat(inflateDataList);
  inflateDataList.length = 0;

  let expectedSize = geometry.filteredSize(metaData);
  geometry.checkSize(
    expectedSize,
    errors.CODES.DIMENSIONS,
    "Image is too large to decode: filtered data exceeds the buffer limit"
  );

  let inflatedData;
  try {
    // Bounding the output means a header that advertises a huge image can
    // never make zlib allocate (or produce) more than the declared scanlines,
    // and a stream that inflates to more than that is rejected as corrupt.
    inflatedData = zlib.inflateSync(inflateData, {
      maxOutputLength: Math.max(expectedSize, 1),
    });
  } catch (ex) {
    if (ex && ex.code === "ERR_BUFFER_TOO_LARGE") {
      throw errors.create(
        errors.CODES.DATA_SIZE,
        "bad png - too much image data",
        { cause: ex }
      );
    }
    throw errors.wrap(
      ex,
      errors.CODES.INFLATE,
      "bad png - invalid inflate data response"
    );
  }
  inflateData = null;

  if (inflatedData.length !== expectedSize) {
    throw errors.create(
      errors.CODES.DATA_SIZE,
      "bad png - image data is " +
        inflatedData.length +
        " bytes, expected " +
        expectedSize
    );
  }

  let unfilteredData = FilterSync.process(inflatedData, metaData);
  inflatedData = null;

  if (unfilteredData.length !== geometry.unfilteredSize(metaData)) {
    throw errors.create(
      errors.CODES.DATA_SIZE,
      "bad png - unexpected amount of image data"
    );
  }

  let bitmapData = bitmapper.dataToBitMap(unfilteredData, metaData);
  unfilteredData = null;

  let normalisedBitmapData = formatNormaliser(
    bitmapData,
    metaData,
    options.skipRescale
  );

  metaData.data = normalisedBitmapData;
  metaData.gamma = gamma || 0;

  return metaData;
};
