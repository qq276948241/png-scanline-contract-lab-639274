"use strict";

let test = require("tape");
let fs = require("fs");
let path = require("path");
let zlib = require("zlib");
let PNG = require("../lib/png").PNG;
let PNGError = require("../lib/png-error").codes;
let builder = require("./fixtures/png-builder");
let manifest = require("./fixtures/files/manifest.json");

let FIXTURES = path.join(__dirname, "fixtures", "files");

// Deterministic pseudo-random generator so the "random" images are
// reproducible across runs and machines.
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomRGBA(width, height, seed, withAlpha) {
  let rand = mulberry32(seed);
  let data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.floor(rand() * 256);
    data[i + 1] = Math.floor(rand() * 256);
    data[i + 2] = Math.floor(rand() * 256);
    data[i + 3] = withAlpha ? Math.floor(rand() * 256) : 255;
  }
  return data;
}

function writeSync(width, height, data, options) {
  let png = Object.assign(
    { width: width, height: height, data: data },
    options || {}
  );
  try {
    return { error: null, buffer: PNG.sync.write(png, options || {}) };
  } catch (e) {
    return { error: e, buffer: null };
  }
}

test("encoder: round trip restores pixels byte-for-byte on random images", function (t) {
  let sizes = [
    [1, 1],
    [2, 3],
    [7, 5],
    [8, 8],
    [13, 11],
    [16, 9],
  ];
  sizes.forEach(function (size, index) {
    let width = size[0];
    let height = size[1];
    let data = randomRGBA(width, height, 1000 + index, true);
    let result = writeSync(width, height, data);
    t.equal(result.error, null, "encode " + width + "x" + height);
    let decoded = PNG.sync.read(result.buffer);
    t.equal(decoded.width, width, "width preserved");
    t.equal(decoded.height, height, "height preserved");
    t.equal(decoded.data.length, data.length, "pixel buffer size preserved");
    t.ok(decoded.data.equals(data), "pixels identical byte-for-byte");
  });
  t.end();
});

test("encoder: every filter choice decodes back to identical pixels", function (t) {
  let width = 12;
  let height = 10;
  let data = randomRGBA(width, height, 42, true);
  let reference = PNG.sync.read(writeSync(width, height, data).buffer).data;

  for (let filterType = 0; filterType <= 4; filterType++) {
    let encoded = writeSync(width, height, data, { filterType: filterType });
    t.equal(encoded.error, null, "filter " + filterType + " encodes");
    let decoded = PNG.sync.read(encoded.buffer);
    t.ok(
      decoded.data.equals(reference),
      "filter " + filterType + " round trips to identical pixels"
    );
  }

  let adaptive = writeSync(width, height, data, { filterType: -1 });
  t.equal(adaptive.error, null, "adaptive filter encodes");
  t.ok(
    PNG.sync.read(adaptive.buffer).data.equals(reference),
    "adaptive filtering preserves semantics"
  );
  t.end();
});

test("encoder: compression level changes bytes but not decoded pixels", function (t) {
  // A larger, compressible image so level differences show up in file size.
  let width = 48;
  let height = 40;
  let data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let i = (y * width + x) * 4;
      // Smooth gradients compress very differently per level.
      data[i] = x * 4;
      data[i + 1] = y * 4;
      data[i + 2] = (x + y) * 2;
      data[i + 3] = 255;
    }
  }
  let sizes = [];
  let reference = null;

  for (let level = zlib.Z_MIN_LEVEL; level <= zlib.Z_MAX_LEVEL; level++) {
    let result = writeSync(width, height, data, { deflateLevel: level });
    t.equal(result.error, null, "level " + level + " encodes");
    sizes.push(result.buffer.length);
    let decoded = PNG.sync.read(result.buffer);
    if (reference === null) {
      reference = decoded.data;
    } else {
      t.ok(
        decoded.data.equals(reference),
        "level " + level + " yields identical pixels"
      );
    }
  }
  let distinct = new Set(sizes);
  t.ok(
    distinct.size > 1,
    "different levels produced differently sized files: " + sizes.join(",")
  );
  t.end();
});

test("encoder: zero and invalid dimensions fail before any output", function (t) {
  let data = Buffer.alloc(4);
  let cases = [
    { width: 0, height: 1 },
    { width: 1, height: 0 },
    { width: -4, height: 4 },
    { width: 4, height: NaN },
  ];
  cases.forEach(function (dim) {
    let result = writeSync(dim.width, dim.height, data);
    t.ok(result.error, dim.width + "x" + dim.height + " rejected");
    t.equal(
      result.error.code,
      PNGError.ERR_PNG_DIMENSIONS,
      dim.width + "x" + dim.height + " coded correctly"
    );
  });
  t.end();
});

test("encoder: oversized dimensions are rejected before allocation", function (t) {
  let result = writeSync(0x7fffffff, 0x7fffffff, Buffer.alloc(4), {
    maxDimension: 100000,
    maxPixels: 100000000,
  });
  t.equal(result.error.code, PNGError.ERR_PNG_TOO_LARGE, "huge image rejected");
  t.equal(result.buffer, null, "no buffer produced");
  t.end();
});

test("encoder: data shorter than the row requires fails before output", function (t) {
  let width = 4;
  let height = 4;
  let shortData = Buffer.alloc(width * height * 4 - 3);
  let result = writeSync(width, height, shortData);
  t.ok(result.error, "short data rejected");
  t.equal(
    result.error.code,
    PNGError.ERR_PNG_ENCODER_INPUT,
    "coded input error"
  );
  t.equal(result.buffer, null, "no output written");

  let longData = Buffer.alloc(width * height * 4 + 5);
  let longResult = writeSync(width, height, longData);
  t.ok(longResult.error, "oversized data rejected");
  t.equal(
    longResult.error.code,
    PNGError.ERR_PNG_ENCODER_INPUT,
    "oversized coded input error"
  );
  t.end();
});

test("encoder: empty and non-buffer input fail before output", function (t) {
  let empty = writeSync(2, 2, Buffer.alloc(0));
  t.equal(empty.error.code, PNGError.ERR_PNG_ENCODER_INPUT, "empty buffer");
  t.equal(empty.buffer, null);

  let png = new PNG({ width: 2, height: 2 });
  png.data = null;
  t.throws(
    function () {
      png.pack();
    },
    function (err) {
      return err.code === PNGError.ERR_PNG_ENCODER_INPUT;
    },
    "async pack with null data emits a coded error"
  );
  t.end();
});

test("encoder: invalid deflate level and filter type are rejected", function (t) {
  let data = randomRGBA(4, 4, 9, false);
  t.equal(
    writeSync(4, 4, data, { deflateLevel: 99 }).error.code,
    PNGError.ERR_PNG_DEFLATE_LEVEL,
    "deflate level 99 rejected"
  );
  t.equal(
    writeSync(4, 4, data, { deflateLevel: -2 }).error.code,
    PNGError.ERR_PNG_DEFLATE_LEVEL,
    "negative deflate level rejected"
  );
  t.equal(
    writeSync(4, 4, data, { filterType: 7 }).error.code,
    PNGError.ERR_PNG_FILTER_TYPE,
    "filter type 7 rejected"
  );
  t.equal(
    writeSync(4, 4, data, { filterType: "nope" }).error.code,
    PNGError.ERR_PNG_FILTER_TYPE,
    "non-numeric filter type rejected"
  );
  t.end();
});

test("encoder: async pack rejects bad input via the error event, no bytes emitted", function (t) {
  let png = new PNG({ width: 4, height: 4 });
  png.data = Buffer.alloc(10); // too short
  let chunks = [];
  let settled = false;
  png.on("data", function (chunk) {
    chunks.push(chunk);
  });
  png.on("error", function (err) {
    settled = true;
    t.equal(err.code, PNGError.ERR_PNG_ENCODER_INPUT, "coded encoder error");
    t.equal(chunks.length, 0, "no data bytes emitted before the error");
    setTimeout(function () {
      t.ok(settled, "error path completed");
      t.end();
    }, 20);
  });
  png.pack();
});

test("encoder: hand-computed 2x2 grayscale fixture round trips exactly", function (t) {
  // A tiny image whose exact bytes are known up front.
  let gray = [0, 64, 128, 255];
  let rgba = Buffer.alloc(4 * 4);
  for (let i = 0; i < 4; i++) {
    rgba[i * 4] = gray[i];
    rgba[i * 4 + 1] = gray[i];
    rgba[i * 4 + 2] = gray[i];
    rgba[i * 4 + 3] = 255;
  }
  let encoded = builder.buildPNG({
    width: 2,
    height: 2,
    depth: 8,
    colorType: 0,
    rgba: rgba,
  });
  let decoded = PNG.sync.read(encoded);
  t.equal(decoded.data.length, 16);
  for (let i = 0; i < 4; i++) {
    t.equal(decoded.data[i * 4], gray[i], "gray sample " + i);
    t.equal(decoded.data[i * 4 + 3], 255, "opaque alpha " + i);
  }

  // Re-encode through the library and decode again for a full library round trip.
  let reencoded = writeSync(2, 2, decoded.data, {
    colorType: 6,
  });
  let redecoded = PNG.sync.read(reencoded.buffer);
  t.ok(redecoded.data.equals(decoded.data), "library round trip stable");
  t.end();
});

test("encoder: fixture images re-encode without semantic change", function (t) {
  manifest.fixtures.forEach(function (entry) {
    let buf = fs.readFileSync(path.join(FIXTURES, entry.file));
    let original = PNG.sync.read(buf);
    let reencoded = writeSync(original.width, original.height, original.data);
    t.equal(reencoded.error, null, entry.name + " re-encodes");
    let redecoded = PNG.sync.read(reencoded.buffer);
    t.ok(
      redecoded.data.equals(original.data),
      entry.name + " pixels survive re-encoding"
    );
  });
  t.end();
});

test("encoder: 16-bit image round trips through write and read", function (t) {
  let width = 5;
  let height = 4;
  // The bit packer reads 16-bit input through a Uint16Array view, so build a
  // properly aligned buffer of one 16-bit sample per channel.
  let samples = new Uint16Array(width * height * 4);
  let rand = mulberry32(31337);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.floor(rand() * 65536);
  }
  let data = Buffer.from(samples.buffer);
  let encoded = writeSync(width, height, data, {
    bitDepth: 16,
    colorType: 6,
  });
  t.equal(encoded.error, null, "16-bit encode ok");
  let decoded = PNG.sync.read(encoded.buffer);
  // The normaliser scales 16-bit samples back to 8 bits; reconstruct the
  // expected 8-bit buffer from the same 16-bit source values.
  let expected8 = Buffer.alloc(width * height * 4);
  for (let i = 0; i < samples.length; i++) {
    expected8[i] = Math.floor((samples[i] * 255) / 65535 + 0.5);
  }
  t.ok(
    decoded.data.equals(expected8),
    "16-bit round trip scales back to the expected 8-bit pixels"
  );
  t.end();
});
