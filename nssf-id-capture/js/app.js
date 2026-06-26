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
  const imgArea = src.cols * src.rows;

  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);

  for (const [low, high] of [[35, 110], [50, 150], [75, 200], [100, 240]]) {
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
      const rectAspect = rw > rh ? rw / rh : rh / rw;
      if (rectAspect >= 1.18 && rectAspect <= 1.95) {
        const rectScore = (areaRatio * 4.5) - Math.abs(rectAspect - 1.586) - 0.15;
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
          const score = (areaRatio * 5) - Math.abs(aspectRatio - 1.586);
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
  const pushLum = (x, y) => {
    const idx = (y * scanW + x) * 4;
    border.push(0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]);
  };
  for (let x = 0; x < scanW; x += 8) {
    pushLum(x, 2);
    pushLum(x, scanH - 3);
  }
  for (let y = 0; y < scanH; y += 8) {
    pushLum(2, y);
    pushLum(scanW - 3, y);
  }
  const bgL = border.reduce((sum, v) => sum + v, 0) / Math.max(1, border.length);

  let minX = scanW, minY = scanH, maxX = 0, maxY = 0, hits = 0;
  for (let y = Math.round(scanH * 0.08); y < Math.round(scanH * 0.92); y += 2) {
    for (let x = Math.round(scanW * 0.02); x < Math.round(scanW * 0.98); x += 2) {
      const idx = (y * scanW + x) * 4;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      const isInk = lum < bgL - 42;
      const isTintedCard = sat > 10 && Math.abs(lum - bgL) > 8;
      const isCardShadow = lum < bgL - 18 && x > scanW * 0.04 && x < scanW * 0.96;
      if (isInk || isTintedCard || isCardShadow) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        hits++;
      }
    }
  }

  if (hits < 80 || maxX <= minX || maxY <= minY) return null;

  const padX = Math.round((maxX - minX) * 0.05);
  const padY = Math.round((maxY - minY) * 0.10);
  minX = Math.max(0, minX - padX);
  maxX = Math.min(scanW - 1, maxX + padX);
  minY = Math.max(0, minY - padY);
  maxY = Math.min(scanH - 1, maxY + padY);

  const w = maxX - minX;
  const h = maxY - minY;
  const ratio = w / h;
  if (ratio < 1.25 || ratio > 2.05) return null;
  if ((w * h) / (scanW * scanH) < 0.08) return null;

  const sx = sourceW / scanW;
  const sy = sourceH / scanH;
  return [
    { x: minX * sx, y: minY * sy },
    { x: maxX * sx, y: minY * sy },
    { x: maxX * sx, y: maxY * sy },
    { x: minX * sx, y: maxY * sy }
  ];
}

function detectCardBoundary(img) {
  return detectCardBoundaryWithOpenCv(img) || detectCardByCanvasScan(img);
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
  const areaRatio = polygonArea(ordered) / ((img.naturalWidth || img.width) * (img.naturalHeight || img.height));
  const ratioScore = Math.max(0, 1 - Math.abs(ratio - 1.586) / 0.55);
  const areaScore = areaRatio >= 0.12 && areaRatio <= 0.92 ? Math.min(1, areaRatio / 0.35) : 0;
  const confidence = Math.max(0, Math.min(1, ratioScore * 0.6 + areaScore * 0.4));
  const label = confidence >= 0.72 ? 'high' : confidence >= 0.46 ? 'medium' : 'low';
  return { confidence, label, ratio, areaRatio };
}

function estimateCenteredCardCorners(img) {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) return null;

  const targetRatio = 1.586;
  let cardW = w * 0.84;
  let cardH = cardW / targetRatio;
  if (cardH > h * 0.62) {
    cardH = h * 0.62;
    cardW = cardH * targetRatio;
  }

  const x = (w - cardW) / 2;
  const y = (h - cardH) / 2;
  return [
    { x, y },
    { x: x + cardW, y },
    { x: x + cardW, y: y + cardH },
    { x, y: y + cardH }
  ];
}

function chooseAutomaticCorners(img) {
  const detected = detectCardBoundary(img);
  const detectedScore = scoreCardDetection(detected, img);
  if (detected && detectedScore.confidence >= 0.35) {
    return { corners: detected, score: detectedScore, source: 'detected' };
  }

  const centered = estimateCenteredCardCorners(img);
  const centeredScore = scoreCardDetection(centered, img);
  if (centered && centeredScore.confidence >= 0.35) {
    return { corners: centered, score: centeredScore, source: 'center-estimate' };
  }

  return { corners: detected || centered, score: detectedScore, source: 'none' };
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
    const result = chooseAutomaticCorners(img);
    if (result.corners && result.score.confidence >= 0.35) {
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
function preprocessROI(croppedCanvas, scaleFactor = 2.5, fieldName = '') {
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
  const lum = new Float32Array(dstW * dstH);
  let sum = 0;

  for (let i = 0, p = 0; i < px.length; i += 4, p++) {
    const v = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    lum[p] = v;
    sum += v;
  }

  const mean = sum / Math.max(1, lum.length);
  const isMrz = fieldName && fieldName.startsWith('mrz_line');
  const threshold = isMrz ? Math.min(188, mean * 0.92) : Math.min(178, mean * 0.86);

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

      if (isMrz) {
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
  // Scale coordinates (500, 30) from 1000x630 virtual grid to actual canvas dimensions
  const scaleX = canvas.width / 1000;
  const scaleY = canvas.height / 630;
  const px = Math.round(500 * scaleX);
  const py = Math.round(30 * scaleY);
  const pixel = ctx.getImageData(px, py, 1, 1).data;
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
 * Runs the OCR pipeline strictly on the warped 856x540 canvases
 */
async function proceedWithWarpedImages(frontCanvas, backCanvas) {
  // Step 5 - Pre-flight size validation
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
      const preprocessed = preprocessROI(cropped, 3.0, field);
      const dataUrl = preprocessed.toDataURL('image/png');

      const result = await worker.recognize(dataUrl);
      await worker.terminate();
      return { field, text: (result.data.text || '').trim() };
    });

    const frontResults = await Promise.all(frontPromises);
    frontResults.forEach(r => {
      let val = r.text;
      if (r.field === 'nin') {
        val = correctNIN(val);
      } else if (r.field === 'dob' || r.field === 'expiry') {
        val = correctDate(val);
      }
      roiFront[r.field] = val;
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

  if (backCanvas) {
    const isSyn = state.isSynthetic;
    const backRois = isSyn ? SYNTHETIC_BACK_ROIS : BACK_ROIS;

    setProgress(60, 'Reading back block and MRZ…', 'Running Tesseract workers');

    const croppedAddr = cropROI(backCanvas, backRois.address_block, 'address_block');
    const preprocessedAddr = preprocessROI(croppedAddr, 2.0, 'address_block');
    const dataUrlAddr = preprocessedAddr.toDataURL('image/png');

    const croppedMrz1 = cropROI(backCanvas, backRois.mrz_line1, 'mrz_line1');
    const preprocessedMrz1 = preprocessROI(croppedMrz1, 3.0, 'mrz_line1');
    const dataUrlMrz1 = preprocessedMrz1.toDataURL('image/png');

    const croppedMrz2 = cropROI(backCanvas, backRois.mrz_line2, 'mrz_line2');
    const preprocessedMrz2 = preprocessROI(croppedMrz2, 3.0, 'mrz_line2');
    const dataUrlMrz2 = preprocessedMrz2.toDataURL('image/png');

    const croppedMrz3 = cropROI(backCanvas, backRois.mrz_line3, 'mrz_line3');
    const preprocessedMrz3 = preprocessROI(croppedMrz3, 3.0, 'mrz_line3');
    const dataUrlMrz3 = preprocessedMrz3.toDataURL('image/png');

    const results = await Promise.all([
      // Address block
      (async () => {
        const settings = FIELD_OCR_SETTINGS.address_block;
        const worker = await Tesseract.createWorker('eng', 1, getTesseractOptions());
        await worker.setParameters({
          preserve_interword_spaces: '1',
          user_defined_dpi: '300',
          tessedit_char_whitelist: settings.whitelist || '',
          tessedit_pageseg_mode: settings.psm
        });
        const res = await worker.recognize(dataUrlAddr);
        await worker.terminate();
        return (res.data.text || '').trim();
      })(),
      // MRZ Line 1
      (async () => {
        const settings = FIELD_OCR_SETTINGS.mrz_line1;
        const worker = await Tesseract.createWorker('eng', 1, getTesseractOptions());
        await worker.setParameters({
          preserve_interword_spaces: '1',
          user_defined_dpi: '300',
          tessedit_char_whitelist: settings.whitelist || '',
          tessedit_pageseg_mode: settings.psm
        });
        const res = await worker.recognize(dataUrlMrz1);
        await worker.terminate();
        return (res.data.text || '').trim();
      })(),
      // MRZ Line 2
      (async () => {
        const settings = FIELD_OCR_SETTINGS.mrz_line2;
        const worker = await Tesseract.createWorker('eng', 1, getTesseractOptions());
        await worker.setParameters({
          preserve_interword_spaces: '1',
          user_defined_dpi: '300',
          tessedit_char_whitelist: settings.whitelist || '',
          tessedit_pageseg_mode: settings.psm
        });
        const res = await worker.recognize(dataUrlMrz2);
        await worker.terminate();
        return (res.data.text || '').trim();
      })(),
      // MRZ Line 3
      (async () => {
        const settings = FIELD_OCR_SETTINGS.mrz_line3;
        const worker = await Tesseract.createWorker('eng', 1, getTesseractOptions());
        await worker.setParameters({
          preserve_interword_spaces: '1',
          user_defined_dpi: '300',
          tessedit_char_whitelist: settings.whitelist || '',
          tessedit_pageseg_mode: settings.psm
        });
        const res = await worker.recognize(dataUrlMrz3);
        await worker.terminate();
        return (res.data.text || '').trim();
      })()
    ]);

    const addrText = results[0];
    const mrzText  = [results[1], results[2], results[3]].join('\n');

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
    const elGal = document.getElementById('input-' + side + '-gallery');
    const elCam = document.getElementById('input-' + side + '-camera');
    if (elGal) elGal.value = '';
    if (elCam) elCam.value = '';
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

  const debugContainer = document.getElementById('debug-warp-container');
  if (debugContainer) debugContainer.style.display = 'none';
  const debugCanvas = document.getElementById('debugWarpCanvas');
  if (debugCanvas) {
    const ctx = debugCanvas.getContext('2d');
    ctx.clearRect(0, 0, debugCanvas.width, debugCanvas.height);
  }

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

// ─── Init ─────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Empty init
});
