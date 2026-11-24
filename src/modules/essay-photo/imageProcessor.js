'use strict';

const crypto = require('crypto');
const sharp = require('sharp');
const { AppError } = require('../../utils/AppError');
const { MAX_INPUT_PIXELS, MAX_DIMENSION, JPEG_QUALITY } = require('./config');

function detectImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'png';
  }
  // WebP: RIFF....WEBP
  if (
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

async function processImage(inputBuffer) {
  const kind = detectImageType(inputBuffer);
  if (!kind) {
    throw new AppError(
      'Unsupported image format. Only JPEG, PNG, and WebP are allowed.',
      422,
      'INVALID_IMAGE_TYPE'
    );
  }

  let outputBuffer;
  try {
    // sharp strips EXIF/metadata by default when .withMetadata() is omitted.
    outputBuffer = await sharp(inputBuffer, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize({
        width: MAX_DIMENSION,
        height: MAX_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();
  } catch {
    throw new AppError('Invalid or corrupted image.', 422, 'INVALID_IMAGE_DATA');
  }

  const sha256 = crypto.createHash('sha256').update(outputBuffer).digest('hex');
  return {
    buffer: outputBuffer,
    mimeType: 'image/jpeg',
    sha256,
  };
}

module.exports = {
  detectImageType,
  processImage,
};
