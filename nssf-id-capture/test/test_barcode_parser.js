const fs = require('fs');
const path = require('path');

const ugIdParserJsPath = path.join(__dirname, '../js/ug-id-parser.js');
const code = fs.readFileSync(ugIdParserJsPath, 'utf8');

// Evaluate the file code
const evalFn = new Function(code);
evalFn();

const UgIdParser = global.UgIdParser || globalThis.UgIdParser;

if (!UgIdParser) {
  throw new Error('UgIdParser not found on global object after evaluation');
}

// Helper to assert conditions
function assert(condition, message) {
  if (!condition) {
    throw new Error('ASSERTION FAILED: ' + message);
  }
}

// ─── Test 1: Valid payload ─────────────────────
console.log('Running Test 1: Valid payload...');
// Surname: LYOMOKI -> TFlPTU9LSQ==
// Given: SAMUEL -> U0FNVUVM
// Other: JUNIOR -> SlVOSU9S
// DOB: 13092000 -> 13 Sep 2000
// Issued: 21012019 -> 21 Jan 2019
// Expires: 21012029 -> 21 Jan 2029
// NIN: CM000351093UXF
// Card Number: 019307246
// Minutiae: AAAAAAA= (decodes to 5 bytes, multiple of 5)
const payload1 = 'TFlPTU9LSQ==;U0FNVUVM;SlVOSU9S;13092000;21012019;21012029;CM000351093UXF;019307246;AAAAAAA=[FNG]1;12;YmFyY29kZQ==';

const record1 = UgIdParser.parseCard(payload1, { strict: true });
assert(record1.surname === 'LYOMOKI', 'Surname mismatch');
assert(record1.givenName === 'SAMUEL', 'Given name mismatch');
assert(record1.otherName === 'JUNIOR', 'Other name mismatch');
assert(record1.sex === 'Male', 'Sex mismatch');
assert(record1.dateOfBirth.getUTCDate() === 13, 'DOB Day mismatch');
assert(record1.dateOfBirth.getUTCMonth() === 8, 'DOB Month mismatch'); // Sept is 8
assert(record1.dateOfBirth.getUTCFullYear() === 2000, 'DOB Year mismatch');
assert(record1.nin === 'CM000351093UXF', 'NIN mismatch');
assert(record1.cardNumber === '019307246', 'Card number mismatch');
assert(record1.fingerprint.fingerIndex === 1, 'Finger index mismatch');
assert(record1.fingerprint.minutiaeCount === 12, 'Minutiae count mismatch');
assert(record1.fingerprint.minutiaeBytes === 5, 'Minutiae bytes mismatch');
assert(record1.fingerprint.sealedBlockBytes === 7, 'Sealed block bytes mismatch'); // atob('YmFyY29kZQ==').length = 7
assert(record1.warnings.length === 0, 'Should have no warnings, got: ' + record1.warnings.join(', '));
console.log('✔ Test 1 passed!');

// ─── Test 2: Mismatched DOB/NIN Birth Year ─────
console.log('\nRunning Test 2: DOB/NIN Birth Year Mismatch...');
// NIN: CM990351093UXF (1999) vs DOB: 2000
const payload2 = 'TFlPTU9LSQ==;U0FNVUVM;SlVOSU9S;13092000;21012019;21012029;CM990351093UXF;019307246;AAAAAAA=[FNG]1;12;YmFyY29kZQ==';
const record2 = UgIdParser.parseCard(payload2, { strict: false });
assert(record2.warnings.some(w => w.includes('birth year')), 'Should warn about birth year mismatch');
console.log('✔ Test 2 passed!');

// ─── Test 3: Bad NIN Format ───────────────────
console.log('\nRunning Test 3: Bad NIN Format...');
const payload3 = 'TFlPTU9LSQ==;U0FNVUVM;SlVOSU9S;13092000;21012019;21012029;CM00000000;019307246;AAAAAAA=[FNG]1;12;YmFyY29kZQ==';
const record3 = UgIdParser.parseCard(payload3, { strict: false });
assert(record3.warnings.some(w => w.includes('layout')), 'Should warn about NIN layout');
console.log('✔ Test 3 passed!');

// ─── Test 4: Expired Card ─────────────────────
console.log('\nRunning Test 4: Expired Card...');
// Expires in 2020 (expired)
const payload4 = 'TFlPTU9LSQ==;U0FNVUVM;SlVOSU9S;13092000;21012015;21012020;CM000351093UXF;019307246;AAAAAAA=[FNG]1;12;YmFyY29kZQ==';
const record4 = UgIdParser.parseCard(payload4, { strict: false });
assert(record4.warnings.some(w => w.includes('expired')), 'Should warn about expired card');
console.log('✔ Test 4 passed!');

// ─── Test 5: Bad Minutiae Length ──────────────
console.log('\nRunning Test 5: Non-multiple-of-5 minutiae block...');
// Minutiae: AAAAAA== (decodes to 4 bytes, not multiple of 5)
const payload5 = 'TFlPTU9LSQ==;U0FNVUVM;SlVOSU9S;13092000;21012019;21012029;CM000351093UXF;019307246;AAAAAA==[FNG]1;12;YmFyY29kZQ==';
const record5 = UgIdParser.parseCard(payload5, { strict: false });
assert(record5.warnings.some(w => w.includes('multiple of the record width')), 'Should warn about minutiae block length');
console.log('✔ Test 5 passed!');

console.log('\nALL TESTS PASSED SUCCESSFULLY!');
delete globalThis.UgIdParser;
delete global.UgIdParser;
