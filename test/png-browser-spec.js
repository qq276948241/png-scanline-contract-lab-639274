"use strict";

// The package ships a Browserify bundle (`npm run browserify`) and the README
// points browser users at it. This spec bundles the entry point on the fly,
// runs it against the same offline fixtures, and requires identical pixels and
// identical error codes to the Node build.

let test = require("tape");
let path = require("path");

let browserify = require("browserify");

let nodePng = require("../lib/png").PNG;
let builder = require("./fixtures/png-builder");
let definitions = require("./fixtures/definitions");

// Bundling takes a moment; build it once and share the result.
let bundlePromise = null;

function loadBundle() {
  if (!bundlePromise) {
    bundlePromise = new Promise(function (resolve, reject) {
      let bundler = browserify(path.join(__dirname, "..", "lib", "png.js"), {
        standalone: "png",
        basedir: path.join(__dirname, ".."),
      });
      let chunks = [];
      let bundleStream = bundler.bundle();
      bundleStream.on("data", function (chunk) {
        chunks.push(chunk);
      });
      bundleStream.on("error", reject);
      bundleStream.on("end", function () {
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
  }
  return bundlePromise;
}

function instantiate(source) {
  let module = { exports: {} };
  // The bundle is a CommonJS wrapper that expects module/exports/require.
  // eslint-disable-next-line no-new-func
  let factory = new Function("module", "exports", "require", source);
  factory(module, module.exports, require);
  return module.exports.PNG;
}

function readOrCode(PNG, buffer) {
  try {
    let parsed = PNG.sync.read(buffer);
    return { data: parsed.data, code: null };
  } catch (err) {
    return { data: null, code: err.code || err.message };
  }
}

test("browser bundle: decodes fixtures identically to the Node build", function (t) {
  return loadBundle().then(function (source) {
    let BrowserPng = instantiate(source);
    t.ok(BrowserPng, "bundle exposes PNG");

    Object.keys(definitions).forEach(function (name) {
      let buffer = builder.build(definitions[name]);
      let fromNode = readOrCode(nodePng, buffer);
      let fromBrowser = readOrCode(BrowserPng, buffer);

      t.equal(fromBrowser.code, fromNode.code, name + ": same error code");
      if (!fromNode.code) {
        t.ok(
          Buffer.compare(
            Buffer.from(fromNode.data),
            Buffer.from(fromBrowser.data)
          ) === 0,
          name + ": identical pixels"
        );
      }
    });
    t.end();
  });
});

test("browser bundle: rejects malformed input with the same error codes", function (t) {
  return loadBundle().then(function (source) {
    let BrowserPng = instantiate(source);

    let valid = builder.build(definitions["rgba8-filters.png"]);
    let badCrc = Buffer.from(valid);
    badCrc[badCrc.length - 1] ^= 0xff;

    let cases = {
      "bad signature": Buffer.from("89504e470d0a1a0b", "hex"),
      "empty input": Buffer.alloc(0),
      truncated: valid.slice(0, 25),
      "bad filter byte": builder.assemble([
        builder.ihdr(2, 2, 8, 6, 0),
        builder.chunk(
          "IDAT",
          builder.deflate(Buffer.from([9, 0, 0, 0, 0, 0, 0, 0, 0]))
        ),
        builder.chunk("IEND", null),
      ]),
      "bad zlib": builder.assemble([
        builder.ihdr(2, 2, 8, 6, 0),
        builder.chunk("IDAT", Buffer.from("deadbeef", "hex")),
        builder.chunk("IEND", null),
      ]),
      "corrupt IEND crc": badCrc,
    };

    Object.keys(cases).forEach(function (name) {
      let fromNode = readOrCode(nodePng, cases[name]);
      let fromBrowser = readOrCode(BrowserPng, cases[name]);
      t.ok(fromNode.code, name + ": Node rejects the input");
      t.equal(
        fromBrowser.code,
        fromNode.code,
        name + ": browser reports the same code"
      );
      t.equal(fromBrowser.data, null, name + ": browser emits no pixels");
    });
    t.end();
  });
});

test("browser bundle: encodes bytes identical to the Node build", function (t) {
  return loadBundle().then(function (source) {
    let BrowserPng = instantiate(source);

    let width = 7;
    let height = 5;
    let data = Buffer.alloc(width * height * 4);
    for (let i = 0; i < data.length; i++) {
      data[i] = (i * 37 + 11) & 0xff;
    }

    let meta = { width: width, height: height, data: data, gamma: 0 };
    let options = { filterType: 4, deflateLevel: 6 };
    let nodeBytes = nodePng.sync.write(meta, Object.assign({}, options));
    let browserBytes = BrowserPng.sync.write(meta, Object.assign({}, options));

    t.ok(
      Buffer.compare(nodeBytes, browserBytes) === 0,
      "both builds produce byte-identical PNGs"
    );

    // ...and the browser output decodes back to the input.
    let roundTrip = BrowserPng.sync.read(browserBytes);
    t.ok(
      Buffer.compare(Buffer.from(roundTrip.data), data) === 0,
      "browser round-trip is lossless"
    );
    t.end();
  });
});

test("browser bundle: invalid encode options fail before writing", function (t) {
  return loadBundle().then(function (source) {
    let BrowserPng = instantiate(source);
    let meta = { width: 2, height: 2, data: Buffer.alloc(16), gamma: 0 };

    [
      [{ filterType: 9 }, "ERR_PNG_OPTIONS"],
      [{ bitDepth: 4 }, "ERR_PNG_OPTIONS"],
      [{ deflateLevel: 42 }, "ERR_PNG_OPTIONS"],
    ].forEach(function (entry) {
      let code = null;
      try {
        BrowserPng.sync.write(meta, entry[0]);
      } catch (err) {
        code = err.code;
      }
      t.equal(code, entry[1], JSON.stringify(entry[0]) + ": rejects");
    });

    let code = null;
    try {
      BrowserPng.sync.write({ width: 2, height: 2, data: Buffer.alloc(3) });
    } catch (err) {
      code = err.code;
    }
    t.equal(code, "ERR_PNG_DATA_SIZE", "short data: rejects");
    t.end();
  });
});
