"use strict";

let util = require("util");
let Stream = require("stream");
let constants = require("./constants");
let Packer = require("./packer");
let errors = require("./errors");

let PackerAsync = (module.exports = function (opt) {
  Stream.call(this);

  let options = opt || {};

  this._packer = new Packer(options);
  this._deflate = null;
  this._destroyed = false;

  this.readable = true;
});
util.inherits(PackerAsync, Stream);

PackerAsync.prototype.pack = function (data, width, height, gamma) {
  // Validation happens before any data event so a rejected image never emits
  // a truncated (but syntactically valid) PNG.
  this._packer.validate(data, width, height);

  let deflate;
  try {
    deflate = this._packer.createDeflate();
  } catch (ex) {
    this._fail(errors.wrap(ex, errors.CODES.OPTIONS));
    return;
  }
  this._deflate = deflate;

  // Signature
  this.emit("data", Buffer.from(constants.PNG_SIGNATURE));
  this.emit("data", this._packer.packIHDR(width, height));

  if (gamma) {
    this.emit("data", this._packer.packGAMA(gamma));
  }

  let filteredData;
  try {
    filteredData = this._packer.filterData(data, width, height);
  } catch (ex) {
    this._fail(ex);
    return;
  }

  deflate.on("error", this._fail.bind(this));

  deflate.on(
    "data",
    function (compressedData) {
      if (this._destroyed) {
        return;
      }
      this.emit("data", this._packer.packIDAT(compressedData));
    }.bind(this)
  );

  deflate.on(
    "end",
    function () {
      if (this._destroyed) {
        return;
      }
      this.emit("data", this._packer.packIEND());
      this.emit("end");
    }.bind(this)
  );

  deflate.end(filteredData);
};

PackerAsync.prototype._fail = function (err) {
  if (this._destroyed) {
    return;
  }
  this._destroyed = true;
  this.readable = false;

  this.emit("error", errors.isPngError(err) ? err : errors.wrap(err));

  if (this._deflate && this._deflate.destroy) {
    this._deflate.destroy();
  }
};

// Cancels an in-flight encode: no further data/end events are emitted and the
// underlying deflate stream is released.
PackerAsync.prototype.abort = function () {
  if (this._destroyed) {
    return;
  }
  this._destroyed = true;
  this.readable = false;
  if (this._deflate && this._deflate.destroy) {
    this._deflate.destroy();
  }
};
