const fs = require('fs');
const path = require('path');

// Read the js/app.js file using absolute path
const appJsPath = 'c:/Users/BEST/Downloads/Firebase/nssf-offline/nssf-id-capture/js/app.js';
let code = fs.readFileSync(appJsPath, 'utf8');

// Mock browser objects to prevent errors during evaluation
const mockCode = `
const document = {
  getElementById: () => ({ style: {}, value: '' }),
  querySelectorAll: () => [],
  addEventListener: () => {}
};
const window = {};
const Tesseract = {};
const TesseractCore = {};
const Image = function() {};
const FileReader = function() {};
`;

// Evaluate the file code
const context = {};
const evalFn = new Function('exports', mockCode + code + `
  return {
    parseFront,
    parseBack,
    mergeAndApplyMrzBackfill
  };
`);

const { parseFront, parseBack, mergeAndApplyMrzBackfill } = evalFn(context);

// Specimen ID front raw OCR text
const rawFront = `
REPUBLIC OF UGANDA
NATIONAL ID CARD
SPECIMEN
a2
BATH MAME
MARTIN
ATIONALITY
ATE Gr in
UTOPIAN    IY
CARD
20.09 1964
BATE Ow Lamery
1234567891234
0123456789
bY
01.04.2015
OER WONA Tee
A
Martin  Specimen
`;

const rawBack = ``;

console.log("--- PARSING FRONT ---");
const frontData = parseFront(rawFront);
console.log(JSON.stringify(frontData, null, 2));

console.log("--- PARSING BACK ---");
const backData = parseBack(rawBack);
console.log(JSON.stringify(backData, null, 2));

console.log("--- MERGED RESULT ---");
const merged = mergeAndApplyMrzBackfill({ front: frontData, back: backData });
console.log(JSON.stringify(merged, null, 2));
