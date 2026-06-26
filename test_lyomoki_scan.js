'use strict';

const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const { createWorker } = require('tesseract.js');
const parser = require('./nssf-id-capture/js/parser.js');

const ROOT = __dirname;
const FRONT_IMAGE = path.join(ROOT, 'ocr_training_data', 'augmented_ids', 'back_000.jpg');
const BACK_IMAGE = path.join(ROOT, 'ocr_training_data', 'augmented_ids', 'front_000.jpg');
const DEBUG_DIR = path.join(ROOT, 'scratch', 'lyomoki_debug');

const EXPECTED = {
  surname: 'LYOMOKI',
  given_names: 'SAMUEL JUNIOR',
  sex: 'M',
  dob: '13.09.2000',
  nin: 'CM000351093UXF',
  expiry: '21.01.2029',
  card_no: '019307246',
  nationality: 'UGA',
  village: 'VILLAGE 12',
  parish: 'NTINDA',
  sub_county: 'NAKAWA',
  county: 'NAKAWA DIVISION',
  district: 'KAMPALA'
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function normalize(v) {
  return (v || '').toString().toUpperCase().replace(/\s+/g, ' ').trim();
}

function normalizeNin(v) {
  return normalize(v).replace(/[^A-Z0-9]/g, '');
}

async function alignToCard(imagePath) {
  const img = await Jimp.read(imagePath);
  if (img.bitmap.height > img.bitmap.width) img.rotate(-90);
  img.resize(856, 540);
  return img;
}

function roiRect(roi, baseW, baseH, field) {
  let padX = 15;
  let padY = 3;
  if (field === 'sex' || field === 'nationality') {
    padX = 2;
    padY = 2;
  } else if (field === 'dob' || field === 'expiry') {
    padX = 4;
    padY = 2;
  } else if (field === 'address_block') {
    padX = 15;
    padY = 10;
  } else if (field && field.startsWith('mrz_line')) {
    padX = 10;
    padY = 3;
  }

  const isAbsolute = roi.x > 1.0;
  const rx = isAbsolute ? roi.x : roi.x * baseW;
  const ry = isAbsolute ? roi.y : roi.y * baseH;
  const rw = isAbsolute ? roi.w : roi.w * baseW;
  const rh = isAbsolute ? roi.h : roi.h * baseH;

  const x = Math.max(0, Math.round(rx) - padX);
  const y = Math.max(0, Math.round(ry) - padY);
  const w = Math.min(baseW - x, Math.round(rw) + 2 * padX);
  const h = Math.min(baseH - y, Math.round(rh) + 2 * padY);
  return { x, y, w, h };
}

function preprocess(img, field) {
  const isMrz = field && field.startsWith('mrz');
  let sum = 0;
  const lum = new Float32Array(img.bitmap.width * img.bitmap.height);

  img.scan(0, 0, img.bitmap.width, img.bitmap.height, function (x, y, idx) {
    const v = 0.299 * this.bitmap.data[idx] + 0.587 * this.bitmap.data[idx + 1] + 0.114 * this.bitmap.data[idx + 2];
    lum[y * this.bitmap.width + x] = v;
    sum += v;
  });

  const mean = sum / lum.length;
  const threshold = isMrz ? Math.min(188, mean * 0.92) : Math.min(178, mean * 0.86);

  img.scan(0, 0, img.bitmap.width, img.bitmap.height, function (x, y, idx) {
    const p = y * this.bitmap.width + x;
    const center = lum[p];
    const left = lum[y * this.bitmap.width + Math.max(0, x - 1)];
    const right = lum[y * this.bitmap.width + Math.min(this.bitmap.width - 1, x + 1)];
    const up = lum[Math.max(0, y - 1) * this.bitmap.width + x];
    const down = lum[Math.min(this.bitmap.height - 1, y + 1) * this.bitmap.width + x];
    const sharpened = center * 1.65 - (left + right + up + down) * 0.1625;
    let v = ((sharpened - mean) * (isMrz ? 1.75 : 1.45)) + 150;
    if (isMrz) v = center < threshold ? 0 : 255;
    v = Math.max(0, Math.min(255, v));
    this.bitmap.data[idx] = v;
    this.bitmap.data[idx + 1] = v;
    this.bitmap.data[idx + 2] = v;
    this.bitmap.data[idx + 3] = 255;
  });
  return img;
}

async function recognize(worker, img, field) {
  const settings = parser.FIELD_OCR_SETTINGS[field] || { psm: '6', whitelist: '' };
  await worker.setParameters({
    preserve_interword_spaces: '1',
    user_defined_dpi: '300',
    tessedit_char_whitelist: settings.whitelist || '',
    tessedit_pageseg_mode: settings.psm
  });
  const buffer = await img.getBufferAsync('image/png');
  const result = await worker.recognize(buffer);
  return (result.data.text || '').trim();
}

async function extractFront(worker) {
  const card = await alignToCard(FRONT_IMAGE);
  await card.writeAsync(path.join(DEBUG_DIR, 'front_warped.png'));
  const out = {};
  for (const field of Object.keys(parser.FRONT_ROIS)) {
    const r = roiRect(parser.FRONT_ROIS[field], card.bitmap.width, card.bitmap.height, field);
    const crop = card.clone().crop(r.x, r.y, r.w, r.h).resize(r.w * 3, r.h * 3);
    preprocess(crop, field);
    await crop.writeAsync(path.join(DEBUG_DIR, `front_${field}.png`));
    out[field] = await recognize(worker, crop, field);
  }
  return {
    surname: parser.normalizeNameStrict(out.surname),
    given_names: parser.normalizeNameStrict(out.given_names),
    nationality: normalize(out.nationality).replace(/[^A-Z]/g, ''),
    sex: parser.validateSexOrBlank(out.sex),
    dob: parser.parseAndFormatDob(out.dob),
    nin: parser.validateNin(out.nin) || parser.correctNIN?.(out.nin) || out.nin,
    expiry: parser.parseAndFormatDob(out.expiry),
    card_no: normalize(out.card_no).replace(/[^0-9]/g, ''),
    raw: out
  };
}

async function extractBack(worker) {
  const card = await alignToCard(BACK_IMAGE);
  await card.writeAsync(path.join(DEBUG_DIR, 'back_warped.png'));
  const texts = {};
  for (const field of Object.keys(parser.BACK_ROIS)) {
    const r = roiRect(parser.BACK_ROIS[field], card.bitmap.width, card.bitmap.height, field);
    const scale = field === 'address_block' ? 2 : 3;
    const crop = card.clone().crop(r.x, r.y, r.w, r.h).resize(r.w * scale, r.h * scale);
    preprocess(crop, field);
    await crop.writeAsync(path.join(DEBUG_DIR, `back_${field}.png`));
    texts[field] = await recognize(worker, crop, field);
  }
  const mrzText = [texts.mrz_line1, texts.mrz_line2, texts.mrz_line3].join('\n');
  return {
    ...parser.parseBack(texts.address_block),
    ...parser.parseMRZ(mrzText),
    raw: texts,
    mrzText
  };
}

function score(actual) {
  const fields = ['surname', 'given_names', 'sex', 'dob', 'nin', 'expiry', 'card_no', 'nationality'];
  const rows = fields.map(field => {
    const expected = field === 'nin' ? normalizeNin(EXPECTED[field]) : normalize(EXPECTED[field]);
    const got = field === 'nin' ? normalizeNin(actual[field]) : normalize(actual[field]);
    return { field, expected, got, ok: expected === got };
  });
  return { rows, passed: rows.filter(r => r.ok).length, total: rows.length };
}

async function main() {
  ensureDir(DEBUG_DIR);
  const worker = await createWorker('eng');
  try {
    const front = await extractFront(worker);
    const back = await extractBack(worker);
    const merged = parser.mergeAndApplyMrzBackfill({ front, back });
    const result = score(merged);

    console.log('FRONT RAW:', front.raw);
    console.log('BACK RAW:', back.raw);
    console.log('MRZ RAW:\n' + back.mrzText);
    console.log('MERGED:', merged);
    console.table(result.rows);
    console.log(`Accuracy: ${result.passed}/${result.total} = ${Math.round(result.passed / result.total * 100)}%`);
    console.log(`Debug images: ${DEBUG_DIR}`);

    if (result.passed !== result.total) process.exitCode = 1;
  } finally {
    await worker.terminate();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
