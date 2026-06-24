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

// constants FRONT_ROIS, BACK_ROIS, and FIELD_OCR_SETTINGS are accessed as globals from parser.js

// ─── Image alignment & ROI extraction helpers ───
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read selected image'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Selected file is not a readable image'));
      img.onload = () => resolve(img);
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function alignCardToStandard(img) {
  // Standard canvas: 1000×1000 virtual units (ROI coords are already normalized 0–1)
  // Physical Uganda NID ratio: 85.6mm × 53.98mm = 1.586:1
  // We use 1000×630 to preserve aspect ratio at a round scale
  const TARGET_W = 1000;
  const TARGET_H = 630;
  const canvas = document.createElement('canvas');
  canvas.width = TARGET_W;
  canvas.height = TARGET_H;
  const ctx = canvas.getContext('2d');
  if (img.naturalHeight > img.naturalWidth) {
    // Portrait — rotate 90° CCW before stretching
    ctx.translate(TARGET_W / 2, TARGET_H / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.drawImage(img, -TARGET_H / 2, -TARGET_W / 2, TARGET_H, TARGET_W);
  } else {
    ctx.drawImage(img, 0, 0, TARGET_W, TARGET_H);
  }
  return canvas;
}

function cropROI(canvas, roi, fieldName) {
  // Field-specific padding to prevent bleed-in from adjacent fields
  let padX = 15;
  let padY = 3;
  if (fieldName === 'sex' || fieldName === 'nationality') {
    padX = 2;
    padY = 2;
  } else if (fieldName === 'dob' || fieldName === 'expiry') {
    padX = 4;
    padY = 2;
  } else if (fieldName === 'address_block') {
    padX = 15;
    padY = 10;
  } else if (fieldName && fieldName.startsWith('mrz_line')) {
    padX = 10;
    padY = 3;
  }

  const x = Math.max(0, Math.round(roi.x * canvas.width) - padX);
  const y = Math.max(0, Math.round(roi.y * canvas.height) - padY);
  const w = Math.min(canvas.width - x, Math.round(roi.w * canvas.width) + 2 * padX);
  const h = Math.min(canvas.height - y, Math.round(roi.h * canvas.height) + 2 * padY);

  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  out.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, w, h);
  return out;
}

function preprocessROI(croppedCanvas, scaleFactor = 2.5) {
  const srcW = croppedCanvas.width;
  const srcH = croppedCanvas.height;
  const dstW = Math.round(srcW * scaleFactor);
  const dstH = Math.round(srcH * scaleFactor);

  const canvas = document.createElement('canvas');
  canvas.width = dstW;
  canvas.height = dstH;
  const ctx = canvas.getContext('2d');

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(croppedCanvas, 0, 0, srcW, srcH, 0, 0, dstW, dstH);

  const imgData = ctx.getImageData(0, 0, dstW, dstH);
  const px = imgData.data;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i];
    const g = px[i + 1];
    const b = px[i + 2];
    let v = 0.299 * r + 0.587 * g + 0.114 * b;
    if (v < 130) {
      v = Math.max(0, v - (130 - v) * 0.5);
    } else {
      v = Math.min(255, v + (v - 130) * 0.5);
    }
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

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
function isNavyColor(r, g, b) {
  return r < 80 && g < 110 && b > 80;
}

function detectIsSynthetic(canvas) {
  const ctx = canvas.getContext('2d');
  const pixel = ctx.getImageData(500, 30, 1, 1).data;
  return isNavyColor(pixel[0], pixel[1], pixel[2]);
}

function getTesseractOptions() {
  const isLocal = window.location.hostname === 'localhost' || 
                  window.location.hostname === '127.0.0.1' || 
                  window.location.hostname.startsWith('192.168.');
  if (isLocal) {
    return {
      workerPath: 'js/worker.min.js',
      corePath:   'js/tesseract-core-simd-lstm.wasm.js',
      langPath:   'lang-data',
      cachePath:  'lang-data',
      gzip:       true
    };
  } else {
    // Let Tesseract.js load from CDN on public domains
    return {};
  }
}

async function runOCR() {
  if (state.ocr.running) return;
  state.ocr.running = true;

  document.getElementById('btn-extract').disabled = true;
  document.getElementById('card-progress').style.display = 'block';
  document.getElementById('card-form').style.display = 'none';

  let rawFront = '', rawBack = '';
  let frontData = {}, backData = {};
  let roiFront = {};

  try {
    if (state.files.front) {
      setProgress(5, 'Loading front of ID…', 'Preparing image');
      const img = await loadImage(state.files.front);
      const frontCanvas = alignCardToStandard(img);

      // Detect layout (synthetic vs real card)
      const isSyn = detectIsSynthetic(frontCanvas);
      state.isSynthetic = isSyn;
      const frontRois = isSyn ? SYNTHETIC_FRONT_ROIS : FRONT_ROIS;

      setProgress(15, 'Reading front ROIs in parallel…', 'Running Tesseract workers');

      // Parallel extraction for front
      const fields = Object.keys(frontRois);
      const frontPromises = fields.map(async (field) => {
        const settings = FIELD_OCR_SETTINGS[field];
        const worker = await Tesseract.createWorker('eng', 1, getTesseractOptions());
        await worker.setParameters({
          preserve_interword_spaces: '1',
          user_defined_dpi: '300',
          tessedit_char_whitelist: settings.whitelist || '',
          tessedit_pageseg_mode: settings.psm
        });

        const cropped = cropROI(frontCanvas, frontRois[field], field);
        const preprocessed = preprocessROI(cropped, 3.0);
        const dataUrl = preprocessed.toDataURL('image/png');

        const result = await worker.recognize(dataUrl);
        await worker.terminate();
        return { field, text: (result.data.text || '').trim() };
      });

      const frontResults = await Promise.all(frontPromises);
      frontResults.forEach(r => {
        roiFront[r.field] = r.text;
      });

      frontData = {
        surname:     normalizeNameStrict(roiFront.surname),
        given_names: normalizeNameStrict(roiFront.given_names),
        nationality: roiFront.nationality ? roiFront.nationality.toUpperCase().replace(/[^A-Z]/g, '') : '',
        sex:         validateSexOrBlank(roiFront.sex),
        dob:         parseAndFormatDob(roiFront.dob),
        nin:         validateNin(roiFront.nin) || roiFront.nin,
        expiry:      parseAndFormatDob(roiFront.expiry) || roiFront.expiry,
        card_no:     roiFront.card_no.replace(/[^0-9]/g, '')
      };

      rawFront = `SURNAME: ${roiFront.surname}\nGIVEN NAMES: ${roiFront.given_names}\nNATIONALITY: ${roiFront.nationality}\nSEX: ${roiFront.sex}\nDOB: ${roiFront.dob}\nNIN: ${roiFront.nin}\nEXPIRY: ${roiFront.expiry}\nCARD NO: ${roiFront.card_no}`;
    }

    if (state.files.back) {
      setProgress(50, 'Loading back of ID…', 'Preparing image');
      const img = await loadImage(state.files.back);
      const backCanvas = alignCardToStandard(img);

      const isSyn = state.isSynthetic;
      const backRois = isSyn ? SYNTHETIC_BACK_ROIS : BACK_ROIS;

      setProgress(60, 'Reading back block and MRZ…', 'Running Tesseract workers');

      const roiAddr = backRois.address_block;
      const padX = 15;
      const padY = 10;
      const ax = Math.max(0, Math.round(roiAddr.x * backCanvas.width) - padX);
      const ay = Math.max(0, Math.round(roiAddr.y * backCanvas.height) - padY);
      const aw = Math.min(backCanvas.width - ax, Math.round(roiAddr.w * backCanvas.width) + 2 * padX);
      const ah = Math.min(backCanvas.height - ay, Math.round(roiAddr.h * backCanvas.height) + 2 * padY);
      const croppedAddr = document.createElement('canvas');
      croppedAddr.width = aw;
      croppedAddr.height = ah;
      croppedAddr.getContext('2d').drawImage(backCanvas, ax, ay, aw, ah, 0, 0, aw, ah);
      const preprocessedAddr = preprocessROI(croppedAddr, 2.0);
      const dataUrlAddr = preprocessedAddr.toDataURL('image/png');

      const mx = 5;
      const my = Math.round(0.70 * backCanvas.height);
      const mw = backCanvas.width - 2 * mx;
      const mh = backCanvas.height - my;
      const croppedMrz = document.createElement('canvas');
      croppedMrz.width = mw;
      croppedMrz.height = mh;
      croppedMrz.getContext('2d').drawImage(backCanvas, mx, my, mw, mh, 0, 0, mw, mh);
      const preprocessedMrz = preprocessROI(croppedMrz, 2.0);
      const dataUrlMrz = preprocessedMrz.toDataURL('image/png');

      const results = await Promise.all([
        (async () => {
          const worker0 = await Tesseract.createWorker('eng', 1, getTesseractOptions());
          await worker0.setParameters({
            preserve_interword_spaces: '1',
            user_defined_dpi: '300',
            tessedit_char_whitelist: '',
            tessedit_pageseg_mode: '6'
          });
          const res = await worker0.recognize(dataUrlAddr);
          await worker0.terminate();
          return (res.data.text || '').trim();
        })(),
        (async () => {
          const worker1 = await Tesseract.createWorker('eng', 1, getTesseractOptions());
          await worker1.setParameters({
            preserve_interword_spaces: '1',
            user_defined_dpi: '300',
            tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<',
            tessedit_pageseg_mode: '6'
          });
          const res = await worker1.recognize(dataUrlMrz);
          await worker1.terminate();
          return (res.data.text || '').trim();
        })()
      ]);

      const addrText = results[0];
      const mrzText  = results[1];

      const backAddrData = parseBack(addrText);
      const backMrzData = parseMRZ(mrzText);

      backData = Object.assign({}, backAddrData, {
        card_no:     backMrzData.card_no     || backAddrData.card_no     || '',
        expiry:      backMrzData.expiry      || backAddrData.expiry      || '',
        nin:         backMrzData.nin         || backAddrData.nin         || '',
        dob:         backMrzData.dob         || backAddrData.dob         || '',
        sex:         backMrzData.sex         || backAddrData.sex         || '',
        surname:     backMrzData.surname     || backAddrData.surname     || '',
        given_names: backMrzData.given_names || backAddrData.given_names || '',
        nationality: backMrzData.nationality || backAddrData.nationality || '',
      });

      rawBack = `ADDRESS BLOCK:\n${addrText}\n\nMRZ:\n${mrzText}`;
    }

    setProgress(95, 'Finalising…', 'Building form');
    await sleep(150);

    const merged = { front: frontData, back: backData };
    const merged2 = mergeAndApplyMrzBackfill(merged);
    fillForm(merged2);
    applyConfidenceBorders(merged2.confidence || {});

    const rawBlock = document.getElementById('raw-block');
    rawBlock.style.display = 'block';
    if (rawFront) document.getElementById('raw-front-text').textContent = '=== FRONT ===\n' + rawFront;
    if (rawBack)  document.getElementById('raw-back-text').textContent  = '\n=== BACK ===\n' + rawBack;

    const hasAny = [
      'surname', 'given_names', 'sex', 'dob', 'nin', 'expiry'
    ].some(k => merged2[k] && String(merged2[k]).trim().length > 0);

    const identityRequired = ['nin', 'dob', 'sex', 'surname', 'expiry'];
    const missingIdentity = identityRequired.filter(k => !merged2[k]);

    const okNinDob = !!merged2.nin && !!merged2.dob;
    const okSurnameDob = !!merged2.surname && !!merged2.dob;

    const showSuccess = hasAny && (okNinDob || okSurnameDob);

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

// Duplicate helper functions and parsers removed. Using globals from parser.js.

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
    expiry: 'f-expiry'
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
  set('f-dob', d.dob);
  set('f-nin', d.nin);
  set('f-expiry', d.expiry);
  set('f-nationality', d.nationality);
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
    dob: g('f-dob'),
    nin: g('f-nin'),
    expiry: g('f-expiry'),
    nationality: g('f-nationality'),
    phone: g('f-phone')
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
    const subs = { front: 'Name · NIN · DOB · Sex', back: 'Back MRZ (optional backup)' };

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
    'f-surname','f-given','f-sex','f-dob','f-nin','f-expiry','f-nationality','f-phone'
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
      </td>
      <td>${r.nationality || '—'}</td>
      <td>${r.sex || '—'}</td>
      <td style="font-family:monospace;font-size:11px">${r.nin || '—'}</td>
      <td>${r.dob || '—'}</td>
      <td>${r.expiry || '—'}</td>
      <td>${r.phone || '—'}</td>
    </tr>
  `).join('');

  container.innerHTML = `
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Name</th>
            <th>Nationality</th>
            <th>Sex</th>
            <th>NIN</th>
            <th>DOB</th>
            <th>Expiry</th>
            <th>Phone</th>
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
    'NIN': r.nin,
    'SURNAME': r.surname,
    'GIVEN NAMES': r.given_names,
    'FULL NAME': r.full_name,
    'NATIONALITY': r.nationality,
    'SEX': r.sex,
    'DATE OF BIRTH': r.dob,
    'DATE OF EXPIRY': r.expiry,
    'PHONE NUMBER': r.phone
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [
    {wch:5},{wch:17},{wch:14},{wch:18},{wch:24},{wch:14},{wch:5},{wch:14},{wch:14},{wch:14}
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
  // Empty init
});

