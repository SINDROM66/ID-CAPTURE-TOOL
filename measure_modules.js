const fs = require("fs");
const path = require("path");

// Read the image as raw JPEG bytes and parse JFIF dimensions
const imgPath = path.resolve("nssf-id-capture/test/test_back.jpg");
const buf = fs.readFileSync(imgPath);

// Find SOF marker to get width/height
let w = 0, h = 0;
for (let i = 0; i < buf.length - 8; i++) {
  if (buf[i] === 0xFF && (buf[i+1] === 0xC0 || buf[i+1] === 0xC2)) {
    h = (buf[i+5] << 8) | buf[i+6];
    w = (buf[i+7] << 8) | buf[i+8];
    break;
  }
}
console.log(`Image dimensions from JPEG header: ${w} x ${h}`);
console.log(`File size: ${(buf.length/1024).toFixed(1)} KB`);

// Known measurement from last test run:
// Detected Bounding Box: [0, 694, 576, 1024]
// Symbol Width (excl. quiet zones): 575 px  (576-0 minus QUIET_ZONE_PX=20 margins would be approx this)
// Let's recompute:
const bbox_left = 0, bbox_top = 694, bbox_right = 576, bbox_bottom = 1024;
const QUIET_ZONE_PX = 20;
const rawBboxWidth = bbox_right - bbox_left;  // 576px
// findSymbolBbox adds QUIET_ZONE_PX on each side of the true symbol edge
// so true symbol edges = cols[0] to cols[last], reported bbox = cols[0]-20 to cols[last]+20
// the reported "symbol width" = cols[last] - cols[0] = bbox_width - 2*QUIET_ZONE_PX
const symbolWidthPx = rawBboxWidth - 2 * QUIET_ZONE_PX;
console.log(`\nMeasured symbol width from last run bbox: ${symbolWidthPx} px`);
console.log(`This is the whole card width (barcode ran full-width in portrait orientation).`);

// The PDF417 formula: total_modules = 17*(data_cols + 3) + 18 = 17*data_cols + 69
// For various data_col counts:
console.log("\nPDF417 total module width by data column count:");
for (const cols of [3, 5, 7, 8, 9, 10, 11, 12]) {
  const total = 17 * cols + 69;  // start(17) + leftRI(17) + cols*17 + rightRI(17) + stop(18)
  console.log(`  ${cols} data cols => ${total} total modules => PPM = ${(symbolWidthPx/total).toFixed(3)} at ${symbolWidthPx}px`);
}

console.log("\n--- Now for a 1600px long-edge cap scenario ---");
// Test image: 576x1024. If original was ~900x1600 (before chat resizing), 
// and we cap at 1600px long edge, we'd have 900x1600.
// Barcode in portrait covers full width, so barcode_px ˜ 900px minus margins
const scaleFactor = 1600 / 1024;
const symbolWidthAt1600 = symbolWidthPx * scaleFactor;
console.log(`At 1600px cap (scale factor x${scaleFactor.toFixed(2)}):`);
for (const cols of [7, 8, 9, 10, 11, 12]) {
  const total = 17 * cols + 69;
  console.log(`  ${cols} data cols => ${total} modules => PPM = ${(symbolWidthAt1600/total).toFixed(3)}`);
}
