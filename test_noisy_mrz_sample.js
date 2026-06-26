'use strict';

const parser = require('./nssf-id-capture/js/parser.js');

const frontText = `SURNAME: S  JU
GIVEN NAMES: UGA        M
NATIONALITY: CMUOLU
DATEOFEXF
SEX:
DOB:
NIN: 2I012029H0LDER
EXPIRY:
CARD NO:`;

const backText = `ADDRESS BLOCK:
| [I~
VILLAGE:       VILLAGE 12
PARISH:          NTINDA
scounty: NAKAWA
COUNTY:        NAKAWA DIVISION
DISTRICT:         KAMPALA

MRZ:
IPUEAD1930724662CM000351093UXF<
0009139M2901215UGA190121<<<<<7
LFOMOKI<<SAMUEL<J UNIOR<K<KLKLKLKLKLKL`;

const expected = {
  surname: 'LYOMOKI',
  given_names: 'SAMUEL JUNIOR',
  sex: 'M',
  dob: '13.09.2000',
  nin: 'CM000351093UXF',
  expiry: '21.01.2029',
  card_no: '019307246',
  nationality: 'UGA',
  village: 'VILLAGE 12',
  parish: 'NTINDA',
  sub_county: 'NAKAWA',
  county: 'NAKAWA DIVISION',
  district: 'KAMPALA',
};

const front = parser.parseFront(frontText);
const back = parser.parseBack(backText);
const merged = parser.mergeAndApplyMrzBackfill({ front, back });

console.log('FRONT:', front);
console.log('BACK:', back);
console.log('MERGED:', merged);

const rows = Object.entries(expected).map(([field, value]) => ({
  field,
  expected: value,
  got: merged[field],
  ok: merged[field] === value,
}));

console.table(rows);

const failed = rows.filter(r => !r.ok);
if (failed.length) {
  console.error(`Noisy MRZ regression failed: ${failed.length}/${rows.length} fields wrong.`);
  process.exit(1);
}

console.log(`Noisy MRZ regression passed: ${rows.length}/${rows.length} fields correct.`);
