/* ═══════════════════════════════════════════
   NSSF ID Capture Tool — App Logic
   Fully offline. No API calls. Tesseract.js OCR only.
   ═══════════════════════════════════════════ */

'use strict';

// --- UI Debug Console Interceptor ---
(function() {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  function appendToUIDebug(msg, isError) {
    const debugBox = document.getElementById('ui-debug-console');
    if (debugBox) {
      const span = document.createElement('span');
      span.style.color = isError ? '#ff4444' : '#00ff00';
      span.innerText = msg + '\n';
      debugBox.appendChild(span);
      debugBox.scrollTop = debugBox.scrollHeight;
    }
  }

  function stringifyArgs(args) {
    return Array.from(args).map(arg => {
      if (typeof arg === 'object') {
        try {
          return JSON.stringify(arg);
        } catch (e) {
          return '[Object]';
        }
      }
      return arg;
    }).join(' ');
  }

  console.log = function() {
    originalLog.apply(console, arguments);
    appendToUIDebug(stringifyArgs(arguments), false);
  };
  console.warn = function() {
    originalWarn.apply(console, arguments);
    appendToUIDebug('WARN: ' + stringifyArgs(arguments), true);
  };
  console.error = function() {
    originalError.apply(console, arguments);
    appendToUIDebug('ERROR: ' + stringifyArgs(arguments), true);
  };
})();

// ─── State ────────────────────────────────────
const state = {
  files: { front: null, back: null },
  records: [],
  ocr: { running: false },
  installPrompt: null,
  scanMode: true,
  layouts: { front: 'old-front', back: 'old-back' },
  captureMode: localStorage.getItem('nssf_capture_mode') || 'scan',
  dataQualityFlag: '',
  barcodeWarnings: []
};

// constants FRONT_ROIS, BACK_ROIS, and FIELD_OCR_SETTINGS are accessed as globals from parser.js

// ─── OpenCV.js Integration & Pre-processing ───
let isOpenCvLoaded = false;
let openCvLoadCallbacks = [];
let openCvScriptRequested = false;
let openCvScriptFailed = false;

function onOpenCvReady() {
  console.log('OpenCV.js has loaded successfully.');
  isOpenCvLoaded = true;
  while (openCvLoadCallbacks.length > 0) {
    const cb = openCvLoadCallbacks.shift();
    try { cb(); } catch (e) { console.error(e); }
  }
}

// In case OpenCV loaded before app.js parsed
if (typeof cv !== 'undefined' && cv.Mat) {
  isOpenCvLoaded = true;
}

// Attach to window so the async script onload can call it
window.onOpenCvReady = onOpenCvReady;

function waitForOpenCv() {
  return new Promise((resolve) => {
    if (isOpenCvLoaded && typeof cv !== 'undefined' && cv.Mat) {
      resolve();
    } else {
      if (!openCvScriptRequested && !openCvScriptFailed) {
        openCvScriptRequested = true;
        tryLoadOpenCvScript('js/opencv.js')
          .catch(() => tryLoadOpenCvScript('https://docs.opencv.org/4.8.0/opencv.js'))
          .catch((err) => {
            console.warn('OpenCV unavailable; using canvas-based card finder.', err);
            openCvScriptFailed = true;
          });
      }
      openCvLoadCallbacks.push(resolve);
      setTimeout(resolve, 4500);
    }
  });
}

function tryLoadOpenCvScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.async = true;
    script.src = src;
    script.onload = () => {
      if (typeof cv === 'undefined') {
        reject(new Error('OpenCV global was not created'));
        return;
      }
      if (cv.Mat) {
        onOpenCvReady();
        resolve(true);
      } else {
        cv.onRuntimeInitialized = () => {
          onOpenCvReady();
          resolve(true);
        };
      }
    };
    script.onerror = () => reject(new Error('Could not load ' + src));
    document.head.appendChild(script);
  });
}

async function ensureOpenCvLoaded(timeoutMs = 4500) {
  if (isOpenCvLoaded && typeof cv !== 'undefined' && cv.Mat) return true;
  if (!openCvScriptRequested && !openCvScriptFailed) {
    openCvScriptRequested = true;
    try {
      await Promise.race([
        tryLoadOpenCvScript('js/opencv.js').catch(() => tryLoadOpenCvScript('https://docs.opencv.org/4.8.0/opencv.js')),
        sleep(timeoutMs).then(() => false)
      ]);
    } catch (err) {
      console.warn('OpenCV unavailable; using canvas-based card finder.', err);
      openCvScriptFailed = true;
    }
  } else {
    await Promise.race([waitForOpenCv(), sleep(timeoutMs)]);
  }
  return isOpenCvLoaded && typeof cv !== 'undefined' && cv.Mat;
}

/**
 * Card boundary detection using OpenCV.js
 */
function detectCardBoundary(img) {
  let src;
  try {
    src = cv.imread(img);
  } catch (e) {
    console.error('Error reading image into cv.Mat:', e);
    return null;
  }
  
  let gray = new cv.Mat();
  let blurred = new cv.Mat();
  let edged = new cv.Mat();
  let contours = new cv.MatVector();
  let hierarchy = new cv.Mat();

  // 1. Convert to grayscale and apply Gaussian blur (kernel 5x5)
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  let ksize = new cv.Size(5, 5);
  cv.GaussianBlur(gray, blurred, ksize, 0, 0, cv.BORDER_DEFAULT);

  // TUNING: lower=75 upper=200 — raise lower to 100 if holographic texture causes false contours
  cv.Canny(blurred, edged, 75, 200, 3, false);

  // 3. Find external contours
  cv.findContours(edged, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  let cardContour = null;
  let maxArea = 0;

  // 4. Loop through contours
  for (let i = 0; i < contours.size(); ++i) {
    let contour = contours.get(i);
    let area = cv.contourArea(contour);
    if (area < 5000) {
      contour.delete();
      continue;
    }

    let perimeter = cv.arcLength(contour, true);
    let approx = new cv.Mat();
    cv.approxPolyDP(contour, approx, 0.02 * perimeter, true);

    if (approx.rows === 4) {
      // Validate aspect ratio and area
      let rect = cv.minAreaRect(contour);
      let w = rect.size.width;
      let h = rect.size.height;
      let aspectRatio = w > h ? w / h : h / w;
      
      const imgArea = src.cols * src.rows;
      const areaRatio = area / imgArea;
      
      // CR80 Card aspect ratio is ~1.58. We check if it is between 1.2 and 1.9.
      // We also check if the card occupies between 10% and 90% of the image.
      if (aspectRatio >= 1.2 && aspectRatio <= 1.9 && areaRatio >= 0.10 && areaRatio <= 0.90) {
        if (area > maxArea) {
          maxArea = area;
          if (cardContour) {
            cardContour.delete();
          }
          cardContour = approx;
        } else {
          approx.delete();
        }
      } else {
        approx.delete();
      }
    } else {
      approx.delete();
    }
    contour.delete();
  }

  // Extract points if found
  let points = null;
  if (cardContour) {
    points = [];
    for (let i = 0; i < 4; ++i) {
      points.push({
        x: cardContour.data32S[i * 2],
        y: cardContour.data32S[i * 2 + 1]
      });
    }
    cardContour.delete();
  }

  // Cleanup
  src.delete();
  gray.delete();
  blurred.delete();
  edged.delete();
  contours.delete();
  hierarchy.delete();

  return points;
}

function detectCardBoundaryWithOpenCv(img) {
  if (typeof cv === 'undefined' || !cv.Mat) return null;

  let src;
  try {
    src = cv.imread(img);
  } catch (e) {
    console.warn('OpenCV could not read image.', e);
    return null;
  }

  let gray = new cv.Mat();
  let blurred = new cv.Mat();
  let edged = new cv.Mat();
  let morph = new cv.Mat();
  let contours = new cv.MatVector();
  let hierarchy = new cv.Mat();
  let kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
  let cardContour = null;
  let bestBox = null;
  let bestScore = -Infinity;
  let detectSrc = src;
  let detectionScale = 1;
  if (Math.max(src.cols, src.rows) > 900) {
    detectionScale = 900 / Math.max(src.cols, src.rows);
    detectSrc = new cv.Mat();
    cv.resize(src, detectSrc, new cv.Size(
      Math.max(1, Math.round(src.cols * detectionScale)),
      Math.max(1, Math.round(src.rows * detectionScale))
    ), 0, 0, cv.INTER_AREA);
  }
  const imgArea = detectSrc.cols * detectSrc.rows;

  cv.cvtColor(detectSrc, gray, cv.COLOR_RGBA2GRAY);
  cv.equalizeHist(gray, gray); // Boost contrast to dramatically improve boundary detection
  cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);

  for (const [low, high] of [[30, 95], [60, 170], [100, 240]]) {
    contours.delete();
    hierarchy.delete();
    contours = new cv.MatVector();
    hierarchy = new cv.Mat();

    cv.Canny(blurred, edged, low, high, 3, false);
    cv.morphologyEx(edged, morph, cv.MORPH_CLOSE, kernel);
    cv.findContours(morph, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    for (let i = 0; i < contours.size(); ++i) {
      const contour = contours.get(i);
      const area = cv.contourArea(contour);
      const areaRatio = area / imgArea;
      if (areaRatio < 0.05 || areaRatio > 0.95) {
        contour.delete();
        continue;
      }

      const perimeter = cv.arcLength(contour, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(contour, approx, 0.018 * perimeter, true);
      const rect = cv.minAreaRect(contour);
      const rw = rect.size.width;
      const rh = rect.size.height;
      const rectArea = Math.max(1, rw * rh);
      const rectangularity = Math.min(1, area / rectArea);
      const rectAspect = rw > rh ? rw / rh : rh / rw;
      if (rectAspect >= 1.18 && rectAspect <= 1.95) {
        const ratioScore = 1 - Math.min(1, Math.abs(rectAspect - 1.586) / 0.45);
        const areaScore = Math.min(1, areaRatio / 0.22);
        const rectScore = ratioScore * 3 + rectangularity * 2 + areaScore;
        if (rectScore > bestScore && !cardContour) {
          bestScore = rectScore;
          bestBox = rotatedRectToPoints(rect);
        }
      }

      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        const w = rect.size.width;
        const h = rect.size.height;
        const aspectRatio = w > h ? w / h : h / w;

        if (aspectRatio >= 1.18 && aspectRatio <= 1.95) {
          const ratioScore = 1 - Math.min(1, Math.abs(aspectRatio - 1.586) / 0.45);
          const areaScore = Math.min(1, areaRatio / 0.22);
          const score = ratioScore * 3 + rectangularity * 2.5 + areaScore + 0.35;
          if (score > bestScore) {
            bestScore = score;
            if (cardContour) cardContour.delete();
            cardContour = approx;
          } else {
            approx.delete();
          }
        } else {
          approx.delete();
        }
      } else {
        approx.delete();
      }
      contour.delete();
    }
  }

  // Pale laminated cards often have weak outer edges against a white surface.
  // Their printed security colors still form one saturated rectangular region,
  // so evaluate several saturation masks as a second independent detector.
  const rgb = new cv.Mat();
  const hsv = new cv.Mat();
  const channels = new cv.MatVector();
  const colorMask = new cv.Mat();
  const colorKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(13, 13));
  cv.cvtColor(detectSrc, rgb, cv.COLOR_RGBA2RGB);
  cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
  cv.split(hsv, channels);
  const saturation = channels.get(1);

  for (const threshold of [9, 16, 24, 36]) {
    cv.threshold(saturation, colorMask, threshold, 255, cv.THRESH_BINARY);
    cv.morphologyEx(colorMask, colorMask, cv.MORPH_CLOSE, colorKernel);
    contours.delete();
    hierarchy.delete();
    contours = new cv.MatVector();
    hierarchy = new cv.Mat();
    cv.findContours(colorMask, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const area = cv.contourArea(contour);
      const areaRatio = area / imgArea;
      if (areaRatio < 0.035 || areaRatio > 0.82) {
        contour.delete();
        continue;
      }
      const rect = cv.minAreaRect(contour);
      const rw = rect.size.width;
      const rh = rect.size.height;
      const aspect = Math.max(rw, rh) / Math.max(1, Math.min(rw, rh));
      const rectangularity = Math.min(1, area / Math.max(1, rw * rh));
      if (aspect >= 1.18 && aspect <= 1.95 && rectangularity >= 0.52) {
        const ratioScore = 1 - Math.min(1, Math.abs(aspect - 1.586) / 0.45);
        const areaScore = Math.min(1, areaRatio / 0.22);
        const score = ratioScore * 3 + rectangularity * 2 + areaScore;
        if (score > bestScore) {
          bestScore = score;
          if (cardContour) {
            cardContour.delete();
            cardContour = null;
          }
          bestBox = rotatedRectToPoints(rect);
        }
      }
      contour.delete();
    }
  }

  rgb.delete();
  hsv.delete();
  saturation.delete();
  channels.delete();
  colorMask.delete();
  colorKernel.delete();

  let points = null;
  if (cardContour) {
    points = [];
    for (let i = 0; i < 4; ++i) {
      points.push({
        x: cardContour.data32S[i * 2],
        y: cardContour.data32S[i * 2 + 1]
      });
    }
    cardContour.delete();
  } else if (bestBox) {
    points = bestBox;
  }

  if (points && detectionScale !== 1) {
    points = points.map(point => ({
      x: point.x / detectionScale,
      y: point.y / detectionScale
    }));
  }

  if (detectSrc !== src) detectSrc.delete();
  src.delete();
  gray.delete();
  blurred.delete();
  edged.delete();
  morph.delete();
  contours.delete();
  hierarchy.delete();
  kernel.delete();
  return points;
}

function rotatedRectToPoints(rect) {
  const angle = rect.angle * Math.PI / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const hw = rect.size.width / 2;
  const hh = rect.size.height / 2;
  const offsets = [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh }
  ];
  return offsets.map(p => ({
    x: rect.center.x + p.x * cos - p.y * sin,
    y: rect.center.y + p.x * sin + p.y * cos
  }));
}

function detectCardByCanvasScan(img) {
  const sourceW = img.naturalWidth || img.width;
  const sourceH = img.naturalHeight || img.height;
  if (!sourceW || !sourceH) return null;

  const scanW = 420;
  const scanH = Math.max(1, Math.round(sourceH * (scanW / sourceW)));
  const canvas = document.createElement('canvas');
  canvas.width = scanW;
  canvas.height = scanH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, scanW, scanH);
  const data = ctx.getImageData(0, 0, scanW, scanH).data;

  const border = [];
  const pushBorder = (x, y) => {
    const idx = (y * scanW + x) * 4;
    const r = data[idx], g = data[idx + 1], b = data[idx + 2];
    border.push({ r, g, b, lum: 0.299 * r + 0.587 * g + 0.114 * b });
  };
  for (let x = 0; x < scanW; x += 8) {
    pushBorder(x, 2);
    pushBorder(x, scanH - 3);
  }
  for (let y = 0; y < scanH; y += 8) {
    pushBorder(2, y);
    pushBorder(scanW - 3, y);
  }

  const bg = border.reduce((acc, v) => {
    acc.r += v.r; acc.g += v.g; acc.b += v.b; acc.lum += v.lum;
    return acc;
  }, { r: 0, g: 0, b: 0, lum: 0 });
  bg.r /= Math.max(1, border.length);
  bg.g /= Math.max(1, border.length);
  bg.b /= Math.max(1, border.length);
  bg.lum /= Math.max(1, border.length);

  const findBox = (mode) => {
    let minX = scanW, minY = scanH, maxX = 0, maxY = 0, hits = 0;
    for (let y = Math.round(scanH * 0.02); y < Math.round(scanH * 0.98); y += 2) {
      for (let x = Math.round(scanW * 0.01); x < Math.round(scanW * 0.99); x += 2) {
        const idx = (y * scanW + x) * 4;
        const r = data[idx], g = data[idx + 1], b = data[idx + 2];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const sat = Math.max(r, g, b) - Math.min(r, g, b);
        const bgDist = Math.hypot(r - bg.r, g - bg.g, b - bg.b);
        const surface = bgDist > 18 && lum > 90 && sat < 120;
        const tintedSurface = sat > 8 && bgDist > 24 && lum > 70;
        const ink = lum < bg.lum - 38;
        const isHit = mode === 'surface'
          ? (surface || tintedSurface)
          : (ink || surface || tintedSurface);
        if (isHit) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
          hits++;
        }
      }
    }

    if (hits < 80 || maxX <= minX || maxY <= minY) return null;

    const padX = Math.round((maxX - minX) * (mode === 'surface' ? 0.035 : 0.075));
    const padY = Math.round((maxY - minY) * (mode === 'surface' ? 0.045 : 0.12));
    minX = Math.max(0, minX - padX);
    maxX = Math.min(scanW - 1, maxX + padX);
    minY = Math.max(0, minY - padY);
    maxY = Math.min(scanH - 1, maxY + padY);

    const w = maxX - minX;
    const h = maxY - minY;
    const ratio = w / h;
    const areaRatio = (w * h) / (scanW * scanH);
    if (ratio < 1.18 || ratio > 2.10) return null;
    if (areaRatio < 0.07 || areaRatio > 0.94) return null;

    const sx = sourceW / scanW;
    const sy = sourceH / scanH;
    return [
      { x: minX * sx, y: minY * sy },
      { x: maxX * sx, y: minY * sy },
      { x: maxX * sx, y: maxY * sy },
      { x: minX * sx, y: maxY * sy }
    ];
  };

  return findBox('surface') || findBox('content');
}

function detectCardByHorizontalBand(img) {
  const sourceW = img.naturalWidth || img.width;
  const sourceH = img.naturalHeight || img.height;
  if (!sourceW || !sourceH) return null;

  const scanW = 360;
  const scanH = Math.max(1, Math.round(sourceH * (scanW / sourceW)));
  const canvas = document.createElement('canvas');
  canvas.width = scanW;
  canvas.height = scanH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, scanW, scanH);
  const data = ctx.getImageData(0, 0, scanW, scanH).data;
  const rowScore = new Float32Array(scanH);
  const colScore = new Float32Array(scanW);

  for (let y = 1; y < scanH - 1; y++) {
    for (let x = Math.round(scanW * 0.02); x < Math.round(scanW * 0.98); x += 2) {
      const idx = (y * scanW + x) * 4;
      const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      const aboveIdx = ((y - 1) * scanW + x) * 4;
      const belowIdx = ((y + 1) * scanW + x) * 4;
      const above = 0.299 * data[aboveIdx] + 0.587 * data[aboveIdx + 1] + 0.114 * data[aboveIdx + 2];
      const below = 0.299 * data[belowIdx] + 0.587 * data[belowIdx + 1] + 0.114 * data[belowIdx + 2];
      const edge = Math.abs(above - below);
      if (edge > 16 || lum < 150) {
        rowScore[y]++;
        colScore[x]++;
      }
    }
  }

  const rowThresh = scanW * 0.10;
  const colThresh = scanH * 0.05;
  let minY = 0, maxY = scanH - 1, minX = 0, maxX = scanW - 1;
  while (minY < scanH && rowScore[minY] < rowThresh) minY++;
  while (maxY > minY && rowScore[maxY] < rowThresh) maxY--;
  while (minX < scanW && colScore[minX] < colThresh) minX++;
  while (maxX > minX && colScore[maxX] < colThresh) maxX--;
  if (maxX <= minX || maxY <= minY) return null;

  const ratio = (maxX - minX) / (maxY - minY);
  if (ratio < 1.18 || ratio > 2.15) return null;

  const sx = sourceW / scanW;
  const sy = sourceH / scanH;
  return [
    { x: minX * sx, y: minY * sy },
    { x: maxX * sx, y: minY * sy },
    { x: maxX * sx, y: maxY * sy },
    { x: minX * sx, y: maxY * sy }
  ];
}

function polygonArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += (a.x * b.y) - (b.x * a.y);
  }
  return Math.abs(sum) / 2;
}

function distance2d(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function scoreCardDetection(points, img) {
  if (!points || points.length !== 4) return { confidence: 0, label: 'none' };
  const ordered = orderCorners(points);
  const w = (distance2d(ordered[0], ordered[1]) + distance2d(ordered[3], ordered[2])) / 2;
  const h = (distance2d(ordered[0], ordered[3]) + distance2d(ordered[1], ordered[2])) / 2;
  const ratio = h > 0 ? w / h : 0;
  const imageW = img.naturalWidth || img.width;
  const imageH = img.naturalHeight || img.height;
  const areaRatio = polygonArea(ordered) / (imageW * imageH);
  const ratioScore = Math.max(0, 1 - Math.abs(ratio - 1.586) / 0.55);
  const areaScore = areaRatio >= 0.035 && areaRatio <= 0.82 ? Math.min(1, areaRatio / 0.24) : 0;
  const marginX = imageW * 0.012;
  const marginY = imageH * 0.012;
  const minX = Math.min(...ordered.map(p => p.x));
  const maxX = Math.max(...ordered.map(p => p.x));
  const minY = Math.min(...ordered.map(p => p.y));
  const maxY = Math.max(...ordered.map(p => p.y));
  const touchingEdges = [minX <= marginX, maxX >= imageW - marginX, minY <= marginY, maxY >= imageH - marginY]
    .filter(Boolean).length;
  const edgeScore = Math.max(0, 1 - touchingEdges * 0.34);
  const confidence = Math.max(0, Math.min(1, ratioScore * 0.52 + areaScore * 0.20 + edgeScore * 0.28));
  const label = confidence >= 0.72 ? 'high' : confidence >= 0.46 ? 'medium' : 'low';
  return { confidence, label, ratio, areaRatio, touchingEdges };
}

function chooseAutomaticCorners(img) {
  const candidates = [
    { corners: detectCardBoundaryWithOpenCv(img), source: 'opencv', minimum: 0.40, priority: 0.08 },
    { corners: detectCardByCanvasScan(img), source: 'color-scan', minimum: 0.72, priority: 0 },
    { corners: detectCardByHorizontalBand(img), source: 'edge-band', minimum: 0.76, priority: -0.02 }
  ].filter(candidate => candidate.corners);

  candidates.forEach(candidate => {
    candidate.score = scoreCardDetection(candidate.corners, img);
    candidate.rank = candidate.score.confidence + candidate.priority;
  });
  candidates.sort((a, b) => b.rank - a.rank);
  const accepted = candidates.find(candidate => candidate.score.confidence >= candidate.minimum);
  if (accepted) return accepted;

  // None of the methods cleared its strict threshold. Accept a plausible
  // best candidate and let downstream image-quality and OCR-confidence checks
  // decide whether the capture is usable instead of aborting before OCR.
  const best = candidates[0];
  const ABSOLUTE_FLOOR = 0.34;
  if (best && best.score.confidence >= ABSOLUTE_FLOOR) {
    console.warn(
      `Accepting low-confidence ${best.source} crop (score ${best.score.confidence.toFixed(2)}, ` +
      `below its normal ${best.minimum} threshold) rather than hard-failing to manual entry.`
    );
    return Object.assign({}, best, { minimum: ABSOLUTE_FLOOR });
  }

  return best || { corners: null, score: { confidence: 0, label: 'none' }, source: 'none' };
}

function analyzeCaptureQuality(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const step = Math.max(1, Math.floor(Math.min(canvas.width, canvas.height) / 180));
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let total = 0;
  let glare = 0;
  let dark = 0;
  let edgeSum = 0;
  let samples = 0;

  function lumAt(x, y) {
    const i = (y * canvas.width + x) * 4;
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }

  for (let y = step; y < canvas.height - step; y += step) {
    for (let x = step; x < canvas.width - step; x += step) {
      const l = lumAt(x, y);
      total += l;
      if (l > 246) glare++;
      if (l < 20) dark++;
      const gx = Math.abs(lumAt(x + step, y) - lumAt(x - step, y));
      const gy = Math.abs(lumAt(x, y + step) - lumAt(x, y - step));
      edgeSum += gx + gy;
      samples++;
    }
  }

  const mean = total / Math.max(1, samples);
  const glareRatio = glare / Math.max(1, samples);
  const darkRatio = dark / Math.max(1, samples);
  const sharpness = edgeSum / Math.max(1, samples);
  const warnings = [];
  if (glareRatio > 0.42) warnings.push('too much glare');
  if (darkRatio > 0.18 || mean < 60) warnings.push('too dark');
  if (sharpness < 7.5) warnings.push('too blurry');
  return { mean, glareRatio, darkRatio, sharpness, warnings, acceptable: warnings.length === 0 };
}

/**
 * Sort corner points: [top-left, top-right, bottom-right, bottom-left]
 */
function orderCorners(pts) {
  // Sort by y coordinate first (top pair vs bottom pair)
  const sortedByY = [...pts].sort((a, b) => a.y - b.y);
  
  // Sort the top pair by x coordinate
  const topPair = [sortedByY[0], sortedByY[1]].sort((a, b) => a.x - b.x);
  const topLeft = topPair[0];
  const topRight = topPair[1];
  
  // Sort the bottom pair by x coordinate
  const bottomPair = [sortedByY[2], sortedByY[3]].sort((a, b) => a.x - b.x);
  const bottomLeft = bottomPair[0];
  const bottomRight = bottomPair[1];
  
  return [topLeft, topRight, bottomRight, bottomLeft];
}

function warpCardWithCanvas(img, orderedPts) {
  const minX = Math.max(0, Math.min(...orderedPts.map(p => p.x)));
  const minY = Math.max(0, Math.min(...orderedPts.map(p => p.y)));
  const maxX = Math.min(img.naturalWidth || img.width, Math.max(...orderedPts.map(p => p.x)));
  const maxY = Math.min(img.naturalHeight || img.height, Math.max(...orderedPts.map(p => p.y)));
  const canvas = document.createElement('canvas');
  canvas.width = 856;
  canvas.height = 540;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, minX, minY, maxX - minX, maxY - minY, 0, 0, 856, 540);
  return canvas;
}

function warpCard(img, orderedPts) {
  if (typeof cv === 'undefined' || !cv.Mat) {
    return warpCardWithCanvas(img, orderedPts);
  }

  let src = cv.imread(img);
  let dst = new cv.Mat();
  let srcCoords = cv.matFromArray(4, 1, cv.CV_32FC2, [
    orderedPts[0].x, orderedPts[0].y,
    orderedPts[1].x, orderedPts[1].y,
    orderedPts[2].x, orderedPts[2].y,
    orderedPts[3].x, orderedPts[3].y
  ]);
  let dstCoords = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0,
    856, 0,
    856, 540,
    0, 540
  ]);
  let M = cv.getPerspectiveTransform(srcCoords, dstCoords);
  let dsize = new cv.Size(856, 540);
  cv.warpPerspective(src, dst, M, dsize, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());

  const canvas = document.createElement('canvas');
  canvas.width = 856;
  canvas.height = 540;
  cv.imshow(canvas, dst);

  src.delete();
  dst.delete();
  srcCoords.delete();
  dstCoords.delete();
  M.delete();
  return canvas;
}

/**
 * Draws the warped canvas onto the visible debug canvas for step 2 verification
 */
function drawDebugCanvas(warpedCanvas) {
  const debugContainer = document.getElementById('debug-warp-container');
  const debugCanvas = document.getElementById('debugWarpCanvas');
  if (debugContainer && debugCanvas) {
    debugContainer.style.display = 'block';
    const ctx = debugCanvas.getContext('2d');
    ctx.clearRect(0, 0, debugCanvas.width, debugCanvas.height);
    ctx.drawImage(warpedCanvas, 0, 0, debugCanvas.width, debugCanvas.height);
  }
}

/**
 * Pre-processes the card image: auto-detects, orders corners, and warps.
 * No manual crop step is used; low-confidence captures ask for a retake.
 */
function getWarpedCanvasOrFallback(img, side) {
  return new Promise((resolve, reject) => {
    const bypassToggle = document.getElementById('bypass-autocrop');
    const bypass = bypassToggle && bypassToggle.checked;

    if (bypass) {
      console.log(`Bypassing auto-crop for ${side}.`);
      try {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        const fullCorners = [
          { x: 0, y: 0 },
          { x: w, y: 0 },
          { x: w, y: h },
          { x: 0, y: h }
        ];
        const warped = warpCard(img, fullCorners);
        drawDebugCanvas(warped);
        resolve(warped);
      } catch (err) {
        reject(err);
      }
      return;
    }

    const result = chooseAutomaticCorners(img);
    // The chooseAutomaticCorners function already applies minimums and an ABSOLUTE_FLOOR fallback.
    // We must trust its return value rather than re-enforcing the strict minimum here.
    if (result && result.corners) {
      console.log(`Automatic ${side} card crop (${result.source}).`, result.score);
      try {
        const ordered = orderCorners(result.corners);
        const warped = warpCard(img, ordered);
        const quality = analyzeCaptureQuality(warped);
        if (!quality.acceptable) {
          reject(new Error(`${side === 'front' ? 'Front' : 'Back'} image quality is poor (${quality.warnings.join(', ')}). Retake with steadier focus and less glare.`));
          return;
        }
        drawDebugCanvas(warped);
        resolve(warped);
      } catch (err) {
        reject(err);
      }
    } else {
      console.warn(`Automatic ${side} card detection failed.`, result.score);
      reject(new Error(`${side === 'front' ? 'Front' : 'Back'} card was not detected clearly. Retake the photo closer, on a plain background, with all four card edges visible and no glare.`));
    }
  });
}

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

/**
 * Like loadImage() but uses URL.createObjectURL() instead of
 * FileReader.readAsDataURL(). This is critical for the barcode scanner:
 * readAsDataURL() decodes the JPEG into a base64 string and then into a
 * bitmap, and Android WebView / Chrome for Android silently downsamples
 * large bitmaps to fit within its internal texture limit (often ~900x1600),
 * destroying the resolution the scanner needs.
 *
 * createObjectURL() gives the browser a direct reference to the raw JPEG
 * bytes; the image element reports the JPEG's true decoded dimensions
 * (e.g. 3024x4032 from a phone camera) without any intermediate downscale.
 *
 * The blob URL is revoked immediately after the image loads to free memory.
 * Do NOT use this function for the OCR path — OCR uses loadImage() and the
 * two paths must remain independent.
 */
function loadImageNative(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Selected file is not a readable image'));
    };
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.src = url;
  });
}

function capBarcodeImage(source, maxLongEdge = 1800) {
  const width = source.naturalWidth || source.width;
  const height = source.naturalHeight || source.height;
  const longEdge = Math.max(width, height);
  if (longEdge <= maxLongEdge) {
    return source;
  }

  const scale = maxLongEdge / longEdge;
  const targetWidth = Math.round(width * scale);
  const targetHeight = Math.round(height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, targetWidth, targetHeight);
  return canvas;
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
  } else if (fieldName === 'dob' || fieldName === 'expiry' || fieldName === 'issue_date') {
    padX = 4;
    padY = 2;
  } else if (fieldName === 'address_block') {
    padX = 15;
    padY = 10;
  } else if (fieldName && fieldName.startsWith('mrz_line')) {
    padX = 10;
    padY = 3;
  }

  const isAbsolute = roi.x > 1.0;
  const rx = isAbsolute ? roi.x : roi.x * canvas.width;
  const ry = isAbsolute ? roi.y : roi.y * canvas.height;
  const rw = isAbsolute ? roi.w : roi.w * canvas.width;
  const rh = isAbsolute ? roi.h : roi.h * canvas.height;

  const x = Math.max(0, Math.round(rx) - padX);
  const y = Math.max(0, Math.round(ry) - padY);
  const w = Math.min(canvas.width - x, Math.round(rw) + 2 * padX);
  const h = Math.min(canvas.height - y, Math.round(rh) + 2 * padY);

  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  out.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, w, h);
  return out;
}



// ─── Tab switching ────────────────────────────
function preprocessROI(croppedCanvas, scaleFactor = 2.5, fieldName = '', layout = 'old') {
  const isMrz = fieldName && fieldName.startsWith('mrz_line');
  const isNewID = layout === 'new';
  const useBwScan = state.scanMode &&
    (isMrz || ['nin', 'dob', 'expiry', 'issue_date', 'card_no', 'sex', 'district', 'county', 'sub_county', 'parish', 'village'].includes(fieldName));

  // If OpenCV is loaded, use advanced adaptive ML thresholding for robust lighting handling
  if (typeof cv !== 'undefined' && cv.Mat && isOpenCvLoaded) {
    try {
      const srcW = croppedCanvas.width;
      const srcH = croppedCanvas.height;
      const dstW = Math.max(1, Math.round(srcW * scaleFactor));
      const dstH = Math.max(1, Math.round(srcH * scaleFactor));
      
      const src = cv.imread(croppedCanvas);
      const dst = new cv.Mat();
      
      // 1. High-quality resize
      cv.resize(src, dst, new cv.Size(dstW, dstH), 0, 0, cv.INTER_CUBIC);
      
      // 2. Grayscale conversion
      cv.cvtColor(dst, dst, cv.COLOR_RGBA2GRAY);
      
      // 3. Adaptive Thresholding to eliminate shadows, glare, and varying lighting
      if (isMrz || useBwScan || (isNewID && fieldName === 'full_front')) {
        let blockSize = isMrz ? 31 : 21;
        let cValue = isMrz ? 15 : 12;
        cv.adaptiveThreshold(dst, dst, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, blockSize, cValue);
      } else {
         // For fields where we want to keep grayscale, just normalize the lighting
         let clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
         clahe.apply(dst, dst);
         clahe.delete();
      }
      
      const outCanvas = document.createElement('canvas');
      outCanvas.width = dstW;
      outCanvas.height = dstH;
      cv.imshow(outCanvas, dst);
      
      src.delete();
      dst.delete();
      
      return outCanvas;
    } catch (err) {
      console.warn("OpenCV preprocess failed, falling back to manual canvas method", err);
    }
  }

  // --- Fallback Manual Canvas Method ---
  const srcW = croppedCanvas.width;
  const srcH = croppedCanvas.height;
  const dstW = Math.max(1, Math.round(srcW * scaleFactor));
  const dstH = Math.max(1, Math.round(srcH * scaleFactor));

  const canvas = document.createElement('canvas');
  canvas.width = dstW;
  canvas.height = dstH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(croppedCanvas, 0, 0, srcW, srcH, 0, 0, dstW, dstH);

  const imgData = ctx.getImageData(0, 0, dstW, dstH);
  const px = imgData.data;
  if (isNewID && fieldName === 'full_front') {
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] < 90 && px[i + 1] < 90 && px[i + 2] < 90) {
        px[i] = px[i + 1] = px[i + 2] = 0;
      } else {
        px[i] = px[i + 1] = px[i + 2] = 255;
      }
      px[i + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    return canvas;
  }

  const lum = new Float32Array(dstW * dstH);
  let sum = 0;

  for (let i = 0, p = 0; i < px.length; i += 4, p++) {
    const v = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    lum[p] = v;
    sum += v;
  }

  const mean = sum / Math.max(1, lum.length);
  const threshold = isMrz ? Math.min(188, mean * 0.92) : Math.min(190, mean * 0.90);

  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const p = y * dstW + x;
      const i = p * 4;
      const center = lum[p];
      const left = lum[y * dstW + Math.max(0, x - 1)];
      const right = lum[y * dstW + Math.min(dstW - 1, x + 1)];
      const up = lum[Math.max(0, y - 1) * dstW + x];
      const down = lum[Math.min(dstH - 1, y + 1) * dstW + x];
      const sharpened = center * 1.65 - (left + right + up + down) * 0.1625;
      let v = ((sharpened - mean) * (isMrz ? 1.75 : 1.45)) + 150;

      if (isMrz || useBwScan) {
        v = center < threshold ? 0 : 255;
      } else {
        v = Math.max(0, Math.min(255, v));
      }

      px[i] = px[i + 1] = px[i + 2] = v;
      px[i + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

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

function handleBarcodeFile(input) {
  const file = input.files[0];
  if (!file) return;
  state.files.barcode = file;

  const url = URL.createObjectURL(file);
  const zone = document.getElementById('zone-barcode');
  const inner = document.getElementById('zone-barcode-inner');

  if (inner) {
    inner.innerHTML = `
      <img src="${url}" class="uzone-img" alt="back of ID">
      <div class="uzone-success-label">✓ Back loaded</div>
    `;
  }
  if (zone) zone.classList.add('loaded');

  const btn = document.getElementById('btn-extract-barcode');
  if (btn) btn.disabled = false;

  const statusEl = document.getElementById('barcode-upload-status');
  if (statusEl) statusEl.innerHTML = '';
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
  // pct is no longer used since we switched to a spinner
  document.getElementById('prog-label').textContent = label;
  document.getElementById('prog-sub').textContent = sub;
}

// ─── OCR runner ───────────────────────────────
function isNavyColor(r, g, b) {
  return r < 80 && g < 110 && b > 80;
}

function detectIsSynthetic(canvas) {
  const ctx = canvas.getContext('2d');
  // Scale coordinates (500, 30) from 1000x630 virtual grid to actual canvas dimensions
  const scaleX = canvas.width / 1000;
  const scaleY = canvas.height / 630;
  const px = Math.round(500 * scaleX);
  const py = Math.round(30 * scaleY);
  const pixel = ctx.getImageData(px, py, 1, 1).data;
  return isNavyColor(pixel[0], pixel[1], pixel[2]);
}

function darkRatioInRegion(canvas, x0, y0, w0, h0) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const x = Math.max(0, Math.round(x0 * canvas.width));
  const y = Math.max(0, Math.round(y0 * canvas.height));
  const w = Math.min(canvas.width - x, Math.round(w0 * canvas.width));
  const h = Math.min(canvas.height - y, Math.round(h0 * canvas.height));
  if (w <= 0 || h <= 0) return 0;
  const data = ctx.getImageData(x, y, w, h).data;
  let dark = 0;
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    if (lum < 95) dark++;
    total++;
  }
  return dark / Math.max(1, total);
}

function ugandaFlagColorRatio(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const x = Math.round(canvas.width * 0.74);
  const y = Math.round(canvas.height * 0.015);
  const w = Math.min(canvas.width - x, Math.round(canvas.width * 0.25));
  const h = Math.min(canvas.height - y, Math.round(canvas.height * 0.25));
  const data = ctx.getImageData(x, y, w, h).data;
  let flagColor = 0;
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const spread = Math.max(r, g, b) - Math.min(r, g, b);
    const red = r > 105 && r > g * 1.35 && r > b * 1.15;
    const yellow = r > 105 && g > 70 && b < Math.min(r, g) * 0.72 && spread > 40;
    if (red || yellow) flagColor++;
    total++;
  }
  return flagColor / Math.max(1, total);
}

function classifyCardLayout(canvas, side) {
  if (detectIsSynthetic(canvas)) return side === 'front' ? 'synthetic-front' : 'synthetic-back';
  if (side === 'front') {
    // A red/yellow Uganda flag is unique to the new front. The old front has a
    // purple Uganda silhouette in the same area, so darkness alone is unsafe.
    if (ugandaFlagColorRatio(canvas) > 0.012) return 'new-front';
    return 'old-front';
  }

  // Combine barcode position with address-row texture. Either signal alone is
  // sensitive to lighting and alignment; extraction scoring below remains the
  // final safety net when this initial guess is wrong.
  const lowerBarcode = darkRatioInRegion(canvas, 0.04, 0.40, 0.92, 0.18);

  const rowVarianceInRegion = (x0, y0, w0, h0) => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const x = Math.max(0, Math.round(x0 * canvas.width));
    const y = Math.max(0, Math.round(y0 * canvas.height));
    const w = Math.min(canvas.width - x, Math.round(w0 * canvas.width));
    const h = Math.min(canvas.height - y, Math.round(h0 * canvas.height));
    if (w <= 0 || h <= 0) return 0;
    const data = ctx.getImageData(x, y, w, h).data;
    const rowRatios = [];
    for (let row = 0; row < h; row++) {
      let dark = 0;
      for (let col = 0; col < w; col++) {
        const i = (row * w + col) * 4;
        const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (lum < 110) dark++;
      }
      rowRatios.push(dark / Math.max(1, w));
    }
    const mean = rowRatios.reduce((a, b) => a + b, 0) / Math.max(1, rowRatios.length);
    return rowRatios.reduce((a, b) => a + (b - mean) * (b - mean), 0) /
      Math.max(1, rowRatios.length);
  };

  const topBandVariance = rowVarianceInRegion(0.02, 0.02, 0.90, 0.18);
  const midBandVariance = rowVarianceInRegion(0.08, 0.28, 0.85, 0.26);
  let newVotes = 0, oldVotes = 0;
  if (lowerBarcode > 0.15) newVotes++; else oldVotes++;
  if (topBandVariance > midBandVariance) newVotes++; else oldVotes++;
  return newVotes > oldVotes ? 'new-back' : 'old-back';
}

function roisForLayout(layout, side) {
  if (layout === 'synthetic-front') return SYNTHETIC_FRONT_ROIS;
  if (layout === 'synthetic-back') return SYNTHETIC_BACK_ROIS;
  if (layout === 'new-front') return NEW_FRONT_ROIS;
  if (layout === 'new-back') return NEW_BACK_ROIS;
  return side === 'front' ? FRONT_ROIS : BACK_ROIS;
}

function detectDynamicMrzRois(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const w = canvas.width;
  const h = canvas.height;
  const img = ctx.getImageData(0, 0, w, h).data;
  const active = new Array(h).fill(false);
  for (let y = Math.floor(h * 0.42); y < h - 5; y++) {
    let dark = 0;
    let total = 0;
    for (let x = 0; x < w; x += 2) {
      const idx = (y * w + x) * 4;
      const lum = 0.299 * img[idx] + 0.587 * img[idx + 1] + 0.114 * img[idx + 2];
      if (lum < 95) dark++;
      total++;
    }
    const ratio = dark / Math.max(1, total);
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
  const bwToggle = document.getElementById('scan-bw-mode');
  state.scanMode = !bwToggle || bwToggle.checked;

  document.getElementById('btn-extract').disabled = true;
  document.getElementById('card-upload').style.display = 'none';
  document.getElementById('card-progress').style.display = 'block';
  document.getElementById('card-form').style.display = 'none';

  const titleEl = document.getElementById('progress-title-text');
  if (titleEl) titleEl.textContent = 'Running OCR — Please Wait';

  // Make sure debug container is hidden at start of a new run
  const debugContainer = document.getElementById('debug-warp-container');
  if (debugContainer) debugContainer.style.display = 'none';

  try {
    // Wait for OpenCV.js if not loaded yet
    if (!isOpenCvLoaded || typeof cv === 'undefined' || !cv.Mat) {
      setProgress(2, 'Loading OpenCV.js engine…', 'Caching resources for offline use');
      await waitForOpenCv();
    }

    let frontCanvas = null;
    let backCanvas = null;

    if (state.files.front) {
      setProgress(5, 'Loading front of ID…', 'Preparing image');
      const img = await loadImage(state.files.front);
      
      setProgress(7, 'Aligning front of ID…', 'Auto-detecting card edges');
      frontCanvas = await getWarpedCanvasOrFallback(img, 'front');
    }

    if (state.files.back) {
      setProgress(50, 'Loading back of ID…', 'Preparing image');
      const img = await loadImage(state.files.back);

      setProgress(52, 'Aligning back of ID…', 'Auto-detecting card edges');
      backCanvas = await getWarpedCanvasOrFallback(img, 'back');
    }

    await proceedWithWarpedImages(frontCanvas, backCanvas);

  } catch (err) {
    document.getElementById('form-alert').innerHTML = alert('error',
      'OCR failed: ' + (err && err.message ? err.message : JSON.stringify(err)) + '. Please fill the form manually.');
    fillForm({});
    document.getElementById('card-progress').style.display = 'none';
    document.getElementById('card-form').style.display = 'block';
    document.getElementById('btn-extract').disabled = false;
    state.ocr.running = false;
  }
}

/**
 * Runs the OCR pipeline on the warped 856×540 canvases for Tesseract.
 * This is a pure OCR path: front-of-card text extraction + optional
 * back-of-card MRZ extraction. There is NO barcode scanning here.
 * Barcode scanning is handled entirely by the standalone runBarcodeCapture()
 * function, which routes the raw image directly to UgIdParser.
 *
 * @param {HTMLCanvasElement|null} frontCanvas  856×540 warped front image
 * @param {HTMLCanvasElement|null} backCanvas   856×540 warped back image (MRZ OCR only)
 */
async function proceedWithWarpedImages(frontCanvas, backCanvas) {
  // Pre-flight size validation
  if (frontCanvas) {
    if (frontCanvas.width !== 856 || frontCanvas.height !== 540) {
      console.error('Front canvas passed to OCR is not 856x540 — aborting');
      document.getElementById('form-alert').innerHTML = alert('error', 'Card alignment failed. Please retake the photo.');
      throw new Error('Front card alignment failed: output size must be exactly 856x540');
    }
  }
  if (backCanvas) {
    if (backCanvas.width !== 856 || backCanvas.height !== 540) {
      console.error('Back canvas passed to OCR is not 856x540 — aborting');
      document.getElementById('form-alert').innerHTML = alert('error', 'Card alignment failed. Please retake the photo.');
      throw new Error('Back card alignment failed: output size must be exactly 856x540');
    }
  }

  let rawFront = '', rawBack = '';
  let frontData = {}, backData = {};
  let roiFront = {};

  if (frontCanvas) {
    const frontLayout = classifyCardLayout(frontCanvas, 'front');
    state.layouts.front = frontLayout;
    console.log('Front card layout:', frontLayout);

    setProgress(20, 'Reading entire front of ID card…', 'Running Tesseract worker');

    const worker = await Tesseract.createWorker('eng', 1, getTesseractOptions());
    await worker.setParameters({
      preserve_interword_spaces: '1',
      user_defined_dpi: '300',
      tessedit_pageseg_mode: '6'
    });

    const preprocessed = preprocessROI(frontCanvas, 1.6, 'full_front', frontLayout);
    const result = await worker.recognize(preprocessed.toDataURL('image/png'));
    await worker.terminate();

    const fullFrontText = (result.data.text || '').trim();
    const fullFrontData = parseFront(fullFrontText);

    frontData = {
      surname:     normalizeNameStrict(fullFrontData.surname) || '',
      given_names: normalizeNameStrict(fullFrontData.given_names) || '',
      nationality: (fullFrontData.nationality ? fullFrontData.nationality.toUpperCase().replace(/[^A-Z]/g, '') : '') || '',
      sex:         validateSexOrBlank(fullFrontData.sex) || '',
      dob:         parseAndFormatDob(fullFrontData.dob) || '',
      nin:         validateNin(fullFrontData.nin) || '',
      expiry:      parseAndFormatDob(fullFrontData.expiry) || '',
      issue_date:  parseAndFormatDob(fullFrontData.issue_date) || '',
      card_no:     (fullFrontData.card_no || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    };

    rawFront = `LAYOUT: ${frontLayout}\n=== FULL FRONT OCR RAW ===\n${fullFrontText}`;
  }

  if (backCanvas) {
    const backLayout = classifyCardLayout(backCanvas, 'back');
    state.layouts.back = backLayout;
    console.log('Back card layout:', backLayout);

    // Back-of-card is OCR-only in this pipeline. Barcode scanning is handled
    // by the dedicated runBarcodeCapture() path, which feeds the raw image
    // (no warp, no resize) directly to UgIdParser. Do not add barcode attempts
    // here — this warp canvas will always fail the PDF417 decoder.
    setProgress(55, 'Reading back of ID card (MRZ)…', 'Running Tesseract worker');

    const worker = await Tesseract.createWorker('eng', 1, getTesseractOptions());
    await worker.setParameters({
      preserve_interword_spaces: '1',
      user_defined_dpi: '300',
      tessedit_pageseg_mode: '6'
    });

    const preprocessed = preprocessROI(backCanvas, 1.6, 'full_back');
    const result = await worker.recognize(preprocessed.toDataURL('image/png'));
    await worker.terminate();

    // Inserted logging right before parseBack
    const fullBackText = (result.data.text || '').trim();
    console.log("=== DEBUG: PRE-PARSE ===");
    console.log("rawBackText:", fullBackText);
    console.log("window.parseBack typeof:", typeof window.parseBack);
    console.log("window.parseBack reference:", window.parseBack.toString().slice(0, 100));
    
    backData = window.parseBack(fullBackText);
    backData.source = 'ocr';
    
    console.log("=== DEBUG: POST-PARSE ===");
    console.log("backData returned:", JSON.stringify(backData));

    rawBack = `LAYOUT: ${backLayout}\n=== FULL BACK OCR RAW ===\n${fullBackText}`;
  }

  setProgress(95, 'Finalising…', 'Building form');
  await sleep(150);

  const merged = { front: frontData, back: backData };
  const merged2 = mergeAndApplyMrzBackfill(merged);
  
  state.dataQualityFlag = merged2.dataQualityFlag || '';
  state.barcodeWarnings = merged2.barcodeWarnings || [];

  fillForm(merged2);
  applyConfidenceBorders(merged2.confidence || {});

  const rawBlock = document.getElementById('raw-block');
  rawBlock.style.display = 'block';
  if (rawFront) document.getElementById('raw-front-text').textContent = '=== FRONT ===\n' + rawFront;
  if (rawBack)  document.getElementById('raw-back-text').textContent  = '\n=== BACK ===\n' + rawBack;

  const hasAny = [
    'surname', 'given_names', 'sex', 'dob', 'nin'
  ].some(k => merged2[k] && String(merged2[k]).trim().length > 0);

  const identityRequired = ['nin', 'dob', 'sex', 'surname'];
  const missingIdentity = identityRequired.filter(k => !merged2[k]);

  const okNinDob = !!merged2.nin && !!merged2.dob;
  const okSurnameDob = !!merged2.surname && !!merged2.dob;

  const showSuccess = hasAny && (okNinDob || okSurnameDob);

  let alertHtml = showSuccess
    ? alert('warning', 'Data extracted — please <strong>review every field</strong> carefully before saving. OCR may have minor errors. Use the raw text below to verify.')
    : alert('error', 'OCR could not confidently read enough identity data. Retake clear, close photos of the full card with no glare, then extract again.');

  if (merged2.dataQualityFlag) {
    alertHtml += '<br>' + alert('error', `<strong>Barcode & OCR Mismatch Detected!</strong><br>${merged2.dataQualityFlag.replace(/; /g, '<br>')}`);
  }

  if (merged2.barcodeWarnings && merged2.barcodeWarnings.length > 0) {
    alertHtml += '<br>' + alert('warning', `<strong>Barcode Warnings:</strong><br>${merged2.barcodeWarnings.join('<br>')}`);
  }

  document.getElementById('form-alert').innerHTML = alertHtml;

  setProgress(100, 'Done', '');
  console.log('OCR complete. merged2:', JSON.stringify(merged2));

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
    nin: 'f-nin'
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
  set('f-other', d.other_name || '');
  set('f-sex', d.sex);
  set('f-dob', d.dob);
  set('f-nin', d.nin);
  set('f-nationality', d.nationality);
}

// ─── Save record ──────────────────────────────
function saveRecord() {
  const g = id => (document.getElementById(id)?.value || '').trim();

  const sur = g('f-surname');
  const giv = g('f-given');
  const sex = g('f-sex');
  const dob = g('f-dob');
  const nat = g('f-nationality');
  const nin = g('f-nin');
  const phn = g('f-phone');

  // Validate mandatory fields (all except f-other)
  const requiredFields = [
    { id: 'f-surname', name: 'Surname', value: sur },
    { id: 'f-given', name: 'Given Name(s)', value: giv },
    { id: 'f-sex', name: 'Sex', value: sex },
    { id: 'f-dob', name: 'Date of Birth', value: dob },
    { id: 'f-nationality', name: 'Nationality', value: nat },
    { id: 'f-nin', name: 'NIN — National ID Number', value: nin },
    { id: 'f-phone', name: 'Phone Number', value: phn }
  ];

  const missing = requiredFields.filter(f => !f.value).map(f => f.name);

  if (missing.length > 0) {
    document.getElementById('form-alert').innerHTML = alert('error',
      `Please fill in all mandatory fields: <strong>${missing.join(', ')}</strong>.`);
    return;
  }

  // Validate NIN length: must have at least 14 characters
  if (nin.length < 14) {
    document.getElementById('form-alert').innerHTML = alert('error',
      'The <strong>NIN — National ID Number</strong> must be at least 14 characters long.');
    return;
  }

  const record = {
    sn: state.records.length + 1,
    surname: sur,
    given_names: giv,
    other_name: g('f-other'),
    full_name: (sur + ' ' + giv + ' ' + g('f-other')).trim().replace(/\s+/g, ' '),
    sex: sex,
    dob: dob,
    nin: nin,
    nationality: nat,
    phone: phn,
    data_quality_flag: state.dataQualityFlag || ''
  };

  state.records.push(record);
  updateTabBadge();
  resetCapture();

  // Display a brief success message so the user has immediate feedback.
  // For 'scan' mode: upload-status (inside card-upload).
  // For 'barcode' mode: barcode-upload-status (inside card-barcode-upload).
  // For 'manual' mode: form-alert (still visible on the cleared form).
  let feedbackElId;
  if (state.captureMode === 'manual') {
    feedbackElId = 'form-alert';
  } else if (state.captureMode === 'barcode') {
    feedbackElId = 'barcode-upload-status';
  } else {
    feedbackElId = 'upload-status';
  }
  const feedbackEl = document.getElementById(feedbackElId);
  if (feedbackEl) {
    feedbackEl.innerHTML = alert('success', `Record for <strong>${record.full_name}</strong> saved successfully!`);
  }
}

// ─── Reset capture flow ───────────────────────
function resetCapture() {
  state.files = { front: null, back: null, barcode: null };
  state.dataQualityFlag = '';
  state.barcodeWarnings = [];

  // Reset upload zones
  ['front', 'back'].forEach(side => {
    const elGal = document.getElementById('input-' + side + '-gallery');
    const elCam = document.getElementById('input-' + side + '-camera');
    if (elGal) elGal.value = '';
    if (elCam) elCam.value = '';
    const zone = document.getElementById('zone-' + side);
    const inner = document.getElementById('zone-' + side + '-inner');
    if (zone) zone.classList.remove('loaded');

    if (inner) {
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
    }
  });

  document.getElementById('upload-status').innerHTML = '';
  document.getElementById('form-alert').innerHTML = '';
  document.getElementById('card-progress').style.display = 'none';
  
  if (state.captureMode === 'manual') {
    document.getElementById('card-upload').style.display = 'none';
    document.getElementById('card-barcode-upload').style.display = 'none';
    document.getElementById('card-form').style.display = 'block';
  } else if (state.captureMode === 'barcode') {
    document.getElementById('card-upload').style.display = 'none';
    document.getElementById('card-barcode-upload').style.display = 'block';
    document.getElementById('card-form').style.display = 'none';
    // Reset the barcode zone thumbnail
    const barcodeInner = document.getElementById('zone-barcode-inner');
    if (barcodeInner) {
      barcodeInner.innerHTML = `
        <svg class="uzone-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M7 15h3M7 11h5"/></svg>
        <p class="uzone-label">Back of ID</p>
        <small>Barcode scan — direct read, no OCR</small>
      `;
    }
    const zoneBarcode = document.getElementById('zone-barcode');
    if (zoneBarcode) zoneBarcode.classList.remove('loaded');
    const bgi = document.getElementById('input-barcode-gallery');
    const bci = document.getElementById('input-barcode-camera');
    if (bgi) bgi.value = '';
    if (bci) bci.value = '';
    const barcodeStatus = document.getElementById('barcode-upload-status');
    if (barcodeStatus) barcodeStatus.innerHTML = '';
  } else {
    document.getElementById('card-upload').style.display = 'block';
    document.getElementById('card-barcode-upload').style.display = 'none';
    document.getElementById('card-form').style.display = 'none';
  }
  
  document.getElementById('btn-extract').disabled = true;
  const extractBarcodeBtn = document.getElementById('btn-extract-barcode');
  if (extractBarcodeBtn) extractBarcodeBtn.disabled = true;

  document.getElementById('raw-block').style.display = 'none';
  document.getElementById('raw-front-text').textContent = '';
  document.getElementById('raw-back-text').textContent = '';

  const debugContainer = document.getElementById('debug-warp-container');
  if (debugContainer) debugContainer.style.display = 'none';
  const debugCanvas = document.getElementById('debugWarpCanvas');
  if (debugCanvas) {
    const ctx = debugCanvas.getContext('2d');
    ctx.clearRect(0, 0, debugCanvas.width, debugCanvas.height);
  }

  const fields = [
    'f-surname','f-given','f-other','f-sex','f-dob','f-nin','f-nationality','f-phone'
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

function setCaptureMode(mode) {
  state.captureMode = mode;
  localStorage.setItem('nssf_capture_mode', mode);

  const scanBtn    = document.getElementById('mode-scan-btn');
  const barcodeBtn = document.getElementById('mode-barcode-btn');
  const manualBtn  = document.getElementById('mode-manual-btn');

  [scanBtn, barcodeBtn, manualBtn].forEach(b => b && b.classList.remove('active'));

  if (mode === 'scan') {
    if (scanBtn) scanBtn.classList.add('active');
  } else if (mode === 'barcode') {
    if (barcodeBtn) barcodeBtn.classList.add('active');
  } else {
    if (manualBtn) manualBtn.classList.add('active');
  }

  resetCapture();
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
        <strong>${r.surname || '—'}</strong> ${r.given_names || ''} ${r.other_name || ''}
      </td>
      <td>${r.nationality || '—'}</td>
      <td>${r.sex || '—'}</td>
      <td style="font-family:monospace;font-size:11px">${r.nin || '—'}</td>
      <td>${r.dob || '—'}</td>
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
    'OTHER NAME': r.other_name || '',
    'FULL NAME': r.full_name,
    'NATIONALITY': r.nationality,
    'SEX': r.sex,
    'DATE OF BIRTH': r.dob,
    'PHONE NUMBER': r.phone,
    'DATA QUALITY FLAG': r.data_quality_flag || ''
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [
    {wch:5},{wch:17},{wch:14},{wch:18},{wch:15},{wch:26},{wch:14},{wch:5},{wch:14},{wch:14},{wch:30}
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
  XLSX.utils.book_append_sheet(wb, ws, 'NSSF Member Data');

  const summaryData = [
    ['NSSF DIGITAL PRE-REGISTRATION — MEMBER DATA EXPORT'],
    [],
    ['Total Records', state.records.length],
    ['Export Date', new Date().toLocaleDateString('en-UG', { dateStyle: 'long' })],
    ['Export Time', new Date().toLocaleTimeString('en-UG')],
    [],
    ['Tool', 'NSSF Member Data Capture Tool v1.0'],
    ['Mode', 'Offline (Tesseract.js OCR)'],
    ['Note', 'All extracted data should be verified against original ID before use.']
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(summaryData);
  ws2['!cols'] = [{ wch: 20 }, { wch: 50 }];
  XLSX.utils.book_append_sheet(wb, ws2, 'Summary');

  const filename = `NSSF_Member_Data_${todayISO()}.xlsx`;
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

function setupInstallAppButton() {
  const btn = document.getElementById('btn-install-app');
  if (!btn) return;

  const isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;

  if (isStandalone) {
    btn.style.display = 'none';
    return;
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.installPrompt = event;
    btn.style.display = 'inline-flex';
  });

  btn.addEventListener('click', async () => {
    if (!state.installPrompt) {
      window.alert('To install on iPhone/iPad, use Share then Add to Home Screen. On Android/Chrome, use the browser menu then Install app.');
      return;
    }

    const promptEvent = state.installPrompt;
    state.installPrompt = null;
    btn.style.display = 'none';
    await promptEvent.prompt();
  });

  window.addEventListener('appinstalled', () => {
    state.installPrompt = null;
    btn.style.display = 'none';
  });
}

// showBarcodeSourceSelector() — reuses the shared Camera / Gallery modal used by
// Scan ID, but targets the barcode-specific file inputs
// (input-barcode-camera / input-barcode-gallery). Those inputs fire
// runBarcodeCapture() on change, which goes straight to ZXing PDF417 scanning
// with zero OCR involvement.
function showBarcodeSourceSelector() {
  if (state.captureMode !== 'barcode') {
    setCaptureMode('barcode');
  }

  showSourceSelector('barcode');
}

/**
 * Execute the barcode-only scan flow.
 *
 * The file goes: File → loadImage() → UgIdParser.parseCardImage() with ZERO
 * preprocessing in between. No warpCard, no getWarpedCanvasOrFallback, no
 * preprocessROI, no canvas resize, no Tesseract involvement at any point.
 *
 * On success: maps CardRecord → form fields using the same fillForm() used by
 *   the OCR pipeline, shows the standard review banner.
 * On failure: displays the verbatim ScanError / CardParseError message and
 *   stops. Does NOT fall back to OCR — the user explicitly chose this path.
 */
async function runBarcodeCapture() {
  const file = state.files.barcode;
  if (!file) return;
  if (state.ocr.running) {
    document.getElementById('form-alert').innerHTML = alert('warning', 'An extraction is already in progress. Please wait for it to finish.');
    return;
  }

  // Show the shared progress spinner; hide the barcode upload section.
  state.ocr.running = true;
  document.getElementById('card-barcode-upload').style.display = 'none';
  document.getElementById('card-form').style.display = 'none';
  document.getElementById('card-progress').style.display = 'block';
  
  const titleEl = document.getElementById('progress-title-text');
  if (titleEl) titleEl.textContent = 'Scanning Barcode — Please Wait';

  setProgress(10, 'Loading image…', 'Preparing barcode scan');

  try {
    // ── Load the raw image at full JPEG resolution ─────────────────────
    // loadImageNative() uses URL.createObjectURL() — NOT FileReader.readAsDataURL().
    // readAsDataURL decodes the JPEG into a base64 bitmap, which Android WebView
    // silently downsamples to ~900x1600. createObjectURL gives the browser a
    // direct reference to the raw JPEG bytes, preserving native camera resolution.
    const rawImage = await loadImageNative(file);
    const barcodeSource = capBarcodeImage(rawImage, 1800);
    const sourceWidth = rawImage.naturalWidth || rawImage.width;
    const sourceHeight = rawImage.naturalHeight || rawImage.height;
    const processedWidth = barcodeSource.width;
    const processedHeight = barcodeSource.height;
    console.log(`Barcode capture: raw image ${sourceWidth}x${sourceHeight} (file: ${(file.size/1024).toFixed(0)} KB); processing at ${processedWidth}x${processedHeight}`);

    setProgress(30, 'Scanning PDF417 barcode\u2026', 'Decoding symbol \u2014 no preprocessing applied');

    // ── The ONLY call that matters in this entire path ──────────────────
    const record = await UgIdParser.parseCardImage(barcodeSource, { debug: false });

    console.log('Barcode scan SUCCESS:', record);
    setProgress(90, 'Barcode decoded — filling form…', '');
    await sleep(100);

    // ── Map CardRecord → the same flat object fillForm() expects ───────
    const fmt = (d) => {
      if (!d || !(d instanceof Date)) return '';
      return [
        String(d.getUTCDate()).padStart(2, '0'),
        String(d.getUTCMonth() + 1).padStart(2, '0'),
        d.getUTCFullYear()
      ].join('.');
    };

    const mapped = {
      surname:     record.surname     || '',
      given_names: record.givenName   || '',
      other_name:  record.otherName   || '',
      sex:         record.sex         || '',
      dob:         fmt(record.dateOfBirth),
      nin:         record.nin         || '',
      expiry:      fmt(record.expiryDate),
      issue_date:  fmt(record.issueDate),
      card_no:     record.cardNumber  || '',
      nationality: '',           // not stored in the barcode
      dataQualityFlag: '',
      barcodeWarnings: record.warnings || []
    };

    // Reuse the exact same field-population function used by the OCR path.
    fillForm(mapped);
    applyConfidenceBorders({});
    state.dataQualityFlag = '';
    state.barcodeWarnings = record.warnings || [];

    // Show raw barcode text in the collapsible block for verification.
    const rawBlock = document.getElementById('raw-block');
    rawBlock.style.display = 'block';
    document.getElementById('raw-front-text').textContent = '';
    document.getElementById('raw-back-text').textContent = '=== BARCODE (PDF417) ===\n' + UgIdParser.render(record);

    // Banner: identical wording to the OCR success banner.
    let alertHtml = alert('warning',
      'Data extracted from barcode — please <strong>review every field</strong> carefully before saving.');
    if (record.warnings && record.warnings.length > 0) {
      alertHtml += '<br>' + alert('warning',
        `<strong>Barcode Warnings:</strong><br>${record.warnings.join('<br>')}`);
    }
    document.getElementById('form-alert').innerHTML = alertHtml;

    setProgress(100, 'Done', '');
    document.getElementById('card-progress').style.display = 'none';
    document.getElementById('card-form').style.display = 'block';
    document.getElementById('btn-extract-barcode').disabled = false;

  } catch (err) {
    // ScanError and CardParseError messages are surfaced verbatim, per spec.
    // No fallback to OCR — this was an explicit user choice.
    console.error('Barcode capture failed:', err);
    const isScanError = err instanceof UgIdParser.ScanError;
    const isParseError = err instanceof UgIdParser.CardParseError;
    const label = isScanError  ? 'Barcode Not Found'
                : isParseError ? 'Barcode Decoded but Could Not Be Parsed'
                :                'Unexpected Error';

    document.getElementById('card-progress').style.display = 'none';
    document.getElementById('card-barcode-upload').style.display = 'block';
    // Show the error in the status div inside the barcode section.
    const barcodeStatus = document.getElementById('barcode-upload-status');
    if (barcodeStatus) {
      barcodeStatus.innerHTML = alert('error', `<strong>${label}</strong><br>${err.message}`);
    }
    document.getElementById('btn-extract-barcode').disabled = true;
  } finally {
    state.ocr.running = false;
    // Clear the file input so the same file can be re-selected after a failure.
    const gi = document.getElementById('input-barcode-gallery');
    const ci = document.getElementById('input-barcode-camera');
    if (gi) gi.value = '';
    if (ci) ci.value = '';
  }
}
window.showBarcodeSourceSelector = showBarcodeSourceSelector;
window.runBarcodeCapture = runBarcodeCapture;

// ─── Photo Source Selector Modal ──────────────
function showSourceSelector(side) {
  const modal = document.getElementById('source-selector-modal');
  const sideName = document.getElementById('source-side-name');
  const btnCamera = document.getElementById('btn-source-camera');
  const btnGallery = document.getElementById('btn-source-gallery');
  const btnCancel = document.getElementById('btn-source-cancel');

  if (!modal || !sideName || !btnCamera || !btnGallery || !btnCancel) return;

  sideName.textContent = side === 'front' ? 'front' : 'back';
  modal.style.display = 'flex';

  btnCamera.onclick = () => {
    modal.style.display = 'none';
    const input = document.getElementById(`input-${side}-camera`);
    if (input) input.click();
  };

  btnGallery.onclick = () => {
    modal.style.display = 'none';
    const input = document.getElementById(`input-${side}-gallery`);
    if (input) input.click();
  };

  btnCancel.onclick = () => {
    modal.style.display = 'none';
  };
}
window.showSourceSelector = showSourceSelector;

document.addEventListener('DOMContentLoaded', () => {
  setupInstallAppButton();
  setCaptureMode(state.captureMode);

  const bypassToggle = document.getElementById('bypass-autocrop');
  if (bypassToggle) {
    bypassToggle.checked = localStorage.getItem('nssf_bypass_autocrop') === 'true';
    bypassToggle.addEventListener('change', (e) => {
      localStorage.setItem('nssf_bypass_autocrop', e.target.checked);
    });
  }
});



