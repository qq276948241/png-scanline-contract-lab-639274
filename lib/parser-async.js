"use strict";

let util = require("util");
let zlib = require("zlib");
let ChunkStream = require("./chunkstream");
let FilterAsync = require("./filter-parse-async");
let Parser = require("./parser");
let bitmapper = require("./bitmapper");
let formatNormaliser = require("./format-normaliser");
let validation = require("./validation");
let PNGError = require("./png-error");

let ParserAsync = (module.exports = function (options) {
  ChunkStream.call(this);

  this._options = options;
  this._destroyed = false;
  this.errord = false;

  this._parser = new Parser(options, {
    read: this.read.bind(this),
    error: this._handleError.bind(this),
    metadata: this._handleMetaData.bind(this),
    gamma: this.emit.bind(this, "gamma"),
    palette: this._handlePalette.bind(this),
    transColor: this._handleTransColor.bind(this),
    finished: this._finished.bind(this),
    inflateData: this._inflateData.bind(this),
    simpleTransparency: this._simpleTransparency.bind(this),
    headersFinished: this._headersFinished.bind(this),
  });
  this.writable = true;

  this._parser.start();
});
util.inherits(ParserAsync, ChunkStream);

ParserAsync.prototype._handleError = function (err) {
  if (this.errord || this._destroyed) {
    return;
  }

  this.errord = true;
  // fail() marks the structural failure and releases every backing stream
  // synchronously, so this error cannot be followed by a truncation error or
  // leave a dangling handle.
  this.fail();
  this.emit("error", err);
};

// Called both by structural parser failures and by the underlying chunk
// stream when it hits an unexpected EOF, so all error paths converge here.
ParserAsync.prototype.fail = function () {
  ChunkStream.prototype.fail.call(this);
  this.errord = true;
  this._releaseStreams();
};

// Shared teardown for both error handling and explicit cancellation.
ParserAsync.prototype._releaseStreams = function () {
  this.writable = false;

  if (this._inflate && this._inflate.destroy) {
    this._inflate.destroy();
  }

  if (this._filter) {
    this._filter.destroy();
    // For backward compatibility with Node 7 and below.
    // Suppress errors due to _inflate calling write() even after
    // it's destroy()'ed.
    this._filter.on("error", function () {});
  }

  ChunkStream.prototype._closeStream.call(this);
};

// Tear everything down without emitting either "parsed" or "error".
// Used when the consumer cancels an in-flight parse.
ParserAsync.prototype.destroy = function () {
  if (this._destroyed) {
    return;
  }
  this._destroyed = true;

  this._releaseStreams();
};

ParserAsync.prototype._getExpectedImageSize = function () {
  let info = this._bitmapInfo;
  if (info.interlace) {
    return validation.getInterlacedImageSize(
      info.width,
      info.height,
      info.bpp,
      info.depth
    );
  }
  return validation.getImageSize(info.width, info.height, info.bpp, info.depth);
};

ParserAsync.prototype._inflateData = function (data) {
  if (!this._inflate) {
    let imageSize = this._getExpectedImageSize();
    let chunkSize = Math.max(imageSize, zlib.Z_MIN_CHUNK);

    this._inflate = zlib.createInflate({ chunkSize: chunkSize });
    let leftToInflate = imageSize;

    let emitError = this._handleError.bind(this);
    this._inflate.on("error", function (err) {
      if (!leftToInflate) {
        return;
      }

      emitError(
        PNGError(
          PNGError.codes.ERR_PNG_INFLATE,
          "bad png - invalid inflate data: " + err.message
        )
      );
    });
    this._filter.on("complete", this._complete.bind(this));
    // A truncated zlib stream can end successfully while leaving the
    // filter waiting for more scan lines; route that through the same
    // error channel instead of crashing on an unhandled "error".
    this._filter.on("error", function (err) {
      emitError(
        PNGError(
          err.code || PNGError.codes.ERR_PNG_TRUNCATED,
          "bad png - truncated filtered data: " + err.message
        )
      );
    });

    let filterWrite = this._filter.write.bind(this._filter);
    this._inflate.on("data", (chunk) => {
      if (this.errord || this._destroyed) {
        return;
      }

      if (chunk.length > leftToInflate) {
        this._handleError(
          PNGError(
            PNGError.codes.ERR_PNG_INFLATE_LENGTH,
            "bad png - inflate produced more data than the IHDR allows"
          )
        );
        return;
      }

      leftToInflate -= chunk.length;

      filterWrite(chunk);
    });

    this._inflate.on("end", () => {
      if (this.errord || this._destroyed) {
        return;
      }
      this._filter.end();
    });
  }
  this._inflate.write(data);
};

ParserAsync.prototype._handleMetaData = function (metaData) {
  this._metaData = metaData;
  this._bitmapInfo = Object.create(metaData);

  this._filter = new FilterAsync(this._bitmapInfo);
};

ParserAsync.prototype._handleTransColor = function (transColor) {
  this._bitmapInfo.transColor = transColor;
};

ParserAsync.prototype._handlePalette = function (palette) {
  this._bitmapInfo.palette = palette;
};

ParserAsync.prototype._simpleTransparency = function () {
  this._metaData.alpha = true;
};

ParserAsync.prototype._headersFinished = function () {
  // Up until this point, we don't know if we have a tRNS chunk (alpha)
  // so we can't emit metadata any earlier
  this.emit("metadata", this._metaData);
};

ParserAsync.prototype._finished = function () {
  if (this.errord || this._destroyed) {
    return;
  }

  if (!this._inflate) {
    this._handleError(
      PNGError(
        PNGError.codes.ERR_PNG_MISSING_IDAT,
        "bad png - no IDAT chunks found"
      )
    );
  } else {
    // no more data to inflate
    this._inflate.end();
  }
};

ParserAsync.prototype._complete = function (filteredData) {
  if (this.errord || this._destroyed) {
    return;
  }

  let normalisedBitmapData;

  try {
    let bitmapData = bitmapper.dataToBitMap(filteredData, this._bitmapInfo);

    normalisedBitmapData = formatNormaliser(
      bitmapData,
      this._bitmapInfo,
      this._options.skipRescale
    );
    bitmapData = null;
  } catch (ex) {
    this._handleError(
      ex.code
        ? ex
        : PNGError(
            PNGError.codes.ERR_PNG_TRUNCATED,
            "bad png - bitmap mapping failed: " + ex.message
          )
    );
    return;
  }

  this.emit("parsed", normalisedBitmapData);
};
