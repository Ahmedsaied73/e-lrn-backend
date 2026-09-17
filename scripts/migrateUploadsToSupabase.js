'use strict';

/**
 * migrateUploadsToSupabase.js
 *
 * One-shot migration: move every file under LOCAL `uploads/` into Supabase
 * Storage and rewrite DB rows whose URL fields pointed into `/uploads/`.
 *
 * TWO-RUN DESIGN (safety boundary — recorded user requirement):
 *
 *   Run 1 (MIGRATE, default):
 *     - Scan `uploads/` recursively.
 *     - Upload each file to the Supabase Storage bucket (path = relative path).
 *     - Verify EVERY uploaded object: download → sha256 + size match against the
 *       local file, then spot-check the public URL returns HTTP 200 + non-empty
 *       body. Unverified files are recorded but never deleted.
 *     - Rewrite DB rows (Submission.fileUrl, Video.url, Video.thumbnail,
 *       Course.thumbnail, BunnyVideo.thumbnailUrl) that pointed into /uploads/.
 *     - Write `uploads-migration-manifest.json` (sha256, size, object path,
 *       public URL, verification result) as the source of truth for run 2.
 *     - NEVER deletes local files.
 *
 *   Run 2 (DELETE): `node scripts/migrateUploadsToSupabase.js --delete-local`
 *     - Re-reads the manifest. For each VERIFIED entry: re-checks the object
 *       still exists in Supabase (info), the public URL still serves, and the
 *       local sha256 still matches the manifest (guards against local drift).
 *       Only then deletes the local file. Already-absent files skip (idempotent).
 *     - Afterwards prunes empty subdirectories and finally the `uploads/` dir.
 *     - Never deletes unverified entries or files whose remote copy is gone.
 *
 * Usage:
 *   node scripts/migrateUploadsToSupabase.js             # migrate (no delete)
 *   node scripts/migrateUploadsToSupabase.js --dry-run   # list only, no writes
 *   node scripts/migrateUploadsToSupabase.js --delete-local
 *
 * Env:
 *   SUPABASE_URL / SUPABASE_SERVICE_KEY   — required (enforced by env.js)
 *   SUPABASE_UPLOADS_BUCKET              — target bucket (default `uploads`)
 *   UPLOADS_DIR                          — local root (default `<project>/uploads`)
 *   MANIFEST_PATH                        — manifest file (default `<project>/uploads-migration-manifest.json`)
 *   DB_UPDATE                            — "all" (default) | "none"
 *
 * Only values whose full /uploads/ tail maps to a migrated file are rewritten.
 * Third-party origins are never touched.
 *
 * Imports config/db (Prisma) + supabaseClient — run from project root with .env.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const prisma = require('../src/config/db');
const {
  isSupabaseConfigured,
  getSupabaseAdmin,
} = require('../src/integrations/supabase/supabaseClient');

const PROJECT_ROOT = path.join(__dirname, '..');
const UPLOADS_DIR = path.resolve(
  process.env.UPLOADS_DIR || path.join(PROJECT_ROOT, 'uploads'),
);
const manifestPath = path.resolve(
  process.env.MANIFEST_PATH || path.join(PROJECT_ROOT, 'uploads-migration-manifest.json'),
);
const BUCKET = process.env.SUPABASE_UPLOADS_BUCKET || 'uploads';
const DB_UPDATE = (process.env.DB_UPDATE || 'all').toLowerCase();

const args = process.argv.slice(2);
const DELETE_LOCAL = args.includes('--delete-local');
const DRY_RUN = args.includes('--dry-run');

const log = (msg) => console.log(`[migrate-uploads] ${msg}`);

// ── Scanning ─────────────────────────────────────────────────────────────────

/** Recursively list files under `dir` relative to UPLOADS_DIR. */
async function scanFiles(dir = UPLOADS_DIR) {
  const out = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return out;
    throw err;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const ent of entries) {
    const absPath = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await scanFiles(absPath)));
    } else if (ent.isFile()) {
      out.push({
        absPath,
        relPath: path.relative(UPLOADS_DIR, absPath).split(path.sep).join('/'),
      });
    }
  }
  return out;
}

/** streamed sha256 of a file's contents */
async function sha256Of(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

// ── Supabase helpers ─────────────────────────────────────────────────────────

async function ensureBucket() {
  const sb = getSupabaseAdmin();
  const { data: buckets, error: listErr } = await sb.storage.listBuckets();
  if (listErr) throw new Error(`listBuckets failed: ${listErr.message}`);
  if (buckets.some((b) => b.name === BUCKET)) {
    log(`bucket "${BUCKET}" already exists`);
    return;
  }
  const { error: createErr } = await sb.storage.createBucket(BUCKET, { public: true });
  if (createErr) throw new Error(`createBucket "${BUCKET}" failed: ${createErr.message}`);
  log(`created public bucket "${BUCKET}"`);
}

async function uploadFile(sb, relPath, absPath, contentType) {
  const body = await fsp.readFile(absPath);
  const { error } = await sb.storage.from(BUCKET).upload(relPath, body, {
    contentType,
    upsert: false,
    cacheControl: '3600',
  });
  if (error) throw new Error(`upload "${relPath}" failed: ${error.message}`);
}

/** Download the object back and compare sha256 + size with the local file. */
async function verifyObject(sb, relPath, expectedSha256, expectedSize) {
  const { data, error } = await sb.storage.from(BUCKET).download(relPath);
  if (error) return { ok: false, reason: `download failed: ${error.message}` };
  const buf = Buffer.from(await data.arrayBuffer());
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (sha !== expectedSha256) return { ok: false, reason: 'sha256 mismatch' };
  if (buf.length !== expectedSize) return { ok: false, reason: 'size mismatch' };
  return { ok: true };
}

/** Promptly confirm the public URL serves (HTTP 200, non-empty body). */
async function verifyPublicUrl(publicUrl) {
  try {
    const res = await fetch(publicUrl, { method: 'GET' });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const buf = await res.arrayBuffer();
    return { ok: buf.byteLength > 0, reason: buf.byteLength > 0 ? undefined : 'empty body' };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

function contentTypeFor(relPath) {
  const map = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  return map[path.extname(relPath).toLowerCase()] || 'application/octet-stream';
}

function publicUrlFor(relPath) {
  const sb = getSupabaseAdmin();
  return sb.storage.from(BUCKET).getPublicUrl(relPath).data.publicUrl;
}

// ── DB rewrite ───────────────────────────────────────────────────────────────

// Prisma model/field pairs whose values may have pointed into /uploads/.
const DB_TARGETS = [
  { model: 'submission', field: 'fileUrl' },
  { model: 'video', field: 'url' },
  { model: 'video', field: 'thumbnail' },
  { model: 'course', field: 'thumbnail' },
  { model: 'bunnyVideo', field: 'thumbnailUrl' },
];

/** Own origins the app could have served /uploads/ URLs from. */
function ownHosts() {
  const raw = [process.env.APP_URL, process.env.FRONTEND_URL, process.env.BACKEND_URL]
    .filter(Boolean)
    .map((h) => h.replace(/^https?:\/\//, '').replace(/\/$/, ''));
  return new Set([...raw, 'localhost', '127.0.0.1', `localhost:${process.env.PORT || 3005}`]);
}

function isLocalUploadsValue(value) {
  if (typeof value !== 'string' || !value) return false;
  if (value.startsWith('/uploads/')) return true;
  const m = value.match(/^https?:\/\/([^/]+)\//);
  if (m) return ownHosts().has(m[1]);
  return value.includes('/uploads/');
}

/** `/uploads/a/b.mp4` → `a/b.mp4` (relative path in the store). */
function uploadsRelPathFromValue(value) {
  const idx = value.indexOf('/uploads/');
  return idx === -1 ? null : value.slice(idx + '/uploads/'.length) || null;
}

/**
 * Scan all DB targets; for rows whose value maps to a verified migrated file,
 * plan a rewrite to the object's public URL. Also records rows whose value
 * points into /uploads/ but cannot be rewritten (for the manifest).
 */
async function planDbRewrites(verifiedRelPaths) {
  const changes = [];
  const skipped = [];

  for (const target of DB_TARGETS) {
    const model = prisma[target.model];
    if (!model) continue;
    let rows;
    try {
      rows = await model.findMany({ select: { id: true, [target.field]: true } });
    } catch (err) {
      log(`WARN: could not read ${target.model}.${target.field}: ${err.message}`);
      continue;
    }
    for (const row of rows) {
      const value = row[target.field];
      if (!value) continue;
      const rel = uploadsRelPathFromValue(value);
      if (rel === null) continue; // not an uploads reference
      if (!verifiedRelPaths.has(rel)) {
        skipped.push({
          model: target.model,
          field: target.field,
          id: row.id,
          reason: `no verified migration for "${rel}"`,
        });
        continue;
      }
      changes.push({
        model: target.model,
        field: target.field,
        id: row.id,
        to: publicUrlFor(rel),
      });
    }
  }
  return { changes, skipped };
}

async function applyDbChanges(changes) {
  let ok = 0;
  for (const c of changes) {
    try {
      await prisma[c.model].update({ where: { id: c.id }, data: { [c.field]: c.to } });
      ok++;
      log(`DB: updated ${c.model}.${c.field}#${c.id}`);
    } catch (err) {
      log(`WARN: failed updating ${c.model}.${c.field}#${c.id}: ${err.message}`);
      c.failed = err.message;
    }
  }
  return ok;
}

// ── Manifest ─────────────────────────────────────────────────────────────────

async function readManifest() {
  try {
    return JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

// ── Delete-local pass (run 2, strictly separate) ─────────────────────────────

async function verifyObjectExists(sb, objectPath) {
  const { data, error } = await sb.storage.from(BUCKET).info(objectPath);
  return error ? null : data;
}

async function pruneEmptyDirs() {
  if (!fs.existsSync(UPLOADS_DIR)) return;
  const walk = async (dir) => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.isDirectory()) await walk(path.join(dir, ent.name));
    }
    try {
      const remaining = await fsp.readdir(dir);
      if (remaining.length === 0) await fsp.rmdir(dir);
    } catch {
      /* non-empty or gone — leave it */
    }
  };
  await walk(UPLOADS_DIR);
}

async function deleteLocalPass() {
  const manifest = await readManifest();
  if (!manifest || !Array.isArray(manifest.files)) {
    log('ERROR: no manifest found — run the migrate pass first.');
    process.exit(1);
  }

  const sb = getSupabaseAdmin();
  const entries = manifest.files.filter((f) => f.verified === true);
  log(`delete pass: ${entries.length}/${manifest.files.length} verified file(s)`);

  let deleted = 0;
  let skipped = 0;
  const kept = [];

  for (const entry of entries) {
    const relPath = entry.relPath || '';
    const absPath = path.join(UPLOADS_DIR, ...relPath.split('/'));
    if (!fs.existsSync(absPath)) {
      skipped++; // already gone — idempotent
      entry.deleteState = 'already-missing';
      continue;
    }

    // Safety re-checks immediately before deleting the only local copy.
    const remote = await verifyObjectExists(sb, entry.objectPath);
    if (!remote) {
      skipped++;
      entry.deleteState = 'skipped: remote object missing';
      continue;
    }
    const serve = await verifyPublicUrl(entry.publicUrl || '');
    if (!serve.ok) {
      skipped++;
      entry.deleteState = `skipped: public URL not serving (${serve.reason})`;
      continue;
    }
    const sha = await sha256Of(absPath);
    if (sha !== entry.sha256) {
      skipped++;
      entry.deleteState = 'skipped: local sha256 drifted from manifest';
      continue;
    }

    await fsp.rm(absPath);
    deleted++;
    entry.deleteState = 'deleted';
    log(`deleted local: ${relPath}`);
  }

  // Prune empty subdirs, then the uploads dir itself if fully empty.
  await pruneEmptyDirs();
  try {
    const remaining = fs.existsSync(UPLOADS_DIR) ? await fsp.readdir(UPLOADS_DIR) : [];
    if (remaining.length === 0) {
      await fsp.rmdir(UPLOADS_DIR);
      log(`removed empty uploads dir: ${UPLOADS_DIR}`);
    }
  } catch {
    /* ignore */
  }

  manifest.deletes = { deleted, skipped, prunedAt: new Date().toISOString() };
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  log(`delete pass done: ${deleted} deleted, ${skipped} skipped. Manifest updated at ${manifestPath}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!isSupabaseConfigured()) {
    log('ERROR: Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_KEY).');
    process.exit(1);
  }

  if (DELETE_LOCAL) {
    await deleteLocalPass();
    await prisma.$disconnect();
    return;
  }

  const files = await scanFiles(UPLOADS_DIR);
  if (files.length === 0) {
    log(`no files under ${UPLOADS_DIR} — nothing to migrate.`);
    await prisma.$disconnect();
    return;
  }

  log(`found ${files.length} file(s) under ${UPLOADS_DIR}`);

  if (DRY_RUN) {
    log('DRY RUN — no writes. Would migrate:');
    for (const f of files) log(`  ${f.relPath}`);
    await prisma.$disconnect();
    return;
  }

  const sb = getSupabaseAdmin();
  await ensureBucket();

  const migrated = [];
  for (const f of files) {
    const { relPath, absPath } = f;
    const entry = {
      relPath,
      objectPath: relPath,
      contentType: contentTypeFor(relPath),
      publicUrl: publicUrlFor(relPath),
      migratedAt: new Date().toISOString(),
    };
    try {
      const stat = await fsp.stat(absPath);
      entry.size = stat.size;
      const sha = await sha256Of(absPath);
      entry.sha256 = sha;
      await uploadFile(sb, relPath, absPath, entry.contentType);
      const ver = await verifyObject(sb, relPath, sha, stat.size);
      if (!ver.ok) {
        entry.verified = false;
        entry.verifyReason = ver.reason;
        log(`WARN: upload verify failed for ${relPath}: ${ver.reason}`);
      } else {
        const serve = await verifyPublicUrl(entry.publicUrl);
        entry.verified = serve.ok;
        entry.serveReason = serve.ok ? undefined : serve.reason;
        entry.verifyReason = serve.ok ? undefined : serve.reason;
        log(`${serve.ok ? 'migrated + verified' : 'WARN not serving'}: ${relPath}`);
      }
    } catch (err) {
      entry.verified = false;
      entry.verifyReason = err.message;
      log(`FAIL: ${relPath}: ${err.message}`);
    }
    migrated.push(entry);
  }

  // ── DB rewrite (only rows whose value maps to a VERIFIED object) ──────────
  const verifiedRelPaths = new Set(migrated.filter((m) => m.verified).map((m) => m.relPath));
  let dbChanges = [];
  let dbSkipped = [];
  if (DB_UPDATE !== 'none') {
    ({ changes: dbChanges, skipped: dbSkipped } = await planDbRewrites(verifiedRelPaths));
  }
  const dbUpdated = await applyDbChanges(dbChanges);

  const verifiedCount = migrated.filter((m) => m.verified).length;
  if (dbUpdated > 0 || dbSkipped.length > 0) {
    log(`DB: ${dbUpdated} row(s) updated, ${dbSkipped.length} skipped (see manifest).`);
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    bucket: BUCKET,
    uploadsDir: UPLOADS_DIR,
    files: migrated,
    dbChanges,
    dbSkipped,
    summary: {
      total: files.length,
      migratedVerified: verifiedCount,
      migratedFailed: migrated.filter((m) => !m.verified).length,
      dbUpdated,
      dbSkipped: dbSkipped.length,
    },
  };
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  log(`manifest written to ${manifestPath}`);

  log(`done: ${verifiedCount}/${files.length} migrated & verified, ${dbUpdated} DB rows updated.`);
  log('NOTE: local files were NOT deleted. After you are satisfied, run:');
  log('  node scripts/migrateUploadsToSupabase.js --delete-local');

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('[migrate-uploads] FATAL:', err.message);
  process.exit(2);
});