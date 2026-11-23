"use strict";

let util = require("util");
let Stream = require("stream");
let constants = require("./constants");
let Packer = require("./packer");

let PackerAsync = (module.exports = function (opt) {
  Stream.call(this);

  let options = opt || {};

  this._packer = new Packer(options);
  this._deflate = this._packer.createDeflate();

  this.readable = true;
});
util.inherits(PackerAsync, Stream);

PackerAsync.prototype.destroy = function () {
  if (this._deflate && this._deflate.destroy) {
    this._deflate.destroy();
  }
};

PackerAsync.prototype.pack = function (data, width, height, gamma) {
  // Validate before any byte is emitted, so an illegal size, over-long row
  // or empty input surfaces as an "error", not a half-written PNG stream.
  let filteredData = this._packer.filterData(data, width, height);

  // Signature
  this.emit("data", Buffer.from(constants.PNG_SIGNATURE));
  this.emit("data", this._packer.packIHDR(width, height));

  if (gamma) {
    this.emit("data", this._packer.packGAMA(gamma));
  }

  // compress it
  this._deflate.on("error", this.emit.bind(this, "error"));

  this._deflate.on(
    "data",
    function (compressedData) {
      this.emit("data", this._packer.packIDAT(compressedData));
    }.bind(this)
  );

  this._deflate.on(
    "end",
    function () {
      this.emit("data", this._packer.packIEND());
      this.emit("end");
    }.bind(this)
  );

  this._deflate.end(filteredData);
};
