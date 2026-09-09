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

module.exports = {
  isSupabaseConfigured,
  getSupabaseAdmin,
  getSupabaseBucket,
};
