"use strict";

// Every error raised while decoding or encoding a PNG carries a stable
// `code`. Codes never change for a given failure mode; messages stay close
// to the historical pngjs wording where one already existed. That makes the
// failure branch of a malformed input distinguishable and repeatable.
let CODES = {
  SIGNATURE: "ERR_PNG_SIGNATURE",
  CHUNK_TYPE: "ERR_PNG_CHUNK_TYPE",
  CHUNK_LENGTH: "ERR_PNG_CHUNK_LENGTH",
  CHUNK_ORDER: "ERR_PNG_CHUNK_ORDER",
  CRC: "ERR_PNG_CRC",
  TRUNCATED: "ERR_PNG_TRUNCATED",
  TRAILING_DATA: "ERR_PNG_TRAILING_DATA",
  CRITICAL_CHUNK: "ERR_PNG_CRITICAL_CHUNK",
  IHDR: "ERR_PNG_IHDR",
  DIMENSIONS: "ERR_PNG_DIMENSIONS",
  BIT_DEPTH: "ERR_PNG_BIT_DEPTH",
  COLOR_TYPE: "ERR_PNG_COLOR_TYPE",
  COMPRESSION: "ERR_PNG_COMPRESSION",
  FILTER_METHOD: "ERR_PNG_FILTER_METHOD",
  INTERLACE: "ERR_PNG_INTERLACE",
  PALETTE: "ERR_PNG_PALETTE",
  TRANSPARENCY: "ERR_PNG_TRANSPARENCY",
  FILTER_TYPE: "ERR_PNG_FILTER_TYPE",
  INFLATE: "ERR_PNG_INFLATE",
  DATA_SIZE: "ERR_PNG_DATA_SIZE",
  NO_DATA: "ERR_PNG_NO_DATA",
  OPTIONS: "ERR_PNG_OPTIONS",
  STATE: "ERR_PNG_STATE",
  INTERNAL: "ERR_PNG_INTERNAL",
};

function create(code, message, properties) {
  let err = new Error(message);
  err.code = code;
  if (properties) {
    for (let key of Object.keys(properties)) {
      // `cause` keeps the original engine error (zlib, Buffer, ...) reachable
      // without folding its text into the stable message.
      err[key] = properties[key];
    }
  }
  return err;
}

function isPngError(err) {
  return Boolean(
    err && typeof err.code === "string" && err.code.indexOf("ERR_PNG_") === 0
  );
}

function wrap(err, code, message) {
  if (isPngError(err)) {
    return err;
  }
  let text = message || (err && err.message) || String(err);
  return create(code, text, { cause: err });
}

module.exports = {
  CODES: CODES,
  create: create,
  isPngError: isPngError,
  wrap: wrap,
};
