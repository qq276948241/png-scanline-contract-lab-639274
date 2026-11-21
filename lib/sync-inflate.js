"use strict";

// Historically this module implemented a synchronous inflate with an output
// cap for Node versions whose zlib lacked one. Every supported Node version
// now provides `zlib.inflateSync(buffer, { maxOutputLength })`, so this is a
// thin wrapper kept for backwards compatibility with code that required
// `pngjs/lib/sync-inflate` directly.
//
// Unlike the old implementation it never dereferences zlib internals: a
// corrupt stream surfaces the original zlib error instead of a TypeError from
// a closed binding.

let zlib = require("zlib");

function inflateSync(buffer, opts) {
  if (typeof buffer === "string") {
    buffer = Buffer.from(buffer);
  }
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError("Not a string or buffer");
  }

  let options = {};
  if (opts && opts.maxLength != null) {
    options.maxOutputLength = opts.maxLength;
  }
  return zlib.inflateSync(buffer, options);
}

module.exports = exports = inflateSync;
exports.inflateSync = inflateSync;

// Kept for API compatibility; zlib's own streams are used everywhere now.
exports.createInflate = function (opts) {
  return zlib.createInflate(opts);
};
