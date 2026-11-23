"use strict";

let test = require("tape");
let fs = require("fs");
let path = require("path");
let stream = require("stream");
let PNG = require("../lib/png").PNG;
let manifest = require("./fixtures/files/manifest.json");

let FIXTURES = path.join(__dirname, "fixtures", "files");

// Feed a buffer through the streaming entry point one chunk at a time.
function parseInChunks(buf, chunkSize, options, cb) {
  let png = new PNG(options || {});
  let source = new stream.Readable({
    read: function () {},
  });
  source.pipe(png);
  png.on("error", function (err) {
    cb(err, null);
  });
  png.on("parsed", function (data) {
    cb(null, { png: png, data: data });
  });
  for (let off = 0; off < buf.length; off += chunkSize) {
    source.push(buf.slice(off, off + chunkSize));
  }
  source.push(null);
}

function parseWhole(buf, options, cb) {
  new PNG(options || {}).parse(buf, cb);
}

let fixtureFiles = manifest.fixtures.map(function (f) {
  return f.file;
});

test("streaming: every chunk boundary gives identical output to one-shot parse", function (t) {
  let pending = 0;

  fixtureFiles.forEach(function (file) {
    let buf = fs.readFileSync(path.join(FIXTURES, file));
    // Every chunk size from 1 to 17 covers every possible byte boundary of
    // these small fixtures, plus a few larger sizes.
    let sizes = [];
    for (let s = 1; s <= 17; s++) {
      sizes.push(s);
    }
    sizes.push(31, 64, 128, 1024, buf.length);
    pending += sizes.length;

    parseWhole(buf, {}, function (wholeErr, wholePng) {
      t.equal(wholeErr, null, file + " whole parse ok");

      sizes.forEach(function (size) {
        parseInChunks(buf, size, {}, function (chunkErr, result) {
          t.equal(chunkErr, null, file + " chunk size " + size + " ok");
          if (!chunkErr && result) {
            t.equal(
              result.png.width,
              wholePng.width,
              file + " width matches at size " + size
            );
            t.equal(
              result.png.height,
              wholePng.height,
              file + " height matches at size " + size
            );
            t.ok(
              result.data.equals(wholePng.data),
              file + " pixels identical at chunk size " + size
            );
          }
          pending -= 1;
          if (pending === 0) {
            t.end();
          }
        });
      });
    });
  });
});

test("streaming: palette and alpha survive every fragmentation", function (t) {
  let buf = fs.readFileSync(path.join(FIXTURES, "indexed-2bit.png"));
  parseWhole(buf, {}, function (wholeErr, wholePng) {
    t.equal(wholeErr, null);
    let pending = 5;
    [1, 2, 3, 5, 13].forEach(function (size) {
      parseInChunks(buf, size, {}, function (err, result) {
        t.equal(err, null, "size " + size + " no error");
        t.ok(
          result.data.equals(wholePng.data),
          "indexed/transparent pixels identical at size " + size
        );
        // the third palette entry has alpha 128 via tRNS
        let alphaSeen128 = false;
        let alphaSeen0 = false;
        for (let i = 3; i < result.data.length; i += 4) {
          if (result.data[i] === 128) {
            alphaSeen128 = true;
          }
          if (result.data[i] === 0) {
            alphaSeen0 = true;
          }
        }
        t.ok(alphaSeen128, "tRNS alpha 128 preserved at size " + size);
        t.ok(alphaSeen0, "tRNS alpha 0 preserved at size " + size);
        pending -= 1;
        if (pending === 0) {
          t.end();
        }
      });
    });
  });
});

test("streaming: interlaced row order matches non-interlaced reference", function (t) {
  // Same source pixels encoded both ways; streaming decode must produce the
  // same top-to-bottom, left-to-right ordering.
  let interlaced = fs.readFileSync(path.join(FIXTURES, "adam7-rgba.png"));
  let planar = fs.readFileSync(path.join(FIXTURES, "rgba-8bit.png"));
  parseInChunks(interlaced, 3, {}, function (iErr, iRes) {
    t.equal(iErr, null);
    parseInChunks(planar, 3, {}, function (pErr, pRes) {
      t.equal(pErr, null);
      t.equal(iRes.png.width, pRes.png.width, "widths match");
      t.equal(iRes.png.height, pRes.png.height, "heights match");
      t.ok(
        iRes.data.equals(pRes.data),
        "Adam7 and flat images yield identical pixel order"
      );
      t.end();
    });
  });
});

test("streaming: short reads (partial writes) and final EOF are both covered", function (t) {
  let buf = fs.readFileSync(path.join(FIXTURES, "rgba-8bit.png"));

  // 1. short read: end the stream before all expected bytes arrive
  let short = buf.slice(0, Math.floor(buf.length / 2));
  parseInChunks(short, 7, {}, function (shortErr) {
    t.ok(shortErr instanceof Error, "short read errors");
    t.equal(shortErr.code, "ERR_PNG_TRUNCATED", "short read is coded");

    // 2. final EOF on a complete stream must succeed, not error
    parseInChunks(buf, 1, {}, function (fullErr, result) {
      t.equal(fullErr, null, "clean EOF after full input succeeds");
      t.equal(result.data.length, manifest.width * manifest.height * 4);
      t.end();
    });
  });
});

test("streaming: write/end API and pipe API agree on a byte stream", function (t) {
  let buf = fs.readFileSync(path.join(FIXTURES, "gray-alpha-8bit.png"));

  let pngA = new PNG();
  pngA.parse(buf, function (errA, parsedA) {
    t.equal(errA, null);

    let pngB = new PNG();
    let pieces = [];
    for (let off = 0; off < buf.length; off += 4) {
      pieces.push(buf.slice(off, off + 4));
    }
    pieces.forEach(function (piece) {
      pngB.write(piece);
    });
    pngB.end();
    pngB.on("error", function (errB) {
      t.error(errB);
    });
    pngB.on("parsed", function (dataB) {
      t.ok(parsedA.data.equals(dataB), "write/end matches parse() output");
      t.end();
    });
  });
});

test("streaming: sync and async entry points return equal pixels and metadata", function (t) {
  let remaining = fixtureFiles.length;
  fixtureFiles.forEach(function (file) {
    let buf = fs.readFileSync(path.join(FIXTURES, file));
    let syncPng = PNG.sync.read(buf);
    let png = new PNG();
    let asyncMeta;
    png.on("metadata", function (metadata) {
      asyncMeta = metadata;
    });
    png.parse(buf, function (err) {
      t.equal(err, null, file + " async ok");
      t.equal(png.width, syncPng.width, file + " width");
      t.equal(png.height, syncPng.height, file + " height");
      t.ok(asyncMeta, file + " metadata event fired");
      t.equal(asyncMeta.depth, syncPng.depth, file + " depth");
      t.equal(asyncMeta.colorType, syncPng.colorType, file + " colorType");
      t.equal(asyncMeta.interlace, syncPng.interlace, file + " interlace");
      t.ok(png.data.equals(syncPng.data), file + " pixels");
      remaining -= 1;
      if (remaining === 0) {
        t.end();
      }
    });
  });
});
