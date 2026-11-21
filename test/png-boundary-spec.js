"use strict";

// Boundary, parity and round-trip coverage for the public decode/encode
// entry points (PNG.sync.read, PNG.sync.write, and the stream API).
//
// Design notes:
//  * Fixtures are built by test/fixtures/png-builder.js, which writes PNGs
//    from the specification and shares no code with lib/ (only the CRC table
//    and the Adam7 pass table, both pure lookup tables).
//  * Every malformed case asserts the *error code* rather than just "an
//    error happened", so each failure branch stays distinguishable.
//  * Nothing here is skipped: every branch either passes or fails.

let test = require("tape");

let pngModule = require("../lib/png");
let PNG = pngModule.PNG;
let errors = require("../lib/errors");
let builder = require("./fixtures/png-builder");
let fixtures = require("./fixtures");
let CODES = errors.CODES;

// ---------------------------------------------------------------------------
// helpers

function readSync(buffer, options) {
  return PNG.sync.read(buffer, options || {});
}

// Parses the whole buffer through the streaming API in one write plus end().
function readStream(buffer, options) {
  return new Promise(function (resolve) {
    let png = new PNG(options || {});
    let metadata = null;
    let settled = false;
    function finish(result) {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    }
    png.on("metadata", function (meta) {
      metadata = meta;
    });
    png.on("parsed", function () {
      finish({ err: null, png: png, metadata: metadata });
    });
    png.on("error", function (err) {
      finish({ err: err, png: png, metadata: metadata });
    });
    try {
      png.end(buffer);
    } catch (ex) {
      finish({ err: ex, png: png, metadata: metadata });
    }
  });
}

// Parses the buffer split at arbitrary byte boundaries, optionally with
// several writes coalesced per tick (short writes).
function readStreamChunked(buffer, sizes, options) {
  return new Promise(function (resolve) {
    let png = new PNG(options || {});
    let settled = false;
    function finish(result) {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    }
    png.on("parsed", function () {
      finish({ err: null, png: png });
    });
    png.on("error", function (err) {
      finish({ err: err, png: png });
    });
    let offset = 0;
    let index = 0;
    function pump() {
      if (offset >= buffer.length) {
        png.end();
        return;
      }
      let size = sizes[index % sizes.length] || 1;
      index++;
      let slice = buffer.slice(offset, offset + size);
      offset += size;
      let more = true;
      try {
        more = png.write(slice);
      } catch (ex) {
        finish({ err: ex, png: png });
        return;
      }
      // Honour backpressure by waiting for drain, which also exercises the
      // short-read path.
      if (more === false) {
        png.once("drain", pump);
      } else {
        setImmediate(pump);
      }
    }
    pump();
  });
}

function expectCode(t, err, code, label) {
  t.ok(err instanceof Error, label + ": error is an Error instance");
  if (err instanceof Error) {
    t.equal(err.code, code, label + ": error code");
  }
}

function mutate(buffer, offset, value) {
  let copy = Buffer.from(buffer);
  copy[offset] = value;
  return copy;
}

function chunkStartOffset(buffer, type) {
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    let length = buffer.readUInt32BE(offset);
    let name = buffer.toString("latin1", offset + 4, offset + 8);
    if (name === type) {
      return offset;
    }
    offset += 12 + length;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// 1. Offline fixtures decode to hand-checked pixels

test("fixtures: hand-computed grayscale pixels", function (t) {
  let opts = fixtures.handComputed;
  let parsed = readSync(builder.build(opts));
  t.equal(parsed.width, 8, "width");
  t.equal(parsed.height, 2, "height");
  t.equal(parsed.depth, 8, "depth");
  // Row 0: sample = x * 32, replicated to R/G/B, opaque.
  t.deepEqual(
    Array.from(parsed.data.slice(0, 16)),
    [0, 0, 0, 255, 32, 32, 32, 255, 64, 64, 64, 255, 96, 96, 96, 255],
    "row 0 pixels"
  );
  // Row 1: sample = 255 - x * 32.
  t.deepEqual(
    Array.from(parsed.data.slice(32, 48)),
    [
      255, 255, 255, 255, 223, 223, 223, 255, 191, 191, 191, 255, 159, 159, 159,
      255,
    ],
    "row 1 pixels"
  );
  t.end();
});

test("fixtures: every colour type/depth decodes to the reference RGBA", function (t) {
  Object.keys(fixtures.fixtures).forEach(function (name) {
    let opts = fixtures.fixtures[name];
    let buffer = builder.build(opts);
    let expected = builder.expectedRgba(opts);
    let parsed;
    try {
      parsed = readSync(buffer);
    } catch (err) {
      t.fail(name + " failed to parse: " + err.code + " " + err.message);
      return;
    }
    t.equal(parsed.width, opts.width, name + ": width");
    t.equal(parsed.height, opts.height, name + ": height");
    t.ok(
      Buffer.compare(parsed.data, expected) === 0,
      name + ": pixel data matches reference"
    );
  });
  t.end();
});

test("fixtures: interlaced equals non-interlaced for the same pixels", function (t) {
  let sampleAt = function (x, y) {
    return [
      (x * 31 + y * 7) & 0xff,
      (x * 13 + y * 51) & 0xff,
      (x * 97 + y * 3) & 0xff,
      255,
    ];
  };
  [
    [1, 1],
    [2, 3],
    [7, 9],
    [8, 8],
    [9, 7],
    [17, 19],
  ].forEach(function (size) {
    let plain = readSync(
      builder.build({
        width: size[0],
        height: size[1],
        depth: 8,
        colorType: 6,
        sampleAt: sampleAt,
      })
    );
    let interlaced = readSync(
      builder.build({
        width: size[0],
        height: size[1],
        depth: 8,
        colorType: 6,
        sampleAt: sampleAt,
        interlace: true,
      })
    );
    t.ok(
      Buffer.compare(plain.data, interlaced.data) === 0,
      size[0] + "x" + size[1] + ": interlaced pixels match"
    );
  });
  t.end();
});

test("fixtures: palette and tRNS surface through the public metadata", function (t) {
  let buffer = builder.build(fixtures.fixtures.indexed8);
  let sync = readSync(buffer);
  t.equal(sync.colorType, 3, "sync: colour type");
  t.equal(sync.alpha, true, "sync: alpha flag set by tRNS");
  t.ok(Array.isArray(sync.palette), "sync: palette array exposed");
  t.equal(sync.palette.length, 5, "sync: palette entry count");
  t.equal(sync.palette[1][3], 64, "sync: tRNS alpha applied to palette");

  return readStream(buffer).then(function (result) {
    t.error(result.err, "stream: no error");
    t.equal(result.png.width, sync.width, "stream: width parity");
    t.ok(
      Array.isArray(result.metadata.palette),
      "stream: palette array exposed"
    );
    t.equal(result.metadata.palette.length, 5, "stream: palette entry count");
    t.deepEqual(
      result.metadata.palette,
      sync.palette,
      "stream: palette (including tRNS alpha) matches buffer API"
    );
    t.equal(result.metadata.alpha, true, "stream: alpha flag");
    t.end();
  });
});

// ---------------------------------------------------------------------------
// 2. Stream vs whole-Buffer parity

test("stream and buffer entry points agree on pixels and metadata", function (t) {
  let names = Object.keys(fixtures.fixtures).concat(["handComputed"]);
  let chain = Promise.resolve();
  names.forEach(function (name) {
    chain = chain.then(function () {
      let opts =
        name === "handComputed"
          ? fixtures.handComputed
          : fixtures.fixtures[name];
      let buffer = builder.build(opts);
      let sync = readSync(buffer);
      return readStream(buffer).then(function (result) {
        t.error(result.err, name + ": stream produced no error");
        if (result.err || !result.png.data) {
          return;
        }
        t.equal(result.png.width, sync.width, name + ": width parity");
        t.equal(result.png.height, sync.height, name + ": height parity");
        t.equal(result.png.gamma, sync.gamma, name + ": gamma parity");
        t.ok(
          Buffer.compare(result.png.data, sync.data) === 0,
          name + ": pixel parity"
        );
        t.ok(
          Buffer.compare(result.png.data, sync.data) === 0,
          name + ": row order parity (byte-identical)"
        );
      });
    });
  });
  return chain.then(function () {
    t.end();
  });
});

test("stream: arbitrary and tiny chunk boundaries give identical pixels", function (t) {
  let cases = [
    fixtures.fixtures.rgba8,
    fixtures.fixtures.rgbaInterlaced,
    fixtures.fixtures.indexed8,
    fixtures.fixtures.gray16Interlaced,
  ];
  let chains = [];
  cases.forEach(function (opts) {
    let buffer = builder.build(opts);
    let expected = readSync(buffer).data;
    let sizes = [[1], [2], [3], [7], [1, 5, 2, 11], [64]];
    sizes.forEach(function (pattern) {
      chains.push(
        readStreamChunked(buffer, pattern).then(function (result) {
          t.error(result.err, "chunks " + pattern.join(",") + ": no error");
          if (result.png.data) {
            t.ok(
              Buffer.compare(result.png.data, expected) === 0,
              "chunks " + pattern.join(",") + ": pixels match buffer API"
            );
          }
        })
      );
    });
  });
  return Promise.all(chains).then(function () {
    t.end();
  });
});

test("stream: a write per byte works at every length", function (t) {
  let buffer = builder.build(fixtures.fixtures.rgba8);
  let expected = readSync(buffer).data;
  return readStreamChunked(buffer, [1]).then(function (result) {
    t.error(result.err, "byte-wise stream parses");
    t.ok(
      Buffer.compare(result.png.data, expected) === 0,
      "byte-wise pixels match"
    );
    t.end();
  });
});

test("stream: read errors surface before any parsed event", function (t) {
  let buffer = builder.build(fixtures.fixtures.rgba8);
  let truncated = buffer.slice(0, buffer.length - 20);
  return readStreamChunked(truncated, [3]).then(function (result) {
    expectCode(t, result.err, CODES.TRUNCATED, "short final chunk");
    t.equal(result.png.data, null, "no pixels were produced");
    t.end();
  });
});

// ---------------------------------------------------------------------------
// 3. Malformed input: distinguishable, deterministic errors

let malformed = {
  "invalid signature": {
    build: function () {
      let buffer = builder.build(fixtures.fixtures.rgba8);
      return mutate(buffer, 1, 0x00);
    },
    code: CODES.SIGNATURE,
  },
  "empty input": {
    build: function () {
      return Buffer.alloc(0);
    },
    code: CODES.TRUNCATED,
  },
  "truncated signature": {
    build: function () {
      return Buffer.from([0x89, 0x50, 0x4e]);
    },
    code: CODES.TRUNCATED,
  },
  "truncated mid-chunk": {
    build: function () {
      let buffer = builder.build(fixtures.fixtures.rgba8);
      return buffer.slice(0, 40);
    },
    code: CODES.TRUNCATED,
  },
  "truncated before IEND": {
    build: function () {
      let buffer = builder.build(fixtures.fixtures.rgba8);
      return buffer.slice(0, buffer.length - 12);
    },
    code: CODES.TRUNCATED,
  },
  "corrupt IHDR CRC": {
    build: function () {
      let buffer = builder.build(fixtures.fixtures.rgba8);
      let offset = chunkStartOffset(buffer, "IHDR");
      return mutate(
        buffer,
        offset + 8 + 13 - 1,
        buffer[offset + 8 + 12] ^ 0xff
      );
    },
    code: CODES.CRC,
  },
  "corrupt IDAT CRC": {
    build: function () {
      let buffer = builder.build(fixtures.fixtures.rgba8);
      let offset = chunkStartOffset(buffer, "IDAT");
      let length = buffer.readUInt32BE(offset);
      return mutate(
        buffer,
        offset + 8 + length,
        buffer[offset + 8 + length] ^ 0xff
      );
    },
    code: CODES.CRC,
  },
  "chunk length above the 2^31-1 cap": {
    build: function () {
      let buffer = builder.build(fixtures.fixtures.rgba8);
      let copy = Buffer.from(buffer);
      // Rewrite the IHDR length field to 0xffffffff (a classic overflow).
      copy.writeUInt32BE(0xffffffff, 8);
      return copy;
    },
    code: CODES.CHUNK_LENGTH,
  },
  "unknown critical chunk": {
    build: function () {
      return builder.assemble([
        builder.ihdr(2, 2, 8, 6, 0),
        builder.chunk("ZZZZ", Buffer.from([1, 2])),
        builder.chunk(
          "IDAT",
          builder.deflate(
            builder.rawImage({
              width: 2,
              height: 2,
              depth: 8,
              colorType: 6,
              sampleAt: function () {
                return [0, 0, 0, 255];
              },
            })
          )
        ),
        builder.chunk("IEND", null),
      ]);
    },
    code: CODES.CRITICAL_CHUNK,
  },
  "unknown ancillary chunk is skipped": {
    build: function () {
      // Not an error: verifies the opposite branch of the critical check.
      return builder.build({
        width: 2,
        height: 2,
        depth: 8,
        colorType: 6,
        beforeIdat: [builder.chunk("prVt", Buffer.from("vendor"))],
        sampleAt: function () {
          return [9, 9, 9, 255];
        },
      });
    },
    ok: true,
  },
  "IHDR is not the first chunk": {
    build: function () {
      return builder.assemble([
        builder.chunk("gAMA", Buffer.alloc(4)),
        builder.ihdr(2, 2, 8, 6, 0),
        builder.chunk("IEND", null),
      ]);
    },
    code: CODES.CHUNK_ORDER,
  },
  "duplicate IHDR": {
    build: function () {
      return builder.assemble([
        builder.ihdr(2, 2, 8, 6, 0),
        builder.ihdr(2, 2, 8, 6, 0),
        builder.chunk("IEND", null),
      ]);
    },
    code: CODES.CHUNK_ORDER,
  },
  "IHDR of the wrong length": {
    build: function () {
      return builder.assemble([
        builder.chunk("IHDR", builder.ihdr(2, 2, 8, 6, 0).subarray(8, 18)),
        builder.chunk("IEND", null),
      ]);
    },
    code: CODES.IHDR,
  },
  "zero width": {
    build: function () {
      return builder.assemble([
        builder.ihdr(0, 2, 8, 6, 0),
        builder.chunk("IDAT", builder.deflate(Buffer.alloc(0))),
        builder.chunk("IEND", null),
      ]);
    },
    code: CODES.DIMENSIONS,
  },
  "zero height": {
    build: function () {
      return builder.assemble([
        builder.ihdr(2, 0, 8, 6, 0),
        builder.chunk("IDAT", builder.deflate(Buffer.alloc(0))),
        builder.chunk("IEND", null),
      ]);
    },
    code: CODES.DIMENSIONS,
  },
  "header-derived size overflows the buffer limit": {
    build: function () {
      // 0x7fffffff x 0x7fffffff RGBA: the row size alone exceeds every
      // platform's maximum buffer length, so this must fail from the header
      // without allocating anything.
      return builder.assemble([
        builder.ihdr(0x7fffffff, 0x7fffffff, 8, 6, 0),
        builder.chunk("IDAT", builder.deflate(Buffer.from([0, 0, 0, 0]))),
        builder.chunk("IEND", null),
      ]);
    },
    code: CODES.DIMENSIONS,
  },
  "single huge dimension": {
    build: function () {
      return builder.assemble([
        builder.ihdr(0x7fffffff, 1, 8, 6, 0),
        builder.chunk("IDAT", builder.deflate(Buffer.from([0, 0, 0, 0]))),
        builder.chunk("IEND", null),
      ]);
    },
    code: CODES.DATA_SIZE,
  },
  "unsupported bit depth": {
    build: function () {
      return builder.assemble([
        builder.ihdr(2, 2, 3, 0, 0),
        builder.chunk("IDAT", builder.deflate(Buffer.alloc(0))),
        builder.chunk("IEND", null),
      ]);
    },
    code: CODES.BIT_DEPTH,
  },
  "bit depth not allowed for the colour type": {
    build: function () {
      return builder.assemble([
        builder.ihdr(2, 2, 4, 2, 0),
        builder.chunk("IDAT", builder.deflate(Buffer.alloc(0))),
        builder.chunk("IEND", null),
      ]);
    },
    code: CODES.BIT_DEPTH,
  },
  "unsupported colour type": {
    build: function () {
      return builder.assemble([
        builder.ihdr(2, 2, 8, 5, 0),
        builder.chunk("IDAT", builder.deflate(Buffer.alloc(0))),
        builder.chunk("IEND", null),
      ]);
    },
    code: CODES.COLOR_TYPE,
  },
  "unsupported compression method": {
    build: function () {
      let header = builder.ihdr(2, 2, 8, 6, 0);
      let copy = Buffer.from(header);
      copy[8 + 10] = 1;
      return builder.assemble([
        recomputeCrc(copy),
        builder.chunk("IEND", null),
      ]);
    },
    code: CODES.COMPRESSION,
  },
  "unsupported filter method": {
    build: function () {
      let header = builder.ihdr(2, 2, 8, 6, 0);
      let copy = Buffer.from(header);
      copy[8 + 11] = 1;
      return builder.assemble([
        recomputeCrc(copy),
        builder.chunk("IEND", null),
      ]);
    },
    code: CODES.FILTER_METHOD,
  },
  "unsupported interlace method": {
    build: function () {
      let header = builder.ihdr(2, 2, 8, 6, 0);
      let copy = Buffer.from(header);
      copy[8 + 12] = 2;
      return builder.assemble([
        recomputeCrc(copy),
        builder.chunk("IEND", null),
      ]);
    },
    code: CODES.INTERLACE,
  },
  "corrupt filter byte in a scanline": {
    build: function () {
      return builder.assemble([
        builder.ihdr(2, 2, 8, 6, 0),
        builder.chunk(
          "IDAT",
          builder.deflate(
            Buffer.from([5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
          )
        ),
        builder.chunk("IEND", null),
      ]);
    },
    code: CODES.FILTER_TYPE,
  },
  "corrupt deflate stream": {
    build: function () {
      return builder.assemble([
        builder.ihdr(2, 2, 8, 6, 0),
        builder.chunk("IDAT", Buffer.from("deadbeef", "hex")),
        builder.chunk("IEND", null),
      ]);
    },
    code: CODES.INFLATE,
  },
  "too little image data": {
    build: function () {
      return builder.assemble([
        builder.ihdr(4, 4, 8, 6, 0),
        builder.chunk("IDAT", builder.deflate(Buffer.from([0, 0, 0, 0, 0]))),
        builder.chunk("IEND", null),
      ]);
    },
    code: CODES.DATA_SIZE,
  },
  "too much image data": {
    build: function () {
      let raw = builder.rawImage({
        width: 2,
        height: 2,
        depth: 8,
        colorType: 6,
        sampleAt: function () {
          return [0, 0, 0, 255];
        },
      });
      return builder.assemble([
        builder.ihdr(2, 2, 8, 6, 0),
        builder.chunk(
          "IDAT",
          builder.deflate(Buffer.concat([raw, Buffer.from([0, 1, 2, 3])]))
        ),
        builder.chunk("IEND", null),
      ]);
    },
    code: CODES.DATA_SIZE,
  },
  "no IDAT": {
    build: function () {
      return builder.assemble([
        builder.ihdr(2, 2, 8, 6, 0),
        builder.chunk("IEND", null),
      ]);
    },
    code: CODES.NO_DATA,
  },
  "palette type without PLTE": {
    build: function () {
      return builder.assemble([
        builder.ihdr(2, 2, 8, 3, 0),
        builder.chunk("IDAT", builder.deflate(Buffer.from([0, 0, 0, 0, 0, 0]))),
        builder.chunk("IEND", null),
      ]);
    },
    code: CODES.PALETTE,
  },
  "PLTE length not a multiple of three": {
    build: function () {
      return builder.assemble([
        builder.ihdr(2, 2, 8, 3, 0),
        builder.chunk("PLTE", Buffer.from([1, 2, 3, 4])),
        builder.chunk("IDAT", builder.deflate(Buffer.from([0, 0, 0, 0, 0, 0]))),
        builder.chunk("IEND", null),
      ]);
    },
    code: CODES.PALETTE,
  },
  "PLTE with more entries than the bit depth allows": {
    build: function () {
      // depth 2 allows 4 entries; provide 5.
      return builder.assemble([
        builder.ihdr(2, 2, 2, 3, 0),
        builder.chunk("PLTE", Buffer.alloc(15, 1)),
        builder.chunk("IDAT", builder.deflate(Buffer.from([0, 0, 0]))),
        builder.chunk("IEND", null),
      ]);
    },
    code: CODES.PALETTE,
  },
  "PLTE on a grayscale image": {
    build: function () {
      return builder.assemble([
        builder.ihdr(2, 2, 8, 0, 0),
        builder.chunk("PLTE", Buffer.from([1, 2, 3])),
        builder.chunk("IDAT", builder.deflate(Buffer.from([0, 0, 0, 0, 0, 0]))),
        builder.chunk("IEND", null),
      ]);
    },
    code: CODES.PALETTE,
  },
  "tRNS longer than the palette": {
    build: function () {
      return builder.assemble([
        builder.ihdr(2, 2, 8, 3, 0),
        builder.chunk("PLTE", Buffer.from([1, 2, 3])),
        builder.chunk("tRNS", Buffer.alloc(4, 0)),
        builder.chunk("IDAT", builder.deflate(Buffer.from([0, 0, 0, 0, 0, 0]))),
        builder.chunk("IEND", null),
      ]);
    },
    code: CODES.TRANSPARENCY,
  },
  "tRNS of the wrong length for grayscale": {
    build: function () {
      return builder.assemble([
        builder.ihdr(2, 2, 8, 0, 0),
        builder.chunk("tRNS", Buffer.from([0])),
        builder.chunk("IDAT", builder.deflate(Buffer.from([0, 0, 0, 0, 0, 0]))),
        builder.chunk("IEND", null),
      ]);
    },
    code: CODES.TRANSPARENCY,
  },
  "tRNS on an image that already has alpha": {
    build: function () {
      return builder.assemble([
        builder.ihdr(2, 2, 8, 6, 0),
        builder.chunk("tRNS", Buffer.alloc(6)),
        builder.chunk("IDAT", builder.deflate(Buffer.from([0, 0, 0, 0, 0, 0]))),
        builder.chunk("IEND", null),
      ]);
    },
    code: CODES.TRANSPARENCY,
  },
  "palette index outside the palette": {
    build: function () {
      return builder.assemble([
        builder.ihdr(2, 2, 8, 3, 0),
        builder.chunk("PLTE", Buffer.from([1, 2, 3])),
        builder.chunk("IDAT", builder.deflate(Buffer.from([0, 9, 9, 0, 9, 9]))),
        builder.chunk("IEND", null),
      ]);
    },
    code: CODES.PALETTE,
  },
  "IDAT chunks split by another chunk": {
    build: function () {
      let raw = builder.rawImage({
        width: 2,
        height: 2,
        depth: 8,
        colorType: 6,
        sampleAt: function () {
          return [1, 2, 3, 255];
        },
      });
      let compressed = builder.deflate(raw);
      let half = Math.floor(compressed.length / 2);
      return builder.assemble([
        builder.ihdr(2, 2, 8, 6, 0),
        builder.chunk("IDAT", compressed.subarray(0, half)),
        builder.chunk("tEXt", Buffer.from("key\u0000value")),
        builder.chunk("IDAT", compressed.subarray(half)),
        builder.chunk("IEND", null),
      ]);
    },
    code: CODES.CHUNK_ORDER,
  },
  "PLTE after IDAT": {
    // The palette is discovered too late: by the time IDAT is decoded there
    // is still no palette, so the missing-palette error is what a caller can
    // act on (the ordering problem is a consequence of it).
    build: function () {
      return builder.assemble([
        builder.ihdr(2, 2, 8, 3, 0),
        builder.chunk("IDAT", builder.deflate(Buffer.from([0, 0, 0, 0, 0, 0]))),
        builder.chunk("PLTE", Buffer.from([1, 2, 3])),
        builder.chunk("IEND", null),
      ]);
    },
    code: CODES.PALETTE,
  },
  "data after IEND": {
    build: function () {
      let buffer = builder.build(fixtures.fixtures.rgba8);
      return Buffer.concat([buffer, Buffer.from("trailing")]);
    },
    code: CODES.TRAILING_DATA,
    // The streaming API has always stopped reading at IEND (one of the
    // bundled fixtures carries a plain-text trailer), so trailing bytes are
    // only rejected by the whole-Buffer entry point. `null` documents that
    // deliberate difference instead of asserting parity.
    streamCode: null,
  },
  "invalid chunk type bytes": {
    build: function () {
      let buffer = builder.build(fixtures.fixtures.rgba8);
      let copy = Buffer.from(buffer);
      copy[12] = 0x01;
      return copy;
    },
    code: CODES.CHUNK_TYPE,
  },
  "IEND with a payload": {
    build: function () {
      return builder.assemble([
        builder.ihdr(2, 2, 8, 6, 0),
        builder.chunk(
          "IDAT",
          builder.deflate(
            builder.rawImage({
              width: 2,
              height: 2,
              depth: 8,
              colorType: 6,
              sampleAt: function () {
                return [0, 0, 0, 255];
              },
            })
          )
        ),
        builder.chunk("IEND", Buffer.from([0])),
      ]);
    },
    code: CODES.CHUNK_LENGTH,
  },
};

function recomputeCrc(chunkBuffer) {
  let crc = require("../lib/crc");
  let copy = Buffer.from(chunkBuffer);
  copy.writeInt32BE(crc.crc32(copy.slice(4, copy.length - 4)), copy.length - 4);
  return copy;
}

test("malformed inputs: sync path reports the expected, stable error code", function (t) {
  Object.keys(malformed).forEach(function (name) {
    let entry = malformed[name];
    let buffer;
    try {
      buffer = entry.build();
    } catch (err) {
      t.fail(name + ": fixture build threw " + err.message);
      return;
    }

    if (entry.ok) {
      try {
        readSync(buffer);
        t.pass(name + ": parses");
      } catch (err) {
        t.fail(name + ": unexpected " + err.code + " " + err.message);
      }
      return;
    }

    let first;
    try {
      readSync(buffer);
      t.fail(name + ": expected " + entry.code + " but parsed successfully");
      return;
    } catch (err) {
      first = err;
    }
    t.ok(first instanceof Error, name + ": threw an Error");
    t.equal(first.code, entry.code, name + ": error code");

    // Determinism: the same bytes must produce the same code and message.
    let second;
    try {
      readSync(buffer);
    } catch (err) {
      second = err;
    }
    t.equal(
      second && second.code,
      first.code,
      name + ": repeated parse gives the same code"
    );
    t.equal(
      second && second.message,
      first.message,
      name + ": repeated parse gives the same message"
    );

    // Error must not be an internal engine artefact.
    t.notEqual(
      first.code,
      undefined,
      name + ": code is defined (not a raw RangeError/TypeError)"
    );
  });
  t.end();
});

test("malformed inputs: stream path reports the same error code as sync", function (t) {
  let names = Object.keys(malformed);
  let chain = Promise.resolve();
  names.forEach(function (name) {
    chain = chain.then(function () {
      let entry = malformed[name];
      let buffer = entry.build();
      return readStreamChunked(buffer, [5]).then(function (result) {
        if (entry.ok) {
          t.error(result.err, name + ": stream parses");
          return;
        }
        if (entry.streamCode === null) {
          t.error(
            result.err,
            name + ": stream stops at IEND (documented difference)"
          );
          return;
        }
        let expected = entry.streamCode || entry.code;
        t.ok(result.err instanceof Error, name + ": stream emitted an Error");
        if (result.err instanceof Error) {
          t.equal(
            result.err.code,
            expected,
            name + ": stream error code parity"
          );
        }
        t.equal(result.png.data, null, name + ": no pixels emitted");
      });
    });
  });
  return chain.then(function () {
    t.end();
  });
});

test("malformed inputs: a broken header never allocates a header-sized buffer", function (t) {
  // 0x7fffffff x 0x7fffffff would need ~2^63 bytes; if the decoder tried to
  // allocate it the process would die or throw ERR_OUT_OF_RANGE instead of
  // our dimension error.
  let buffer = builder.assemble([
    builder.ihdr(0x7fffffff, 0x7fffffff, 16, 6, 0),
    builder.chunk("IDAT", builder.deflate(Buffer.alloc(0))),
    builder.chunk("IEND", null),
  ]);
  try {
    readSync(buffer);
    t.fail("expected a dimension error");
  } catch (err) {
    t.equal(
      err.code,
      CODES.DIMENSIONS,
      "dimension error, not an allocation failure"
    );
  }
  t.end();
});

test("malformed inputs: checkCRC=false still rejects structural problems", function (t) {
  let buffer = builder.build(fixtures.fixtures.rgba8);
  // Corrupt only the trailing CRC field of the IDAT chunk, leaving the
  // (still perfectly valid) compressed payload intact.
  let idat = chunkStartOffset(buffer, "IDAT");
  let idatLength = buffer.readUInt32BE(idat);
  let badCrc = mutate(
    buffer,
    idat + 8 + idatLength,
    buffer[idat + 8 + idatLength] ^ 0xff
  );

  // With CRC checking on, this is a CRC error; with it off, the payload is
  // still valid so the image decodes (the historical option contract).
  try {
    readSync(badCrc);
    t.fail("CRC mismatch should fail by default");
  } catch (err) {
    t.equal(err.code, CODES.CRC, "default checks CRC");
  }

  let parsed = readSync(badCrc, { checkCRC: false });
  t.equal(
    parsed.width,
    fixtures.fixtures.rgba8.width,
    "checkCRC=false skips the checksum"
  );

  let missingIend = buffer.slice(0, buffer.length - 12);
  try {
    readSync(missingIend, { checkCRC: false });
    t.fail("missing IEND should still fail");
  } catch (err) {
    t.equal(
      err.code,
      CODES.TRUNCATED,
      "structural errors survive checkCRC=false"
    );
  }
  t.end();
});

// ---------------------------------------------------------------------------
// 4. Encoder: constraints, reversibility, compression invariance

test("encoder: rejected inputs fail before any bytes are written", function (t) {
  let cases = [
    ["no data", { width: 2, height: 2, data: null }, CODES.NO_DATA],
    [
      "empty data",
      { width: 2, height: 2, data: Buffer.alloc(0) },
      CODES.NO_DATA,
    ],
    [
      "short data",
      { width: 2, height: 2, data: Buffer.alloc(4) },
      CODES.DATA_SIZE,
    ],
    [
      "long data",
      { width: 2, height: 2, data: Buffer.alloc(64) },
      CODES.DATA_SIZE,
    ],
    [
      "zero width",
      { width: 0, height: 2, data: Buffer.alloc(16) },
      CODES.DIMENSIONS,
    ],
    [
      "negative height",
      { width: 2, height: -3, data: Buffer.alloc(16) },
      CODES.DIMENSIONS,
    ],
    [
      "fractional width",
      { width: 2.5, height: 2, data: Buffer.alloc(16) },
      CODES.DIMENSIONS,
    ],
    [
      "huge width",
      { width: 0x7fffffff + 1, height: 1, data: Buffer.alloc(16) },
      CODES.DIMENSIONS,
    ],
  ];
  cases.forEach(function (c) {
    let meta = {
      width: c[1].width,
      height: c[1].height,
      data: c[1].data,
      gamma: 0,
    };
    try {
      PNG.sync.write(meta);
      t.fail(c[0] + ": expected an error");
    } catch (err) {
      t.equal(err.code, c[2], c[0] + ": error code");
    }
  });
  t.end();
});

test("encoder: illegal options fail with code, before writing", function (t) {
  let base = { width: 2, height: 2, data: Buffer.alloc(16), gamma: 0 };
  let cases = [
    ["filter 9", { filterType: 9 }],
    ["filter -2", { filterType: -2 }],
    ["array of filters", { filterType: [0, 1] }],
    ["bit depth 4", { bitDepth: 4 }],
    ["colour type 5", { colorType: 5 }],
    ["input colour type 3", { inputColorType: 3 }],
    ["deflate level 99", { deflateLevel: 99 }],
    ["deflate strategy 9", { deflateStrategy: 9 }],
    ["deflate chunk 1", { deflateChunkSize: 1 }],
  ];
  cases.forEach(function (c) {
    try {
      PNG.sync.write(base, c[1]);
      t.fail(c[0] + ": expected an error");
    } catch (err) {
      t.equal(err.code, CODES.OPTIONS, c[0] + ": option error code");
    }
  });
  t.end();
});

test("encoder: oversized image is rejected from the header arithmetic", function (t) {
  // 0x7fffffff x 0x7fffffff pixels is ~2^62 samples: the size arithmetic
  // leaves the safe-integer range. The check must fire before any buffer for
  // the row or the filtered image is allocated.
  try {
    PNG.sync.write({
      width: 0x7fffffff,
      height: 0x7fffffff,
      data: Buffer.alloc(16),
      gamma: 0,
    });
    t.fail("expected an error");
  } catch (err) {
    t.equal(err.code, CODES.DIMENSIONS, "oversized image error code");
  }
  t.end();
});

test("encoder: round-trip is byte-exact for supported colour types", function (t) {
  let width = 5;
  let height = 4;
  let count = width * height;

  // Each spec declares where its input samples come from and what the decoder
  // must give back. Lossless combinations are checked byte for byte; the
  // deliberately lossy one (RGB -> grayscale) is checked against the exact
  // conversion the encoder documents.
  let specs = [
    {
      name: "RGBA -> RGBA",
      options: { colorType: 6, inputColorType: 6, inputHasAlpha: true },
      input: function () {
        let data = Buffer.alloc(count * 4);
        for (let i = 0; i < data.length; i++) {
          data[i] = (i * 37 + 11) & 0xff;
        }
        for (let i = 3; i < data.length; i += 4) {
          data[i] = 255;
        }
        return data;
      },
      expected: function (input) {
        return input;
      },
    },
    {
      name: "RGBA -> RGB",
      options: { colorType: 2, inputColorType: 6, inputHasAlpha: true },
      input: function () {
        let data = Buffer.alloc(count * 4);
        for (let i = 0; i < data.length; i++) {
          data[i] = (i * 37 + 11) & 0xff;
        }
        for (let i = 3; i < data.length; i += 4) {
          data[i] = 255;
        }
        return data;
      },
      expected: function (input) {
        let out = Buffer.alloc(count * 4);
        for (let i = 0; i < count; i++) {
          out[i * 4] = input[i * 4];
          out[i * 4 + 1] = input[i * 4 + 1];
          out[i * 4 + 2] = input[i * 4 + 2];
          out[i * 4 + 3] = 255;
        }
        return out;
      },
    },
    {
      name: "grey -> grey",
      options: { colorType: 0, inputColorType: 0, inputHasAlpha: false },
      input: function () {
        let data = Buffer.alloc(count);
        for (let i = 0; i < data.length; i++) {
          data[i] = (i * 29 + 5) & 0xff;
        }
        return data;
      },
      expected: function (input) {
        let out = Buffer.alloc(count * 4);
        for (let i = 0; i < count; i++) {
          out[i * 4] = input[i];
          out[i * 4 + 1] = input[i];
          out[i * 4 + 2] = input[i];
          out[i * 4 + 3] = 255;
        }
        return out;
      },
    },
    {
      name: "grey+alpha -> grey+alpha",
      options: { colorType: 4, inputColorType: 4, inputHasAlpha: true },
      input: function () {
        let data = Buffer.alloc(count * 2);
        for (let i = 0; i < data.length; i++) {
          data[i] = (i * 53 + 9) & 0xff;
        }
        return data;
      },
      expected: function (input) {
        let out = Buffer.alloc(count * 4);
        for (let i = 0; i < count; i++) {
          out[i * 4] = input[i * 2];
          out[i * 4 + 1] = input[i * 2];
          out[i * 4 + 2] = input[i * 2];
          out[i * 4 + 3] = input[i * 2 + 1];
        }
        return out;
      },
    },
    {
      name: "RGB (3-channel input) -> RGBA",
      options: { colorType: 6, inputColorType: 6, inputHasAlpha: false },
      input: function () {
        let data = Buffer.alloc(count * 3);
        for (let i = 0; i < data.length; i++) {
          data[i] = (i * 17 + 3) & 0xff;
        }
        return data;
      },
      expected: function (input) {
        let out = Buffer.alloc(count * 4);
        for (let i = 0; i < count; i++) {
          out[i * 4] = input[i * 3];
          out[i * 4 + 1] = input[i * 3 + 1];
          out[i * 4 + 2] = input[i * 3 + 2];
          out[i * 4 + 3] = 255;
        }
        return out;
      },
    },
  ];

  specs.forEach(function (spec) {
    let input = spec.input();
    let expected = spec.expected(input);
    let encoded = PNG.sync.write(
      { width: width, height: height, data: input, gamma: 0 },
      spec.options
    );
    let decoded = readSync(encoded);
    t.equal(decoded.width, width, spec.name + ": width");
    t.equal(decoded.height, height, spec.name + ": height");
    t.ok(
      Buffer.compare(decoded.data, expected) === 0,
      spec.name + ": reversible pixel data"
    );
  });
  t.end();
});

test("encoder: 16-bit samples survive a round-trip", function (t) {
  let width = 3;
  let height = 2;
  let data = Buffer.alloc(width * height * 4 * 2);
  let view = new Uint16Array(data.buffer, data.byteOffset, width * height * 4);
  for (let i = 0; i < view.length; i++) {
    view[i] = (i * 4099 + 12345) & 0xffff;
  }
  let encoded = PNG.sync.write(
    { width: width, height: height, data: data, gamma: 0 },
    { bitDepth: 16, colorType: 6, inputColorType: 6 }
  );
  let decoded = readSync(encoded, { skipRescale: true });
  t.equal(decoded.depth, 16, "16-bit depth preserved");
  // 16-bit output is a Uint16Array of samples, so compare sample by sample.
  let decodedSamples = new Uint16Array(
    decoded.data.buffer,
    decoded.data.byteOffset,
    decoded.data.length
  );
  t.equal(decodedSamples.length, view.length, "sample count");
  let same = true;
  for (let i = 0; i < view.length; i++) {
    if (decodedSamples[i] !== view[i]) {
      same = false;
      break;
    }
  }
  t.ok(same, "16-bit RGBA samples round-trip exactly");
  t.end();
});

test("encoder: a 16-bit Buffer slice encodes the bytes at its offset", function (t) {
  // Regression: the 16-bit path used `new Uint16Array(buffer.buffer)` and so
  // read from the start of the allocation instead of the slice.
  let backing = Buffer.alloc(4 * 4 * 2 + 32, 0xee);
  let data = backing.subarray(16, 16 + 4 * 4 * 2);
  let view = new Uint16Array(data.buffer, data.byteOffset, 16);
  for (let i = 0; i < view.length; i++) {
    view[i] = (i + 1) * 1000;
  }
  let encoded = PNG.sync.write(
    { width: 2, height: 2, data: data, gamma: 0 },
    { bitDepth: 16, colorType: 6, inputColorType: 6 }
  );
  let decoded = readSync(encoded, { skipRescale: true });
  let decodedSamples = new Uint16Array(
    decoded.data.buffer,
    decoded.data.byteOffset,
    decoded.data.length
  );
  let same = true;
  for (let i = 0; i < view.length; i++) {
    if (decodedSamples[i] !== view[i]) {
      same = false;
      break;
    }
  }
  t.ok(same, "slice offset respected");
  t.end();
});

test("encoder: compression level changes bytes but not semantics", function (t) {
  // A smooth gradient: highly compressible, so deflate level has a visible
  // effect on the encoded bytes (random noise is incompressible at every
  // level, which would make this check vacuous).
  let width = 64;
  let height = 64;
  let data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let i = (y * width + x) * 4;
      data[i] = (x * 4) & 0xff;
      data[i + 1] = (y * 4) & 0xff;
      data[i + 2] = (x + y) & 0xff;
      data[i + 3] = 255;
    }
  }

  let outputs = [];
  [0, 1, 6, 9].forEach(function (level) {
    let encoded = PNG.sync.write(
      { width: width, height: height, data: data, gamma: 0 },
      { deflateLevel: level }
    );
    outputs.push({
      level: level,
      encoded: encoded,
      decoded: readSync(encoded),
    });
  });

  outputs.forEach(function (entry) {
    t.ok(
      Buffer.compare(entry.decoded.data, data) === 0,
      "level " + entry.level + ": pixels are lossless"
    );
  });
  t.ok(
    Buffer.compare(
      outputs[0].decoded.data,
      outputs[outputs.length - 1].decoded.data
    ) === 0,
    "level 0 and level 9 decode to identical pixels"
  );

  let identical = true;
  for (let i = 1; i < outputs.length; i++) {
    if (Buffer.compare(outputs[0].encoded, outputs[i].encoded) !== 0) {
      identical = false;
    }
  }
  t.notOk(
    identical,
    "compression level is honoured (at least two levels differ in bytes)"
  );
  t.end();
});

test("encoder: filter selection is honoured and reversible", function (t) {
  let width = 7;
  let height = 5;
  let data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i++) {
    data[i] = (i * 53 + 7) & 0xff;
  }
  for (let i = 3; i < data.length; i += 4) {
    data[i] = 255;
  }

  [0, 1, 2, 3, 4, -1].forEach(function (filterType) {
    let encoded = PNG.sync.write(
      { width: width, height: height, data: data, gamma: 0 },
      { filterType: filterType }
    );
    let decoded = readSync(encoded);
    t.ok(
      Buffer.compare(decoded.data, data) === 0,
      "filter " + filterType + ": reversible"
    );
  });
  t.end();
});

test("encoder: inputHasAlpha=false does not read a phantom alpha byte", function (t) {
  let data = Buffer.alloc(3 * 2 * 3); // 3 px RGB
  for (let i = 0; i < data.length; i++) {
    data[i] = (i * 17) & 0xff;
  }
  let encoded = PNG.sync.write(
    { width: 3, height: 2, data: data, gamma: 0 },
    { colorType: 6, inputColorType: 6, inputHasAlpha: false }
  );
  let decoded = readSync(encoded);
  t.equal(decoded.data[3], 255, "alpha is opaque for a 3-channel input");
  t.equal(decoded.data[0], data[0], "red preserved");
  t.equal(decoded.data[1], data[1], "green preserved");
  t.equal(decoded.data[2], data[2], "blue preserved");
  t.end();
});

test("encoder: sequential calls do not leak state between images", function (t) {
  let first = Buffer.alloc(2 * 2 * 4, 0x11);
  let second = Buffer.alloc(3 * 3 * 4, 0x7f);
  let encodedFirst = PNG.sync.write({
    width: 2,
    height: 2,
    data: first,
    gamma: 0,
  });
  let encodedSecond = PNG.sync.write({
    width: 3,
    height: 3,
    data: second,
    gamma: 0,
  });
  let encodedFirstAgain = PNG.sync.write({
    width: 2,
    height: 2,
    data: first,
    gamma: 0,
  });

  t.ok(
    Buffer.compare(readSync(encodedFirst).data, first) === 0,
    "first image intact"
  );
  t.ok(
    Buffer.compare(readSync(encodedSecond).data, second) === 0,
    "second image intact"
  );
  t.ok(
    Buffer.compare(encodedFirst, encodedFirstAgain) === 0,
    "re-encoding the first image is byte-identical"
  );
  t.end();
});

test("encoder: the caller's options object is not mutated", function (t) {
  let options = { colorType: 2, bgColor: {} };
  let snapshot = JSON.stringify(options);
  PNG.sync.write(
    { width: 2, height: 2, data: Buffer.alloc(16, 0x40), gamma: 0 },
    options
  );
  t.equal(JSON.stringify(options), snapshot, "options unchanged");
  t.end();
});

// ---------------------------------------------------------------------------
// 5. Lifecycle: cancellation, cleanup, callback safety

test("lifecycle: destroy() mid-parse stops quietly with no pending reads", function (t) {
  let buffer = builder.build(fixtures.fixtures.rgba8);
  let png = new PNG();
  let sawError = false;
  png.on("error", function () {
    sawError = true;
  });
  png.write(buffer.slice(0, 20));
  png.destroy();
  png.write(buffer.slice(20));
  png.end();
  setImmediate(function () {
    t.notOk(sawError, "destroy does not emit an error");
    t.equal(png._parser.writable, false, "parser is not writable");
    t.equal(png._parser._reads, null, "queued reads released");
    t.notOk(png._parser._inflate, "inflate released");
    t.notOk(png._parser._filter, "filter released");
    t.end();
  });
});

test("lifecycle: a second pack() while one is running is rejected with a code", function (t) {
  let png = new PNG({ width: 2, height: 2 });
  let errors = [];
  png.on("error", function (err) {
    errors.push(err);
  });
  png.on("data", function () {});
  png.data = Buffer.alloc(16, 0x20);
  png.pack();
  png.pack();
  setImmediate(function () {
    t.equal(errors.length, 1, "one error emitted");
    t.equal(errors[0] && errors[0].code, CODES.STATE, "state error code");
    t.end();
  });
});

test("lifecycle: non-Buffer parse input is reported with a code, not a raw throw", function (t) {
  let png = new PNG();
  let received = null;
  png.on("error", function (err) {
    received = err;
  });
  // Write a non-buffer value: the chunk stream rejects it via the same
  // coded-error path used for every other failure.
  png.write(undefined);
  setImmediate(function () {
    t.ok(received instanceof Error, "an Error was emitted");
    t.ok(
      received && /^ERR_PNG_/.test(received.code || ""),
      "error carries a pngjs code"
    );
    t.end();
  });
});

test("lifecycle: destroy() is idempotent", function (t) {
  let png = new PNG();
  png.destroy();
  png.destroy();
  t.pass("second destroy is a no-op");
  t.end();
});

test("lifecycle: a parse callback that throws is the caller's exception", function (t) {
  let buffer = builder.build(fixtures.fixtures.rgba8);
  let thrown = null;
  let handler = function (err) {
    thrown = err;
  };
  process.once("uncaughtException", handler);
  let png = new PNG();
  png.parse(buffer, function () {
    throw new Error("callback boom");
  });
  setTimeout(function () {
    process.removeListener("uncaughtException", handler);
    t.ok(
      thrown,
      "caller exception surfaced as uncaught, not as a decode error"
    );
    t.equal(thrown && thrown.message, "callback boom", "the caller's message");
    t.end();
  }, 20);
});

test("lifecycle: parse callback receives an Error for a string-shaped emission", function (t) {
  // The packer's legacy "No data provided" path emits a string; the parse
  // callback contract promises an Error.
  let png = new PNG();
  let received = null;
  png.parse(Buffer.from("not a png"), function (err) {
    received = err;
  });
  setTimeout(function () {
    t.ok(received instanceof Error, "callback got an Error");
    t.equal(received.code, CODES.SIGNATURE, "and it is the signature error");
    t.end();
  }, 20);
});

test("lifecycle: async error is emitted exactly once per bad input", function (t) {
  let buffer = builder.build(fixtures.fixtures.rgba8);
  let badFilter = builder.assemble([
    builder.ihdr(2, 2, 8, 6, 0),
    builder.chunk(
      "IDAT",
      builder.deflate(Buffer.from([9, 0, 0, 0, 0, 0, 0, 0, 0]))
    ),
    builder.chunk("IEND", null),
  ]);
  let cases = [
    buffer.slice(0, 30),
    badFilter,
    builder.assemble([
      builder.ihdr(2, 2, 8, 6, 0),
      builder.chunk("IEND", null),
    ]),
    Buffer.from("89504e470d0a1a0b", "hex"),
  ];

  let chain = Promise.resolve();
  cases.forEach(function (bytes) {
    chain = chain.then(function () {
      return new Promise(function (resolve) {
        let count = 0;
        let png = new PNG();
        png.on("error", function () {
          count++;
        });
        png.end(bytes);
        setTimeout(function () {
          t.equal(count, 1, "exactly one error event");
          resolve();
        }, 30);
      });
    });
  });
  return chain.then(function () {
    t.end();
  });
});

test("lifecycle: repeated decodes on fresh instances are identical", function (t) {
  let buffer = builder.build(fixtures.fixtures.rgbaInterlaced);
  let first = readSync(buffer).data;
  for (let i = 0; i < 5; i++) {
    let again = readSync(buffer).data;
    t.ok(Buffer.compare(first, again) === 0, "run " + i + " matches");
  }
  t.end();
});

test("lifecycle: the decoder does not mutate the caller's buffer", function (t) {
  let buffer = builder.build(fixtures.fixtures.rgba8);
  let copy = Buffer.from(buffer);
  readSync(buffer);
  t.ok(Buffer.compare(buffer, copy) === 0, "input buffer untouched");
  t.end();
});

test("lifecycle: async packer rejects invalid data before emitting bytes", function (t) {
  let png = new PNG({ width: 2, height: 2 });
  let dataEvents = 0;
  let error = null;
  png.on("data", function () {
    dataEvents++;
  });
  png.on("error", function (err) {
    error = err;
  });
  png.data = Buffer.alloc(3);
  png.pack();
  setTimeout(function () {
    t.equal(dataEvents, 0, "no output bytes were emitted");
    t.ok(error instanceof Error, "an Error was emitted");
    t.equal(error && error.code, CODES.DATA_SIZE, "data-size error code");
    t.end();
  }, 40);
});

test("lifecycle: stream output round-trips through the stream decoder", function (t) {
  let width = 4;
  let height = 4;
  let data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i++) {
    data[i] = (i * 29 + 3) & 0xff;
  }
  for (let i = 3; i < data.length; i += 4) {
    data[i] = 255;
  }

  let source = new PNG({ width: width, height: height });
  source.data = data;
  let encoded = [];
  source.on("data", function (chunk) {
    encoded.push(chunk);
  });
  source.on("end", function () {
    let bytes = Buffer.concat(encoded);
    return readStream(bytes).then(function (result) {
      t.error(result.err, "stream-encoded PNG decodes via the stream API");
      t.ok(Buffer.compare(result.png.data, data) === 0, "pixels round-trip");
      t.end();
    });
  });
  source.pack();
});

// ---------------------------------------------------------------------------
// 6. Random small images: sync/stream parity and encode/decode reversibility

test("random small images: encode/decode/stream all agree", function (t) {
  let random = fixtures.prng(0x5eed);
  let iterations = 40;
  for (let i = 0; i < iterations; i++) {
    let width = 1 + Math.floor(random() * 9);
    let height = 1 + Math.floor(random() * 9);
    let pixels = Buffer.alloc(width * height * 4);
    for (let p = 0; p < pixels.length; p += 4) {
      pixels[p] = Math.floor(random() * 256);
      pixels[p + 1] = Math.floor(random() * 256);
      pixels[p + 2] = Math.floor(random() * 256);
      pixels[p + 3] = 255;
    }
    let filterType = Math.floor(random() * 5);
    let level = Math.floor(random() * 10);
    let encoded = PNG.sync.write(
      { width: width, height: height, data: pixels, gamma: 0 },
      { filterType: filterType, deflateLevel: level }
    );
    let decoded = readSync(encoded);
    t.ok(
      Buffer.compare(decoded.data, pixels) === 0,
      "image " +
        i +
        " (" +
        width +
        "x" +
        height +
        ", filter " +
        filterType +
        "): sync round-trip"
    );
  }
  t.end();
});

test("random small images: stream decoding matches buffer decoding", function (t) {
  let random = fixtures.prng(0xbeef);
  let chain = Promise.resolve();
  for (let i = 0; i < 12; i++) {
    chain = chain.then(function () {
      let width = 1 + Math.floor(random() * 6);
      let height = 1 + Math.floor(random() * 6);
      let interlace = random() < 0.5;
      let samples = [];
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          samples.push([
            Math.floor(random() * 256),
            Math.floor(random() * 256),
            Math.floor(random() * 256),
            255,
          ]);
        }
      }
      let buffer = builder.build({
        width: width,
        height: height,
        depth: 8,
        colorType: 6,
        interlace: interlace,
        sampleAt: function (x, y) {
          return samples[y * width + x];
        },
      });
      let sync = readSync(buffer).data;
      return readStreamChunked(buffer, [1 + Math.floor(random() * 5)]).then(
        function (result) {
          t.error(result.err, "image " + i + ": stream ok");
          if (result.png.data) {
            t.ok(
              Buffer.compare(result.png.data, sync) === 0,
              "image " +
                i +
                (interlace ? " (interlaced)" : "") +
                ": stream == buffer"
            );
          }
        }
      );
    });
  }
  return chain.then(function () {
    t.end();
  });
});

// ---------------------------------------------------------------------------
// 7. Encoder output checked against an independent decoder

// Minimal PNG reader written from the specification (8-bit only). It shares
// no code with lib/, so agreement between the two means the encoder's filtered
// stream really is a valid PNG rather than merely self-consistent.
function decodeIndependently(buffer) {
  let zlib = require("zlib");
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let palette = null;
  let trns = null;
  let idat = [];

  while (offset + 8 <= buffer.length) {
    let length = buffer.readUInt32BE(offset);
    let type = buffer.toString("latin1", offset + 4, offset + 8);
    let payload = buffer.slice(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = payload.readUInt32BE(0);
      height = payload.readUInt32BE(4);
      colorType = payload[9];
    } else if (type === "PLTE") {
      palette = payload;
    } else if (type === "tRNS") {
      trns = payload;
    } else if (type === "IDAT") {
      idat.push(payload);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  let raw = zlib.inflateSync(Buffer.concat(idat));
  let channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  let stride = width * channels;
  let out = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);
  let pos = 0;

  function paeth(a, b, c) {
    let p = a + b - c;
    let pa = Math.abs(p - a);
    let pb = Math.abs(p - b);
    let pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  }

  for (let y = 0; y < height; y++) {
    let filter = raw[pos++];
    let line = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      let value = raw[pos + x];
      let left = x >= channels ? line[x - channels] : 0;
      let above = previous[x];
      let upLeft = x >= channels ? previous[x - channels] : 0;
      switch (filter) {
        case 0:
          break;
        case 1:
          value += left;
          break;
        case 2:
          value += above;
          break;
        case 3:
          value += (left + above) >> 1;
          break;
        case 4:
          value += paeth(left, above, upLeft);
          break;
        default:
          throw new Error("unexpected filter " + filter);
      }
      line[x] = value & 0xff;
    }
    pos += stride;

    for (let x = 0; x < width; x++) {
      let o = (y * width + x) * 4;
      let s = x * channels;
      if (colorType === 0) {
        out[o] = out[o + 1] = out[o + 2] = line[s];
        out[o + 3] = 255;
      } else if (colorType === 2) {
        out[o] = line[s];
        out[o + 1] = line[s + 1];
        out[o + 2] = line[s + 2];
        out[o + 3] = 255;
      } else if (colorType === 3) {
        let i = line[s];
        out[o] = palette[i * 3];
        out[o + 1] = palette[i * 3 + 1];
        out[o + 2] = palette[i * 3 + 2];
        out[o + 3] = trns && i < trns.length ? trns[i] : 255;
      } else if (colorType === 4) {
        out[o] = out[o + 1] = out[o + 2] = line[s];
        out[o + 3] = line[s + 1];
      } else {
        out[o] = line[s];
        out[o + 1] = line[s + 1];
        out[o + 2] = line[s + 2];
        out[o + 3] = line[s + 3];
      }
    }
    previous = line;
  }

  return { width: width, height: height, colorType: colorType, data: out };
}

test("encoder output decodes correctly in an independent decoder", function (t) {
  let random = fixtures.prng(0x1234abcd);
  let iterations = 60;
  let colorTypes = [0, 2, 4, 6];

  for (let i = 0; i < iterations; i++) {
    let width = 1 + Math.floor(random() * 10);
    let height = 1 + Math.floor(random() * 10);
    let outType = colorTypes[Math.floor(random() * colorTypes.length)];
    let inType = colorTypes[Math.floor(random() * colorTypes.length)];
    let inChannels = { 0: 1, 2: 3, 4: 2, 6: 4 }[inType];
    let input = Buffer.alloc(width * height * inChannels);
    for (let p = 0; p < input.length; p++) {
      input[p] = Math.floor(random() * 256);
    }

    let options = {
      colorType: outType,
      inputColorType: inType,
      inputHasAlpha: inType === 4 || inType === 6,
      filterType: Math.floor(random() * 5),
      deflateLevel: Math.floor(random() * 10),
    };

    let encoded = PNG.sync.write(
      { width: width, height: height, data: input, gamma: 0 },
      options
    );

    let label =
      "image " +
      i +
      " (" +
      width +
      "x" +
      height +
      ", " +
      inType +
      "->" +
      outType +
      ", filter " +
      options.filterType +
      ")";

    // The independent decoder must accept the bytes and agree with pngjs.
    let independent;
    try {
      independent = decodeIndependently(encoded);
    } catch (err) {
      t.fail(
        label + ": independent decoder rejected the output: " + err.message
      );
      continue;
    }
    let decoded = readSync(encoded);
    t.equal(independent.colorType, outType, label + ": colour type written");
    t.ok(
      Buffer.compare(independent.data, decoded.data) === 0,
      label + ": independent and pngjs decoders agree"
    );

    // ...and the pixels must be exactly the documented conversion of the
    // input (with alpha flattened against white when the output has none).
    let outHasAlpha = outType === 4 || outType === 6;
    let mismatch = -1;
    for (let p = 0; p < width * height && mismatch === -1; p++) {
      let s = p * inChannels;
      let r, g, b, a;
      if (inType === 0) {
        r = g = b = input[s];
        a = 255;
      } else if (inType === 2) {
        r = input[s];
        g = input[s + 1];
        b = input[s + 2];
        a = 255;
      } else if (inType === 4) {
        r = g = b = input[s];
        a = input[s + 1];
      } else {
        r = input[s];
        g = input[s + 1];
        b = input[s + 2];
        a = input[s + 3];
      }
      if (!outHasAlpha) {
        let alpha = a / 255;
        r = Math.min(
          Math.max(Math.round((1 - alpha) * 255 + alpha * r), 0),
          255
        );
        g = Math.min(
          Math.max(Math.round((1 - alpha) * 255 + alpha * g), 0),
          255
        );
        b = Math.min(
          Math.max(Math.round((1 - alpha) * 255 + alpha * b), 0),
          255
        );
      }
      let expected =
        outType === 0 || outType === 4
          ? [
              Math.floor((r + g + b) / 3),
              Math.floor((r + g + b) / 3),
              Math.floor((r + g + b) / 3),
            ]
          : [r, g, b];
      let expectedAlpha = outType === 0 || outType === 2 ? 255 : a;
      let o = p * 4;
      if (
        decoded.data[o] !== expected[0] ||
        decoded.data[o + 1] !== expected[1] ||
        decoded.data[o + 2] !== expected[2] ||
        decoded.data[o + 3] !== expectedAlpha
      ) {
        mismatch = p;
      }
    }
    t.equal(mismatch, -1, label + ": documented pixel conversion");
  }
  t.end();
});
