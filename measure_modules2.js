const fs = require("fs");
// The last verification run measured:
// Bounding Box: [0, 694, 576, 1024]
// Symbol width excluding quiet zones: 575px  <-- from log "Isolated Symbol Width: 575 px"
// (The test harness computes this as raw_width - 2*QUIET_ZONE_PX, but the log says 575, 
//  meaning cols[last]-cols[0] = 575 directly from the ink projection, 
//  bbox right edge = cols[last]+QUIET_ZONE_PX = 576 => cols[last] = 556; bbox[0]=0 => cols[0]=20
//  so symbol width = 556-20 = 536? OR the test harness computes differently...
//  Let us recheck: the test harness line 137 says: const ppm = symbol_width / 204
//  and reported PPM = 2.819, so symbol_width = 2.819 * 204 = 575.1 => ~575px
// So the harness is using 575 px, not 536. The test harness must NOT subtract 2*QUIET_ZONE.
// symbol_width = cols[last] - cols[0] (before adding quiet zone margins to the bbox)
// That means the actual ink extent is 575px wide.

const symbol_width_px = 575;  // from the verified run: ppm = 2.819 * 204
console.log("Confirmed symbol width from last run: " + symbol_width_px + " px");
console.log("(Source: PPM=2.819 * 204 modules = " + (2.819*204).toFixed(1) + " px)");
console.log("\nPDF417 total module count formula: 17*data_cols + 69");
console.log("(= start[17] + leftRI[17] + data_cols*17 + rightRI[17] + stop[18])");
console.log("\nModule count reconciliation table (at 575px symbol width):");
for (const cols of [5, 6, 7, 8, 9, 10, 11, 12]) {
  const total = 17 * cols + 69;
  const ppm = symbol_width_px / total;
  const narrowRunEstimate = (symbol_width_px / total).toFixed(2);
  console.log(`  ${cols} data cols => ${total} modules => PPM = ${ppm.toFixed(3)} px/module  (narrow module = ~${narrowRunEstimate} px)`);
}

console.log("\n204-module assumption implies: data_cols = (204-69)/17 = " + ((204-69)/17).toFixed(2));
console.log("=> 7.94 columns => rounds to 8 data columns => 8 data cols => 205 total modules");
console.log("=> PPM at 575px = " + (575/205).toFixed(3));
console.log("=> PPM at 575px using 204 (as hardcoded in harness) = " + (575/204).toFixed(3));
console.log("\n--- The 456-module figure in the previous proposal was WRONG ---");
console.log("456 modules would require (456-69)/17 = " + ((456-69)/17).toFixed(1) + " data columns");
console.log("Max PDF417 data columns = 30 (ISO/IEC 15438), so 456 is impossible.\n");

console.log("--- Resolution cap analysis ---");
// Test image is 576x1024. Chat platform downscaled from original.
// In production, a phone captures at native res. Common budget Android: 1600x1200 to 3264x2448.
// If the card fills the frame in portrait, barcode width ˜ card_width_px ˜ image_width
// Cap at 1600px long edge.
const longEdgeCap = 1600;
// If captured portrait 3264x2448 => scale to long edge 2448->1600 => factor = 1600/2448 = 0.653
// image width at cap = 3264 * 0.653 = 2131 px -- card fills frame => barcode_px ˜ 2131 * 0.85 = 1811
// If captured portrait 1920x1080 => long edge=1920, scale to 1600 => factor=0.833 => width=900
//   card fills frame in landscape => barcode width ˜ 900 * 0.45 (half card) = 405 px  <- landscape!
// Portrait is better for this card.

// Conservative case: portrait, card fills ~85% of width, 1600px wide
const portraitBarcodePx = Math.round(1600 * 0.85);
console.log("Portrait capture at 1600px long edge, barcode fills ~85% of width:");
for (const cols of [7, 8, 9]) {
  const total = 17 * cols + 69;
  const ppm = portraitBarcodePx / total;
  console.log(`  ${cols} data cols => ${total} modules => PPM = ${ppm.toFixed(3)}`);
}
console.log("\nVery conservative: barcode fills only 60% of width:");
const conservativeBarcodePx = Math.round(1600 * 0.60);
for (const cols of [7, 8, 9]) {
  const total = 17 * cols + 69;
  const ppm = conservativeBarcodePx / total;
  console.log(`  ${cols} data cols => ${total} modules => PPM = ${ppm.toFixed(3)}`);
}
