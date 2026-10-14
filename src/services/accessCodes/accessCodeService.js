'use strict';

const crypto = require('crypto');
const prisma = require('../../config/db');

// 32-character alphabet with ambiguous characters (0, O, 1, I, L) removed.
// Since 256 % 32 === 0, byte % 32 has zero modulo bias.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ALPHABET_LENGTH = ALPHABET.length; // 32
const VALID_CODE_LENGTHS = [8, 10, 12];
const DEFAULT_CODE_LENGTH = 8;
const MAX_BATCH_QUANTITY = 10000;
const ACCESS_WINDOW_DAYS = 365;

/**
 * Creates a structured error with status code and machine-readable code.
 */
function createError(message, statusCode, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

/**
 * Formats a canonical code with a dash every 4 characters.
 * E.g., 'A7X3K9M2' -> 'A7X3-K9M2'
 */
function formatCode(canonical) {
  if (!canonical || typeof canonical !== 'string') return '';
  const clean = canonical.replace(/[^A-Z0-9]/g, '');
  return clean.match(/.{1,4}/g)?.join('-') || clean;
}

/**
 * Normalizes user input into canonical uppercase code without spaces or dashes.
 * Transliterates Arabic-Indic and Eastern Arabic-Indic numerals to standard ASCII 0-9.
 */
function normalizeCode(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .trim();
}

/**
 * Generates a single cryptographically secure random code string.
 */
function generateRandomCodeString(length) {
  const bytes = crypto.randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i++) {
    code += ALPHABET[bytes[i] % ALPHABET_LENGTH];
  }
  return code;
}

/**
 * Generates a batch of unique access codes for a course.
 */
async function generateBatch({ courseId, quantity, codeLength = DEFAULT_CODE_LENGTH, label = null, tags = [], adminId }) {
  let course;
  const parsedCourseId = parseInt(courseId, 10);
  if (parsedCourseId && parsedCourseId > 0 && !isNaN(parsedCourseId) && /^\d+$/.test(String(courseId).trim())) {
    course = await prisma.course.findUnique({
      where: { id: parsedCourseId },
      select: { id: true, title: true, slug: true },
    });
  } else if (courseId && typeof courseId === 'string' && courseId.trim()) {
    course = await prisma.course.findUnique({
      where: { slug: courseId.trim() },
      select: { id: true, title: true, slug: true },
    });
  } else {
    throw createError('Valid courseId is required.', 400, 'INVALID_INPUT');
  }

  if (!course) {
    throw createError('Course not found.', 404, 'COURSE_NOT_FOUND');
  }

  const parsedQty = parseInt(quantity, 10);
  if (!parsedQty || parsedQty < 1 || parsedQty > MAX_BATCH_QUANTITY || isNaN(parsedQty)) {
    throw createError(`Quantity must be between 1 and ${MAX_BATCH_QUANTITY}.`, 400, 'INVALID_QUANTITY');
  }

  let parsedLength = DEFAULT_CODE_LENGTH;
  if (codeLength !== undefined && codeLength !== null) {
    parsedLength = parseInt(codeLength, 10);
    if (!VALID_CODE_LENGTHS.includes(parsedLength)) {
      throw createError('Code length must be 8, 10, or 12.', 400, 'INVALID_CODE_LENGTH');
    }
  }

  const sanitizedLabel = label && typeof label === 'string' ? label.trim().slice(0, 200) : null;
  const sanitizedTags = Array.isArray(tags)
    ? tags.map((t) => String(t).trim().slice(0, 50)).filter(Boolean).slice(0, 10)
    : [];

  // Generate unique codes in memory
  const codeSet = new Set();
  while (codeSet.size < parsedQty) {
    codeSet.add(generateRandomCodeString(parsedLength));
  }

  // Collision mitigation: check if any of these already exist in DB
  let candidateCodes = Array.from(codeSet);
  let attempts = 0;
  while (attempts < 5) {
    const existing = await prisma.accessCode.findMany({
      where: { code: { in: candidateCodes } },
      select: { code: true },
    });

    if (existing.length === 0) break;

    const existingSet = new Set(existing.map((e) => e.code));
    for (const c of existingSet) {
      codeSet.delete(c);
    }
    while (codeSet.size < parsedQty) {
      codeSet.add(generateRandomCodeString(parsedLength));
    }
    candidateCodes = Array.from(codeSet);
    attempts++;
  }

  const finalCodes = candidateCodes;

  // Persist batch and codes in an atomic transaction
  const batch = await prisma.$transaction(async (tx) => {
    const createdBatch = await tx.accessBatch.create({
      data: {
        courseId: course.id,
        quantity: parsedQty,
        codeLength: parsedLength,
        label: sanitizedLabel,
        tags: sanitizedTags,
        generatedBy: adminId,
      },
    });

    const codeRecords = finalCodes.map((code) => ({
      code,
      batchId: createdBatch.id,
      courseId: course.id,
      status: 'AVAILABLE',
    }));

    await tx.accessCode.createMany({
      data: codeRecords,
      skipDuplicates: true,
    });

    return createdBatch;
  });

  return {
    batchId: batch.id,
    courseId: course.id,
    courseName: course.title,
    quantity: batch.quantity,
    codeLength: batch.codeLength,
    label: batch.label,
    tags: batch.tags,
    codes: finalCodes.map(formatCode),
    generatedAt: batch.createdAt,
  };
}

/**
 * Redeems an access code for a student.
 * Uses atomic CAS transaction with 365-day access window.
 * Aborts with 409 if already actively enrolled (code is not consumed).
 */
async function redeemCode({ userId, code }) {
  if (!userId || typeof userId !== 'number') {
    throw createError('Authentication required.', 401, 'UNAUTHORIZED');
  }

  const canonicalCode = normalizeCode(code);
  if (!canonicalCode || canonicalCode.length < 6 || canonicalCode.length > 16 || !/^[A-Z0-9]+$/.test(canonicalCode)) {
    throw createError('الكود المُدخل غير صحيح', 400, 'INVALID_INPUT');
  }

  // Pre-fetch code to inspect status and course
  const codeRow = await prisma.accessCode.findUnique({
    where: { code: canonicalCode },
    include: {
      course: { select: { id: true, title: true, slug: true } },
    },
  });

  // Generic uniform error for not found, already redeemed, or revoked to prevent code enumeration
  if (!codeRow || codeRow.status !== 'AVAILABLE') {
    throw createError('هذا الكود غير صالح أو تم استخدامه بالفعل', 422, 'INVALID_CODE');
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + ACCESS_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  // Atomic transaction
  const result = await prisma.$transaction(async (tx) => {
    // 1. Check existing active enrollment
    const existingEnrollment = await tx.enrollment.findUnique({
      where: {
        userId_courseId: { userId, courseId: codeRow.courseId },
      },
    });

    const isAlreadyActivelyEnrolled =
      existingEnrollment &&
      existingEnrollment.isPaid &&
      (!existingEnrollment.expiresAt || existingEnrollment.expiresAt > now);

    if (isAlreadyActivelyEnrolled) {
      throw createError('أنت مشترك بالفعل في هذا الكورس', 409, 'ALREADY_ENROLLED');
    }

    // 2. Atomic Compare-And-Swap (CAS) update
    const updateResult = await tx.accessCode.updateMany({
      where: {
        id: codeRow.id,
        status: 'AVAILABLE',
      },
      data: {
        status: 'REDEEMED',
        redeemedBy: userId,
        redeemedAt: now,
      },
    });

    if (updateResult.count === 0) {
      throw createError('هذا الكود غير صالح أو تم استخدامه بالفعل', 422, 'INVALID_CODE');
    }

    // 3. Upsert Enrollment
    const enrollment = await tx.enrollment.upsert({
      where: {
        userId_courseId: { userId, courseId: codeRow.courseId },
      },
      update: {
        isPaid: true,
        paymentDate: now,
        expiresAt: expiresAt,
      },
      create: {
        userId,
        courseId: codeRow.courseId,
        isPaid: true,
        paymentDate: now,
        expiresAt: expiresAt,
      },
    });

    return {
      courseName: codeRow.course.title,
      courseId: codeRow.courseId,
      courseSlug: codeRow.course.slug,
      enrollmentId: enrollment.id,
      expiresAt: expiresAt.toISOString(),
    };
  });

  return result;
}

/**
 * Revokes individual unused access codes.
 */
async function revokeCode({ codeIds, adminId }) {
  if (!Array.isArray(codeIds) || codeIds.length === 0 || codeIds.length > 100) {
    throw createError('codeIds must be an array of 1 to 100 IDs.', 400, 'INVALID_INPUT');
  }

  const ids = codeIds.map((id) => parseInt(id, 10)).filter((id) => id > 0 && !isNaN(id));
  if (ids.length !== codeIds.length) {
    throw createError('All codeIds must be positive integers.', 400, 'INVALID_INPUT');
  }

  const codes = await prisma.accessCode.findMany({
    where: { id: { in: ids } },
    select: { id: true, code: true, status: true },
  });

  if (codes.length === 0) {
    throw createError('No codes found.', 404, 'CODE_NOT_FOUND');
  }

  if (codes.length !== ids.length) {
    throw createError('One or more codes not found.', 404, 'CODE_NOT_FOUND');
  }

  const alreadyRedeemed = codes.find((c) => c.status === 'REDEEMED');
  if (alreadyRedeemed) {
    throw createError(
      `Cannot revoke code ${formatCode(alreadyRedeemed.code)}: code has already been redeemed.`,
      409,
      'CODE_ALREADY_REDEEMED'
    );
  }

  const now = new Date();
  const updateResult = await prisma.accessCode.updateMany({
    where: {
      id: { in: ids },
      status: 'AVAILABLE',
    },
    data: {
      status: 'REVOKED',
      revokedBy: adminId,
      revokedAt: now,
    },
  });

  return { revokedCount: updateResult.count };
}

/**
 * Revokes all AVAILABLE codes within an entire batch.
 */
async function revokeBatch({ batchId, adminId }) {
  const parsedBatchId = parseInt(batchId, 10);
  if (!parsedBatchId || parsedBatchId <= 0 || isNaN(parsedBatchId)) {
    throw createError('Valid batchId is required.', 400, 'INVALID_INPUT');
  }

  const batch = await prisma.accessBatch.findUnique({
    where: { id: parsedBatchId },
    select: { id: true },
  });

  if (!batch) {
    throw createError('Batch not found.', 404, 'BATCH_NOT_FOUND');
  }

  const now = new Date();
  const updateResult = await prisma.accessCode.updateMany({
    where: {
      batchId: parsedBatchId,
      status: 'AVAILABLE',
    },
    data: {
      status: 'REVOKED',
      revokedBy: adminId,
      revokedAt: now,
    },
  });

  return { revokedCount: updateResult.count };
}

/**
 * Looks up full details and audit history for a single code.
 */
async function lookupCode(rawCode) {
  const canonicalCode = normalizeCode(rawCode);
  if (!canonicalCode) {
    throw createError('Code is required.', 400, 'INVALID_INPUT');
  }

  const codeRow = await prisma.accessCode.findUnique({
    where: { code: canonicalCode },
    include: {
      course: { select: { id: true, title: true } },
      batch: { select: { id: true, label: true, createdAt: true } },
    },
  });

  if (!codeRow) {
    throw createError('Code not found.', 404, 'CODE_NOT_FOUND');
  }

  let redeemedUser = null;
  if (codeRow.redeemedBy) {
    redeemedUser = await prisma.user.findUnique({
      where: { id: codeRow.redeemedBy },
      select: { id: true, name: true, email: true },
    });
  }

  let revokedUser = null;
  if (codeRow.revokedBy) {
    revokedUser = await prisma.user.findUnique({
      where: { id: codeRow.revokedBy },
      select: { id: true, name: true, email: true },
    });
  }

  return {
    id: codeRow.id,
    code: formatCode(codeRow.code),
    status: codeRow.status,
    courseId: codeRow.courseId,
    courseName: codeRow.course ? codeRow.course.title : null,
    batchId: codeRow.batchId,
    batchLabel: codeRow.batch ? codeRow.batch.label : null,
    redeemedBy: redeemedUser ? { id: redeemedUser.id, name: redeemedUser.name, email: redeemedUser.email } : null,
    redeemedAt: codeRow.redeemedAt,
    revokedBy: revokedUser ? { id: revokedUser.id, name: revokedUser.name, email: revokedUser.email } : null,
    revokedAt: codeRow.revokedAt,
    createdAt: codeRow.createdAt,
  };
}

/**
 * Lists batches with filtering, pagination, and status aggregation.
 */
async function getBatches({ courseId, search, page = 1, limit = 20 }) {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.max(1, Math.min(parseInt(limit, 10) || 20, 100));
  const skip = (pageNum - 1) * limitNum;

  const where = {};
  if (courseId) {
    const cid = parseInt(courseId, 10);
    if (cid > 0 && !isNaN(cid) && /^\d+$/.test(String(courseId).trim())) {
      where.courseId = cid;
    } else if (typeof courseId === 'string' && courseId.trim()) {
      const c = await prisma.course.findUnique({ where: { slug: courseId.trim() }, select: { id: true } });
      if (c) where.courseId = c.id;
    }
  }

  if (search && typeof search === 'string' && search.trim()) {
    const s = search.trim();
    where.OR = [
      { label: { contains: s, mode: 'insensitive' } },
      { course: { title: { contains: s, mode: 'insensitive' } } },
      { tags: { has: s } },
    ];
  }

  const [total, batches] = await Promise.all([
    prisma.accessBatch.count({ where }),
    prisma.accessBatch.findMany({
      where,
      skip,
      take: limitNum,
      orderBy: { createdAt: 'desc' },
      include: {
        course: { select: { id: true, title: true, slug: true } },
      },
    }),
  ]);

  if (batches.length === 0) {
    return {
      batches: [],
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    };
  }

  const batchIds = batches.map((b) => b.id);
  const adminIds = [...new Set(batches.map((b) => b.generatedBy))];

  // Group code counts by batch and status
  const [groupedStats, admins] = await Promise.all([
    prisma.accessCode.groupBy({
      by: ['batchId', 'status'],
      where: { batchId: { in: batchIds } },
      _count: { _all: true },
    }),
    prisma.user.findMany({
      where: { id: { in: adminIds } },
      select: { id: true, name: true, email: true },
    }),
  ]);

  const statsMap = new Map();
  for (const row of groupedStats) {
    if (!statsMap.has(row.batchId)) {
      statsMap.set(row.batchId, { available: 0, redeemed: 0, revoked: 0 });
    }
    const current = statsMap.get(row.batchId);
    if (row.status === 'AVAILABLE') current.available = row._count._all;
    else if (row.status === 'REDEEMED') current.redeemed = row._count._all;
    else if (row.status === 'REVOKED') current.revoked = row._count._all;
  }

  const adminMap = new Map(admins.map((a) => [a.id, a]));

  const formattedBatches = batches.map((b) => ({
    id: b.id,
    courseId: b.courseId,
    courseSlug: b.course ? b.course.slug : null,
    courseName: b.course ? b.course.title : 'Deleted Course',
    quantity: b.quantity,
    codeLength: b.codeLength,
    label: b.label,
    tags: b.tags,
    stats: statsMap.get(b.id) || { available: 0, redeemed: 0, revoked: 0 },
    generatedBy: adminMap.get(b.generatedBy)
      ? { id: b.generatedBy, name: adminMap.get(b.generatedBy).name }
      : { id: b.generatedBy, name: 'Admin' },
    createdAt: b.createdAt,
  }));

  // Calculate summary stats across all matching batches for the current query/filter
  const allMatchingBatches = await prisma.accessBatch.findMany({
    where,
    select: { id: true },
  });
  const allIds = allMatchingBatches.map((b) => b.id);
  const summaryStats = { available: 0, redeemed: 0, revoked: 0 };
  if (allIds.length > 0) {
    const allGrouped = await prisma.accessCode.groupBy({
      by: ['status'],
      where: { batchId: { in: allIds } },
      _count: { _all: true },
    });
    for (const row of allGrouped) {
      if (row.status === 'AVAILABLE') summaryStats.available = row._count._all;
      else if (row.status === 'REDEEMED') summaryStats.redeemed = row._count._all;
      else if (row.status === 'REVOKED') summaryStats.revoked = row._count._all;
    }
  }

  return {
    batches: formattedBatches,
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.ceil(total / limitNum),
    },
    summaryStats,
  };
}

/**
 * Returns batch details and paginated code list.
 */
async function getBatchDetails({ batchId, status, search, page = 1, limit = 50 }) {
  const parsedBatchId = parseInt(batchId, 10);
  if (!parsedBatchId || parsedBatchId <= 0 || isNaN(parsedBatchId)) {
    throw createError('Valid batchId is required.', 400, 'INVALID_INPUT');
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.max(1, Math.min(parseInt(limit, 10) || 50, 100));
  const skip = (pageNum - 1) * limitNum;

  const batch = await prisma.accessBatch.findUnique({
    where: { id: parsedBatchId },
    include: {
      course: { select: { id: true, title: true } },
    },
  });

  if (!batch) {
    throw createError('Batch not found.', 404, 'BATCH_NOT_FOUND');
  }

  // Get aggregated stats for this batch
  const groupedStats = await prisma.accessCode.groupBy({
    by: ['status'],
    where: { batchId: parsedBatchId },
    _count: { _all: true },
  });

  const stats = { available: 0, redeemed: 0, revoked: 0 };
  for (const row of groupedStats) {
    if (row.status === 'AVAILABLE') stats.available = row._count._all;
    else if (row.status === 'REDEEMED') stats.redeemed = row._count._all;
    else if (row.status === 'REVOKED') stats.revoked = row._count._all;
  }

  const where = { batchId: parsedBatchId };
  if (status && ['AVAILABLE', 'REDEEMED', 'REVOKED'].includes(status.toUpperCase())) {
    where.status = status.toUpperCase();
  }

  if (search && typeof search === 'string' && search.trim()) {
    const normalized = normalizeCode(search);
    if (normalized) {
      where.code = { contains: normalized };
    }
  }

  const [total, codes, adminUser] = await Promise.all([
    prisma.accessCode.count({ where }),
    prisma.accessCode.findMany({
      where,
      skip,
      take: limitNum,
      orderBy: { id: 'asc' },
    }),
    prisma.user.findUnique({
      where: { id: batch.generatedBy },
      select: { id: true, name: true, email: true },
    }),
  ]);

  const studentIds = codes.map((c) => c.redeemedBy).filter(Boolean);
  const revokerIds = codes.map((c) => c.revokedBy).filter(Boolean);
  const userIdsToFetch = [...new Set([...studentIds, ...revokerIds])];

  const users =
    userIdsToFetch.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: userIdsToFetch } },
          select: { id: true, name: true, email: true },
        })
      : [];

  const userMap = new Map(users.map((u) => [u.id, u]));

  return {
    batch: {
      id: batch.id,
      courseId: batch.courseId,
      courseName: batch.course ? batch.course.title : 'Deleted Course',
      quantity: batch.quantity,
      codeLength: batch.codeLength,
      label: batch.label,
      tags: batch.tags,
      stats,
      generatedBy: adminUser ? { id: adminUser.id, name: adminUser.name } : { id: batch.generatedBy, name: 'Admin' },
      createdAt: batch.createdAt,
    },
    codes: codes.map((c) => ({
      id: c.id,
      code: formatCode(c.code),
      status: c.status,
      redeemedBy: c.redeemedBy && userMap.get(c.redeemedBy) ? userMap.get(c.redeemedBy) : null,
      redeemedAt: c.redeemedAt,
      revokedBy: c.revokedBy && userMap.get(c.revokedBy) ? userMap.get(c.revokedBy) : null,
      revokedAt: c.revokedAt,
      createdAt: c.createdAt,
    })),
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.ceil(total / limitNum),
    },
  };
}

/**
 * Prepares CSV content and filename for batch code export.
 */
async function getBatchCsv(batchId) {
  const parsedBatchId = parseInt(batchId, 10);
  if (!parsedBatchId || parsedBatchId <= 0 || isNaN(parsedBatchId)) {
    throw createError('Valid batchId is required.', 400, 'INVALID_INPUT');
  }

  const batch = await prisma.accessBatch.findUnique({
    where: { id: parsedBatchId },
    include: {
      course: { select: { id: true, title: true } },
    },
  });

  if (!batch) {
    throw createError('Batch not found.', 404, 'BATCH_NOT_FOUND');
  }

  const codes = await prisma.accessCode.findMany({
    where: { batchId: parsedBatchId },
    orderBy: { id: 'asc' },
  });

  const studentIds = codes.map((c) => c.redeemedBy).filter(Boolean);
  const students =
    studentIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: studentIds } },
          select: { id: true, name: true, email: true },
        })
      : [];

  const studentMap = new Map(students.map((s) => [s.id, s]));

  // CSV escape helper with formula injection mitigation (CWE-1236)
  const escapeCsv = (val) => {
    if (val === null || val === undefined) return '';
    let str = String(val);
    if (/^[=+\-@\t\r]/.test(str)) {
      str = "'" + str;
    }
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const courseTitle = batch.course ? batch.course.title : 'Course';
  const header = ['code', 'status', 'courseId', 'courseName', 'redeemedBy', 'redeemedAt'].join(',');
  const rows = codes.map((c) => {
    const student = c.redeemedBy ? studentMap.get(c.redeemedBy) : null;
    const studentInfo = student ? student.email : '';
    const redeemedAtStr = c.redeemedAt ? c.redeemedAt.toISOString() : '';
    return [
      escapeCsv(formatCode(c.code)),
      escapeCsv(c.status),
      escapeCsv(batch.courseId),
      escapeCsv(courseTitle),
      escapeCsv(studentInfo),
      escapeCsv(redeemedAtStr),
    ].join(',');
  });

  const csvContent = '\uFEFF' + [header, ...rows].join('\r\n'); // Add BOM for Excel UTF-8 support
  const safeTitle = (batch.label || courseTitle).replace(/[^a-zA-Z0-9_\u0600-\u06FF-]/g, '_');
  const filename = `batch-${batch.id}-${safeTitle}.csv`;

  return { filename, csvContent };
}

module.exports = {
  generateBatch,
  redeemCode,
  revokeCode,
  revokeBatch,
  lookupCode,
  getBatches,
  getBatchDetails,
  getBatchCsv,
  formatCode,
  normalizeCode,
};
