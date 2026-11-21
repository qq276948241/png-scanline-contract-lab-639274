"use strict";

let util = require("util");
let Stream = require("stream");
let Parser = require("./parser-async");
let Packer = require("./packer-async");
let PNGSync = require("./png-sync");
let errors = require("./errors");

let PNG = (exports.PNG = function (options) {
  Stream.call(this);

  options = options || {}; // eslint-disable-line no-param-reassign

  // coerce pixel dimensions to integers (also coerces undefined -> 0):
  this.width = options.width | 0;
  this.height = options.height | 0;

  this.data =
    this.width > 0 && this.height > 0
      ? Buffer.alloc(4 * this.width * this.height)
      : null;

  if (options.fill && this.data) {
    this.data.fill(0);
  }

  this.gamma = 0;
  this.readable = this.writable = true;
  this._destroyed = false;
  // Guards against a pack() call while the async packer is mid-flight: the
  // same PNG instance can produce exactly one output stream at a time.
  this._packing = false;

  this._parser = new Parser(options);

  this._parser.on("error", this.emit.bind(this, "error"));
  this._parser.on("close", this._handleClose.bind(this));
  this._parser.on("metadata", this._metadata.bind(this));
  this._parser.on("gamma", this._gamma.bind(this));
  this._parser.on(
    "parsed",
    function (data) {
      this.data = data;
      this.emit("parsed", data);
    }.bind(this)
  );

  this._packer = new Packer(options);
  this._packer.on("data", this.emit.bind(this, "data"));
  this._packer.on("end", this.emit.bind(this, "end"));
  this._parser.on("close", this._handleClose.bind(this));
  this._packer.on("error", this.emit.bind(this, "error"));
});
util.inherits(PNG, Stream);

PNG.sync = PNGSync;

PNG.prototype.pack = function () {
  if (this._destroyed) {
    return this;
  }
  if (!this.data || !this.data.length) {
    this.emit("error", errors.create(errors.CODES.NO_DATA, "No data provided"));
    return this;
  }
  if (this._packing) {
    this.emit(
      "error",
      errors.create(errors.CODES.STATE, "Packing already in progress")
    );
    return this;
  }
  this._packing = true;

  process.nextTick(
    function () {
      if (this._destroyed) {
        this._packing = false;
        return;
      }
      try {
        this._packer.pack(this.data, this.width, this.height, this.gamma);
      } catch (ex) {
        this._packing = false;
        // Packer validation runs before any bytes are written; surface it
        // through the normal error event rather than an uncaught throw from
        // a nextTick callback.
        this.emit("error", errors.wrap(ex, errors.CODES.OPTIONS));
      }
    }.bind(this)
  );

  return this;
};

PNG.prototype.parse = function (data, callback) {
  if (callback) {
    let onParsed,
      onError,
      called = false;

    let done = function (err, parsed) {
      if (called) {
        return;
      }
      called = true;
      callback(err, parsed);
    };

    onParsed = function (parsedData) {
      this.removeListener("error", onError);

      this.data = parsedData;
      done(null, this);
    }.bind(this);

    onError = function (err) {
      this.removeListener("parsed", onParsed);

      // Errors emitted on a stream are strings in some legacy paths; the
      // callback contract is an Error instance, so normalise here.
      done(err instanceof Error ? err : new Error(String(err)), null);
    }.bind(this);

    this.once("parsed", onParsed);
    this.once("error", onError);
  }

  try {
    this.end(data);
  } catch (ex) {
    // A synchronous throw (for example a non-Buffer argument) must reach the
    // caller the same way an emitted error would.
    process.nextTick(
      function () {
        this.emit("error", errors.wrap(ex, errors.CODES.INTERNAL));
      }.bind(this)
    );
  }
  return this;
};

PNG.prototype.write = function (data) {
  this._parser.write(data);
  return true;
};

PNG.prototype.end = function (data) {
  this._parser.end(data);
};

// Cancels a running parse and releases the zlib/filter machinery without
// emitting an error. Safe to call more than once, and safe to call after the
// stream already finished.
PNG.prototype.destroy = function () {
  if (this._destroyed) {
    return this;
  }
  this._destroyed = true;
  this.readable = this.writable = false;

  if (this._parser && this._parser.abort) {
    this._parser.abort();
  }
  if (this._packer && this._packer.abort) {
    this._packer.abort();
  }
  return this;
};

PNG.prototype._metadata = function (metadata) {
  this.width = metadata.width;
  this.height = metadata.height;

  this.emit("metadata", metadata);
};

PNG.prototype._gamma = function (gamma) {
  this.gamma = gamma;
};

PNG.prototype._handleClose = function () {
  if (!this._parser.writable && !this._packer.readable) {
    this.emit("close");
  }
};

PNG.bitblt = function (src, dst, srcX, srcY, width, height, deltaX, deltaY) {
  // eslint-disable-line max-params
  // coerce pixel dimensions to integers (also coerces undefined -> 0):
  /* eslint-disable no-param-reassign */
  srcX |= 0;
  srcY |= 0;
  width |= 0;
  height |= 0;
  deltaX |= 0;
  deltaY |= 0;
  /* eslint-enable no-param-reassign */

  if (
    srcX > src.width ||
    srcY > src.height ||
    srcX + width > src.width ||
    srcY + height > src.height
  ) {
    throw new Error("bitblt reading outside image");
  }

  if (
    deltaX > dst.width ||
    deltaY > dst.height ||
    deltaX + width > dst.width ||
    deltaY + height > dst.height
  ) {
    throw new Error("bitblt writing outside image");
  }

  for (let y = 0; y < height; y++) {
    src.data.copy(
      dst.data,
      ((deltaY + y) * dst.width + deltaX) << 2,
      ((srcY + y) * src.width + srcX) << 2,
      ((srcY + y) * src.width + srcX + width) << 2
    );
  }
};

PNG.prototype.bitblt = function (
  dst,
  srcX,
  srcY,
  width,
  height,
  deltaX,
  deltaY
) {
  // eslint-disable-line max-params

  PNG.bitblt(this, dst, srcX, srcY, width, height, deltaX, deltaY);
  return this;
};

PNG.adjustGamma = function (src) {
  if (src.gamma) {
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        let idx = (src.width * y + x) << 2;

        for (let i = 0; i < 3; i++) {
          let sample = src.data[idx + i] / 255;
          sample = Math.pow(sample, 1 / 2.2 / src.gamma);
          src.data[idx + i] = Math.round(sample * 255);
        }
      }
    }
    src.gamma = 0;
  }
};

PNG.prototype.adjustGamma = function () {
  PNG.adjustGamma(this);
};
