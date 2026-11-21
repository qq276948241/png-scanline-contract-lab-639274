"use strict";

let constants = require("./constants");
let errors = require("./errors");

module.exports = function (dataIn, width, height, options) {
  let outHasAlpha =
    [constants.COLORTYPE_COLOR_ALPHA, constants.COLORTYPE_ALPHA].indexOf(
      options.colorType
    ) !== -1;
  if (options.colorType === options.inputColorType) {
    // The fast path is only valid when the input really has the same channel
    // layout as the output. A 3-channel buffer declared as colour type 6
    // (inputHasAlpha === false) still needs the alpha sample synthesised, so
    // it must go through the general conversion below.
    let inputAlphaMatches =
      Boolean(options.inputHasAlpha) === Boolean(outHasAlpha);
    if (inputAlphaMatches) {
      let bigEndian = (function () {
        let buffer = new ArrayBuffer(2);
        new DataView(buffer).setInt16(0, 256, true /* littleEndian */);
        // Int16Array uses the platform's endianness.
        return new Int16Array(buffer)[0] !== 256;
      })();
      // If no need to convert to grayscale and alpha is present/absent in both, take a fast route
      if (options.bitDepth === 8 || (options.bitDepth === 16 && bigEndian)) {
        return dataIn;
      }
    }
  }

  // map to a UInt16 view if data is 16bit. The view must honour the source
  // buffer's byteOffset: a Buffer can be a slice of a larger allocation, and
  // reading through the raw ArrayBuffer would pick up unrelated bytes.
  let data =
    options.bitDepth !== 16
      ? dataIn
      : new Uint16Array(
          dataIn.buffer,
          dataIn.byteOffset,
          Math.floor(dataIn.length / 2)
        );

  let maxValue = 255;
  let inBpp = constants.COLORTYPE_TO_BPP_MAP[options.inputColorType];
  if (
    options.inputColorType === constants.COLORTYPE_COLOR_ALPHA &&
    !options.inputHasAlpha
  ) {
    // A 3 channel input still reports color type 6 so the alpha must be
    // treated as fully opaque rather than read from a byte that isn't there.
    inBpp = 3;
  }
  let outBpp = constants.COLORTYPE_TO_BPP_MAP[options.colorType];
  if (options.bitDepth === 16) {
    maxValue = 65535;
    outBpp *= 2;
  }
  // Sizes were validated by Packer#validate before this point; the explicit
  // check keeps the module safe when used directly.
  let outData = Buffer.alloc(width * height * outBpp);

  let inIndex = 0;
  let outIndex = 0;

  // Copied so filling in the defaults does not mutate the caller's options
  // object (and, via it, the next encode that reuses those options).
  let bgColor = options.bgColor || {};
  bgColor = {
    red: bgColor.red === undefined ? maxValue : bgColor.red,
    green: bgColor.green === undefined ? maxValue : bgColor.green,
    blue: bgColor.blue === undefined ? maxValue : bgColor.blue,
  };

  function getRGBA() {
    let red;
    let green;
    let blue;
    let alpha = maxValue;
    switch (options.inputColorType) {
      case constants.COLORTYPE_COLOR_ALPHA:
        red = data[inIndex];
        green = data[inIndex + 1];
        blue = data[inIndex + 2];
        if (options.inputHasAlpha) {
          alpha = data[inIndex + 3];
        }
        break;
      case constants.COLORTYPE_COLOR:
        red = data[inIndex];
        green = data[inIndex + 1];
        blue = data[inIndex + 2];
        break;
      case constants.COLORTYPE_ALPHA:
        alpha = data[inIndex + 1];
        red = data[inIndex];
        green = red;
        blue = red;
        break;
      case constants.COLORTYPE_GRAYSCALE:
        red = data[inIndex];
        green = red;
        blue = red;
        break;
      default:
        throw errors.create(
          errors.CODES.COLOR_TYPE,
          "input color type:" +
            options.inputColorType +
            " is not supported at present"
        );
    }

    if (options.inputHasAlpha) {
      if (!outHasAlpha) {
        alpha /= maxValue;
        red = Math.min(
          Math.max(Math.round((1 - alpha) * bgColor.red + alpha * red), 0),
          maxValue
        );
        green = Math.min(
          Math.max(Math.round((1 - alpha) * bgColor.green + alpha * green), 0),
          maxValue
        );
        blue = Math.min(
          Math.max(Math.round((1 - alpha) * bgColor.blue + alpha * blue), 0),
          maxValue
        );
      }
    }
    return { red: red, green: green, blue: blue, alpha: alpha };
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let rgba = getRGBA(data, inIndex);

      switch (options.colorType) {
        case constants.COLORTYPE_COLOR_ALPHA:
        case constants.COLORTYPE_COLOR:
          if (options.bitDepth === 8) {
            outData[outIndex] = rgba.red;
            outData[outIndex + 1] = rgba.green;
            outData[outIndex + 2] = rgba.blue;
            if (outHasAlpha) {
              outData[outIndex + 3] = rgba.alpha;
            }
          } else {
            outData.writeUInt16BE(rgba.red, outIndex);
            outData.writeUInt16BE(rgba.green, outIndex + 2);
            outData.writeUInt16BE(rgba.blue, outIndex + 4);
            if (outHasAlpha) {
              outData.writeUInt16BE(rgba.alpha, outIndex + 6);
            }
          }
          break;
        case constants.COLORTYPE_ALPHA:
        case constants.COLORTYPE_GRAYSCALE: {
          // Convert to grayscale and alpha
          let grayscale = (rgba.red + rgba.green + rgba.blue) / 3;
          if (options.bitDepth === 8) {
            outData[outIndex] = grayscale;
            if (outHasAlpha) {
              outData[outIndex + 1] = rgba.alpha;
            }
          } else {
            outData.writeUInt16BE(grayscale | 0, outIndex);
            if (outHasAlpha) {
              outData.writeUInt16BE(rgba.alpha, outIndex + 2);
            }
          }
          break;
        }
        default:
          throw errors.create(
            errors.CODES.COLOR_TYPE,
            "unrecognised color Type " + options.colorType
          );
      }

      inIndex += inBpp;
      outIndex += outBpp;
    }
  }

  return outData;
};
