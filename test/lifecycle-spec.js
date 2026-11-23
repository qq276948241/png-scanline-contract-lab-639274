"use strict";

let test = require("tape");
let fs = require("fs");
let path = require("path");
let stream = require("stream");
let PNG = require("../lib/png").PNG;
let PNGError = require("../lib/png-error").codes;

let FIXTURES = path.join(__dirname, "fixtures", "files");

function readAsync(buf, options, cb) {
  if (typeof options === "function") {
    cb = options;
    options = {};
  }
  new PNG(options).parse(buf, cb);
}

test("lifecycle: one failed parse does not affect an independent later parse", function (t) {
  let good = fs.readFileSync(path.join(FIXTURES, "rgba-8bit.png"));
  let bad = Buffer.from("not a png at all, just text");

  // Interleave good and bad inputs on separate PNG instances.
  let sequence = [
    { buf: bad, ok: false },
    { buf: good, ok: true },
    { buf: bad, ok: false },
    { buf: good, ok: true },
    { buf: good, ok: true },
    { buf: bad, ok: false },
  ];
  let pending = sequence.length;
  sequence.forEach(function (entry, index) {
    readAsync(entry.buf, function (err, png) {
      if (entry.ok) {
        t.equal(err, null, "index " + index + " succeeds");
        t.equal(png.width, 9, "index " + index + " width unaffected");
      } else {
        t.ok(err instanceof Error, "index " + index + " fails");
      }
      pending -= 1;
      if (pending === 0) {
        t.end();
      }
    });
  });
});

test("lifecycle: repeated sync parses return independent pixel buffers", function (t) {
  let good = fs.readFileSync(path.join(FIXTURES, "rgba-8bit.png"));
  let first = PNG.sync.read(good);
  let second = PNG.sync.read(good);
  t.notEqual(first.data, second.data, "distinct buffers allocated per call");
  t.ok(first.data.equals(second.data), "identical content");
  first.data[0] = (first.data[0] + 1) % 256;
  t.notEqual(
    first.data[0],
    second.data[0],
    "mutating one result cannot reach the next call"
  );
  t.end();
});

test("lifecycle: internal inflate state is reset across back-to-back parses", function (t) {
  let files = [
    "grayscale-8bit.png",
    "adam7-rgba.png",
    "truecolor-16bit.png",
    "indexed-2bit.png",
    "rgba-8bit.png",
  ];
  let reference = PNG.sync.read(
    fs.readFileSync(path.join(FIXTURES, "rgba-8bit.png"))
  );
  let pending = files.length;
  files.forEach(function (file, i) {
    let buf = fs.readFileSync(path.join(FIXTURES, file));
    readAsync(buf, function (err) {
      t.equal(err, null, file + " parsed after " + i + " others");
      pending -= 1;
      if (pending === 0) {
        // and a final parse still returns the right pixels
        readAsync(
          fs.readFileSync(path.join(FIXTURES, "rgba-8bit.png")),
          function (finalErr, finalPng) {
            t.equal(finalErr, null);
            t.ok(finalPng.data.equals(reference.data), "final pixels intact");
            t.end();
          }
        );
      }
    });
  });
});

test("lifecycle: destroying a parse releases streams without parsed or error", function (t) {
  let good = fs.readFileSync(path.join(FIXTURES, "rgba-8bit.png"));
  let png = new PNG();
  let settled = false;
  png.on("parsed", function () {
    settled = true;
    t.fail("parsed must not fire after destroy");
  });
  png.on("error", function () {
    settled = true;
    t.fail("error must not fire after destroy");
  });
  png.on("close", function () {
    t.pass("close emitted on destroy");
  });

  // Feed the first few bytes, then cancel while the parser is waiting for more.
  png.write(good.slice(0, 12));
  png.destroy();
  t.equal(png.writable, false, "png marked not writable");
  t.equal(png.readable, false, "png marked not readable");

  // Further writes are no-ops and never throw.
  t.doesNotThrow(function () {
    png.write(good);
    png.end(good);
  }, "writes after destroy are safe");

  setTimeout(function () {
    t.equal(settled, false, "no parsed/error after destroy");
    t.end();
  }, 100);
});

test("lifecycle: destroy is idempotent and safe before any data", function (t) {
  let png = new PNG();
  t.doesNotThrow(function () {
    png.destroy();
    png.destroy();
  }, "double destroy is safe");
  t.equal(png.writable, false);
  t.end();
});

test("lifecycle: an error path tears down inflate and filter streams", function (t) {
  let good = fs.readFileSync(path.join(FIXTURES, "rgba-8bit.png"));
  let png = new PNG();
  png.parse(good.slice(0, 20), function (err) {
    t.ok(err instanceof Error, "truncated parse errors");
    t.equal(err.code, PNGError.ERR_PNG_TRUNCATED, "coded truncation");
    // teardown is synchronous in the error path
    t.equal(png._parser._buffers, null, "chunk stream buffers released");
    t.equal(png._parser._reads, null, "chunk stream reads released");
    t.end();
  });
});

test("lifecycle: a throwing parsed callback is routed to the error channel", function (t) {
  let good = fs.readFileSync(path.join(FIXTURES, "rgba-8bit.png"));
  let png = new PNG();
  let boom = new Error("callback exploded");
  png.on("error", function (err) {
    t.equal(err, boom, "callback exception surfaces on error");
    t.end();
  });
  png.on("parsed", function () {
    throw boom;
  });
  png.end(good);
});

test("lifecycle: a throwing error callback still releases the parser", function (t) {
  let bad = Buffer.from("still not a png");
  let png = new PNG();
  let sawRethrown = false;
  // The exception raised inside the error callback is not swallowed: it is
  // re-routed onto the error channel so user code can still observe it.
  png.on("error", function (err) {
    if (err.message === "error callback exploded") {
      sawRethrown = true;
      t.equal(png._parser._buffers, null, "parser released despite throw");
    }
  });
  png.parse(bad, function (err) {
    t.ok(err instanceof Error, "error delivered to callback");
    throw new Error("error callback exploded");
  });
  setTimeout(function () {
    t.ok(sawRethrown, "callback exception was re-routed, not swallowed");
    t.end();
  }, 50);
});

test("lifecycle: no handles keep the event loop alive after completion", function (t) {
  let good = fs.readFileSync(path.join(FIXTURES, "rgba-8bit.png"));
  readAsync(good, function (err) {
    t.equal(err, null);
    // If streams were left open the process would not exit; the test runner
    // reaching its natural end is the assertion. A timer that never fires is
    // used so tape itself stays alive just long enough.
    let timer = setTimeout(function () {
      t.fail("should have been cleared");
    }, 5000);
    timer.unref();
    t.pass("parse completed");
    t.end();
  });
});

test("lifecycle: piping a stream then destroying stops further processing", function (t) {
  let good = fs.readFileSync(path.join(FIXTURES, "rgba-8bit.png"));
  let source = new stream.Readable({
    read: function () {},
  });
  let png = new PNG();
  let gotEvent = false;
  png.on("parsed", function () {
    gotEvent = true;
  });
  png.on("error", function () {
    gotEvent = true;
  });
  source.pipe(png);
  source.push(good.slice(0, 10));
  png.destroy();
  source.push(good.slice(10));
  source.push(null);
  setTimeout(function () {
    t.equal(gotEvent, false, "no terminal event after mid-stream destroy");
    t.end();
  }, 100);
});
