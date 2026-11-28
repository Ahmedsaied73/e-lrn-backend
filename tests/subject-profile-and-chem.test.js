'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { subjectProfile } = require('../src/lib/subjectProfile');

describe('Subject profile mapping across all ثانوية عامة subjects', () => {
  it('maps Math branches & Physics to RICH without chem', () => {
    for (const s of ['رياضيات', 'تفاضل وتكامل', 'استاتيكا', 'ديناميكا', 'جبر وهندسة فراغية', 'إحصاء', 'فيزياء', 'MATH', 'PHYSICS']) {
      assert.deepEqual(subjectProfile(s), { defaultFormat: 'RICH', allowChem: false }, `failed for ${s}`);
    }
  });

  it('maps Chemistry to RICH with allowChem=true', () => {
    for (const s of ['كيمياء', 'الكيمياء', 'CHEMISTRY']) {
      assert.deepEqual(subjectProfile(s), { defaultFormat: 'RICH', allowChem: true }, `failed for ${s}`);
    }
  });

  it('maps Biology, Geology, Languages, and Humanities to PLAIN without warnings', () => {
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      for (const s of ['أحياء', 'جيولوجيا', 'عربي', 'إنجليزي', 'فرنساوي', 'ألماني', 'إيطالي', 'تاريخ', 'جغرافيا', 'فلسفة ومنطق', 'علم نفس']) {
        assert.deepEqual(subjectProfile(s), { defaultFormat: 'PLAIN', allowChem: false }, `failed for ${s}`);
      }
      assert.equal(warnings.length, 0, `unexpected warnings: ${warnings.join('; ')}`);
    } finally {
      console.warn = origWarn;
    }
  });
});
