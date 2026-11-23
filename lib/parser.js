"use strict";

let constants = require("./constants");
let CrcCalculator = require("./crc");
let PNGError = require("./png-error");
let validation = require("./validation");

let Parser = (module.exports = function (options, dependencies) {
  this._options = options;
  options.checkCRC = options.checkCRC !== false;

  this._hasIHDR = false;
  this._hasIEND = false;
  this._hasIDAT = false;
  this._hasPLTE = false;
  this._hasTRNS = false;
  this._hasGAMA = false;
  this._emittedHeadersFinished = false;
  this._error = null;

  // input flags/metadata
  this._palette = [];
  this._colorType = 0;

  this._chunks = {};
  this._chunks[constants.TYPE_IHDR] = this._handleIHDR.bind(this);
  this._chunks[constants.TYPE_IEND] = this._handleIEND.bind(this);
  this._chunks[constants.TYPE_IDAT] = this._handleIDAT.bind(this);
  this._chunks[constants.TYPE_PLTE] = this._handlePLTE.bind(this);
  this._chunks[constants.TYPE_tRNS] = this._handleTRNS.bind(this);
  this._chunks[constants.TYPE_gAMA] = this._handleGAMA.bind(this);

  this.read = dependencies.read;
  this.error = this._wrapError(dependencies.error);
  this.metadata = dependencies.metadata;
  this.gamma = dependencies.gamma;
  this.transColor = dependencies.transColor;
  this.palette = dependencies.palette;
  this.parsed = dependencies.parsed;
  this.inflateData = dependencies.inflateData;
  this.finished = dependencies.finished;
  this.simpleTransparency = dependencies.simpleTransparency;
  this.headersFinished = dependencies.headersFinished || function () {};
});

// A single input can only fail once: the first error wins, every later
// failure (including exceptions raised while unwinding the first one) is
// swallowed so error reporting stays deterministic.
Parser.prototype._wrapError = function (errorCallback) {
  let parser = this;
  return function (err) {
    if (parser._error) {
      return;
    }
    parser._error = err;
    errorCallback(err);
  };
};

Parser.prototype.start = function () {
  this.read(constants.PNG_SIGNATURE.length, this._parseSignature.bind(this));
};

Parser.prototype._parseSignature = function (data) {
  let signature = constants.PNG_SIGNATURE;

  for (let i = 0; i < signature.length; i++) {
    if (data[i] !== signature[i]) {
      this.error(
        PNGError(PNGError.codes.ERR_PNG_SIGNATURE, "Invalid file signature")
      );
      return;
    }
  }
  this.read(8, this._parseChunkBegin.bind(this));
};

Parser.prototype._parseChunkBegin = function (data) {
  // chunk content length
  let length = data.readUInt32BE(0);

  try {
    validation.validateChunkLength(length);
  } catch (err) {
    this.error(err);
    return;
  }

  // chunk type
  let type = data.readUInt32BE(4);
  let name = "";
  for (let i = 4; i < 8; i++) {
    const charCode = data[i];
    if (charCode < 65 || charCode > 122 || (charCode > 90 && charCode < 97)) {
      this.error(
        PNGError(PNGError.codes.ERR_PNG_CHUNK_TYPE, "Invalid chunk type")
      );
      return;
    }
    name += String.fromCharCode(charCode);
  }

  //console.log('chunk ', name, length);

  // chunk flags
  let ancillary = Boolean(data[4] & 0x20); // or critical
  //    priv = Boolean(data[5] & 0x20), // or public
  //    safeToCopy = Boolean(data[7] & 0x20); // or unsafe

  if (!this._hasIHDR && type !== constants.TYPE_IHDR) {
    this.error(
      PNGError(
        PNGError.codes.ERR_PNG_CHUNK_ORDER,
        "Expected IHDR to be first chunk"
      )
    );
    return;
  }

  if (this._hasIEND) {
    this.error(
      PNGError(
        PNGError.codes.ERR_PNG_CHUNK_ORDER,
        "Unexpected chunk " + name + " after IEND"
      )
    );
    return;
  }

  this._crc = new CrcCalculator();
  this._crc.write(Buffer.from(name));

  if (this._chunks[type]) {
    return this._chunks[type](length);
  }

  if (!ancillary) {
    this.error(
      PNGError(
        PNGError.codes.ERR_PNG_CHUNK_TYPE,
        "Unsupported critical chunk type " + name
      )
    );
    return;
  }

  this.read(length, this._skipChunk.bind(this, length));
};

// Unknown ancillary chunks still have to be CRC-validated, then advanced
// past exactly (length data bytes + 4 CRC bytes).
Parser.prototype._skipChunk = function (length, data) {
  this._crc.write(data);
  this.read(4, this._parseSkippedChunkEnd.bind(this));
};

Parser.prototype._parseSkippedChunkEnd = function (data) {
  let fileCrc = data.readInt32BE(0);
  let calcCrc = this._crc.crc32();

  if (this._options.checkCRC && calcCrc !== fileCrc) {
    this.error(
      PNGError(
        PNGError.codes.ERR_PNG_CRC,
        "Crc error - " + fileCrc + " - " + calcCrc
      )
    );
    return;
  }

  this.read(8, this._parseChunkBegin.bind(this));
};

Parser.prototype._handleChunkEnd = function () {
  this.read(4, this._parseChunkEnd.bind(this));
};

Parser.prototype._parseChunkEnd = function (data) {
  let fileCrc = data.readInt32BE(0);
  let calcCrc = this._crc.crc32();

  // check CRC
  if (this._options.checkCRC && calcCrc !== fileCrc) {
    this.error(
      PNGError(
        PNGError.codes.ERR_PNG_CRC,
        "Crc error - " + fileCrc + " - " + calcCrc
      )
    );
    return;
  }

  if (!this._hasIEND) {
    this.read(8, this._parseChunkBegin.bind(this));
  }
};

Parser.prototype._handleIHDR = function (length) {
  this.read(length, this._parseIHDR.bind(this));
};
Parser.prototype._parseIHDR = function (data) {
  this._crc.write(data);

  if (data.length < 13) {
    this.error(
      PNGError(
        PNGError.codes.ERR_PNG_CHUNK_LENGTH,
        "IHDR chunk must be exactly 13 bytes"
      )
    );
    return;
  }

  let width = data.readUInt32BE(0);
  let height = data.readUInt32BE(4);
  let depth = data[8];
  let colorType = data[9]; // bits: 1 palette, 2 color, 4 alpha
  let compr = data[10];
  let filter = data[11];
  let interlace = data[12];

  if (this._hasIHDR) {
    this.error(
      PNGError(PNGError.codes.ERR_PNG_DUPLICATE_CHUNK, "Duplicate IHDR chunk")
    );
    return;
  }

  try {
    validation.validateIHDR(
      {
        width: width,
        height: height,
        depth: depth,
        colorType: colorType,
        compression: compr,
        filterMethod: filter,
        interlace: interlace,
      },
      this._options
    );
  } catch (err) {
    this.error(err);
    return;
  }

  this._colorType = colorType;

  let bpp = constants.COLORTYPE_TO_BPP_MAP[this._colorType];

  this._hasIHDR = true;

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

  this._handleChunkEnd();
};

Parser.prototype._handlePLTE = function (length) {
  this.read(length, this._parsePLTE.bind(this));
};
Parser.prototype._parsePLTE = function (data) {
  this._crc.write(data);

  if (this._hasPLTE) {
    this.error(
      PNGError(PNGError.codes.ERR_PNG_DUPLICATE_CHUNK, "Duplicate PLTE chunk")
    );
    return;
  }

  if (this._hasIDAT) {
    this.error(
      PNGError(
        PNGError.codes.ERR_PNG_CHUNK_ORDER,
        "Palette chunk must appear before IDAT"
      )
    );
    return;
  }

  if (data.length === 0 || data.length % 3 !== 0) {
    this.error(
      PNGError(
        PNGError.codes.ERR_PNG_CHUNK_LENGTH,
        "Palette chunk length must be a positive multiple of 3"
      )
    );
    return;
  }

  let entries = data.length / 3;
  if (entries > 256) {
    this.error(
      PNGError(
        PNGError.codes.ERR_PNG_CHUNK_LENGTH,
        "Palette may contain at most 256 entries"
      )
    );
    return;
  }

  this._hasPLTE = true;

  // console.log('Palette:', entries);

  for (let i = 0; i < entries; i++) {
    this._palette.push([data[i * 3], data[i * 3 + 1], data[i * 3 + 2], 0xff]);
  }

  this.palette(this._palette);

  this._handleChunkEnd();
};

Parser.prototype._handleTRNS = function (length) {
  if (this._hasTRNS) {
    this.error(
      PNGError(PNGError.codes.ERR_PNG_DUPLICATE_CHUNK, "Duplicate tRNS chunk")
    );
    return;
  }

  if (this._hasIDAT) {
    this.error(
      PNGError(
        PNGError.codes.ERR_PNG_CHUNK_ORDER,
        "tRNS chunk must appear before IDAT"
      )
    );
    return;
  }

  this._hasTRNS = true;
  this.simpleTransparency();
  this.read(length, this._parseTRNS.bind(this));
};
Parser.prototype._parseTRNS = function (data) {
  this._crc.write(data);

  // palette
  if (this._colorType === constants.COLORTYPE_PALETTE_COLOR) {
    if (this._palette.length === 0) {
      this.error(
        PNGError(
          PNGError.codes.ERR_PNG_TRNS,
          "Transparency chunk must be after palette"
        )
      );
      return;
    }
    if (data.length > this._palette.length) {
      this.error(
        PNGError(
          PNGError.codes.ERR_PNG_TRNS,
          "More transparent colors than palette size"
        )
      );
      return;
    }
    for (let i = 0; i < data.length; i++) {
      this._palette[i][3] = data[i];
    }
    this.palette(this._palette);
  }

  // for colorType 0 (grayscale) and 2 (rgb)
  // there might be one gray/color defined as transparent
  if (this._colorType === constants.COLORTYPE_GRAYSCALE) {
    if (data.length < 2) {
      this.error(
        PNGError(
          PNGError.codes.ERR_PNG_TRNS,
          "tRNS chunk for grayscale must be 2 bytes"
        )
      );
      return;
    }
    // grey, 2 bytes
    this.transColor([data.readUInt16BE(0)]);
  }
  if (this._colorType === constants.COLORTYPE_COLOR) {
    if (data.length < 6) {
      this.error(
        PNGError(
          PNGError.codes.ERR_PNG_TRNS,
          "tRNS chunk for truecolor must be 6 bytes"
        )
      );
      return;
    }
    this.transColor([
      data.readUInt16BE(0),
      data.readUInt16BE(2),
      data.readUInt16BE(4),
    ]);
  }

  this._handleChunkEnd();
};

Parser.prototype._handleGAMA = function (length) {
  this.read(length, this._parseGAMA.bind(this));
};
Parser.prototype._parseGAMA = function (data) {
  this._crc.write(data);

  if (this._hasGAMA) {
    this.error(
      PNGError(PNGError.codes.ERR_PNG_DUPLICATE_CHUNK, "Duplicate gAMA chunk")
    );
    return;
  }

  if (data.length < 4) {
    this.error(
      PNGError(
        PNGError.codes.ERR_PNG_CHUNK_LENGTH,
        "gAMA chunk must be 4 bytes"
      )
    );
    return;
  }

  this._hasGAMA = true;
  this.gamma(data.readUInt32BE(0) / constants.GAMMA_DIVISION);

  this._handleChunkEnd();
};

Parser.prototype._handleIDAT = function (length) {
  if (!this._emittedHeadersFinished) {
    this._emittedHeadersFinished = true;
    this.headersFinished();
  }
  this._hasIDAT = true;
  this.read(-length, this._parseIDAT.bind(this, length));
};
Parser.prototype._parseIDAT = function (length, data) {
  this._crc.write(data);

  if (
    this._colorType === constants.COLORTYPE_PALETTE_COLOR &&
    this._palette.length === 0
  ) {
    this.error(
      PNGError(
        PNGError.codes.ERR_PNG_MISSING_PALETTE,
        "Expected palette not found"
      )
    );
    return;
  }

  this.inflateData(data);
  let leftOverLength = length - data.length;

  if (leftOverLength > 0) {
    this._handleIDAT(leftOverLength);
  } else {
    this._handleChunkEnd();
  }
};

Parser.prototype._handleIEND = function (length) {
  this.read(length, this._parseIEND.bind(this));
};
Parser.prototype._parseIEND = function (data) {
  this._crc.write(data);

  if (data.length !== 0) {
    this.error(
      PNGError(PNGError.codes.ERR_PNG_CHUNK_LENGTH, "IEND chunk must be empty")
    );
    return;
  }

  this._hasIEND = true;
  this._handleChunkEnd();

  if (this.finished) {
    this.finished();
  }
};
