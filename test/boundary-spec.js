"use strict";

let test = require("tape");
let fs = require("fs");
let path = require("path");
let PNG = require("../lib/png").PNG;
let PNGError = require("../lib/png-error").codes;
let builder = require("./fixtures/png-builder");
let damage = require("./fixtures/png-damage");

let FIXTURES = path.join(__dirname, "fixtures", "files");
let manifest = require("./fixtures/files/manifest.json");

function validPNG() {
  return fs.readFileSync(path.join(FIXTURES, "rgba-8bit.png"));
}

function readSync(buf, options) {
  try {
    return { error: null, png: PNG.sync.read(buf, options || {}) };
  } catch (e) {
    return { error: e, png: null };
  }
}

function readAsync(buf, options, cb) {
  if (typeof options === "function") {
    cb = options;
    options = {};
  }
  new PNG(options).parse(buf, cb);
}

test("boundary: bad signature fails with ERR_PNG_SIGNATURE in sync and async", function (t) {
  let buf = damage.breakSignature(validPNG());
  let sync = readSync(buf);
  t.ok(sync.error, "sync rejects");
  t.equal(sync.error.code, PNGError.ERR_PNG_SIGNATURE, "sync error code");

  readAsync(buf, function (err) {
    t.ok(err instanceof Error, "async rejects");
    t.equal(err.code, PNGError.ERR_PNG_SIGNATURE, "async error code");
    t.end();
  });
});

test("boundary: truncated at every prefix length is rejected", function (t) {
  let original = validPNG();
  let seenCodes = {};
  let checks = [];
  // Truncate at a spread of offsets covering signature, headers and data.
  for (let len = 0; len < original.length; len += 7) {
    checks.push(len);
  }
  checks.push(original.length - 1);

  let pending = checks.length;
  checks.forEach(function (len) {
    let buf = damage.truncate(original, len);
    let sync = readSync(buf);
    t.ok(sync.error, "sync truncation at " + len + " rejects");
    t.ok(
      sync.error.code === PNGError.ERR_PNG_TRUNCATED ||
        sync.error.code === PNGError.ERR_PNG_SIGNATURE ||
        sync.error.code === PNGError.ERR_PNG_CRC ||
        sync.error.code === PNGError.ERR_PNG_INFLATE ||
        sync.error.code === PNGError.ERR_PNG_FILTER_TYPE,
      "sync truncation at " +
        len +
        " has a coded error (" +
        sync.error.code +
        ")"
    );
    seenCodes[sync.error.code] = true;

    readAsync(buf, function (err) {
      t.ok(err instanceof Error, "async truncation at " + len + " rejects");
      t.equal(
        err.code,
        sync.error.code,
        "async/sync agree on code at length " + len
      );
      pending -= 1;
      if (pending === 0) {
        t.ok(
          seenCodes[PNGError.ERR_PNG_TRUNCATED],
          "at least one truncation maps to ERR_PNG_TRUNCATED"
        );
        t.end();
      }
    });
  });
});

test("boundary: CRC corruption fails with ERR_PNG_CRC", function (t) {
  let buf = damage.breakCrc(validPNG(), "IHDR");
  let sync = readSync(buf);
  t.equal(sync.error.code, PNGError.ERR_PNG_CRC, "sync CRC code");

  readAsync(buf, function (err) {
    t.equal(err.code, PNGError.ERR_PNG_CRC, "async CRC code");
    // checkCRC:false must keep the image parseable.
    let skipped = readSync(buf, { checkCRC: false });
    t.equal(skipped.error, null, "checkCRC false bypasses CRC failure");
    t.end();
  });
});

test("boundary: unknown critical chunk fails with ERR_PNG_CHUNK_TYPE", function (t) {
  let png = validPNG();
  let location = damage.findChunk(png, "IHDR");
  // A structurally complete chunk (length 0 + valid CRC), so the chunk type
  // check is reached before any truncation. An uppercase first letter means
  // the chunk is critical, and the type is one the parser does not know.
  let unknownCritical = builder.chunk("BLAh", Buffer.alloc(0));
  let buf = Buffer.concat([png.slice(0, location.end), unknownCritical]);
  let sync = readSync(buf);
  t.equal(sync.error.code, PNGError.ERR_PNG_CHUNK_TYPE, "sync code");

  readAsync(buf, function (err) {
    t.equal(err.code, PNGError.ERR_PNG_CHUNK_TYPE, "async code");
    t.end();
  });
});

test("boundary: illegal bit depth / color type combos are rejected", function (t) {
  let png = validPNG();
  // IHDR data layout: width(4) height(4) depth(1) colorType(1) ...
  // depth 7 is never legal
  let badDepth = damage.patchIHDR(png, 8, 7);
  t.equal(
    readSync(badDepth).error.code,
    PNGError.ERR_PNG_BIT_DEPTH,
    "depth 7 rejected"
  );
  // color type 5 is reserved
  let badColor = damage.patchIHDR(png, 9, 5);
  t.equal(
    readSync(badColor).error.code,
    PNGError.ERR_PNG_COLOR_TYPE,
    "color type 5 rejected"
  );
  // 16-bit palette images are forbidden by the spec
  let palettePNG = fs.readFileSync(path.join(FIXTURES, "indexed-2bit.png"));
  let depth16Palette = damage.patchIHDR(palettePNG, 8, 16);
  t.equal(
    readSync(depth16Palette).error.code,
    PNGError.ERR_PNG_BIT_DEPTH,
    "16-bit palette rejected"
  );
  // unknown interlace method 2
  let badInterlace = damage.patchIHDR(png, 12, 2);
  t.equal(
    readSync(badInterlace).error.code,
    PNGError.ERR_PNG_INTERLACE,
    "interlace 2 rejected"
  );
  t.end();
});

test("boundary: zero and oversized dimensions are rejected before allocation", function (t) {
  let png = validPNG();
  let zero = damage.setDimensions(png, 0, 0);
  t.equal(
    readSync(zero).error.code,
    PNGError.ERR_PNG_DIMENSIONS,
    "zero dimensions rejected"
  );
  let huge = damage.setDimensions(png, 0x7fffffff, 0x7fffffff);
  let result = readSync(huge, { maxDimension: 100000, maxPixels: 100000000 });
  t.equal(
    result.error.code,
    PNGError.ERR_PNG_TOO_LARGE,
    "huge dimensions rejected without allocation"
  );
  t.end();
});

test("boundary: chunk length overflow is rejected without a big buffer", function (t) {
  let buf = damage.insertHugeLengthChunk(validPNG());
  let sync = readSync(buf);
  t.ok(sync.error, "huge chunk rejected");
  t.equal(
    sync.error.code,
    PNGError.ERR_PNG_CHUNK_LENGTH,
    "maps to ERR_PNG_CHUNK_LENGTH"
  );
  readAsync(buf, function (err) {
    t.equal(err.code, PNGError.ERR_PNG_CHUNK_LENGTH, "async agrees");
    t.end();
  });
});

test("boundary: missing IDAT fails with a dedicated error", function (t) {
  let buf = damage.removeIDAT(validPNG());
  let sync = readSync(buf);
  t.equal(sync.error.code, PNGError.ERR_PNG_MISSING_IDAT, "sync code");
  readAsync(buf, function (err) {
    t.equal(err.code, PNGError.ERR_PNG_MISSING_IDAT, "async code");
    t.end();
  });
});

test("boundary: corrupted deflate stream fails with a coded error", function (t) {
  let buf = damage.breakIDATCompression(validPNG());
  let sync = readSync(buf);
  t.ok(sync.error, "sync rejects corrupted payload");
  // The bundled sync inflate tolerates some byte flips and surfaces the
  // resulting garbage as a filter error; the streaming zlib binding rejects
  // the malformed stream directly. Both are deterministic coded failures.
  t.ok(
    sync.error.code === PNGError.ERR_PNG_INFLATE ||
      sync.error.code === PNGError.ERR_PNG_FILTER_TYPE,
    "sync coded error: " + sync.error.code
  );
  readAsync(buf, function (err) {
    t.ok(
      err.code === PNGError.ERR_PNG_INFLATE ||
        err.code === PNGError.ERR_PNG_FILTER_TYPE,
      "async coded error: " + err.code
    );
    t.end();
  });
});

test("boundary: a truncated deflate stream is an inflate/filter error on both paths", function (t) {
  let png = validPNG();
  let location = damage.findChunk(png, "IDAT");
  // Keep the zlib header but cut the payload in half and fix the chunk CRC.
  let shortPayload = png.slice(location.dataOffset, location.dataOffset + 4);
  let rebuilt = Buffer.concat([
    png.slice(0, location.start),
    builder.chunk("IDAT", shortPayload),
    png.slice(location.end),
  ]);
  let sync = readSync(rebuilt);
  t.ok(sync.error, "sync rejects truncated deflate");
  t.ok(
    sync.error.code === PNGError.ERR_PNG_INFLATE ||
      sync.error.code === PNGError.ERR_PNG_INFLATE_LENGTH ||
      sync.error.code === PNGError.ERR_PNG_TRUNCATED ||
      sync.error.code === PNGError.ERR_PNG_FILTER_TYPE,
    "sync coded: " + sync.error.code
  );
  readAsync(rebuilt, function (err) {
    t.ok(err instanceof Error, "async rejects truncated deflate");
    t.ok(
      err.code === PNGError.ERR_PNG_INFLATE ||
        err.code === PNGError.ERR_PNG_TRUNCATED ||
        err.code === PNGError.ERR_PNG_FILTER_TYPE,
      "async coded: " + err.code
    );
    t.end();
  });
});

test("boundary: illegal filter byte fails with ERR_PNG_FILTER_TYPE", function (t) {
  let raw = Buffer.alloc((9 * 4 + 1) * 7, 0);
  let buf = damage.withIllegalFilterByte(raw, 9, 7, 6, 8);
  let sync = readSync(buf);
  t.equal(sync.error.code, PNGError.ERR_PNG_FILTER_TYPE, "sync filter code");
  readAsync(buf, function (err) {
    t.equal(err.code, PNGError.ERR_PNG_FILTER_TYPE, "async filter code");
    t.end();
  });
});

test("boundary: length mismatch between IHDR and data is detected", function (t) {
  // Claim more rows than the inflated payload actually contains.
  let png = validPNG();
  let resized = damage.setDimensions(png, 9, 20);
  let sync = readSync(resized);
  t.ok(sync.error, "declared larger image fails");
  t.ok(
    sync.error.code === PNGError.ERR_PNG_INFLATE_LENGTH ||
      sync.error.code === PNGError.ERR_PNG_TRUNCATED ||
      sync.error.code === PNGError.ERR_PNG_FILTER_TYPE,
    "length mismatch coded error: " + sync.error.code
  );
  t.end();
});

test("boundary: errors are deterministic for the same input", function (t) {
  let cases = [
    damage.breakSignature(validPNG()),
    damage.breakCrc(validPNG(), "IHDR"),
    damage.removeIDAT(validPNG()),
    damage.setDimensions(validPNG(), 0, 0),
    damage.patchIHDR(validPNG(), 8, 7),
  ];
  cases.forEach(function (buf) {
    let first = readSync(buf).error;
    let second = readSync(buf).error;
    t.equal(first.code, second.code, "stable code");
    t.equal(first.message, second.message, "stable message");
    t.notEqual(first, second, "each failure gets a fresh error object");
  });
  t.end();
});

test("boundary: every committed fixture parses with the expected metadata", function (t) {
  manifest.fixtures.forEach(function (entry) {
    let buf = fs.readFileSync(path.join(FIXTURES, entry.file));
    let result = readSync(buf);
    t.equal(result.error, null, entry.name + " parses");
    t.equal(result.png.width, manifest.width, entry.name + " width");
    t.equal(result.png.height, manifest.height, entry.name + " height");
    t.equal(result.png.depth, entry.expect.depth, entry.name + " depth");
    t.equal(
      result.png.interlace,
      entry.expect.interlace,
      entry.name + " interlace"
    );
  });
  t.end();
});

test("boundary: builder still produces a parseable interlaced image", function (t) {
  let rgba = Buffer.alloc(8 * 8 * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = i % 256;
    rgba[i + 1] = (i * 3) % 256;
    rgba[i + 2] = (i * 7) % 256;
    rgba[i + 3] = 255;
  }
  let png = builder.buildPNG({
    width: 8,
    height: 8,
    depth: 8,
    colorType: 6,
    rgba: rgba,
    interlace: true,
  });
  let result = readSync(png);
  t.equal(result.error, null);
  t.ok(result.png.data.equals(rgba), "Adam7 pixels reconstruct exactly");
  t.end();
});
