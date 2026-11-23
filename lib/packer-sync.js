"use strict";

let hasSyncZlib = true;
let zlib = require("zlib");
if (!zlib.deflateSync) {
  hasSyncZlib = false;
}
let constants = require("./constants");
let Packer = require("./packer");

module.exports = function (metaData, opt) {
  if (!hasSyncZlib) {
    throw new Error(
      "To use the sync capability of this library in old node versions, please pin pngjs to v2.3.0"
    );
  }

  let options = opt || {};

  let packer = new Packer(options);

  let chunks = [];

  // Build and validate the pixel data before emitting a single byte, so an
  // illegal size, over-long row or empty input fails before any output.
  let filteredData = packer.filterData(
    metaData.data,
    metaData.width,
    metaData.height
  );

  // Signature
  chunks.push(Buffer.from(constants.PNG_SIGNATURE));

  // Header
  chunks.push(packer.packIHDR(metaData.width, metaData.height));

  if (metaData.gamma) {
    chunks.push(packer.packGAMA(metaData.gamma));
  }

  // compress it
  let compressedData = zlib.deflateSync(
    filteredData,
    packer.getDeflateOptions()
  );
  filteredData = null;

  if (!compressedData || !compressedData.length) {
    throw new Error("bad png - invalid compressed data response");
  }
  chunks.push(packer.packIDAT(compressedData));

  // End
  chunks.push(packer.packIEND());

  return Buffer.concat(chunks);
};
