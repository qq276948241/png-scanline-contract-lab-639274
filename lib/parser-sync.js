"use strict";

let hasSyncZlib = true;
let zlib = require("zlib");
let inflateSync = require("./sync-inflate");
if (!zlib.deflateSync) {
  hasSyncZlib = false;
}
let SyncReader = require("./sync-reader");
let FilterSync = require("./filter-parse-sync");
let Parser = require("./parser");
let bitmapper = require("./bitmapper");
let formatNormaliser = require("./format-normaliser");
let validation = require("./validation");
let PNGError = require("./png-error");

module.exports = function (buffer, options) {
  if (!hasSyncZlib) {
    throw new Error(
      "To use the sync capability of this library in old node versions, please pin pngjs to v2.3.0"
    );
  }

  options = options || {};

  let reader = new SyncReader(buffer);

  let err;
  function handleError(_err_) {
    err = _err_;
    // Stop registering further reads so the structural error is not masked
    // by a generic truncation while the parser unwinds.
    reader.fail();
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
  try {
    reader.process();
  } catch (readerErr) {
    // A structural parser error is the root cause; the reader only noticed
    // the stream was exhausted while unwinding it. Report the root cause.
    if (!err) {
      err = readerErr;
    }
  }

  if (err) {
    inflateDataList.length = 0;
    throw err;
  }

  if (!metaData) {
    throw PNGError(
      PNGError.codes.ERR_PNG_TRUNCATED,
      "bad png - stream ended before IHDR was parsed"
    );
  }

  if (inflateDataList.length === 0) {
    throw PNGError(
      PNGError.codes.ERR_PNG_MISSING_IDAT,
      "bad png - no IDAT chunks found"
    );
  }

  //join together the inflate datas
  let inflateData = Buffer.concat(inflateDataList);
  inflateDataList.length = 0;

  let imageSize;
  if (metaData.interlace) {
    imageSize = validation.getInterlacedImageSize(
      metaData.width,
      metaData.height,
      metaData.bpp,
      metaData.depth
    );
  } else {
    imageSize = validation.getImageSize(
      metaData.width,
      metaData.height,
      metaData.bpp,
      metaData.depth
    );
  }

  let inflatedData;
  try {
    inflatedData = inflateSync(inflateData, {
      chunkSize: Math.max(imageSize, zlib.Z_MIN_CHUNK),
      maxLength: imageSize,
    });
  } catch (inflateErr) {
    throw PNGError(
      PNGError.codes.ERR_PNG_INFLATE,
      "bad png - invalid inflate data: " + inflateErr.message
    );
  }

  // The length-capped inflate can silently pad a truncated stream up to the
  // cap. When the output filled the cap exactly, verify the zlib stream is
  // genuinely complete (a truncated/over-long stream fails this check).
  if (inflatedData.length === imageSize) {
    try {
      zlib.inflateSync(inflateData);
    } catch (verifyErr) {
      throw PNGError(
        PNGError.codes.ERR_PNG_INFLATE,
        "bad png - invalid inflate data: " + verifyErr.message
      );
    }
  }
  inflateData = null;

  if (!inflatedData || !inflatedData.length) {
    throw PNGError(
      PNGError.codes.ERR_PNG_INFLATE,
      "bad png - invalid inflate data response"
    );
  }

  if (inflatedData.length !== imageSize) {
    throw PNGError(
      PNGError.codes.ERR_PNG_INFLATE_LENGTH,
      "bad png - inflate data length " +
        inflatedData.length +
        " does not match expected " +
        imageSize
    );
  }

  let unfilteredData;
  try {
    unfilteredData = FilterSync.process(inflatedData, metaData);
  } catch (filterErr) {
    throw PNGError(
      filterErr.code || PNGError.codes.ERR_PNG_FILTER_TYPE,
      "bad png - filter failure: " + filterErr.message
    );
  }
  inflateData = null;

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
