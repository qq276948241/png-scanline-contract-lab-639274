"use strict";

// Helpers that take a valid PNG buffer and return a deliberately broken
// variant, so error handling can be exercised through the public API.

let builder = require("./png-builder");

// Flip one byte at an absolute offset.
function corruptByte(png, offset, value) {
  let out = Buffer.from(png);
  out[offset] = value == null ? out[offset] ^ 0xff : value;
  return out;
}

function breakSignature(png) {
  let out = Buffer.from(png);
  out[0] = 0x00;
  return out;
}

function truncate(png, length) {
  return png.slice(0, length);
}

// Locate the first chunk of the given type and return its byte range
// { start, lengthOffset, typeOffset, dataOffset, crcOffset, end }.
function findChunk(png, type) {
  let off = builder.SIGNATURE.length;
  while (off + 8 <= png.length) {
    let len = png.readUInt32BE(off);
    let typeString = png.toString("ascii", off + 4, off + 8);
    let end = off + 12 + len;
    if (typeString === type) {
      return {
        start: off,
        lengthOffset: off,
        typeOffset: off + 4,
        dataOffset: off + 8,
        crcOffset: off + 8 + len,
        end: end,
        length: len,
      };
    }
    off = end;
  }
  return null;
}

function breakCrc(png, type) {
  let location = findChunk(png, type || "IHDR");
  if (!location) {
    throw new Error("chunk not found: " + type);
  }
  let out = Buffer.from(png);
  out[location.crcOffset] ^= 0xff;
  return out;
}

// Rewrite the IHDR length field (and nothing else), producing a structural
// mismatch between the declared length and the real chunk.
function breakIHDRLength(png, newLength) {
  let location = findChunk(png, "IHDR");
  let out = Buffer.from(png);
  out.writeUInt32BE(newLength, location.lengthOffset);
  return out;
}

function patchIHDR(png, fieldOffset, value) {
  let location = findChunk(png, "IHDR");
  let out = Buffer.from(png);
  out[location.dataOffset + fieldOffset] = value;
  // Recompute the CRC so the patched field itself is the only failure.
  let typeAndData = out.slice(
    location.typeOffset,
    location.dataOffset + location.length
  );
  out.writeUInt32BE(builder.crc32(typeAndData), location.crcOffset);
  return out;
}

function setDimensions(png, width, height) {
  let location = findChunk(png, "IHDR");
  let out = Buffer.from(png);
  out.writeUInt32BE(width, location.dataOffset);
  out.writeUInt32BE(height, location.dataOffset + 4);
  let typeAndData = out.slice(
    location.typeOffset,
    location.dataOffset + location.length
  );
  out.writeUInt32BE(builder.crc32(typeAndData), location.crcOffset);
  return out;
}

// Drop every IDAT chunk from the file, keeping signature/IHDR/IEND intact.
function removeIDAT(png) {
  let out = [png.slice(0, builder.SIGNATURE.length)];
  let off = builder.SIGNATURE.length;
  while (off + 8 <= png.length) {
    let len = png.readUInt32BE(off);
    let type = png.toString("ascii", off + 4, off + 8);
    let end = off + 12 + len;
    if (type !== "IDAT") {
      out.push(png.slice(off, end));
    }
    off = end;
  }
  return Buffer.concat(out);
}

// Insert a chunk claiming an enormous length, then immediately end the
// stream so the parser must reject the length before any big allocation.
function insertHugeLengthChunk(png) {
  let location = findChunk(png, "IHDR");
  let fake = Buffer.alloc(8);
  fake.writeUInt32BE(0xffffffff, 0);
  fake.write("cUsT", 4, "ascii"); // ancillary bit set, unknown type
  return Buffer.concat([png.slice(0, location.end), fake]);
}

// Corrupt the first IDAT data byte so the zlib stream is invalid.
// Truncate the IDAT payload, dropping the end of the deflate stream and its
// Adler-32 checksum. Both inflate implementations reject this reliably,
// unlike a single byte flip which small streams may tolerate.
function breakIDATCompression(png) {
  let location = findChunk(png, "IDAT");
  let payload = png.slice(
    location.dataOffset,
    location.dataOffset + location.length
  );
  let shortened = payload.slice(0, Math.max(2, payload.length - 6));
  let out = Buffer.concat([
    png.slice(0, location.start),
    builder.chunk("IDAT", shortened),
    png.slice(location.end),
  ]);
  return out;
}

// Overwrite the first scan line's filter-type byte (first inflated byte).
// Requires the caller to pass raw IDAT replacement data, so instead this
// helper rebuilds a PNG from raw image data with an illegal filter byte.
function withIllegalFilterByte(rawImageData, width, height, colorType, depth) {
  let zlib = require("zlib");
  let ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth;
  ihdr[9] = colorType;
  let parts = [builder.SIGNATURE, builder.chunk("IHDR", ihdr)];
  let broken = Buffer.from(rawImageData);
  broken[0] = 99; // illegal filter type
  parts.push(builder.chunk("IDAT", zlib.deflateSync(broken)));
  parts.push(builder.chunk("IEND"));
  return Buffer.concat(parts);
}

// Append trailing junk after IEND.
function appendTrailingData(png, extra) {
  return Buffer.concat([png, Buffer.from(extra || "junk-junk-junk")]);
}

// Duplicate a chunk that must only appear once (e.g. IHDR).
function duplicateChunk(png, type) {
  let location = findChunk(png, type);
  let chunkBytes = png.slice(location.start, location.end);
  return Buffer.concat([
    png.slice(0, location.end),
    chunkBytes,
    png.slice(location.end),
  ]);
}

module.exports = {
  corruptByte: corruptByte,
  breakSignature: breakSignature,
  truncate: truncate,
  findChunk: findChunk,
  breakCrc: breakCrc,
  breakIHDRLength: breakIHDRLength,
  patchIHDR: patchIHDR,
  setDimensions: setDimensions,
  removeIDAT: removeIDAT,
  insertHugeLengthChunk: insertHugeLengthChunk,
  breakIDATCompression: breakIDATCompression,
  withIllegalFilterByte: withIllegalFilterByte,
  appendTrailingData: appendTrailingData,
  duplicateChunk: duplicateChunk,
};
