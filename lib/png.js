"use strict";

let util = require("util");
let Stream = require("stream");
let Parser = require("./parser-async");
let Packer = require("./packer-async");
let PNGSync = require("./png-sync");
let PNGError = require("./png-error");

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

  this._parser = new Parser(options);

  this._parser.on("error", this._handleParserError.bind(this));
  this._parser.on("close", this._handleClose.bind(this));
  this._parser.on("metadata", this._metadata.bind(this));
  this._parser.on("gamma", this._gamma.bind(this));
  this._parser.on(
    "parsed",
    function (data) {
      this.data = data;
      // A throwing "parsed" listener must not unwind through the streaming
      // internals (where it would be mistaken for a malformed-file error).
      // Surface it on the error channel after the parser has settled.
      try {
        this.emit("parsed", data);
      } catch (callbackErr) {
        process.nextTick(
          function () {
            this._handleParserError(callbackErr);
          }.bind(this)
        );
      }
    }.bind(this)
  );

  this._packer = new Packer(options);
  this._packer.on("data", this.emit.bind(this, "data"));
  this._packer.on("end", this.emit.bind(this, "end"));
  this._packer.on("error", this._handlePackerError.bind(this));
});
util.inherits(PNG, Stream);

PNG.sync = PNGSync;

// Errors coming from user callbacks (e.g. a "parsed" listener throwing) must
// never leave the parser in a half-open state: surface them on the error
// channel instead of an uncaught exception with dangling streams behind it.
PNG.prototype._handleParserError = function (err) {
  if (this._destroyed) {
    return;
  }
  this.emit("error", err);
};

PNG.prototype._handlePackerError = function (err) {
  if (this._destroyed) {
    return;
  }
  this.emit("error", err);
};

PNG.prototype.pack = function () {
  if (!this.data || !this.data.length) {
    this.emit(
      "error",
      PNGError(PNGError.codes.ERR_PNG_ENCODER_INPUT, "No data provided")
    );
    return this;
  }

  process.nextTick(
    function () {
      if (this._destroyed) {
        return;
      }
      try {
        this._packer.pack(this.data, this.width, this.height, this.gamma);
      } catch (err) {
        this._handlePackerError(err);
      }
    }.bind(this)
  );

  return this;
};

PNG.prototype.parse = function (data, callback) {
  if (callback) {
    let onParsed, onError;

    onParsed = function (parsedData) {
      this.removeListener("error", onError);

      this.data = parsedData;
      try {
        callback(null, this);
      } catch (callbackErr) {
        this._handleParserError(callbackErr);
      }
    }.bind(this);

    onError = function (err) {
      this.removeListener("parsed", onParsed);

      try {
        callback(err, null);
      } catch (callbackErr) {
        // A throwing error callback still has to release the parser; once
        // torn down there is nothing left listening, so the exception is
        // rethrown asynchronously rather than swallowed silently.
        this._parser.destroy();
        if (this.listenerCount("error") > 0) {
          this.emit("error", callbackErr);
        } else {
          process.nextTick(function () {
            throw callbackErr;
          });
        }
      }
    }.bind(this);

    this.once("parsed", onParsed);
    this.once("error", onError);
  }

  this.end(data);
  return this;
};

PNG.prototype.write = function (data) {
  if (this._destroyed) {
    return false;
  }
  this._parser.write(data);
  return true;
};

PNG.prototype.end = function (data) {
  if (this._destroyed) {
    return;
  }
  this._parser.end(data);
};

// Abort an in-flight parse/pack and release every backing stream without
// emitting either "error" or "parsed". Safe to call repeatedly.
PNG.prototype.destroy = function () {
  if (this._destroyed) {
    return this;
  }
  this._destroyed = true;
  this.writable = false;
  this.readable = false;

  if (this._parser && this._parser.destroy) {
    this._parser.destroy();
  }
  if (this._packer && this._packer.destroy) {
    this._packer.destroy();
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
