"use strict";

let PNGError = require("./png-error");

let SyncReader = (module.exports = function (buffer) {
  this._buffer = buffer;
  this._reads = [];
  this._failed = false;
});

SyncReader.prototype.read = function (length, callback) {
  // After a failure the parser unwinds by enqueuing reads that can never be
  // satisfied; registering them would mask the root error as truncation.
  if (this._failed) {
    return;
  }
  this._reads.push({
    length: Math.abs(length), // if length < 0 then at most this length
    allowLess: length < 0,
    func: callback,
  });
};

SyncReader.prototype.fail = function () {
  this._failed = true;
};

SyncReader.prototype.process = function () {
  // as long as there is any data and read requests
  while (!this._failed && this._reads.length > 0 && this._buffer.length) {
    let read = this._reads[0];

    if (
      this._buffer.length &&
      (this._buffer.length >= read.length || read.allowLess)
    ) {
      // ok there is any data so that we can satisfy this request
      this._reads.shift(); // == read

      let buf = this._buffer;

      this._buffer = buf.slice(read.length);

      read.func.call(this, buf.slice(0, read.length));
    } else {
      break;
    }
  }

  // A structural failure deliberately leaves reads queued while the parser
  // unwinds; that is not a truncation.
  if (this._failed) {
    return;
  }

  if (this._reads.length > 0) {
    throw PNGError(
      PNGError.codes.ERR_PNG_TRUNCATED,
      "There are some read requests waiting on finished stream"
    );
  }

  if (this._buffer.length > 0) {
    throw PNGError(
      PNGError.codes.ERR_PNG_EXTRA_DATA,
      "Unrecognised content at end of stream"
    );
  }
};
