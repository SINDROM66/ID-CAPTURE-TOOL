/* ═══════════════════════════════════════════════════════════════════════
   regression.test.js — Node test harness for parser.js
   Run with: node test/regression.test.js
   No browser APIs required (parser.js is pure).
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const assert = require('assert');
const p = require('../js/parser.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
    failed++;
  }
}

console.log('\n=== Fixture: LYOMOKI old-front / old-back card (regression) ===');

// Exact MRZ lines transcribed from the physical card back (with the O/0
// OCR confusion Tesseract actually produces on this card).
const LYOMOKI_MRZ_LINES = [
  'IDUGA0193072462CM000351093UXF<',
  'OOO9139M2901215UGA190121<<<<<7',
  'LYOMOKI<<SAMUEL<JUNIOR<<<<<<<<'
];
const LYOMOKI_ADDRESS_TEXT = [
  'VILLAGE: VILLAGE 12',
  'PARISH: NTINDA',
  'S.COUNTY: NAKAWA',
  'COUNTY: NAKAWA DIVISION',
  'DISTRICT: KAMPALA'
].join('\n');

test('parseMRZ recovers dob/sex/expiry despite O-for-0 OCR confusion in line 2', () => {
  const mrz = p.parseMRZ(LYOMOKI_MRZ_LINES.join('\n'));
  assert.strictEqual(mrz.dob, '13.09.2000');
  assert.strictEqual(mrz.sex, 'M');
  assert.strictEqual(mrz.expiry, '21.01.2029');
  assert.strictEqual(mrz.nin, 'CM000351093UXF');
  assert.strictEqual(mrz.card_no, '019307246');
  assert.strictEqual(mrz.surname, 'LYOMOKI');
  assert.strictEqual(mrz.given_names, 'SAMUEL JUNIOR');
});

test('parseBack recovers full address block alongside MRZ', () => {
  const back = p.parseBack([LYOMOKI_ADDRESS_TEXT, ...LYOMOKI_MRZ_LINES].join('\n'));
  assert.strictEqual(back.village, 'VILLAGE 12');
  assert.strictEqual(back.parish, 'NTINDA');
  assert.strictEqual(back.sub_county, 'NAKAWA');
  assert.strictEqual(back.county, 'NAKAWA DIVISION');
  assert.strictEqual(back.district, 'KAMPALA');
});

test('mergeAndApplyMrzBackfill: correct back layout + weak front OCR ⇒ all fields correct', () => {
  const backData = p.parseBack([LYOMOKI_ADDRESS_TEXT, ...LYOMOKI_MRZ_LINES].join('\n'));
  const frontData = {
    surname: 'IYOMOKI',        // realistic front OCR misread (L→I)
    given_names: 'SAMUEL JUNIOR',
    nationality: 'UGA',
    sex: '', dob: '', nin: '', expiry: '', card_no: ''
  };
  const merged = p.mergeAndApplyMrzBackfill({ front: frontData, back: backData });
  assert.strictEqual(merged.surname, 'LYOMOKI', 'MRZ should correct the L/I misread');
  assert.strictEqual(merged.given_names, 'SAMUEL JUNIOR');
  assert.strictEqual(merged.sex, 'M');
  assert.strictEqual(merged.dob, '13.09.2000');
  assert.strictEqual(merged.nin, 'CM000351093UXF');
  assert.strictEqual(merged.expiry, '21.01.2029');
  assert.strictEqual(merged.village, 'VILLAGE 12');
  assert.strictEqual(merged.parish, 'NTINDA');
  assert.strictEqual(merged.sub_county, 'NAKAWA');
  assert.strictEqual(merged.county, 'NAKAWA DIVISION');
  assert.strictEqual(merged.district, 'KAMPALA');
});

test('mergeAndApplyMrzBackfill: exact reported failure ⇒ invalid junk is blanked, not leaked', () => {
  // Reproduces the actual failed run: back layout misclassified, MRZ never
  // recovered, front-only OCR produced garbage in dob/expiry/card_no.
  const frontData = {
    surname: 'IYOMOKI',
    given_names: 'SAMUEL JUNIOR',
    nationality: 'UGA',
    sex: '',
    dob: '01.93.0724',   // invalid: month 93 — must NOT reach the form
    nin: '',
    expiry: '5',         // invalid: not a date at all — must NOT reach the form
    card_no: 'CL'
  };
  const merged = p.mergeAndApplyMrzBackfill({ front: frontData, back: {} });
  assert.strictEqual(merged.dob, '', 'invalid dob must be blank, not "01.93.0724"');
  assert.strictEqual(merged.expiry, '', 'invalid expiry must be blank, not "5"');
  assert.strictEqual(merged.sex, '');
  assert.strictEqual(merged.nin, '');
  // Confidence should reflect the missing data rather than silently look fine
  assert.strictEqual(merged.confidence.dob, 'low');
});

test('scoreBackExtraction: correct old-back OCR scores far higher than misclassified new-back garbage', () => {
  const correctBack = p.parseBack([LYOMOKI_ADDRESS_TEXT, ...LYOMOKI_MRZ_LINES].join('\n'));
  const correctScore = p.scoreBackExtraction(correctBack, LYOMOKI_MRZ_LINES);

  // What actually came out when NEW_BACK_ROIS were wrongly applied to this
  // old-back card (address ROIs landing on fingerprint/barcode noise, MRZ
  // ROIs landing on the address text) — taken from the reported failure.
  const wrongLines = ['RIGHT THLIMR', 'GBILITEV VIVIVITWY', 'ER', 'IR'];
  const wrongAddrText = ['NAKAWA', 'NAKAWADIVISION', 'BISTRICT KARPR PALS CC S NX V'];
  const wrongBack = p.parseBack([...wrongLines, ...wrongAddrText].join('\n'));
  const wrongScore = p.scoreBackExtraction(wrongBack, wrongAddrText);

  assert.ok(correctScore > wrongScore + 5,
    `expected correct-layout score (${correctScore}) to clearly beat wrong-layout score (${wrongScore})`);
});

test('real-world weak-photo back extraction falls below the address trust floor', () => {
  const weakAttempt = p.parseBack([
    'DISTRICT: RIGHT THLIMR',
    'COUNTY: GBILITEV VIVIVITWY',
    'SUB COUNTY: ER',
    'VILLAGE: IR'
  ].join('\n'));
  const wrongMrzLines = [
    'NAKAWA',
    'NAKAWADIVISION',
    'BISTRICT KARPR PALS CC S NX V'
  ];
  const score = p.scoreBackExtraction(weakAttempt, wrongMrzLines);
  const MIN_TRUSTWORTHY_BACK_SCORE = 8;
  assert.ok(score < MIN_TRUSTWORTHY_BACK_SCORE,
    `expected weak-photo score ${score} below trust floor ${MIN_TRUSTWORTHY_BACK_SCORE}`);
});

console.log('\n=== Fixture: MUYUNGA new-front / new-back card ===');

const MUYUNGA_MRZ_LINES = [
  'IDUGA1321896642CM0208310AU7AE<',
  '0204174M3511048UGA<<<<<<<<<<<7',
  'MUYUNGA<<TIMOTHY<<<<<<<<<<<<<<'
];
const MUYUNGA_ADDRESS_TEXT = [
  'DISTRICT: BUYENDE',
  'COUNTY: BUDIOPE EAST',
  'SUBCOUNTY: IRUNDU',
  'PARISH: BUDIPA',
  'VILLAGE: BUDIPA II'
].join('\n');

test('parseMRZ correctly reads a clean new-back MRZ (no O/0 confusion)', () => {
  const mrz = p.parseMRZ(MUYUNGA_MRZ_LINES.join('\n'));
  assert.strictEqual(mrz.dob, '17.04.2002');
  assert.strictEqual(mrz.sex, 'M');
  assert.strictEqual(mrz.expiry, '04.11.2035');
  assert.strictEqual(mrz.surname, 'MUYUNGA');
  assert.strictEqual(mrz.given_names, 'TIMOTHY');
});

test('parseBack recovers new-layout paired address fields', () => {
  const back = p.parseBack([MUYUNGA_ADDRESS_TEXT, ...MUYUNGA_MRZ_LINES].join('\n'));
  assert.strictEqual(back.district, 'BUYENDE');
  assert.strictEqual(back.county, 'BUDIOPE EAST');
  assert.strictEqual(back.parish, 'BUDIPA');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
