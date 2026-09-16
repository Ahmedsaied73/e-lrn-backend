'use strict';

/**
 * supabaseClient.js
 * Single module for ALL Supabase calls — no other file imports
 * @supabase/supabase-js directly (mirrors the bunnyStreamClient isolation rule).
 *
 * Auth model: server-side service key only (ADMIN-proxied uploads).
 * The key never leaves the server — the frontend has no Supabase credentials.
 */

const config = require('../../config/env');

let cached = null;

function isSupabaseConfigured() {
  return Boolean(config.supabase && config.supabase.configured);
}

function getSupabaseAdmin() {
  if (!isSupabaseConfigured()) return null;
  if (!cached) {
    // Lazy require: importing is harmless, but client construction throws
    // on empty credentials — only build it when configured.
    const { createClient } = require('@supabase/supabase-js');
    cached = createClient(config.supabase.url, config.supabase.serviceKey, {
      auth: { persistSession: false },
    });
  }
  return cached;
}

function getSupabaseBucket() {
  return (config.supabase && config.supabase.bucket) || 'quiz-images';
}

/**
 * Extract object names in OUR bucket referenced by a SurveyJS definition.
 * Pure function — used by removeQuizImagesBestEffort and by upsert diff cleanup.
 * Only URLs whose path begins with `/storage/v1/object/public/<bucket>/` count;
 * third-party/pasted URLs are never returned.
 */
function extractBucketObjectNames(surveyJson) {
  if (!surveyJson || typeof surveyJson !== 'string') return [];
  const bucket = getSupabaseBucket();
  const marker = `/storage/v1/object/public/${bucket}/`;

  const imageLinks = [];
  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'imageLink' && typeof value === 'string') imageLinks.push(value);
        else walk(value);
      }
    }
  };
  walk(JSON.parse(surveyJson));

  return [...new Set(
    imageLinks
      .filter((url) => url.includes(marker))
      .map((url) => {
        const idx = url.indexOf(marker);
        return url.slice(idx + marker.length);
      })
      .filter(Boolean)
  )];
}

/**
 * Best-effort removal of a quiz's referenced images from Supabase Storage.
 *
 * SurveyJS questions reference images via an `imageLink` field. Quiz rows are
 * cascade-deleted (deleteQuiz, and deleteCourse → BunnyVideo → Quiz), so without
 * this the objects in the bucket would be orphaned forever. There is no tracking
 * table — the surveyJson IS the source of truth for what an admin uploaded.
 *
 * Safety: only objects whose URL points into OUR configured bucket are removed
 * (third-party/pasted URLs are never touched). Never throws; bucket failures are
 * logged and swallowed so a storage wobble can't fail a DB delete.
 */
async function removeQuizImagesBestEffort(surveyJson) {
  try {
    if (!isSupabaseConfigured()) return;
    const objects = extractBucketObjectNames(surveyJson);
    if (objects.length === 0) return;
    const { error } = await getSupabaseAdmin().storage.from(getSupabaseBucket()).remove(objects);
    if (error) {
      console.error(`[Supabase] removeQuizImagesBestEffort failed (${objects.length} object(s)):`, error.message);
    }
  } catch (error) {
    // Cleanup is best-effort by contract — never propagate storage/parse errors.
    console.error('[Supabase] removeQuizImagesBestEffort error:', error.message);
  }
}

module.exports = {
  isSupabaseConfigured,
  getSupabaseAdmin,
  getSupabaseBucket,
  extractBucketObjectNames,
  removeQuizImagesBestEffort,
};
