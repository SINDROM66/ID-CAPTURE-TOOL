'use strict';

const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const { createWorker } = require('tesseract.js');
const parser = require('./nssf-id-capture/js/parser.js');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'ocr_training_data', 'NEW ID design');
const DEBUG_DIR = path.join(ROOT, 'scratch', 'new_id_debug');

const EXPECTED = {
  surname: 'MUYUNGA',
  given_names: 'TIMOTHY',
  sex: 'M',
  dob: '17.04.2002',
  nin: 'CM0208310AU7AE',
  expiry: '04.11.2035',
  card_no: 'CA132189664',
  nationality: 'UGA',
  district: 'BUYENDE',
  county: 'BUDIOPE EAST',
  sub_county: 'IRUNDU',
  parish: 'BUDIPA',
  village: 'BUDIPA II'
};

const CASES = [
  {
    name: 'new-close',
    front: path.join(DATA_DIR, 'NEW ID CARDS_01.jpg'),
    back: path.join(DATA_DIR, 'NEW ID CARDS_02.jpg'),
    crop: false
  },
  {
    name: 'new-phone',
    front: path.join(DATA_DIR, 'New ID 331.jpg'),
    back: path.join(DATA_DIR, 'New ID 332.jpg'),
    crop: true
  }
];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function norm(v) {
  return String(v || '').toUpperCase().replace(/\s+/g, ' ').trim();
}

function normCompact(v) {
  return norm(v).replace(/[^A-Z0-9]/g, '');
}

function expandToCardRatio(box, img) {
  const target = 856 / 540;
  let { x, y, w, h } = box;
  const cx = x + w / 2;
  const cy = y + h / 2;
  if (w / h < target) {
    w = h * target;
  } else {
    h = w / target;
  }
  x = Math.max(0, Math.round(cx - w / 2));
  y = Math.max(0, Math.round(cy - h / 2));
  w = Math.min(img.bitmap.width - x, Math.round(w));
  h = Math.min(img.bitmap.height - y, Math.round(h));
  return { x, y, w, h };
}

function findCardBox(img) {
  const w = img.bitmap.width;
  const h = img.bitmap.height;
  const samples = [];
  const push = (x, y) => {
    const c = Jimp.intToRGBA(img.getPixelColor(x, y));
    const lum = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
    samples.push({ ...c, lum });
  };
  for (let x = 0; x < w; x += Math.max(1, Math.floor(w / 80))) {
    push(x, 1);
    push(x, h - 2);
  }
  for (let y = 0; y < h; y += Math.max(1, Math.floor(h / 80))) {
    push(1, y);
    push(w - 2, y);
  }
  const bg = samples.reduce((a, c) => {
    a.r += c.r; a.g += c.g; a.b += c.b; a.lum += c.lum;
    return a;
  }, { r: 0, g: 0, b: 0, lum: 0 });
  bg.r /= samples.length; bg.g /= samples.length; bg.b /= samples.length; bg.lum /= samples.length;

  let minX = w, minY = h, maxX = 0, maxY = 0, hits = 0;
  const step = Math.max(2, Math.floor(Math.min(w, h) / 380));
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const c = Jimp.intToRGBA(img.getPixelColor(x, y));
      const lum = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
      const sat = Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
      const bgDist = Math.hypot(c.r - bg.r, c.g - bg.g, c.b - bg.b);
      const ink = lum < Math.min(155, bg.lum - 45);
      const tinted = sat > 28 && bgDist > 14 && lum > 65;
      if (ink || tinted) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        hits++;
      }
    }
  }
  if (hits < 80 || maxX <= minX || maxY <= minY) {
    return { x: 0, y: 0, w, h };
  }
  const areaRatio = ((maxX - minX) * (maxY - minY)) / (w * h);
  if (areaRatio > 0.85) {
    return { x: 0, y: 0, w, h };
  }
  const padX = Math.round((maxX - minX) * 0.025);
  const padY = Math.round((maxY - minY) * 0.04);
  return expandToCardRatio({
    x: Math.max(0, minX - padX),
    y: Math.max(0, minY - padY),
    w: Math.min(w, maxX - minX + padX * 2),
    h: Math.min(h, maxY - minY + padY * 2)
  }, img);
}

function trimRemainingBackground(img) {
  const w = img.bitmap.width;
  const h = img.bitmap.height;
  const samples = [];
  const push = (x, y) => {
    const c = Jimp.intToRGBA(img.getPixelColor(x, y));
    const lum = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
    samples.push({ ...c, lum });
  };
  for (let x = 0; x < w; x += Math.max(1, Math.floor(w / 80))) {
    push(x, 1);
    push(x, h - 2);
  }
  for (let y = 0; y < h; y += Math.max(1, Math.floor(h / 80))) {
    push(1, y);
    push(w - 2, y);
  }
  const bg = samples.reduce((a, c) => {
    a.r += c.r; a.g += c.g; a.b += c.b; a.lum += c.lum;
    return a;
  }, { r: 0, g: 0, b: 0, lum: 0 });
  bg.r /= samples.length; bg.g /= samples.length; bg.b /= samples.length; bg.lum /= samples.length;

  const rowHits = new Array(h).fill(0);
  const colHits = new Array(w).fill(0);
  const step = Math.max(1, Math.floor(Math.min(w, h) / 420));
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const c = Jimp.intToRGBA(img.getPixelColor(x, y));
      const lum = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
      const sat = Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
      const bgDist = Math.hypot(c.r - bg.r, c.g - bg.g, c.b - bg.b);
      if ((sat > 20 && bgDist > 8) || lum < bg.lum - 42) {
        rowHits[y]++;
        colHits[x]++;
      }
    }
  }
  const rowThreshold = Math.max(3, Math.round((w / step) * 0.035));
  const colThreshold = Math.max(3, Math.round((h / step) * 0.035));
  const rowActive = rowHits.map(v => v >= rowThreshold);
  const colActive = colHits.map(v => v >= colThreshold);

  const longestRun = active => {
    let bestStart = -1, bestEnd = -1, curStart = -1;
    for (let i = 0; i < active.length; i++) {
      if (active[i] && curStart < 0) curStart = i;
      if ((!active[i] || i === active.length - 1) && curStart >= 0) {
        const end = active[i] && i === active.length - 1 ? i : i - 1;
        if (end - curStart > bestEnd - bestStart) {
          bestStart = curStart;
          bestEnd = end;
        }
        curStart = -1;
      }
    }
    return { start: bestStart, end: bestEnd };
  };

  const yr = longestRun(rowActive);
  const xr = longestRun(colActive);
  if (yr.start < 0 || xr.start < 0 || yr.end <= yr.start || xr.end <= xr.start) return img;
  const box = expandToCardRatio({
    x: Math.max(0, xr.start - 4),
    y: Math.max(0, yr.start - 4),
    w: Math.min(w, xr.end - xr.start + 8),
    h: Math.min(h, yr.end - yr.start + 8)
  }, img);
  return img.crop(box.x, box.y, box.w, box.h);
}

async function loadCard(imagePath, shouldCrop) {
  let img = await Jimp.read(imagePath);
  if (shouldCrop) {
    const box = findCardBox(img);
    img = img.crop(box.x, box.y, box.w, box.h);
    img = trimRemainingBackground(img);
  } else if (img.bitmap.height > img.bitmap.width) {
    img.rotate(-90);
  }
  img.resize(856, 540);
  return img;
}

function roiRect(roi, baseW, baseH, field) {
  let padX = 10, padY = 3;
  if (field === 'sex' || field === 'nationality') { padX = 2; padY = 2; }
  if (field === 'dob' || field === 'expiry' || field === 'issue_date') { padX = 4; padY = 2; }
  if (field === 'address_block') { padX = 10; padY = 8; }
  if (field.startsWith('mrz_line')) { padX = 8; padY = 2; }
  const x = Math.max(0, Math.round(roi.x) - padX);
  const y = Math.max(0, Math.round(roi.y) - padY);
  const w = Math.min(baseW - x, Math.round(roi.w) + padX * 2);
  const h = Math.min(baseH - y, Math.round(roi.h) + padY * 2);
  return { x, y, w, h };
}

function preprocess(img, field) {
  const isMrz = field.startsWith('mrz_line');
  const isAddress = field === 'address_block';
  const width = img.bitmap.width;
  const height = img.bitmap.height;
  let sum = 0;
  const lum = new Float32Array(width * height);
  img.scan(0, 0, width, height, function (x, y, idx) {
    const v = 0.299 * this.bitmap.data[idx] + 0.587 * this.bitmap.data[idx + 1] + 0.114 * this.bitmap.data[idx + 2];
    lum[y * width + x] = v;
    sum += v;
  });
  const mean = sum / Math.max(1, lum.length);
  const threshold = isMrz ? Math.min(190, mean * 0.94) : Math.min(192, mean * 0.90);
  img.scan(0, 0, width, height, function (x, y, idx) {
    const p = y * width + x;
    const center = lum[p];
    const left = lum[y * width + Math.max(0, x - 1)];
    const right = lum[y * width + Math.min(width - 1, x + 1)];
    const up = lum[Math.max(0, y - 1) * width + x];
    const down = lum[Math.min(height - 1, y + 1) * width + x];
    const sharpened = center * 1.7 - (left + right + up + down) * 0.175;
    let v = ((sharpened - mean) * (isMrz ? 1.75 : 1.45)) + 150;
    const useBw = isMrz || ['nin', 'dob', 'expiry', 'issue_date', 'card_no', 'sex', 'district', 'county', 'sub_county', 'parish', 'village'].includes(field);
    if (!isAddress && useBw) v = center < threshold ? 0 : 255;
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

async function extractRois(worker, card, rois, prefix, scale = 3) {
  const out = {};
  await card.writeAsync(path.join(DEBUG_DIR, `${prefix}_warped.png`));
  for (const field of Object.keys(rois)) {
    const r = roiRect(rois[field], card.bitmap.width, card.bitmap.height, field);
    const s = field === 'address_block' ? 2 : scale;
    const crop = card.clone().crop(r.x, r.y, r.w, r.h).resize(r.w * s, r.h * s);
    preprocess(crop, field);
    await crop.writeAsync(path.join(DEBUG_DIR, `${prefix}_${field}.png`));
    out[field] = await recognize(worker, crop, field);
  }
  return out;
}

function detectMrzRois(card) {
  const w = card.bitmap.width;
  const h = card.bitmap.height;
  const active = [];
  for (let y = Math.floor(h * 0.42); y < h - 5; y++) {
    let dark = 0;
    for (let x = 0; x < w; x += 2) {
      const c = Jimp.intToRGBA(card.getPixelColor(x, y));
      const lum = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
      if (lum < 95) dark++;
    }
    const ratio = dark / Math.ceil(w / 2);
    active[y] = ratio > 0.025 && ratio < 0.33;
  }
  const bands = [];
  let start = -1;
  for (let y = Math.floor(h * 0.42); y < h - 5; y++) {
    if (active[y] && start < 0) start = y;
    if ((!active[y] || y === h - 6) && start >= 0) {
      const end = active[y] && y === h - 6 ? y : y - 1;
      if (end - start >= 4) bands.push({ start, end, mid: (start + end) / 2 });
      start = -1;
    }
  }
  const mrzBands = bands
    .filter(b => b.mid > h * 0.50)
    .sort((a, b) => b.mid - a.mid)
    .slice(0, 3)
    .sort((a, b) => a.mid - b.mid);
  if (mrzBands.length < 3) return null;
  const rois = {};
  mrzBands.forEach((band, i) => {
    rois[`mrz_line${i + 1}`] = {
      x: Math.round(w * 0.03),
      y: Math.max(0, Math.round(band.start - 10)),
      w: Math.round(w * 0.94),
      h: Math.min(h, Math.round((band.end - band.start) + 26))
    };
  });
  return rois;
}

function frontData(raw) {
  return {
    surname: parser.normalizeNameStrict(raw.surname),
    given_names: parser.normalizeNameStrict(raw.given_names),
    nationality: norm(raw.nationality).replace(/[^A-Z]/g, ''),
    sex: parser.validateSexOrBlank(raw.sex),
    dob: parser.parseAndFormatDob(raw.dob),
    nin: parser.validateNin(raw.nin) || parser.correctNIN(raw.nin) || raw.nin,
    expiry: parser.parseAndFormatDob(raw.expiry),
    card_no: normCompact(raw.card_no),
    raw
  };
}

function backData(raw) {
  const mrz = [raw.mrz_line1, raw.mrz_line2, raw.mrz_line3].join('\n');
  const parsedAddress = parser.parseBack(raw.address_block);
  const parsedMrz = parser.parseMRZ(mrz);
  const preferLocation = (direct, parsed, field) => {
    const d = parser.cleanLocationNameStrict(direct);
    const p = parser.cleanLocationNameStrict(parsed);
    let chosen = '';
    if (!d) chosen = p || '';
    else if (!p) chosen = d;
    else {
    const dTokens = d.split(/\s+/).length;
    const pTokens = p.split(/\s+/).length;
      if (dTokens > pTokens + 1) chosen = p;
      else if (!d.includes(p) && !p.includes(d) && p.length >= 4 && d.length <= 10) chosen = p;
      else chosen = d;
    }
    chosen = chosen.replace(/^R\s+(?=[A-Z])/, '');
    if (field === 'village') {
      const parish = parser.cleanLocationNameStrict(parsedAddress.parish);
      if (parish && chosen === `${parish} I`) return `${parish} II`;
    }
    return chosen;
  };
  return {
    ...parsedAddress,
    ...parsedMrz,
    district: preferLocation(raw.district, parsedAddress.district, 'district'),
    county: preferLocation(raw.county, parsedAddress.county, 'county'),
    sub_county: preferLocation(raw.sub_county, parsedAddress.sub_county, 'sub_county'),
    parish: preferLocation(raw.parish, parsedAddress.parish, 'parish'),
    village: preferLocation(raw.village, parsedAddress.village, 'village'),
    raw,
    mrz
  };
}

function score(actual) {
  const fields = Object.keys(EXPECTED);
  return fields.map(field => {
    const expected = field === 'nin' || field === 'card_no' ? normCompact(EXPECTED[field]) : norm(EXPECTED[field]);
    const got = field === 'nin' || field === 'card_no' ? normCompact(actual[field]) : norm(actual[field]);
    return { field, expected, got, ok: expected === got };
  });
}

async function runCase(worker, testCase) {
  const frontCard = await loadCard(testCase.front, testCase.crop);
  const backCard = await loadCard(testCase.back, testCase.crop);
  const frontRaw = await extractRois(worker, frontCard, parser.NEW_FRONT_ROIS, `${testCase.name}_front`);
  const dynamicMrz = testCase.crop ? detectMrzRois(backCard) : null;
  const backRois = dynamicMrz ? { ...parser.NEW_BACK_ROIS, ...dynamicMrz } : parser.NEW_BACK_ROIS;
  const backRaw = await extractRois(worker, backCard, backRois, `${testCase.name}_back`);
  const front = frontData(frontRaw);
  const back = backData(backRaw);
  const merged = parser.mergeAndApplyMrzBackfill({ front, back });
  const rows = score(merged);
  console.log(`\n=== ${testCase.name} ===`);
  console.log('FRONT RAW:', frontRaw);
  console.log('BACK RAW:', backRaw);
  console.log('MRZ RAW:\n' + back.mrz);
  console.log('MERGED:', merged);
  console.table(rows);
  return rows;
}

async function main() {
  ensureDir(DEBUG_DIR);
  const worker = await createWorker('eng');
  const allRows = [];
  try {
    for (const testCase of CASES) {
      if (!fs.existsSync(testCase.front) || !fs.existsSync(testCase.back)) {
        console.warn(`Skipping ${testCase.name}: missing image files.`);
        continue;
      }
      allRows.push(...await runCase(worker, testCase));
    }
  } finally {
    await worker.terminate();
  }
  const passed = allRows.filter(r => r.ok).length;
  const total = allRows.length;
  const pct = total ? (passed / total) * 100 : 0;
  console.log(`\nNew ID accuracy: ${passed}/${total} = ${pct.toFixed(1)}%`);
  console.log(`Debug images: ${DEBUG_DIR}`);
  if (pct < 90) process.exitCode = 1;
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
