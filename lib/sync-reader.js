"use strict";

let errors = require("./errors");

let SyncReader = (module.exports = function (buffer) {
  this._buffer = buffer;
  this._reads = [];
});

SyncReader.prototype.read = function (length, callback) {
  this._reads.push({
    length: Math.abs(length), // if length < 0 then at most this length
    allowLess: length < 0,
    func: callback,
  });
};

// Drains the read queue against the buffered input. Throws a coded error when
// the input ends while a fixed-length read is still pending (a truncated
// file), when a read request was left unsatisfied, or when bytes remain after
// the last read was satisfied (trailing data).
SyncReader.prototype.process = function () {
  // as long as there is any data and read requests
  while (this._reads.length > 0 && this._buffer.length) {
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

  if (this._reads.length > 0) {
    // Input ended while a fixed-length read was still pending: the file is
    // truncated (either exactly at a chunk boundary or mid-chunk). The same
    // message is used for both so callers see one deterministic result.
    throw errors.create(errors.CODES.TRUNCATED, "Unexpected end of input");
  }

  if (this._buffer.length > 0) {
    throw errors.create(
      errors.CODES.TRAILING_DATA,
      "Unrecognised content at end of stream"
    );
  }
};

// True when the last process() call consumed input until EOF without errors.
SyncReader.prototype.finished = function () {
  return this._reads.length === 0 && this._buffer.length === 0;
};
