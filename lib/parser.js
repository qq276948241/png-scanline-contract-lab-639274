"use strict";

let constants = require("./constants");
let CrcCalculator = require("./crc");
let errors = require("./errors");
let geometry = require("./geometry");

let Parser = (module.exports = function (options, dependencies) {
  this._options = options;
  options.checkCRC = options.checkCRC !== false;

  this._hasIHDR = false;
  this._hasIEND = false;
  this._hasPLTE = false;
  this._hasTRNS = false;
  this._hasGAMA = false;
  this._hasIDAT = false;
  this._idatFinished = false;
  this._emittedHeadersFinished = false;

  // input flags/metadata
  this._palette = [];
  this._colorType = 0;
  this._depth = 0;

  this._chunks = {};
  this._chunks[constants.TYPE_IHDR] = this._parseIHDR.bind(this);
  this._chunks[constants.TYPE_PLTE] = this._parsePLTE.bind(this);
  this._chunks[constants.TYPE_tRNS] = this._parseTRNS.bind(this);
  this._chunks[constants.TYPE_gAMA] = this._parseGAMA.bind(this);

  // After the first failure no further reads are scheduled, so a host that
  // reacts to the error (async stream teardown) is never asked for more data.
  let read = dependencies.read;
  this.read = function (length, callback) {
    if (this._failed) {
      return;
    }
    read(length, callback);
  }.bind(this);
  this.error = dependencies.error;
  this.metadata = dependencies.metadata;
  this.gamma = dependencies.gamma;
  this.transColor = dependencies.transColor;
  this.palette = dependencies.palette;
  this.inflateData = dependencies.inflateData;
  this.finished = dependencies.finished;
  this.simpleTransparency = dependencies.simpleTransparency;
  this.headersFinished = dependencies.headersFinished || function () {};
});

Parser.prototype.start = function () {
  this.read(constants.PNG_SIGNATURE.length, this._parseSignature.bind(this));
};

// Once an error has been reported the parser stops scheduling further reads,
// so a malformed file produces exactly one, deterministic error instead of a
// follow-up "unexpected end of input" masking the real cause.
Parser.prototype._fail = function (err) {
  if (this._failed) {
    return;
  }
  this._failed = true;
  this.error(err);
};

Parser.prototype._parseSignature = function (data) {
  let signature = constants.PNG_SIGNATURE;

  for (let i = 0; i < signature.length; i++) {
    if (data[i] !== signature[i]) {
      this._fail(
        errors.create(errors.CODES.SIGNATURE, "Invalid file signature")
      );
      return;
    }
  }
  this.read(8, this._parseChunkBegin.bind(this));
};

Parser.prototype._parseChunkBegin = function (data) {
  // chunk content length
  let length = data.readUInt32BE(0);

  // chunk type
  let type = data.readUInt32BE(4);
  let name = "";
  for (let i = 4; i < 8; i++) {
    const charCode = data[i];
    if (charCode < 65 || charCode > 122 || (charCode > 90 && charCode < 97)) {
      this._fail(errors.create(errors.CODES.CHUNK_TYPE, "Invalid chunk type"));
      return;
    }
    name += String.fromCharCode(charCode);
  }

  // Chunk lengths are capped at 2^31-1 by the PNG spec. Reject anything
  // larger before a single byte is allocated for it.
  if (length > geometry.MAX_CHUNK_LENGTH) {
    this._fail(
      errors.create(
        errors.CODES.CHUNK_LENGTH,
        "Invalid chunk length " + length + " for " + name
      )
    );
    return;
  }

  // 32 bit chunk type bit 5 of the first byte marks a chunk ancillary.
  let ancillary = Boolean(data[4] & 0x20);

  if (!this._hasIHDR && type !== constants.TYPE_IHDR) {
    this._fail(
      errors.create(errors.CODES.CHUNK_ORDER, "Expected IHDR to be first chunk")
    );
    return;
  }

  if (this._hasIHDR && type === constants.TYPE_IHDR) {
    this._fail(errors.create(errors.CODES.CHUNK_ORDER, "Duplicate IHDR chunk"));
    return;
  }

  if (this._hasIEND) {
    this._fail(
      errors.create(
        errors.CODES.TRAILING_DATA,
        "Unexpected data after IEND chunk"
      )
    );
    return;
  }

  // Chunks that must be unique in a stream.
  if (type === constants.TYPE_PLTE && this._hasPLTE) {
    this._fail(errors.create(errors.CODES.CHUNK_ORDER, "Duplicate PLTE chunk"));
    return;
  }
  if (type === constants.TYPE_tRNS && this._hasTRNS) {
    this._fail(errors.create(errors.CODES.CHUNK_ORDER, "Duplicate tRNS chunk"));
    return;
  }
  if (type === constants.TYPE_gAMA && this._hasGAMA) {
    this._fail(errors.create(errors.CODES.CHUNK_ORDER, "Duplicate gAMA chunk"));
    return;
  }

  // IDAT data must be a single consecutive run; anything else either means
  // the IDAT stream was cut in two (invalid) or unrelated chunks were
  // inserted between its parts.
  if (type !== constants.TYPE_IDAT && this._hasIDAT && !this._idatFinished) {
    this._idatFinished = true;
  }
  if (type === constants.TYPE_IDAT && this._idatFinished) {
    this._fail(
      errors.create(errors.CODES.CHUNK_ORDER, "IDAT chunks must be consecutive")
    );
    return;
  }

  // PLTE and tRNS carry information the IDAT stream depends on, so they must
  // appear before the first IDAT.
  if (
    (type === constants.TYPE_PLTE || type === constants.TYPE_tRNS) &&
    this._hasIDAT
  ) {
    this._fail(
      errors.create(
        errors.CODES.CHUNK_ORDER,
        name + " chunk must come before IDAT"
      )
    );
    return;
  }

  // Chunks whose payload size is fixed by the specification are rejected
  // before their payload is read, so a file claiming a huge IHDR cannot make
  // the reader even try to buffer it.
  if (type === constants.TYPE_IHDR && length !== 13) {
    this._fail(
      errors.create(
        errors.CODES.IHDR,
        "IHDR chunk must be 13 bytes, found " + length
      )
    );
    return;
  }
  if (type === constants.TYPE_gAMA && length !== 4) {
    this._fail(
      errors.create(errors.CODES.CHUNK_LENGTH, "gAMA chunk must be 4 bytes")
    );
    return;
  }

  this._crc = new CrcCalculator();
  this._crc.write(Buffer.from(name));

  if (type === constants.TYPE_IDAT) {
    return this._handleIDAT(length);
  }
  if (type === constants.TYPE_IEND) {
    return this._handleIEND(length);
  }

  let handler = this._chunks[type];
  if (handler) {
    // Fixed-size payload: buffer it, verify its CRC, and only then interpret
    // the bytes. A corrupted header therefore reports a checksum failure
    // instead of whatever unsupported field the flipped byte lands on.
    return this.read(length, this._verifyThenParse.bind(this, length, handler));
  }

  if (!ancillary) {
    this._fail(
      errors.create(
        errors.CODES.CRITICAL_CHUNK,
        "Unsupported critical chunk type " + name
      )
    );
    return;
  }

  // Unknown ancillary chunk: skip the payload but still validate its CRC.
  this.read(length + 4, this._skipAncillary.bind(this, length));
};

Parser.prototype._verifyThenParse = function (length, handler, data) {
  this._crc.write(data);
  this.read(
    4,
    function (crcBytes) {
      if (!this._verifyChunkCrc(crcBytes)) {
        return;
      }
      handler(data, length);
    }.bind(this)
  );
};

Parser.prototype._skipAncillary = function (length, buffer) {
  // buffer holds payload + 4 CRC bytes.
  this._crc.write(buffer.slice(0, length));
  if (!this._verifyChunkCrc(buffer.slice(length))) {
    return;
  }
  this._nextChunk();
};

Parser.prototype._verifyChunkCrc = function (crcBytes) {
  let fileCrc = crcBytes.readInt32BE(0);
  let calcCrc = this._crc.crc32();

  if (this._options.checkCRC && calcCrc !== fileCrc) {
    this._fail(
      errors.create(
        errors.CODES.CRC,
        "Crc error - " + fileCrc + " - " + calcCrc
      )
    );
    return false;
  }
  return true;
};

Parser.prototype._nextChunk = function () {
  if (this._failed) {
    return;
  }
  this.read(8, this._parseChunkBegin.bind(this));
};

Parser.prototype._parseIHDR = function (data) {
  // Length was validated as the chunk was opened; the payload always has the
  // 13 byte layout the specification defines.
  let width = data.readUInt32BE(0);
  let height = data.readUInt32BE(4);
  let depth = data[8];
  let colorType = data[9]; // bits: 1 palette, 2 color, 4 alpha
  let compr = data[10];
  let filter = data[11];
  let interlace = data[12];

  if (compr !== 0) {
    this._fail(
      errors.create(
        errors.CODES.COMPRESSION,
        "Unsupported compression method " + compr
      )
    );
    return;
  }
  if (filter !== 0) {
    this._fail(
      errors.create(
        errors.CODES.FILTER_METHOD,
        "Unsupported filter method " + filter
      )
    );
    return;
  }
  if (interlace !== 0 && interlace !== 1) {
    this._fail(
      errors.create(
        errors.CODES.INTERLACE,
        "Unsupported interlace method " + interlace
      )
    );
    return;
  }

  let sizeInfo;
  try {
    // Validates the dimension/bit depth/colour type combination and checks
    // the derived sizes against the maximum buffer length. Nothing is
    // allocated here.
    sizeInfo = geometry.validateHeader(width, height, depth, colorType);
  } catch (ex) {
    this._fail(errors.wrap(ex, errors.CODES.IHDR));
    return;
  }

  this._colorType = colorType;
  this._depth = depth;
  this._width = width;
  this._height = height;
  this._interlace = Boolean(interlace);
  this._hasIHDR = true;

  let bpp = sizeInfo.bpp;

  this.metadata({
    width: width,
    height: height,
    depth: depth,
    interlace: Boolean(interlace),
    palette: Boolean(colorType & constants.COLORTYPE_PALETTE),
    color: Boolean(colorType & constants.COLORTYPE_COLOR),
    alpha: Boolean(colorType & constants.COLORTYPE_ALPHA),
    bpp: bpp,
    colorType: colorType,
  });

  this._nextChunk();
};

Parser.prototype._parsePLTE = function (data) {
  let entries = Math.floor(data.length / 3);
  // console.log('Palette:', entries);

  if (
    this._colorType === constants.COLORTYPE_GRAYSCALE ||
    this._colorType === constants.COLORTYPE_ALPHA
  ) {
    this._fail(
      errors.create(
        errors.CODES.PALETTE,
        "PLTE chunk is not allowed for color type " + this._colorType
      )
    );
    return;
  }
  if (data.length === 0 || data.length % 3 !== 0) {
    this._fail(
      errors.create(
        errors.CODES.PALETTE,
        "PLTE chunk length must be a non zero multiple of 3"
      )
    );
    return;
  }
  if (entries > 256) {
    this._fail(
      errors.create(errors.CODES.PALETTE, "PLTE chunk has too many entries")
    );
    return;
  }
  if (this._colorType === constants.COLORTYPE_PALETTE_COLOR) {
    let maxEntries = Math.pow(2, this._depth);
    if (entries > maxEntries) {
      this._fail(
        errors.create(
          errors.CODES.PALETTE,
          "PLTE chunk has more entries than the bit depth allows"
        )
      );
      return;
    }
  }

  for (let i = 0; i < entries; i++) {
    this._palette.push([data[i * 3], data[i * 3 + 1], data[i * 3 + 2], 0xff]);
  }

  this._hasPLTE = true;
  this.palette(this._palette);

  this._nextChunk();
};

Parser.prototype._parseTRNS = function (data) {
  // palette
  if (this._colorType === constants.COLORTYPE_PALETTE_COLOR) {
    if (this._palette.length === 0) {
      this._fail(
        errors.create(
          errors.CODES.TRANSPARENCY,
          "Transparency chunk must be after palette"
        )
      );
      return;
    }
    if (data.length === 0 || data.length > this._palette.length) {
      this._fail(
        errors.create(
          errors.CODES.TRANSPARENCY,
          "More transparent colors than palette size"
        )
      );
      return;
    }
    for (let i = 0; i < data.length; i++) {
      this._palette[i][3] = data[i];
    }
    this._hasTRNS = true;
    this.simpleTransparency();
    this.palette(this._palette);
    this._nextChunk();
    return;
  }

  // for colorType 0 (grayscale) and 2 (rgb)
  // there might be one gray/color defined as transparent
  if (this._colorType === constants.COLORTYPE_GRAYSCALE) {
    // grey, 2 bytes
    if (data.length !== 2) {
      this._fail(
        errors.create(
          errors.CODES.TRANSPARENCY,
          "tRNS chunk for grayscale images must be 2 bytes"
        )
      );
      return;
    }
    this.transColor([data.readUInt16BE(0)]);
  } else if (this._colorType === constants.COLORTYPE_COLOR) {
    if (data.length !== 6) {
      this._fail(
        errors.create(
          errors.CODES.TRANSPARENCY,
          "tRNS chunk for truecolor images must be 6 bytes"
        )
      );
      return;
    }
    this.transColor([
      data.readUInt16BE(0),
      data.readUInt16BE(2),
      data.readUInt16BE(4),
    ]);
  } else {
    // 4 and 6 already carry an alpha channel; a tRNS chunk is invalid there.
    this._fail(
      errors.create(
        errors.CODES.TRANSPARENCY,
        "tRNS chunk is not allowed for color type " + this._colorType
      )
    );
    return;
  }

  this._hasTRNS = true;
  this.simpleTransparency();
  this._nextChunk();
};

Parser.prototype._parseGAMA = function (data) {
  this._hasGAMA = true;
  this.gamma(data.readUInt32BE(0) / constants.GAMMA_DIVISION);

  this._nextChunk();
};

Parser.prototype._handleIDAT = function (length) {
  if (!this._emittedHeadersFinished) {
    this._emittedHeadersFinished = true;

    if (
      this._colorType === constants.COLORTYPE_PALETTE_COLOR &&
      this._palette.length === 0
    ) {
      this._fail(
        errors.create(errors.CODES.PALETTE, "Expected palette not found")
      );
      return;
    }

    this.headersFinished();
  }

  this._hasIDAT = true;
  this.read(-length, this._parseIDAT.bind(this, length));
};

Parser.prototype._parseIDAT = function (length, data) {
  this._crc.write(data);

  this.inflateData(data);
  let leftOverLength = length - data.length;

  if (leftOverLength > 0) {
    this._handleIDAT(leftOverLength);
  } else {
    this.read(4, this._parseIDATEnd.bind(this));
  }
};

Parser.prototype._parseIDATEnd = function (crcBytes) {
  if (!this._verifyChunkCrc(crcBytes)) {
    return;
  }
  this._nextChunk();
};

Parser.prototype._handleIEND = function (length) {
  if (length !== 0) {
    this._fail(
      errors.create(errors.CODES.CHUNK_LENGTH, "IEND chunk must be empty")
    );
    return;
  }
  this.read(4, this._parseIENDEnd.bind(this));
};

Parser.prototype._parseIENDEnd = function (crcBytes) {
  if (!this._verifyChunkCrc(crcBytes)) {
    return;
  }

  if (!this._hasIDAT) {
    this._fail(errors.create(errors.CODES.NO_DATA, "No IDAT chunks found"));
    return;
  }

  // IEND only counts once its CRC has been accepted, so callers watching for
  // it never treat a corrupt terminator as success.
  this._hasIEND = true;
  this._idatFinished = true;

  if (this.finished) {
    this.finished();
  }
};
