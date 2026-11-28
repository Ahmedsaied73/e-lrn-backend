'use strict';

const busboy = require('busboy');
const { AppError } = require('../../utils/AppError');
const { MAX_IMAGE_BYTES } = require('./config');
const { isAdmin } = require('../../middlewares/index');
const defaultService = require('./service');

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = busboy({ headers: req.headers, limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } });
    } catch {
      reject(new AppError('Invalid multipart request.', 400, 'INVALID_MULTIPART'));
      return;
    }

    const fields = {};
    let fileBuffer = null;
    let fileTooLarge = false;
    let readFailed = false;

    bb.on('field', (name, val) => {
      fields[name] = val;
    });

    bb.on('file', (fieldName, fileStream) => {
      fileStream.on('error', () => {
        readFailed = true;
      });
      if (fieldName !== 'image' && fieldName !== 'file') {
        fileStream.resume();
        return;
      }
      const chunks = [];
      let size = 0;
      fileStream.on('data', (chunk) => {
        if (fileTooLarge || readFailed) return;
        size += chunk.length;
        if (size > MAX_IMAGE_BYTES) {
          fileTooLarge = true;
          fileStream.resume();
          return;
        }
        chunks.push(chunk);
      });
      fileStream.on('limit', () => {
        fileTooLarge = true;
        fileStream.resume();
      });
      fileStream.on('end', () => {
        if (!fileTooLarge && !readFailed) {
          fileBuffer = Buffer.concat(chunks);
        }
      });
    });

    bb.on('error', () => {
      reject(new AppError('Malformed multipart payload.', 400, 'INVALID_MULTIPART'));
    });

    bb.on('finish', () => {
      if (fileTooLarge) {
        reject(new AppError('Image exceeds 4MB limit.', 422, 'IMAGE_TOO_LARGE'));
        return;
      }
      if (readFailed) {
        reject(new AppError('Failed to read uploaded image.', 400, 'IMAGE_READ_FAILED'));
        return;
      }
      resolve({ fields, fileBuffer });
    });

    req.pipe(bb);
  });
}

function createController(service = defaultService) {
  async function extract(req, res) {
    try {
      const { fields, fileBuffer } = await parseMultipart(req);
      const admin = await isAdmin(req);
      const data = await service.extractEssayPhoto({
        userId: req.user.id,
        userRole: admin ? 'ADMIN' : 'STUDENT',
        examId: fields.examId,
        attemptId: fields.attemptId,
        questionId: fields.questionId,
        imageBuffer: fileBuffer,
      });
      return res.status(200).json({ success: true, data });
    } catch (err) {
      if (err instanceof AppError) {
        return res.status(err.statusCode).json({
          success: false,
          error: err.message,
          code: err.code,
        });
      }
      console.error('[EssayPhoto] Unexpected error:', err.message);
      return res.status(500).json({
        success: false,
        error: 'Internal server error.',
        code: 'INTERNAL_ERROR',
      });
    }
  }

  return { extract };
}

const defaultController = createController();

module.exports = {
  createController,
  extract: defaultController.extract,
};
