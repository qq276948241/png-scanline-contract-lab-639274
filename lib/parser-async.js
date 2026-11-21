"use strict";

let util = require("util");
let zlib = require("zlib");
let ChunkStream = require("./chunkstream");
let FilterAsync = require("./filter-parse-async");
let Parser = require("./parser");
let bitmapper = require("./bitmapper");
let formatNormaliser = require("./format-normaliser");
let errors = require("./errors");
let geometry = require("./geometry");

let ParserAsync = (module.exports = function (options) {
  ChunkStream.call(this);

  this._parser = new Parser(options, {
    read: this.read.bind(this),
    error: this._handleError.bind(this),
    metadata: this._handleMetaData.bind(this),
    gamma: this._emitToConsumer.bind(this, "gamma"),
    palette: this._handlePalette.bind(this),
    transColor: this._handleTransColor.bind(this),
    finished: this._finished.bind(this),
    inflateData: this._inflateData.bind(this),
    simpleTransparency: this._simpleTransparency.bind(this),
    headersFinished: this._headersFinished.bind(this),
  });
  this._options = options;
  this.writable = true;

  this._parser.start();
});
util.inherits(ParserAsync, ChunkStream);

ParserAsync.prototype._handleError = function (err) {
  // Every failure is reported once, as an Error carrying a stable code.
  // Anything already reported (or arriving after a cancellation) is dropped
  // so that a single bad input cannot produce two different errors.
  if (this.errord) {
    return;
  }
  this.errord = true;
  this.writable = false;

  let error = errors.isPngError(err)
    ? err
    : errors.wrap(err, errors.CODES.INTERNAL);

  this._emitToConsumer("error", error);

  this._destroyInflate();
  this._destroyFilter();

  this.destroy();
};

// Errors raised while draining the internal chunk stream (truncated input,
// trailing bytes, a filter throwing while inflate is pumping data) take the
// same path as parser errors so they too get a code and full teardown.
ParserAsync.prototype._handleStreamError = function (err) {
  this._handleError(err);
};

// Emits to consumer listeners, marking any exception they throw so the chunk
// stream's drain loop re-throws it instead of interpreting it as a decode
// failure.
ParserAsync.prototype._emitToConsumer = function () {
  try {
    return this.emit.apply(this, arguments);
  } catch (ex) {
    if (ex && typeof ex === "object" && !errors.isPngError(ex)) {
      ex.pngConsumerException = true;
    }
    throw ex;
  }
};

ParserAsync.prototype._destroyInflate = function () {
  if (this._inflate) {
    let inflate = this._inflate;
    this._inflate = null;
    if (inflate.destroy) {
      inflate.destroy();
    }
    // Detach the data pump before destroying so pending zlib callbacks
    // cannot push bytes into a destroyed filter.
    inflate.removeAllListeners("data");
  }
};

ParserAsync.prototype._destroyFilter = function () {
  if (this._filter) {
    let filter = this._filter;
    this._filter = null;
    // Suppress errors due to _inflate calling write() after destroy().
    filter.on("error", function () {});
    filter.destroy();
  }
};

ParserAsync.prototype._inflateData = function (data) {
  if (this.errord) {
    return;
  }

  if (!this._inflate) {
    let imageSize = this._expectedSize;
    // The inflate buffer is only a read window over the stream, so it is
    // capped independently of the declared image size: a header advertising
    // a gigabyte-sized image must not make zlib allocate a gigabyte before
    // any image data has been seen.
    let chunkSize = Math.min(
      Math.max(imageSize, zlib.Z_MIN_CHUNK),
      zlib.Z_MIN_CHUNK * 16
    );

    let inflate = zlib.createInflate({ chunkSize: chunkSize });
    this._inflate = inflate;
    this._leftToInflate = imageSize;

    inflate.on(
      "error",
      function (err) {
        // zlib reports a corrupt deflate stream; report it with the same code
        // the sync path uses instead of a generic internal error.
        this._handleError(
          errors.wrap(
            err,
            errors.CODES.INFLATE,
            "bad png - invalid inflate data response"
          )
        );
      }.bind(this)
    );

    this._filter.on("complete", this._complete.bind(this));

    inflate.on(
      "data",
      function (chunk) {
        if (this.errord) {
          return;
        }

        let left = this._leftToInflate;
        if (chunk.length > left) {
          // More inflated bytes than the header says the image can contain.
          // Report it immediately, before the filter (and therefore the
          // "parsed" event) can see a complete image, so a stream that is
          // merely corrupt is never reported as successfully decoded.
          this._handleError(
            errors.create(
              errors.CODES.DATA_SIZE,
              "bad png - too much image data"
            )
          );
          return;
        }
        this._leftToInflate -= chunk.length;
        if (chunk.length > 0) {
          this._filter.write(chunk);
        }
      }.bind(this)
    );

    inflate.on("end", this._handleInflateEnd.bind(this));
  }
  this._inflate.write(data);
};

ParserAsync.prototype._handleInflateEnd = function () {
  if (this.errord) {
    return;
  }

  if (this._leftToInflate > 0) {
    // The deflate stream finished before all scanlines were produced.
    this._handleError(
      errors.create(errors.CODES.DATA_SIZE, "bad png - not enough image data")
    );
    return;
  }

  this._filter.end();
};

ParserAsync.prototype._handleMetaData = function (metaData) {
  this._metaData = metaData;
  this._bitmapInfo = Object.create(metaData);

  try {
    // The parser already validated the header; this re-checks the derived
    // pass sizes so interlaced images cannot allocate beyond the limit.
    this._expectedSize = geometry.validateImageSize(metaData);
  } catch (ex) {
    this._handleError(ex);
    return;
  }

  this._filter = new FilterAsync(this._bitmapInfo);
  this._filter.on("error", this._handleError.bind(this));
};

ParserAsync.prototype._handleTransColor = function (transColor) {
  if (this._bitmapInfo) {
    this._bitmapInfo.transColor = transColor;
  }
  if (this._metaData) {
    this._metaData.transColor = transColor;
  }
};

ParserAsync.prototype._handlePalette = function (palette) {
  if (this._bitmapInfo) {
    this._bitmapInfo.palette = palette;
  }
  // The sync entry point returns the palette array in `palette`; mirror that
  // on the async path so both APIs expose the same metadata shape.
  if (this._metaData) {
    this._metaData.palette = palette;
  }
};

ParserAsync.prototype._simpleTransparency = function () {
  this._metaData.alpha = true;
};

ParserAsync.prototype._headersFinished = function () {
  // Up until this point, we don't know if we have a tRNS chunk (alpha)
  // so we can't emit metadata any earlier
  this._emitToConsumer("metadata", this._metaData);
};

ParserAsync.prototype._finished = function () {
  if (this.errord) {
    return;
  }

  if (!this._inflate) {
    this._handleError(errors.create(errors.CODES.NO_DATA, "No Inflate block"));
    return;
  }

  // IEND and its checksum have been accepted. Only now can a decode be
  // reported as successful (see _emitParsedIfComplete).
  this._reachedEnd = true;

  // no more data to inflate; parsed is emitted once the filter has seen the
  // whole image (see _emitParsedIfComplete).
  this._inflate.end();
  // The filter may already have produced every scanline before the trailing
  // chunks arrived, in which case this is the moment "parsed" becomes valid.
  this._emitParsedIfComplete();
};

ParserAsync.prototype._complete = function (filteredData) {
  if (this.errord) {
    return;
  }

  let expected = geometry.unfilteredSize(this._bitmapInfo);
  if (filteredData.length !== expected) {
    this._handleError(
      errors.create(
        errors.CODES.DATA_SIZE,
        "bad png - unexpected amount of image data"
      )
    );
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
    this._handleError(ex);
    return;
  }

  this._completedData = normalisedBitmapData;
  this._emitParsedIfComplete();
};

// The scanlines are fully known as soon as the filter has seen them, which
// happens before the trailing chunks (and therefore their CRCs) have been
// validated. "parsed" is held back until IEND has been accepted so a stream
// with a corrupt IDAT CRC or a missing IEND fails instead of reporting a
// successful decode; this matches the whole-Buffer entry point.
ParserAsync.prototype._emitParsedIfComplete = function () {
  if (this.errord || this._parsedEmitted) {
    return;
  }
  if (this._completedData === undefined) {
    return;
  }
  if (!this._reachedEnd) {
    return;
  }
  this._parsedEmitted = true;
  let data = this._completedData;
  this._completedData = undefined;
  this._emitToConsumer("parsed", data);
  this._maybeFinishStream();
};

// The decode is fully validated (image data and IEND CRC) at this point. The
// stream is closed here rather than in the parser's finished() callback so
// teardown happens after the last consumer event.
ParserAsync.prototype._maybeFinishStream = function () {
  if (this._streamEnded) {
    return;
  }
  this._streamEnded = true;
  this.writable = false;
  this.destroy();
};

// Cancels an in-flight decode (for example from PNG#destroy) without
// emitting an error or leaving pending read requests behind.
ParserAsync.prototype.abort = function () {
  if (this.errord) {
    return;
  }
  this.errord = true;
  this.writable = false;
  this._destroyInflate();
  this._destroyFilter();
  this.destroy();
};
