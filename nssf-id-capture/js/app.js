/* ═══════════════════════════════════════════
   NSSF ID Capture Tool — App Logic
   Fully offline. No API calls. Tesseract.js OCR only.
   ═══════════════════════════════════════════ */

'use strict';

// ─── State ────────────────────────────────────
const state = {
  files: { front: null, back: null },
  records: [],
  ocr: { running: false }
};

// ─── Tab switching ────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === name)
  );
  document.querySelectorAll('.tab-content').forEach(s =>
    s.classList.toggle('active', s.id === 'tab-' + name)
  );
  if (name === 'records') renderRecordsTable();
}

// ─── File loading ─────────────────────────────
function handleFile(side, input) {
  const file = input.files[0];
  if (!file) return;
  state.files[side] = file;

  const url = URL.createObjectURL(file);
  const zone = document.getElementById('zone-' + side);
  const inner = document.getElementById('zone-' + side + '-inner');

  inner.innerHTML = `
    <img src="${url}" class="uzone-img" alt="${side} of ID">
    <div class="uzone-success-label">✓ ${side === 'front' ? 'Front' : 'Back'} loaded</div>
  `;
  zone.classList.add('loaded');

  updateUploadStatus();
}

function updateUploadStatus() {
  const hF = !!state.files.front;
  const hB = !!state.files.back;
  const btn = document.getElementById('btn-extract');
  btn.disabled = !(hF || hB);

  const el = document.getElementById('upload-status');
  if (hF && hB) {
    el.innerHTML = alert('success',
      'Both sides uploaded — ready to extract all data.');
  } else if (hF) {
    el.innerHTML = alert('warning',
      'Front loaded. Upload the <strong>back</strong> side for village &amp; district data.');
  } else if (hB) {
    el.innerHTML = alert('warning',
      'Back loaded. Upload the <strong>front</strong> side for name, NIN &amp; DOB.');
  }
}

// ─── Alert helper ─────────────────────────────
function alert(type, html) {
  const icons = {
    success: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
    warning: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
    error:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`
  };
  return `<div class="alert alert-${type}">${icons[type] || icons.error}<span>${html}</span></div>`;
}

// ─── Progress helpers ─────────────────────────
function setProgress(pct, label, sub) {
  document.getElementById('prog-fill').style.width = pct + '%';
  document.getElementById('prog-label').textContent = label;
  document.getElementById('prog-sub').textContent = sub;
}

// ─── OCR runner ───────────────────────────────
async function runOCR() {
  if (state.ocr.running) return;
  state.ocr.running = true;

  document.getElementById('btn-extract').disabled = true;
  document.getElementById('card-progress').style.display = 'block';
  document.getElementById('card-form').style.display = 'none';

  let rawFront = '', rawBack = '';
  let frontData = {}, backData = {};

  try {
    if (state.files.front) {
      setProgress(5, 'Reading front of ID…', 'Starting OCR engine');
      rawFront = await runTesseract(state.files.front, pct => {
        setProgress(5 + pct * 40, 'Reading front of ID…', Math.round(pct * 100) + '% complete');
      }, 'front');
      frontData = parseFront(rawFront);
    }

    if (state.files.back) {
      setProgress(50, 'Reading back of ID…', 'Starting OCR engine');
      rawBack = await runTesseract(state.files.back, pct => {
        setProgress(50 + pct * 40, 'Reading back of ID…', Math.round(pct * 100) + '% complete');
      }, 'back');
      backData = parseBack(rawBack);
    }

    setProgress(98, 'Finalising…', 'Building form');
    await sleep(150);

    // Merge + MRZ backfill + confidence
    const merged = { front: frontData, back: backData };
    const merged2 = mergeAndApplyMrzBackfill(merged);
    fillForm(merged2);
    applyConfidenceBorders(merged2.confidence || {});

    // Show raw OCR text for staff verification
    const rawBlock = document.getElementById('raw-block');
    rawBlock.style.display = 'block';
    if (rawFront) document.getElementById('raw-front-text').textContent = '=== FRONT ===\n' + rawFront;
    if (rawBack)  document.getElementById('raw-back-text').textContent  = '\n=== BACK ===\n' + rawBack;

    const hasAny = [
      'surname', 'given_names', 'sex', 'dob', 'nin', 'village', 'parish', 'sub_county', 'district'
    ].some(k => merged2[k] && String(merged2[k]).trim().length > 0);

    // Banner logic: require at least the identity core.
    // MRZ may be noisy/missing; strict NIN/Surname/DOB/SEX are still validated + colored.
    const identityRequired = ['nin', 'dob', 'sex', 'surname'];
    const missingIdentity = identityRequired.filter(k => !merged2[k]);

    // Decide based on strongest fields: NIN+DOB OR Surname+DOB.
    const okNinDob = !!merged2.nin && !!merged2.dob;
    const okSurnameDob = !!merged2.surname && !!merged2.dob;

    const showSuccess = hasAny && (okNinDob || okSurnameDob);
    const showError = !showSuccess;

    document.getElementById('form-alert').innerHTML =
      showSuccess
        ? alert('warning', 'Data extracted — please <strong>review every field</strong> carefully before saving. OCR may have minor errors. Use the raw text below to verify.')
        : alert('error', 'OCR could not confidently read enough identity data. Retake clear, close photos of the full card with no glare, then extract again.');


    setProgress(100, 'Done', '');
    console.log('OCR complete. merged2:', JSON.stringify(merged2));

  } catch (err) {
    document.getElementById('form-alert').innerHTML = alert('error',
      'OCR failed: ' + (err && err.message ? err.message : JSON.stringify(err)) + '. Please fill the form manually.');
    fillForm({});
  }

  document.getElementById('card-progress').style.display = 'none';
  document.getElementById('card-form').style.display = 'block';
  document.getElementById('btn-extract').disabled = false;
  state.ocr.running = false;
}

// ─── Tesseract wrapper ────────────────────────
// All paths are local — no CDN, no internet required.
// gzip:false tells Tesseract the traineddata is already uncompressed
async function runTesseract(file, onProgress, side) {
  console.log('runTesseract called, side:', side, 'file:', file && file.name);
  const images = await prepareImageForOCR(file); // returns normalized 1000px wide bitmaps
  const worker = await Tesseract.createWorker('eng', 1, {
    workerPath: 'js/worker.min.js',
    corePath:   'js/tesseract-core-simd-lstm.wasm.js',
    langPath:   'lang-data',
    cachePath:  'lang-data',
    gzip:       false,
    logger: m => {
      if (m.status === 'recognizing text' && onProgress) onProgress(m.progress);
    }
  });

  await worker.setParameters({
    preserve_interword_spaces: '1',
    user_defined_dpi: '300'
  });

  // OCR on MRZ region first (more reliable). Then OCR whole-side as fallback.
  // We approximate ROIs using normalized image dimensions.
  const mrzROI = { x: 0.02, y: 0.66, w: 0.62, h: 0.30 };
  const addressROI = { x: 0.50, y: 0.02, w: 0.45, h: 0.42 };


  function cropDataUrl(srcDataUrl, roi) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const w = img.width;
        const h = img.height;
        const cx = Math.max(0, Math.round(roi.x * w));
        const cy = Math.max(0, Math.round(roi.y * h));
        const cw = Math.max(1, Math.round(roi.w * w));
        const ch = Math.max(1, Math.round(roi.h * h));
        const canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, cx, cy, cw, ch, 0, 0, cw, ch);
        resolve({ src: canvas.toDataURL('image/png'), width: cw, height: ch });
      };
      img.src = srcDataUrl;
    });
  }

  async function recognizeVariants(textImages, pagesegModes, scoreSide) {
    let best = { text: '', score: -1 };
    const total = textImages.length * pagesegModes.length;
    let done = 0;

    for (const image of textImages) {
      for (const mode of pagesegModes) {
        await worker.setParameters({ tessedit_pageseg_mode: mode });
        const result = await worker.recognize(image.src);
        const text = result.data.text || '';
        const score = scoreOCRText(text, scoreSide);
        if (score > best.score) best = { text, score };
        done += 1;
        if (onProgress) onProgress(Math.min(0.98, done / total));
      }
    }
    return best;
  }

  // Step A: MRZ region (back side only)
  if (side === 'back') {
    const mrzImages = [];
    for (const image of images) {
      mrzImages.push(await cropDataUrl(image.src, mrzROI));
    }
    // Whitelist + psm tuned for MRZ-like text
    // (tesseract.js supports whitelist via tessedit_char_whitelist)
    await worker.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<', tessedit_pageseg_mode: '7' });
    const mrzBest = await recognizeVariants(mrzImages, ['7', '13'], 'back');

    if (mrzBest && mrzBest.score >= 30 && mrzBest.text && mrzBest.text.trim().length > 0) {
      // Fix 3: After MRZ succeeds, run a second ROI crop for address/location.
      const addrImages = [];
      for (const image of images) {
        addrImages.push(await cropDataUrl(image.src, addressROI));
      }

      // Allow full alphabet (no whitelist).
      await worker.setParameters({ tessedit_pageseg_mode: '6' });
      const addrBest = await recognizeVariants(addrImages, ['6'], 'back');

      await worker.terminate();
      const addrText = addrBest && addrBest.text ? addrBest.text : '';
      return (mrzBest.text || '') + '\n' + (addrText || '');
    }
  }

  // Step B: whole side fallback

  let best = { text: '', score: -1 };
  const modes = ['6', '11'];
  for (const image of images) {
    const rec = await recognizeVariants([image], modes, side);
    if (rec.score > best.score) best = rec;
  }

  await worker.terminate();
  return best.text;
}


// ─── Fix 1: Canvas preprocessing + normalized 1000px bitmap ─────────────
async function prepareImageForOCR(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read selected image'));
    reader.onload = () => {
      let img = new Image();
      img.onerror = () => reject(new Error('Selected file is not a readable image'));
      img.onload = async () => {
        // Auto-rotate portrait images (CCW) to landscape before preprocessing.
        if (img.naturalHeight > img.naturalWidth) {
          // Card is portrait — rotate 90° CCW to landscape
          const offscreen = document.createElement('canvas');
          offscreen.width = img.naturalHeight;
          offscreen.height = img.naturalWidth;
          const ctx = offscreen.getContext('2d');
          ctx.translate(offscreen.width / 2, offscreen.height / 2);
          ctx.rotate(-Math.PI / 2);
          ctx.drawImage(
            img,
            -img.naturalWidth / 2,
            -img.naturalHeight / 2
          );
          // Replace img source with rotated canvas before continuing
          img = await canvasToImage(offscreen);
        }

        const normalized = normalizeTo1000pxBitmap(img, {
          // Apply grayscale, contrast stretch, sharpen
          // “Increase contrast (apply a levels adjustment — darken midtones)”
          contrast: 1.35,
          midtone: 0.52,
          levelsShadow: 0.0,
          levelsHighlight: 1.0,
          sharpen: true
        });

        // Try multiple sharpen/threshold variants but always same 1000px geometry.
        resolve([
          normalized.variant(1.0, false),
          normalized.variant(1.15, true),
          normalized.variant(1.25, true)
        ]);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function canvasToImage(canvas) {
  return new Promise(resolve => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.src = canvas.toDataURL('image/jpeg', 0.95);
  });
}


function normalizeTo1000pxBitmap(img, opts) {
  const sourceMax = Math.max(img.width, img.height);
  const scale = sourceMax === 0 ? 1 : (1000 / sourceMax);
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));

  const baseCanvas = document.createElement('canvas');
  baseCanvas.width = width;
  baseCanvas.height = height;
  const baseCtx = baseCanvas.getContext('2d', { willReadFrequently: true });

  baseCtx.imageSmoothingEnabled = true;
  baseCtx.imageSmoothingQuality = 'high';
  baseCtx.drawImage(img, 0, 0, width, height);

  const baseImageData = baseCtx.getImageData(0, 0, width, height);

  function applyLevelsAndContrast(gray, contrast, midtone) {
    // darken midtones: shift around midtone.
    // simple S-curve: map [0..1] -> [0..1]
    const x = gray;
    const m = midtone;
    // shift midtones by compressing around midtone
    // k>1 increases contrast; midtone controls where darkening occurs.
    let y;
    if (x <= m) {
      // lower half: darken
      const t = m === 0 ? 0 : (x / m);
      y = m * Math.pow(t, contrast);
    } else {
      // upper half: keep relatively linear
      const t = (1 - m) === 0 ? 1 : ((x - m) / (1 - m));
      y = m + (1 - m) * Math.pow(t, 1 / Math.max(1e-6, contrast));
    }
    return Math.max(0, Math.min(1, y));
  }

  function convolveSharpen(imageData) {
    const { width: w, height: h, data } = imageData;
    const out = new Uint8ClampedArray(data.length);

    // Simple sharpening kernel
    //  0 -1  0
    // -1  5 -1
    //  0 -1  0
    const kernel = [
      0, -1, 0,
      -1, 5, -1,
      0, -1, 0
    ];

    const kSize = 3;
    const kHalf = 1;

    function idx(x, y, c) {
      return ((y * w + x) * 4) + c;
    }

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < 3; c++) {
          let acc = 0;
          for (let ky = -kHalf; ky <= kHalf; ky++) {
            for (let kx = -kHalf; kx <= kHalf; kx++) {
              const ix = Math.min(w - 1, Math.max(0, x + kx));
              const iy = Math.min(h - 1, Math.max(0, y + ky));
              const k = kernel[(ky + kHalf) * kSize + (kx + kHalf)];
              acc += data[idx(ix, iy, c)] * k;
            }
          }
          out[idx(x, y, c)] = Math.max(0, Math.min(255, acc));
        }
        // alpha
        out[idx(x, y, 3)] = 255;
      }
    }

    const outImageData = new ImageData(out, w, h);
    return outImageData;
  }

  return {
    variant(contrastScale, doSharpen) {
      const imageData = new ImageData(new Uint8ClampedArray(baseImageData.data), width, height);
      const px = imageData.data;

      // grayscale + levels adjustment + midtone contrast
      const c = (opts && typeof opts.contrast === 'number') ? opts.contrast : 1.35;
      const midtone = (opts && typeof opts.midtonr === 'number') ? opts.midtone : (opts && typeof opts.midtone === 'number' ? opts.midtone : 0.52);

      for (let i = 0; i < px.length; i += 4) {
        const r = px[i];
        const g = px[i + 1];
        const b = px[i + 2];
        let gray = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

        // Levels (shadow/highlight) not too complex; keep as described by darkening midtones.
        gray = applyLevelsAndContrast(gray, (c * contrastScale), midtone);
        const v = Math.round(gray * 255);
        px[i] = px[i + 1] = px[i + 2] = v;
      }

      // Sharpen
      let finalData = imageData;
      if (doSharpen) {
        finalData = convolveSharpen(imageData);
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.putImageData(finalData, 0, 0);
      return { src: canvas.toDataURL('image/png') };
    }
  };
}

function scoreOCRText(text, side) {
  const up = normalizeOCRText(text);
  const parsed = side === 'back' ? parseBack(up) : parseFront(up);
  let score = Object.values(parsed).filter(Boolean).length * 20;
  if (/\bSURNAME\b/.test(up)) score += 12;
  if (/\bGIVEN\s+NAME/.test(up)) score += 12;
  if (/\bDATE\s+OF\s+BIRTH\b/.test(up)) score += 10;
  if (/\bVILLAGE\b|\bPARISH\b|\bDISTRICT\b/.test(up)) score += 14;
  if (/\bIDUGA|[A-Z0-9<]{20,}$/.test(up)) score += 10;
  if (/([CA][MF](\d{8}[A-Z0-9]{4}|\d{9}[A-Z0-9]{3}))/.test(up.replace(/[^A-Z0-9]/g, ''))) score += 25;
  return score;
}

// ─── Fix 2: Strict validators + strict extraction rules ────────────────
const NIN_REGEX = /^[CA][MF](\d{8}[A-Z0-9]{4}|\d{9}[A-Z0-9]{3})$/;

function normalizeNinCandidate(candidate) {
  // Apply limited OCR confusions only within the candidate token.
  let v = (candidate || '').toUpperCase();
  // common substitutions
  v = v
    .replace(/O/g, '0')
    .replace(/I/g, '1')
    .replace(/S/g, '5')
    .replace(/B/g, '8');
  // remove non-token chars
  v = v.replace(/[^A-Z0-9]/g, '');

  // Auto-correct common OCR duplicate-zero insertion (15-character NIN starting with CM000... or CF000...)
  if (v.length === 15 && /^C[MF]0{3,}/.test(v)) {
    v = v.slice(0, 2) + v.slice(3); // remove one zero
  }
  return v;
}

function validateNin(n) {
  const v = normalizeNinCandidate(n);
  return NIN_REGEX.test(v) ? v : '';
}


function parseAndFormatDob(raw) {
  const t = (raw || '').trim();
  // DD.MM.YYYY or DD/MM/YYYY
  let m = t.match(/\b(\d{2})[.\/](\d{2})[.\/](\d{4})\b/);
  if (m) {
    return `${m[1]}.${m[2]}.${m[3]}`;
  }
  m = t.match(/\b(\d{2})[.-](\d{2})[.-](\d{4})\b/);
  if (m) {
    return `${m[1]}.${m[2]}.${m[3]}`;
  }
  return '';
}

function validateSexOrBlank(s) {
  const v = (s || '').toString().trim().toUpperCase();
  if (v === 'M' || v === 'F') return v;
  return '';
}

function stripDigits(s) {
  return (s || '').toString().replace(/\d+/g, '');
}

function stripLabelWords(s) {
  const out = (s || '').toString().toUpperCase();
  // strip label words (SURNAME, GIVEN, NAME, NATIONALITY)
  return out.replace(/\b(SURNAME|GIVEN|NAME|NATIONALITY)\b/g, ' ');
}

const NAME_STOPWORDS = new Set([
  'EID','NIN','ID','SURNAME','GIVEN','NAME','NATIONALITY','UGA','SEX',
  'SGT','CE','SHEET','CARD','DATE','BIRTH','EXPIRY','HOLDER','SIGNATURE',
  'UGANDA','REPUBLIC','THE','AND','FOR','OF'
]);

function normalizeNameStrict(raw) {
  let v = (raw || '').toString();
  v = stripDigits(v);
  v = stripLabelWords(v);
  v = v.toUpperCase().replace(/[^A-Z' -]/g, ' ');
  v = v.replace(/\s+/g, ' ').trim();

  // remove stopword tokens (prevents label fragments like “EID” becoming surname)
  const toks = v.split(/\s+/).filter(Boolean).filter(t => !NAME_STOPWORDS.has(t));
  return toks.join(' ');
}


function isPersonNameStrict(name) {
  // Uppercase only rule is applied by normalizeNameStrict.
  if (!name || name.length < 2 || name.length > 60) return false;
  if (!/^[A-Z][A-Z' -]*$/.test(name)) return false;
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;
  // ensure each part is plausible length
  return parts.every(p => p.length >= 2 && p.length <= 22);
}

function stripMrzLines(lines) {
  return (lines || []).filter(l => !l.includes('<'));
}

function normalizeLocationLines(lines) {
  // Strip MRZ lines (lines containing < characters)
  const nonMrz = stripMrzLines(lines);
  // Strip lines shorter than 3 chars
  return nonMrz.map(l => l.trim()).filter(l => l.length >= 3);
}

// ─── Front side parser (Fix 2 strict) ───────────────
function parseFront(raw) {
  const data = {};
  const up = normalizeOCRText(raw);

  const lines = up.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // NIN: strict regex matching individual words/tokens
  const words = up.split(/[\s|]+/).filter(Boolean);
  let nin = '';
  for (const w of words) {
    const candidate = validateNin(w);
    if (candidate) {
      nin = candidate;
      break;
    }
  }
  if (nin) data.nin = nin;

  // DOB strict parsing & reformat
  const dobCandidate = up.match(/\b\d{2}[.\/\-]\d{2}[.\/\-]\d{4}\b/)?.[0] || '';
  const dob = parseAndFormatDob(dobCandidate);
  if (dob) data.dob = dob;

  // Sex strict
  // Accept exact M/F only close to the SEX label
  const sexMatch = up.match(/\bSEX\s+[\s\S]{0,60}\b([MF])\b/);
  const sex = sexMatch ? validateSexOrBlank(sexMatch[1]) : validateSexOrBlank(lines.find(l => /^[MF]$/.test(l.trim().toUpperCase())));
  if (sex) data.sex = sex;

  // Names: strip digits, strip label words, uppercase only
  // Prefer labeled region extraction if present.
  const surnameMatch = up.match(/\b(SURNAME|SUENAML|SURNAM|SURNAMF)\b/);
  const surnamePos = surnameMatch ? surnameMatch.index : -1;

  const givenMatch = up.match(/\b(GIVEN|GIVER|GIVEM)\b/);
  const givenPos = givenMatch ? givenMatch.index : -1;

  if (surnamePos >= 0) {
    let slice = up.slice(surnamePos, surnamePos + 80);
    const boundaryMatch = slice.match(/\b(GIVEN|GIVER|NATIONALITY|SEX|DATE|BIRTH|NIN)\b/);
    if (boundaryMatch) {
      slice = slice.slice(0, boundaryMatch.index);
    }
    const candidate = slice.replace(/\b(SURNAME|SUENAML|SURNAM|SURNAMF)\b/, ' ');
    const nm = normalizeNameStrict(candidate);
    // Find the first token that is a valid person name (skipping single-character noise like F or I)
    const tok = nm.split(/\s+/).filter(Boolean).find(isPersonNameStrict) || '';
    if (tok) data.surname = tok;
  }
  if (givenPos >= 0) {
    let slice = up.slice(givenPos, givenPos + 100);
    const boundaryMatch = slice.match(/\b(NATIONALITY|SEX|DATE|BIRTH|NIN|BATE|GARD|CARD)\b/);
    if (boundaryMatch) {
      slice = slice.slice(0, boundaryMatch.index);
    }
    const candidate = slice.replace(/\b(GIVEN|GIVER|GIVEM)\b/, ' ');
    const nm = normalizeNameStrict(candidate);
    const toks = nm.split(/\s+/).filter(Boolean);
    const FNAME_STOP = new Set(['NATIONAL','ID','CARD','REPUBLIC','UGANDA','GIVEN','NAME','GIVER','SUENAML','SURNAME','NATIONALITY','SEX','BIRTH','EXPIRY','HOLDER','SIGNATURE','DATE','OF','LS','LA','AS','IS','TO']);
    const cleanToks = toks.filter(t => !FNAME_STOP.has(t) && t.length >= 2);
    if (cleanToks.length) data.given_names = cleanToks.slice(0, 3).join(' ');
  }

  // If above not found, fallback to scanning lines for MRZ-like exclusion
  // but keep strict name normalization.
  if (!data.surname || !data.given_names) {
    const candidates = lines
      .filter(l => !l.includes('<'))
      .map(normalizeNameStrict)
      .filter(v => v && v.length >= 2)
      .filter(v => isPersonNameStrict(v));

    if (!data.surname && candidates.length >= 1) data.surname = candidates[0].split(/\s+/)[0];
    if (!data.given_names && candidates.length >= 2) data.given_names = candidates.slice(1, 2).join(' ');
  }

  // Nationality (may be present; keep simple)
  if (up.includes('UGA')) data.nationality = 'UGA';

  return data;
}

// ─── Back side parser (Fix 3 strict MRZ + location lines rules) ─────────
function parseBack(raw) {
  const data = {};
  const up = normalizeOCRText(raw);

  // MRZ parsing
  Object.assign(data, parseMRZ(up));

  // Location extraction strictly:
  // Village/Parish/District: strip MRZ lines (contain <) and strip lines shorter than 3 chars.
  const lines = up.split('\n').map(l => l.trim()).filter(Boolean);
  const nonMrzLines = normalizeLocationLines(lines);

  // Try labeled extraction first (but still strict cleaning)
  const findAfterLabel = (label) => {
    const idx = up.indexOf(label);
    if (idx < 0) return '';
    const after = up.slice(idx + label.length).trim();
    const beforeNext = after.split(/\n/)[0] || after;
    return cleanLocationNameStrict(beforeNext);
  };

  if (!data.village) data.village = findAfterLabel('VILLAGE');
  if (!data.parish) data.parish = findAfterLabel('PARISH');
  if (!data.district) data.district = findAfterLabel('DISTRICT');

  // Fallback: Filter all non-MRZ lines using cleanLocationNameStrict and grab the first three valid ones.
  const cleanedLines = nonMrzLines
    .map(cleanLocationNameStrict)
    .filter(Boolean);

  if (!data.village && cleanedLines[0]) data.village = cleanedLines[0];
  if (!data.parish && cleanedLines[1]) data.parish = cleanedLines[1];
  if (!data.district && cleanedLines[2]) data.district = cleanedLines[2];

  return data;
}

function cleanLocationNameStrict(value) {
  // strip MRZ fragments & non-location chars; keep uppercase.
  const v = (value || '').toString();
  if (v.includes('<')) return '';
  if (v.length < 4) return '';

  const cleaned = v
    .toUpperCase()
    .replace(/[<>|()[\]{}]/g, ' ')
    .replace(/[^A-Z0-9' -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Filter out thumb fingerprint placeholders and signatures
  const blacklist = /(THUMB|FINGER|PRINTS?|SIGNATURE|HOLDER)/;
  if (blacklist.test(cleaned)) return '';

  // Require at least one vowel
  if (!/[AEIOU]/.test(cleaned)) return '';
  return cleaned;
}

function mrzYYMMDDToDisplay(yyMMdd, isExpiry) {
  if (!/^[0-9]{6}$/.test(yyMMdd)) return '';
  const yy = parseInt(yyMMdd.slice(0, 2), 10);
  const mm = yyMMdd.slice(2, 4);
  const dd = yyMMdd.slice(4, 6);
  if (isExpiry) {
    return `${dd}.${mm}.${2000 + yy}`;
  }
  const currentYY = new Date().getFullYear() % 100;
  const century = yy > currentYY ? 1900 : 2000;
  return `${dd}.${mm}.${century + yy}`;
}

// Fix 3 MRZ parsing rules
function parseMRZ(text) {
  const data = {};
  const norm = normalizeOCRText(text);
  const rawLines = norm.split('\n').map(l => l.trim()).filter(Boolean);

  const lines = rawLines
    .map(l => l.replace(/\s+/g, '').replace(/[^A-Z0-9<]/g, ''))
    .filter(l => /^[A-Z0-9<]{20,}$/.test(l));

  function fixN(str) {
    return str.replace(/O/g,'0').replace(/I/g,'1').replace(/S/g,'5').replace(/B/g,'8');
  }

  const raw1 = lines[0] || '';
  const raw2 = lines[1] || '';
  const raw3 = lines[2] || '';

  const i1 = raw1.indexOf('IDUGA');
  const line1 = i1 >= 0 ? raw1.slice(i1) : raw1;

  const r2start = raw2.search(/[0-9]/);
  const raw2trim = r2start >= 0 ? raw2.slice(r2start) : raw2;
  const line2 = fixN(raw2trim.slice(0,6)) + (raw2trim[6]||'') + (raw2trim[7]||'')
              + fixN(raw2trim.slice(8,14)) + raw2trim.slice(14);

  if (line1.startsWith('IDUGA') && line1.length >= 14) {
    const cardNo = fixN(line1.slice(5,14)).replace(/</g,'');
    if (cardNo) data.card_no = cardNo;

    // Dynamically search for NIN instead of hardcoded slice from 14 to 28
    const remaining = fixN(line1.slice(14)).replace(/</g, '');
    const ninMatch = remaining.match(/C[MF][0-9]{9}[A-Z0-9]{2,4}/);
    const nin = ninMatch ? validateNin(ninMatch[0]) : '';
    if (nin) data.nin = nin;

    const tail = line1.slice(28);
    const nameLine = (tail && tail.replace(/</g,'').trim().length > 3) ? tail : raw3;
    const parts = nameLine.split('<<');
    const sRaw = (parts[0] || '').replace(/</g,' ').trim();
    const gRaw = parts.slice(1).join(' ').replace(/</g,' ').trim();
    const sur = normalizeNameStrict(sRaw);
    const giv = normalizeNameStrict(gRaw);
    if (isPersonNameStrict(sur)) data.surname = sur;
    if (giv) data.given_names = giv;
    data.nationality = 'UGA';
  }

  if (line2.length >= 8) {
    const dob = mrzYYMMDDToDisplay(fixN(line2.slice(0,6)), false);
    if (dob) data.dob = dob;
    const sex = validateSexOrBlank(line2[7]);
    if (sex) data.sex = sex;
    const expiry = mrzYYMMDDToDisplay(fixN(line2.slice(8,14)), true);
    if (expiry) data.expiry = expiry;
  }

  return data;
}


function mergeAndApplyMrzBackfill(merged) {
  const front = merged.front || {};
  const back = merged.back || {};

  const mrz = {
    nin: back.nin || '',
    dob: back.dob || '',
    sex: back.sex || '',
    surname: back.surname || '',
    given_names: back.given_names || ''
  };

  // Validation results for confidence
  const confidence = {};

  // Determine final values:
  // - Use front values if they pass strict validation.
  // - Back MRZ fills any missing/failed validation.
  let out = {
    surname: '',
    given_names: '',
    sex: '',
    dob: '',
    expiry: '',
    nationality: front.nationality || back.nationality || 'UGA',
    nin: '',
    card_no: '',
    village: back.village || '',
    parish: back.parish || '',
    sub_county: '',
    county: '',
    district: back.district || '',
  };

  // Fill from front with validation already strict in parseFront.
  out.card_no = back.card_no || '';
  out.expiry  = back.expiry  || '';
  out.nin = front.nin || '';
  out.dob = front.dob || '';
  out.sex = front.sex || '';
  out.surname = front.surname || '';
  out.given_names = front.given_names || '';

  // Apply MRZ backfill for any front empty/failed validation
  // NIN
  if (!validateNin(out.nin) && mrz.nin) {
    out.nin = mrz.nin;
  }
  // DOB
  if (!parseAndFormatDob(out.dob) && mrz.dob) {
    out.dob = mrz.dob;
  }
  // Sex
  if (!validateSexOrBlank(out.sex) && mrz.sex) {
    out.sex = mrz.sex;
  }
  // Names
  const surnameNorm = normalizeNameStrict(out.surname);
  if (!isPersonNameStrict(surnameNorm) && mrz.surname) out.surname = mrz.surname;
  const givenNorm = normalizeNameStrict(out.given_names);
  if (!isPersonNameStrict(givenNorm) && mrz.given_names) out.given_names = mrz.given_names;

  // Confidence score per field:
  // high: value passed validation AND matched MRZ
  // medium: value passed validation but no MRZ match
  // low: value from fallback only
  const fields = [
    { key: 'nin', get: () => out.nin, valid: v => !!validateNin(v), mrz: mrz.nin },
    { key: 'dob', get: () => out.dob, valid: v => !!parseAndFormatDob(v), mrz: mrz.dob },
    { key: 'sex', get: () => out.sex, valid: v => !!validateSexOrBlank(v), mrz: mrz.sex },
    { key: 'surname', get: () => out.surname, valid: v => isPersonNameStrict(normalizeNameStrict(v)), mrz: mrz.surname },
    { key: 'given_names', get: () => out.given_names, valid: v => isPersonNameStrict(normalizeNameStrict(v)), mrz: mrz.given_names }
  ];

  for (const f of fields) {
    const val = f.get();
    const mrzVal = f.mrz;
    const passes = f.valid(val);
    const matchesMrz = passes && mrzVal && String(val).toUpperCase().trim() === String(mrzVal).toUpperCase().trim();

    let level = 'low';
    if (passes && matchesMrz) level = 'high';
    else if (passes && !matchesMrz) level = 'medium';
    else {
      // fallback: if present but didn't pass, keep low only when MRZ was used
      level = passes ? 'medium' : 'low';
    }
    confidence[f.key] = level;
  }

  out.confidence = confidence;
  return out;
}

function applyConfidenceBorders(conf) {
  // green/amber/red border
  const color = {
    high: '#1f8f3a',
    medium: '#d18b00',
    low: '#c1121f'
  };
  const borderW = '2px';

  const mapFieldToId = {
    surname: 'f-surname',
    given_names: 'f-given',
    sex: 'f-sex',
    dob: 'f-dob',
    nin: 'f-nin',
    // location not specified but we can default to low
    village: 'f-village',
    parish: 'f-parish',
    district: 'f-district'
  };

  Object.keys(mapFieldToId).forEach(k => {
    const id = mapFieldToId[k];
    const el = document.getElementById(id);
    if (!el) return;

    const level = (conf && conf[k]) ? conf[k] : null;
    if (!level) {
      el.style.border = '';
      el.style.boxShadow = '';
      return;
    }

    const c = color[level] || '#aaa';
    el.style.border = `${borderW} solid ${c}`;
    el.style.boxShadow = `0 0 0 3px ${c}33`;
  });
}

function normalizeOCRText(text) {
  return (text || '')
    .replace(/[|]/g, 'I')
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .toUpperCase();
}

// ─── Fill form ────────────────────────────────
function fillForm(d) {
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val || '';
  };

  set('f-surname', d.surname);
  set('f-given', d.given_names);
  set('f-sex', d.sex);
  set('f-nationality', d.nationality || 'UGA');
  set('f-dob', d.dob);
  set('f-expiry', d.expiry);
  set('f-nin', d.nin);
  set('f-cardno', d.card_no);
  set('f-village', d.village);
  set('f-parish', d.parish);
  set('f-subcounty', d.sub_county);
  set('f-county', d.county);
  set('f-district', d.district);

  const dateEl = document.getElementById('f-date');
  if (dateEl) dateEl.value = todayISO();
}

// ─── Save record ──────────────────────────────
function saveRecord() {
  const g = id => (document.getElementById(id)?.value || '').trim();

  const nin = g('f-nin');
  const sur = g('f-surname');

  if (!nin && !sur) {
    document.getElementById('form-alert').innerHTML = alert('error',
      'Please enter at least the <strong>NIN</strong> and <strong>Surname</strong> before saving.');
    return;
  }

  const record = {
    sn: state.records.length + 1,
    surname: g('f-surname'),
    given_names: g('f-given'),
    full_name: (g('f-surname') + ' ' + g('f-given')).trim(),
    sex: g('f-sex'),
    nationality: g('f-nationality'),
    dob: g('f-dob'),
    expiry: g('f-expiry'),
    nin: g('f-nin'),
    card_no: g('f-cardno'),
    phone: g('f-phone'),
    village: g('f-village'),
    parish: g('f-parish'),
    sub_county: g('f-subcounty'),
    county: g('f-county'),
    district: g('f-district'),
    officer: g('f-officer'),
    date_collected: g('f-date'),
    notes: g('f-notes')
  };

  state.records.push(record);
  updateTabBadge();
  resetCapture();
  switchTab('records');
}

// ─── Reset capture flow ───────────────────────
function resetCapture() {
  state.files = { front: null, back: null };

  // Reset upload zones
  ['front', 'back'].forEach(side => {
    document.getElementById('input-' + side).value = '';
    const zone = document.getElementById('zone-' + side);
    const inner = document.getElementById('zone-' + side + '-inner');
    zone.classList.remove('loaded');

    const icons = {
      front: `<svg class="uzone-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="8" cy="12" r="2"/><path d="M22 12H17l-2 4H9L7 12H2"/></svg>`,
      back:  `<svg class="uzone-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M7 15h3M7 11h5"/></svg>`
    };
    const labels = { front: 'Front of ID', back: 'Back of ID' };
    const subs = { front: 'Name · NIN · DOB · Expiry', back: 'Village · Parish · District' };

    inner.innerHTML = `
      ${icons[side]}
      <p class="uzone-label">${labels[side]}</p>
      <small>${subs[side]}</small>
    `;
  });

  document.getElementById('upload-status').innerHTML = '';
  document.getElementById('form-alert').innerHTML = '';
  document.getElementById('card-progress').style.display = 'none';
  document.getElementById('card-form').style.display = 'none';
  document.getElementById('btn-extract').disabled = true;
  document.getElementById('raw-block').style.display = 'none';
  document.getElementById('raw-front-text').textContent = '';
  document.getElementById('raw-back-text').textContent = '';

  const fields = [
    'f-surname','f-given','f-sex','f-nationality','f-dob','f-expiry',
    'f-nin','f-cardno','f-phone','f-village','f-parish',
    'f-subcounty','f-county','f-district','f-officer','f-notes'
  ];

  fields.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.value = '';
      el.style.border = '';
      el.style.boxShadow = '';
    }
  });
}

// ─── Records table ────────────────────────────
function renderRecordsTable() {
  const container = document.getElementById('records-container');
  const countEl = document.getElementById('records-count');
  const n = state.records.length;

  countEl.textContent = n + ' record' + (n !== 1 ? 's' : '');

  if (n === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M9 12h6M9 16h6M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z"/>
        </svg>
        <p>No records yet.</p>
        <small>Capture your first ID to get started.</small>
      </div>`;
    return;
  }

  let rows = state.records.map(r => `
    <tr>
      <td><span class="sn-chip">${r.sn}</span></td>
      <td class="name-cell">
        <strong>${r.surname || '—'}</strong> ${r.given_names || ''}
        <small>${r.sex || ''}${r.nationality ? ' · ' + r.nationality : ''}</small>
      </td>
      <td style="font-family:monospace;font-size:11px">${r.nin || '—'}</td>
      <td>${r.dob || '—'}</td>
      <td>${r.phone || '—'}</td>
      <td>${r.village || '—'}</td>
      <td>${r.district || '—'}</td>
    </tr>
  `).join('');

  container.innerHTML = `
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Name</th>
            <th>NIN</th>
            <th>DOB</th>
            <th>Phone</th>
            <th>Village</th>
            <th>District</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function updateTabBadge() {
  const badge = document.getElementById('tab-badge');
  const n = state.records.length;
  badge.style.display = n > 0 ? 'inline-block' : 'none';
  badge.textContent = n;
}

// ─── Excel export ─────────────────────────────
function exportExcel() {
  if (state.records.length === 0) {
    alert('No records to export.');
    return;
  }

  const rows = state.records.map(r => ({
    'S/N': r.sn,
    'SURNAME': r.surname,
    'GIVEN NAMES': r.given_names,
    'FULL NAME': r.full_name,
    'SEX': r.sex,
    'NATIONALITY': r.nationality,
    'DATE OF BIRTH': r.dob,
    'DATE OF EXPIRY': r.expiry,
    'NIN': r.nin,
    'CARD NUMBER': r.card_no,
    'PHONE NUMBER': r.phone,
    'VILLAGE': r.village,
    'PARISH': r.parish,
    'SUB COUNTY': r.sub_county,
    'COUNTY': r.county,
    'DISTRICT': r.district,
    'DATE COLLECTED': r.date_collected,
    'COLLECTED BY': r.officer,
    'NOTES / FLAGS': r.notes
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [
    {wch:5},{wch:14},{wch:18},{wch:24},{wch:5},{wch:12},
    {wch:14},{wch:14},{wch:17},{wch:13},{wch:14},
    {wch:14},{wch:14},{wch:16},{wch:14},{wch:13},
    {wch:15},{wch:16},{wch:26}
  ];

  const headerStyle = {
    font: { bold: true, color: { rgb: 'FFFFFF' } },
    fill: { fgColor: { rgb: '0D4F82' } },
    alignment: { horizontal: 'center' }
  };
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let c = range.s.c; c <= range.e.c; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r: 0, c })];
    if (cell) cell.s = headerStyle;
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'NSSF SmartLife Data');

  const summaryData = [
    ['NSSF SMARTLIFE FLEXI — ENROLMENT DATA EXPORT'],
    [],
    ['Total Records', state.records.length],
    ['Export Date', new Date().toLocaleDateString('en-UG', { dateStyle: 'long' })],
    ['Export Time', new Date().toLocaleTimeString('en-UG')],
    [],
    ['Tool', 'NSSF ID Capture Tool v1.0'],
    ['Mode', 'Offline (Tesseract.js OCR)'],
    ['Note', 'All extracted data should be verified against original ID before use.']
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(summaryData);
  ws2['!cols'] = [{ wch: 20 }, { wch: 50 }];
  XLSX.utils.book_append_sheet(wb, ws2, 'Summary');

  const filename = `NSSF_SmartLife_${todayISO()}.xlsx`;
  XLSX.writeFile(wb, filename);
}

// ─── Clear all records ────────────────────────
function clearAllRecords() {
  if (state.records.length === 0) return;
  if (confirm(`Delete all ${state.records.length} record(s)? This cannot be undone.`)) {
    state.records = [];
    updateTabBadge();
    renderRecordsTable();
  }
}

// ─── Utilities ────────────────────────────────
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Init ─────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const el = document.getElementById('f-date');
  if (el) el.value = todayISO();
});

