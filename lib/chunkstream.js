"use strict";

let util = require("util");
let Stream = require("stream");
let errors = require("./errors");

let ChunkStream = (module.exports = function () {
  Stream.call(this);

  this._buffers = [];
  this._buffered = 0;

  this._reads = [];
  this._paused = false;

  this._encoding = "utf8";
  this.writable = true;
});
util.inherits(ChunkStream, Stream);

ChunkStream.prototype.read = function (length, callback) {
  this._reads.push({
    length: Math.abs(length), // if length < 0 then at most this length
    allowLess: length < 0,
    func: callback,
  });

  process.nextTick(
    function () {
      this._process();

      // its paused and there is not enought data then ask for more
      if (this._paused && this._reads && this._reads.length > 0) {
        this._paused = false;

        this.emit("drain");
      }
    }.bind(this)
  );
};

ChunkStream.prototype.write = function (data, encoding) {
  if (!this.writable || this.errord) {
    // After an error the stream is closed; the original error is the one
    // callers should see, so a late write is a silent no-op.
    if (!this.errord) {
      this._handleStreamError(
        errors.create(errors.CODES.STATE, "Stream not writable")
      );
    }
    return false;
  }

  let dataBuffer;
  if (Buffer.isBuffer(data)) {
    dataBuffer = data;
  } else if (data instanceof Uint8Array) {
    dataBuffer = Buffer.from(data);
  } else if (typeof data === "string") {
    dataBuffer = Buffer.from(data, encoding || this._encoding);
  } else {
    // Report bad input through the same coded-error path as every other
    // failure instead of letting Buffer.from throw a raw TypeError.
    this._handleStreamError(
      errors.create(
        errors.CODES.OPTIONS,
        "PNG data must be a Buffer, Uint8Array or string"
      )
    );
    return false;
  }

  this._buffers.push(dataBuffer);
  this._buffered += dataBuffer.length;

  this._process();

  // ok if there are no more read requests
  if (this._reads && this._reads.length === 0) {
    this._paused = true;
  }

  return this.writable && !this._paused;
};

ChunkStream.prototype.end = function (data, encoding) {
  if (data) {
    this.write(data, encoding);
  }

  if (this.errord || !this._buffers) {
    return;
  }

  this.writable = false;

  // already destroyed
  if (!this._buffers) {
    return;
  }

  // enqueue or handle end
  if (this._buffers.length === 0) {
    this._end();
  } else {
    this._buffers.push(null);
    this._process();
  }
};

ChunkStream.prototype.destroySoon = ChunkStream.prototype.end;

ChunkStream.prototype._end = function () {
  if (this._reads && this._reads.length > 0) {
    this._handleStreamError(
      errors.create(errors.CODES.TRUNCATED, "Unexpected end of input")
    );
    return;
  }

  // Any bytes still buffered were never claimed by a read request. The
  // streaming contract stops at IEND, so trailing data is left alone (unlike
  // the whole-Buffer API, which rejects it).
  this.destroy();
};

ChunkStream.prototype.destroy = function () {
  if (!this._buffers) {
    return;
  }

  this.writable = false;
  this._reads = null;
  this._buffers = null;

  this.emit("close");
};

ChunkStream.prototype._processReadAllowingLess = function (read) {
  if (!this._reads || !this._buffers) {
    return;
  }
  // ok there is any data so that we can satisfy this request
  this._reads.shift(); // == read

  // first we need to peek into first buffer
  let smallerBuf = this._buffers[0];

  // ok there is more data than we need
  if (smallerBuf.length > read.length) {
    this._buffered -= read.length;
    this._buffers[0] = smallerBuf.slice(read.length);

    this._callRead(read, smallerBuf.slice(0, read.length));
  } else {
    // ok this is less than maximum length so use it all
    this._buffered -= smallerBuf.length;
    this._buffers.shift(); // == smallerBuf

    this._callRead(read, smallerBuf);
  }
};

ChunkStream.prototype._processRead = function (read) {
  this._reads.shift(); // == read

  let pos = 0;
  let count = 0;
  let data = Buffer.alloc(read.length);

  // create buffer for all data
  while (pos < read.length) {
    let buf = this._buffers[count++];
    let len = Math.min(buf.length, read.length - pos);

    buf.copy(data, pos, 0, len);
    pos += len;

    // last buffer wasn't used all so just slice it and leave
    if (len !== buf.length) {
      this._buffers[--count] = buf.slice(len);
    }
  }

  // remove all used buffers
  if (count > 0) {
    this._buffers.splice(0, count);
  }

  this._buffered -= read.length;

  this._callRead(read, data);
};

ChunkStream.prototype._process = function () {
  if (this.errord) {
    return;
  }
  try {
    // as long as there is any data and read requests
    while (this._buffered > 0 && this._reads && this._reads.length > 0) {
      let read = this._reads[0];

      // read any data (but no more than length)
      if (read.allowLess) {
        this._processReadAllowingLess(read);
      } else if (this._buffered >= read.length) {
        // ok we can meet some expectations

        this._processRead(read);
      } else {
        // not enought data to satisfy first request in queue
        // so we need to wait for more
        break;
      }
    }

    if (this._buffers && !this.writable && !this.errord) {
      this._end();
    }
  } catch (ex) {
    // An exception thrown by a consumer's own listener is the consumer's
    // exception. Re-throwing keeps normal EventEmitter semantics instead of
    // misreporting it as a decode failure (and emitting a second, bogus
    // "error" that would have no listener left).
    if (ex && ex.pngConsumerException) {
      throw ex;
    }
    this._handleStreamError(ex);
  }
};

// Runs a queued read callback. Exceptions are tagged by the code that
// invokes consumer listeners (see ParserAsync._emitToConsumer) so _process
// can tell a real stream failure from a consumer's own thrown exception.
ChunkStream.prototype._callRead = function (read, data) {
  read.func.call(this, data);
};

// Subclasses (the async parser) override this to run their own teardown.
// Without an override the error is simply emitted, matching historical
// behaviour for the plain chunk stream.
ChunkStream.prototype._handleStreamError = function (ex) {
  if (this.errord) {
    return;
  }
  this.errord = true;
  this.emit("error", ex);
};
