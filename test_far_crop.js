'use strict';

const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const cvModule = require('./nssf-id-capture/js/opencv.js');

const ROOT = __dirname;
const OUTPUT = path.join(ROOT, 'scratch', 'far_crop_debug');
const CASES = [
  ['old-front-far', 'ocr_training_data/augmented_ids/123.jpg'],
  ['old-back-far', 'ocr_training_data/augmented_ids/124.jpg'],
  ['new-front-far', 'ocr_training_data/NEW ID design/New ID 331.jpg'],
  ['new-back-far', 'ocr_training_data/NEW ID design/New ID 332.jpg']
];

function rotatedRectToPoints(rect) {
  const angle = rect.angle * Math.PI / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const hw = rect.size.width / 2;
  const hh = rect.size.height / 2;
  return [
    { x: -hw, y: -hh }, { x: hw, y: -hh },
    { x: hw, y: hh }, { x: -hw, y: hh }
  ].map(p => ({
    x: rect.center.x + p.x * cos - p.y * sin,
    y: rect.center.y + p.x * sin + p.y * cos
  }));
}

function orderCorners(points) {
  const byY = [...points].sort((a, b) => a.y - b.y);
  const top = byY.slice(0, 2).sort((a, b) => a.x - b.x);
  const bottom = byY.slice(2).sort((a, b) => a.x - b.x);
  return [top[0], top[1], bottom[1], bottom[0]];
}

function detect(cv, src) {
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edged = new cv.Mat();
  const morph = new cv.Mat();
  let contours = new cv.MatVector();
  let hierarchy = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
  let bestPoints = null;
  let bestScore = -Infinity;
  const diagnostics = [];
  const imageArea = src.cols * src.rows;

  const inspectMask = mask => {
    contours.delete(); hierarchy.delete();
    contours = new cv.MatVector(); hierarchy = new cv.Mat();
    cv.findContours(mask, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const area = cv.contourArea(contour);
      const areaRatio = area / imageArea;
      if (areaRatio < 0.035 || areaRatio > 0.82) { contour.delete(); continue; }
      const rect = cv.minAreaRect(contour);
      const rw = rect.size.width;
      const rh = rect.size.height;
      const aspect = Math.max(rw, rh) / Math.max(1, Math.min(rw, rh));
      const rectangularity = Math.min(1, area / Math.max(1, rw * rh));
      if (aspect >= 1.05 && aspect <= 2.2) diagnostics.push({ areaRatio, aspect, rectangularity });
      if (aspect >= 1.18 && aspect <= 1.95 && rectangularity >= 0.52) {
        const ratioScore = 1 - Math.min(1, Math.abs(aspect - 1.586) / 0.45);
        const areaScore = Math.min(1, areaRatio / 0.22);
        const score = ratioScore * 3 + rectangularity * 2 + areaScore;
        if (score > bestScore) { bestScore = score; bestPoints = rotatedRectToPoints(rect); }
      }
      contour.delete();
    }
  };

  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);

  for (const [low, high] of [[35, 110], [90, 220]]) {
    contours.delete(); hierarchy.delete();
    contours = new cv.MatVector(); hierarchy = new cv.Mat();
    cv.Canny(blurred, edged, low, high, 3, false);
    cv.morphologyEx(edged, morph, cv.MORPH_CLOSE, kernel);
    inspectMask(morph);
  }

  const rgb = new cv.Mat();
  const hsv = new cv.Mat();
  const channels = new cv.MatVector();
  const colorMask = new cv.Mat();
  const colorKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(13, 13));
  cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
  cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
  cv.split(hsv, channels);
  const saturation = channels.get(1);
  for (const threshold of [9, 16, 24, 36]) {
    cv.threshold(saturation, colorMask, threshold, 255, cv.THRESH_BINARY);
    cv.morphologyEx(colorMask, colorMask, cv.MORPH_CLOSE, colorKernel);
    inspectMask(colorMask);
  }
  rgb.delete(); hsv.delete(); saturation.delete(); channels.delete(); colorMask.delete(); colorKernel.delete();

  gray.delete(); blurred.delete(); edged.delete(); morph.delete();
  contours.delete(); hierarchy.delete(); kernel.delete();
  diagnostics.sort((a, b) => b.areaRatio - a.areaRatio);
  return { points: bestPoints, score: bestScore, diagnostics: diagnostics.slice(0, 5) };
}

function warp(cv, src, points) {
  const p = orderCorners(points);
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, p.flatMap(v => [v.x, v.y]));
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, 856, 0, 856, 540, 0, 540]);
  const matrix = cv.getPerspectiveTransform(from, to);
  const dst = new cv.Mat();
  cv.warpPerspective(src, dst, matrix, new cv.Size(856, 540), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());
  from.delete(); to.delete(); matrix.delete();
  return dst;
}

async function main() {
  const cv = cvModule;
  const started = Date.now();
  while (typeof cv.Mat !== 'function') {
    if (Date.now() - started > 30000) throw new Error('OpenCV.js initialization timed out');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  fs.mkdirSync(OUTPUT, { recursive: true });
  let passed = 0;
  for (const [name, relative] of CASES) {
    const image = await Jimp.read(path.join(ROOT, relative));
    if (Math.max(image.bitmap.width, image.bitmap.height) > 500) {
      image.scale(500 / Math.max(image.bitmap.width, image.bitmap.height));
    }
    const rgba = new Uint8ClampedArray(image.bitmap.data);
    const src = cv.matFromImageData({ data: rgba, width: image.bitmap.width, height: image.bitmap.height });
    const result = detect(cv, src);
    if (!result.points) {
      console.log(`${name}: FAIL - no credible card quadrilateral candidates=${JSON.stringify(result.diagnostics)}`);
      src.delete();
      continue;
    }
    const dst = warp(cv, src, result.points);
    const output = new Jimp({ width: dst.cols, height: dst.rows, data: Buffer.from(dst.data) });
    await output.writeAsync(path.join(OUTPUT, `${name}.png`));
    console.log(`${name}: PASS score=${result.score.toFixed(3)} corners=${JSON.stringify(orderCorners(result.points).map(p => [Math.round(p.x), Math.round(p.y)]))}`);
    passed++;
    dst.delete(); src.delete();
  }
  console.log(`Far crop detection: ${passed}/${CASES.length}`);
  console.log(`Debug crops: ${OUTPUT}`);
  if (passed !== CASES.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
