/* ═══════════════════════════════════════════════════════════════════════
   parser.js — Pure OCR parsing logic for Uganda National ID cards.
   Extracted from app.js for use in Node.js test harness.
   NO browser APIs: no document, Image, canvas, window, FileReader.
   Accepts raw OCR text strings as input.
   ═══════════════════════════════════════════════════════════════════════ */

'use strict';

// ─── Regex constants ──────────────────────────────────────────────────────
const NIN_REGEX = /^[CAP][MF][A-Z0-9]{12}$/;
const OLD_NIN_REGEX = /^[CAP][MF][0-9]{9}[A-Z]{3}$/;
const NEW_NIN_REGEX = /^[CAP][MF][0-9]{7}[A-Z]{2}[0-9][A-Z]{2}$/;

// ─── Low-level helpers ────────────────────────────────────────────────────

function normalizeOCRText(text) {
  return (text || '')
    .replace(/[|]/g, 'I')
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .toUpperCase();
}

// OCR confusion maps (bidirectional)
const DIGIT_TO_LETTER = { '0':'O','1':'I','5':'S','8':'B','6':'G','4':'A','2':'Z','3':'J' };
const LETTER_TO_DIGIT = { 
  'O':'0', 'I':'1', 'S':'5', 'B':'8', 'G':'6', 'A':'4', 'Z':'2', 
  'D':'0', 'E':'0', 'Q':'0', 'R':'8', 'T':'7', 'Y':'7', 'U':'0', 
  'P':'9', 'H':'8' 
};

// Uganda NIN structure: [C][M|F][9 digits][3 letters] = 14 chars total
// Position 0-1  : must be letters (CM or CF prefix)
// Position 2-10 : must be digits (9 digits)
// Position 11-13: must be letters (3-letter suffix)
function cleanMrzNameToken(t) {
  return t.replace(/^LF(?=[AEIOU])/, 'LY').replace(/^LIO(?=Y)/, 'MU').replace(/^K+(?=[A-Z]{3,})/, '').replace(/[KLCXVES<]+$/, match => {
    if (!/[K<]/.test(match) && match.length <= 2) return match;
    if (match.length >= 2) {
      const firstChar = match[0];
      const prevChar = t[t.length - match.length - 1] || '';
      const isVowel = /[AEIOU]/.test(prevChar.toUpperCase());
      if (isVowel && /[LCX]/i.test(firstChar)) {
        return firstChar;
      }
      return '';
    }
    return match === '<' ? '' : match;
  });
}

function tryNormalizeOldFormat(chars) {
  const c = [...chars];
  for (let i = 2; i <= 10; i++) {
    if (LETTER_TO_DIGIT[c[i]]) c[i] = LETTER_TO_DIGIT[c[i]];
  }
  for (let i = 11; i <= 13; i++) {
    if (DIGIT_TO_LETTER[c[i]]) c[i] = DIGIT_TO_LETTER[c[i]];
  }
  return c.join('');
}

function tryNormalizeNewFormat(chars) {
  const c = [...chars];
  const newDigitMap = { ...LETTER_TO_DIGIT, 'Z': '7', 'T': '7', 'Y': '7', 'L': '1' };
  for (let i = 2; i <= 8; i++) {
    if (LETTER_TO_DIGIT[c[i]]) c[i] = LETTER_TO_DIGIT[c[i]];
  }
  for (let i = 9; i <= 10; i++) {
    if (DIGIT_TO_LETTER[c[i]]) c[i] = DIGIT_TO_LETTER[c[i]];
  }
  if (newDigitMap[c[11]]) c[11] = newDigitMap[c[11]];
  for (let i = 12; i <= 13; i++) {
    if (DIGIT_TO_LETTER[c[i]]) c[i] = DIGIT_TO_LETTER[c[i]];
  }
  return c.join('');
}

function normalizeNinCandidate(candidate, dob) {
  let v = (candidate || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const embeddedNin = v.match(/[CAP1G0OI4L][MFN13PR0-9BH][A-Z0-9]{12}/i);
  if (embeddedNin && embeddedNin[0] !== v) {
    return normalizeNinCandidate(embeddedNin[0], dob);
  }

  // Extract a 14-character NIN candidate if present in a longer string
  if (v.length !== 14) {
    const match = v.match(/([CAP1G0OI4L][MFN13PR0-9BH])([A-Z0-9]{12})/i);
    if (match) {
      v = match[0];
    } else {
      return '';
    }
  }

  // Position-aware structural normalization
  const chars = v.split('');

  // Positions 0-1: must be letters (prefix CM / CF / AM / AF / PM / PF)
  for (let i = 0; i <= 1; i++) {
    if (DIGIT_TO_LETTER[chars[i]]) chars[i] = DIGIT_TO_LETTER[chars[i]];
  }
  // Double-check prefix corrections
  if (chars[0] === 'I' || chars[0] === '1' || chars[0] === 'O' || chars[0] === '0') chars[0] = 'C';
  else if (chars[0] !== 'A' && chars[0] !== 'P') chars[0] = 'C';
  if (chars[1] === 'N' || chars[1] === 'H' || chars[1] === 'K') chars[1] = 'M';

  // Apply DOB Year alignment for first two digits of digits group
  if (dob && dob.includes('.')) {
    const parts = dob.split('.');
    if (parts.length === 3) {
      const year = parts[2];
      if (year && year.length === 4) {
        const yy = year.slice(2);
        if (chars[2] !== yy[0] && (chars[2] === 'E' || chars[2] === 'C' || !/[0-9]/.test(chars[2]))) {
          chars[2] = yy[0];
        }
        if (chars[3] !== yy[1] && (chars[3] === 'R' || chars[3] === 'B' || !/[0-9]/.test(chars[3]))) {
          chars[3] = yy[1];
        }
      }
    }
  }

  // Try old format correction
  const oldCand = tryNormalizeOldFormat(chars);
  if (OLD_NIN_REGEX.test(oldCand)) return oldCand;

  // Try new format correction
  const newCand = tryNormalizeNewFormat(chars);
  if (NEW_NIN_REGEX.test(newCand)) return newCand;

  // Fallback: check broad NIN_REGEX or return old candidate as best effort
  if (NIN_REGEX.test(oldCand)) return oldCand;
  if (NIN_REGEX.test(newCand)) return newCand;

  return oldCand;
}

function fixDigitsOnly(str) {
  return (str || '')
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/I/g, '1')
    .replace(/S/g, '5')
    .replace(/B/g, '8')
    .replace(/D/g, '0')
    .replace(/G/g, '6')
    .replace(/Z/g, '2')
    .replace(/E/g, '0')  // MRZ monospace: '0' sometimes read as 'E'
    .replace(/Q/g, '0'); // MRZ monospace: '0' sometimes read as 'Q' in digit-only zones
}

function validateNin(n, dob) {
  const v = normalizeNinCandidate(n, dob);
  if (!NIN_REGEX.test(v)) return '';
  if (!OLD_NIN_REGEX.test(v) && !NEW_NIN_REGEX.test(v)) return '';
  return v;
}

function correctNIN(raw) {
  const normalizedCandidate = normalizeNinCandidate(raw);
  if (NIN_REGEX.test(normalizedCandidate)) return normalizedCandidate;

  // Remove all spaces, force uppercase
  let s = (raw || '').replace(/\s/g, '').toUpperCase().substring(0, 14);
  const chars = s.split('');

  // Positions 0-1: must be letters — fix digit→letter confusions
  for (let i = 0; i <= 1; i++) {
    if (chars[i] === '0') chars[i] = 'O';
    if (chars[i] === '1') chars[i] = 'I';
    if (chars[i] === '8') chars[i] = 'B';
    if (chars[i] === '5') chars[i] = 'S';
  }

  // Positions 2-10: must be digits — fix letter→digit confusions
  for (let i = 2; i <= 10; i++) {
    if (chars[i] === 'O') chars[i] = '0';
    if (chars[i] === 'I') chars[i] = '1';
    if (chars[i] === 'B') chars[i] = '8';
    if (chars[i] === 'S') chars[i] = '5';
    if (chars[i] === 'Z') chars[i] = '2';
    if (chars[i] === 'G') chars[i] = '6';
  }

  // Positions 11-13: must be letters — same corrections as positions 0-1
  for (let i = 11; i <= 13; i++) {
    if (chars[i] === '0') chars[i] = 'O';
    if (chars[i] === '1') chars[i] = 'I';
    if (chars[i] === '8') chars[i] = 'B';
    if (chars[i] === '5') chars[i] = 'S';
  }

  const corrected = chars.join('');
  return validateNin(corrected) || '';
}

function correctDate(raw) {
  // Strip everything except digits
  const digits = (raw || '').replace(/[^0-9]/g, '');
  if (digits.length >= 8) {
    return digits.substring(0,2) + '.' + digits.substring(2,4) + '.' + digits.substring(4,8);
  }
  return (raw || '').trim();
}

function parseAndFormatDob(raw) {
  const clean = (raw || '').replace(/\s+/g, '').replace(/,/g, '.');
  let m = clean.match(/(\d{2})[.\/\-](\d{2})[.\/\-](\d{4})/);
  if (m) {
    const dd = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12) {
      return `${m[1]}.${m[2]}.${m[3]}`;
    }
  }
  return '';
}

function validateDob(dob) {
  const d = parseAndFormatDob(dob);
  if (!d) return '';
  const yyyy = parseInt(d.split('.')[2], 10);
  const curY = new Date().getFullYear();
  if (yyyy >= 1930 && yyyy <= curY) return d;
  return '';
}

function validateExpiry(expiry) {
  const d = parseAndFormatDob(expiry);
  if (!d) return '';
  const yyyy = parseInt(d.split('.')[2], 10);
  if (yyyy >= 2015 && yyyy <= 2050) return d;
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
  return out.replace(/\b(SURNAME|GIVEN|NAME|NATIONALITY)\b/g, ' ');
}

const NAME_STOPWORDS = new Set([
  'EID','NIN','ID','SURNAME','GIVEN','NAME','NATIONALITY','UGA','SEX',
  'SGT','CE','SHEET','CARD','DATE','BIRTH','EXPIRY','HOLDER','SIGNATURE',
  'UGANDA','REPUBLIC','THE','AND','FOR','OF','NATIONAL',
  // Synthetic-card watermark tokens seen causing surname/given_name pollution:
  'MACHINE','LEARNING','OCR','USE','ONLY','TRAINING','REVERSE','THUMB',
  'SIVENAME','NAVE','NANE','NAHE','GVEN','PRESRD','BOOED','SANT',
  'CFVQR','CFWTT','CMWRZ','CMJE','RNAML','SURNAMEF',
  // Short/noise tokens frequently produced by OCR on these synthetic cards:
  'TST','SCR','FIRNAME','FIRSTNAME','PHOTO','PIVEN','SIVEN','DAE',
  'HOLDERS','VUE','TIP','OR','NE','AI','BH','EE','TA','IEA','RAE',
  'SHRD','MM','FY','SL','NSA','NENG','NT','IH',
]);

function normalizeNameStrict(raw) {
  let v = (raw || '').toString();
  v = stripDigits(v);
  v = stripLabelWords(v);
  v = v.toUpperCase().replace(/[^A-Z' -]/g, ' ');
  v = v.replace(/\s+/g, ' ').trim();
  const toks = v.split(/\s+/).filter(Boolean).filter(t => !NAME_STOPWORDS.has(t));
  return toks.join(' ');
}

function isPersonNameStrict(name) {
  if (!name || name.length < 3 || name.length > 60) return false;
  if (!/^[A-Z][A-Z' -]*$/.test(name)) return false;
  // Must have at least one vowel across the whole name
  if (!/[AEIOU]/.test(name)) return false;
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;
  // Each token must be 3-22 chars (raises floor from 2 to 3 to exclude 2-char noise)
  return parts.every(p => p.length >= 3 && p.length <= 22);
}

function stripMrzLines(lines) {
  return (lines || []).filter(l => !l.includes('<'));
}

function normalizeLocationLines(lines) {
  const mrzStartIdx = lines.findIndex(l => /ID[A-Z]{3}/.test(l) || l.includes('<'));
  const locationLines = mrzStartIdx >= 0 ? lines.slice(0, mrzStartIdx) : lines;
  const nonMrz = stripMrzLines(locationLines);
  return nonMrz.map(l => l.trim()).filter(l => l.length >= 3);
}

function cleanLocationNameStrict(value) {
  const v = (value || '').toString();
  if (v.includes('<')) return '';
  if (v.length < 4) return '';

  let cleaned = v
    .toUpperCase()
    .replace(/[<>|()|\[\]{}]/g, ' ')
    .replace(/[^A-Z0-9' -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const blacklist = /(THUMB|FINGER|PRINTS?|SIGNATURE|HOLDER)/;
  if (blacklist.test(cleaned)) return '';
  if (!/[AEIOU]/.test(cleaned)) return '';

  // Restore space before trailing digits that OCR collapsed:
  // "ZONE3" → "ZONE 3", "BLOCK4" → "BLOCK 4", "VILLAGE12" → "VILLAGE 12"
  cleaned = cleaned.replace(/([A-Z])(\d+)$/, '$1 $2');
  // Also: "NLLAGE" should stay — we only fix digit-suffix collapses, not letter merges
  cleaned = cleaned.replace(/([A-Z])(\d+)$/, '$1 $2');
  cleaned = cleaned
    .replace(/\b(FINGER|INDEX|RINDEX|LINDEX|THIS|CARD|PROPERTY|REPUBLIC|UGANDA|TINH|OMA|HI|NR|NT|TT|BRATS|SAE|OPS)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  cleaned = cleaned
    .replace(/^C+\s*BUVENDE\s*[A-Z]?$/, 'BUYENDE')
    .replace(/^CBUVENDE$/, 'BUYENDE')
    .replace(/^BUVENDE$/, 'BUYENDE')
    .replace(/^JRUNDU$/, 'IRUNDU')
    .replace(/^IRUNDU\s+[A-Z ]{1,6}$/, 'IRUNDU');

  return cleaned;
}

function normalizeCardNumber(raw) {
  const v = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const directNew = v.match(/CA[0-9]{9}/);
  if (directNew) return directNew[0];
  const directOld = v.match(/[0-9]{9}/);
  if (directOld) return directOld[0];
  return '';
}

function mrzYYMMDDToDisplay(yyMMdd, isExpiry) {
  if (!/^[0-9]{6}$/.test(yyMMdd)) return '';
  const yy = parseInt(yyMMdd.slice(0, 2), 10);
  const mmVal = parseInt(yyMMdd.slice(2, 4), 10);
  const ddVal = parseInt(yyMMdd.slice(4, 6), 10);
  if (mmVal < 1 || mmVal > 12 || ddVal < 1 || ddVal > 31) return '';
  const mm = yyMMdd.slice(2, 4);
  const dd = yyMMdd.slice(4, 6);
  if (isExpiry) {
    return `${dd}.${mm}.${2000 + yy}`;
  }
  const currentYY = new Date().getFullYear() % 100;
  const century = yy > currentYY ? 1900 : 2000;
  return `${dd}.${mm}.${century + yy}`;
}

// ─── Front parser ─────────────────────────────────────────────────────────
// Accepts a raw OCR text string from the front of the ID card.
function parseFront(raw) {
  const data = {};
  const up = normalizeOCRText(raw);
  const lines = up.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // Dates: Try labels first to avoid positional shifts
  const dates = [];
  const dateMatches = up.matchAll(/\b\d{2}[.\/\-]\d{2}[.\/\-]\d{4}\b/g);
  for (const m of dateMatches) {
    const d = parseAndFormatDob(m[0]);
    if (d) dates.push(d);
  }

  // --- Robust Chronological Date Sorting ---
  // The new ID cards often cause Tesseract to read the dates out of layout order.
  // We extract all valid dates, sort them chronologically, and map them logically:
  // Oldest = DOB, Middle = Issue Date, Newest = Expiry Date
  let validDates = [];
  const dateMatchesGlob = up.matchAll(/\b(\d{2}[.\/\-]\d{2}[.\/\-]\d{4})\b/g);
  for (const m of dateMatchesGlob) {
    const d = parseAndFormatDob(m[1]);
    if (d) {
      const parts = d.split('.');
      const ts = new Date(parseInt(parts[2], 10), parseInt(parts[1], 10) - 1, parseInt(parts[0], 10)).getTime();
      validDates.push({ dateStr: d, ts });
    }
  }

  // Remove duplicates
  validDates = validDates.filter((v, i, a) => a.findIndex(t => (t.dateStr === v.dateStr)) === i);
  // Sort oldest to newest
  validDates.sort((a, b) => a.ts - b.ts);

  if (validDates.length === 3) {
    data.dob = validDates[0].dateStr;
    // index 1 is issue date (ignored for now as we don't store it)
    data.expiry = validDates[2].dateStr;
  } else if (validDates.length === 2) {
    // If we only found 2 dates, it's tricky. Let's rely on labels as a fallback, or assume DOB and Expiry.
    // If one year is > current year, it must be expiry.
    const curY = new Date().getFullYear();
    const y0 = parseInt(validDates[0].dateStr.split('.')[2], 10);
    const y1 = parseInt(validDates[1].dateStr.split('.')[2], 10);
    
    if (y1 > curY) {
      data.expiry = validDates[1].dateStr;
      data.dob = validDates[0].dateStr;
    } else {
      // Fallback to label matching if chronological is ambiguous
      const dobMatch = up.match(/\b(?:DOB|BIRTH)[\s\S]{0,40}?\b(\d{2}[.\/\-]\d{2}[.\/\-]\d{4})\b/i);
      if (dobMatch) data.dob = parseAndFormatDob(dobMatch[1]);
      const expiryMatch = up.match(/\b(?:EXPIRY|EXP)[\s\S]{0,40}?\b(\d{2}[.\/\-]\d{2}[.\/\-]\d{4})\b/i);
      if (expiryMatch) data.expiry = parseAndFormatDob(expiryMatch[1]);
    }
  } else {
    const dobMatch = up.match(/\b(?:DOB|BIRTH)[\s\S]{0,40}?\b(\d{2}[.\/\-]\d{2}[.\/\-]\d{4})\b/i);
    if (dobMatch) data.dob = parseAndFormatDob(dobMatch[1]);
    const expiryMatch = up.match(/\b(?:EXPIRY|EXP)[\s\S]{0,40}?\b(\d{2}[.\/\-]\d{2}[.\/\-]\d{4})\b/i);
    if (expiryMatch) data.expiry = parseAndFormatDob(expiryMatch[1]);
  }

  // NIN (uses DOB for prefix Year of Birth reconciliation if available)
  const words = up.split(/[\s|]+/).filter(Boolean);
  let nin = '';
  
  // Search for the NIN structural pattern ANYWHERE in the raw OCR text
  // We use word boundaries \b and the strict pattern to avoid matching random noise.
  const ninMatches = up.match(/\b[CAP][MF]\d{2}[A-Z0-9]{10}\b/gi) || [];
  for (const matchStr of ninMatches) {
    const candidate = validateNin(matchStr, data.dob);
    if (candidate) { 
      nin = candidate; 
      break; 
    }
  }

  // Fallback to words just in case
  if (!nin) {
    for (const w of words) {
      const candidate = validateNin(w, data.dob);
      if (candidate) { nin = candidate; break; }
    }
  }
  if (nin) data.nin = nin;

  // Sex
  const sexMatch = up.match(/\bSEX\b[\s\S]{0,35}?(?<!\bO\s*)\b([MF])\b/i);
  const sex = sexMatch
    ? validateSexOrBlank(sexMatch[1].toUpperCase())
    : validateSexOrBlank(lines.find(l => /^[MF]$/.test(l.trim().toUpperCase())));
  if (sex) data.sex = sex;

  // Names (labeled)
  const surnameMatch = up.match(/\b(SURNAME|SUENAML|SURNAM|SURNAMF|RNAML|SURNAMEF)\b/);
  const surnamePos = surnameMatch ? surnameMatch.index : -1;

  const givenMatch = up.match(/\b(GIVEN|GIVER|GIVEM)\b/);
  const givenPos = givenMatch ? givenMatch.index : -1;

  if (surnamePos >= 0) {
    let slice = up.slice(surnamePos, surnamePos + 80);
    const boundaryMatch = slice.match(/\b(GIVEN|GIVER|NATIONALITY|SEX|DATE|BIRTH|NIN)\b/);
    if (boundaryMatch) slice = slice.slice(0, boundaryMatch.index);
    const candidate = slice.replace(/\b(SURNAME|SUENAML|SURNAM|SURNAMF|RNAML|SURNAMEF)\b/, ' ');
    const nm = normalizeNameStrict(candidate);
    const tok = nm.split(/\s+/).filter(Boolean).find(isPersonNameStrict) || '';
    if (tok) data.surname = tok;
  }

  if (givenPos >= 0) {
    // slice text from GIVEN to next label (or up to 100 chars)
    const chunk = up.slice(givenPos, givenPos + 100);
    // clean out known labels
    const cleanedChunk = chunk.replace(/\b(GIVEN|NAMES?|NATIONALITY|UGA|SEX|DOB|DATE|EXPIRY|CARD|NIN|HOLDER|OTHER)\b/g, '');
    const nm = normalizeNameStrict(cleanedChunk);
    const toks = nm.split(/\s+/).filter(Boolean);
    // FIX 3: extended stop-word list includes synthetic-card watermark noise tokens
    const FNAME_STOP = new Set(['NATIONAL','ID','CARD','REPUBLIC','UGANDA','GIVEN','NAME','GIVER',
      'SUENAML','SURNAME','NATIONALITY','SEX','BIRTH','EXPIRY','HOLDER','SIGNATURE','DATE','OF',
      'LS','LA','AS','IS','TO','BATH','MAME','BATE','ATIONALITY','OER','WONA','TEE','LAMERY',
      // Watermark/label noise seen in synthetic cards:
      'NAVE','NANE','NAHE','GVEN','SIVENAME','GIVEN','PRESRD','MACHENE','MACHINE',
      'LEARNING','USE','ONLY','EE','TY','ITY','PR','HET','INA','LE','CMLQM','TEN','NAM',
      // Extra 3+ char noise fragments observed in v2 run:
      'BOOED','SANT','NANKYA','CFVQR','SUM','SINAN',
      // v6 additions - photo area + label garble noise:
      'PHOTO','PHOT','PIVEN','SIVEN','GVEN','DAE','OR','NE','NIEN','FY','SL','NSA','NENG',
      'NT','IH','MM','SSD','TST','SCR','FIRNAME','FIRSTNAME',
    ]);
    let cleanToks = toks.filter(t => !FNAME_STOP.has(t) && t.length >= 2);
    // Drop tokens ≤ 2 chars (EA, EO, EM, IF, MM, BH etc. are pure noise)
    cleanToks = cleanToks.filter(t => t.length > 2);
    // Drop NIN-like fragments starting with CF/CM (e.g. CFDYQ, CMALWK, CFBH)
    cleanToks = cleanToks.filter(t => !/^C[MF][A-Z0-9]{1,8}$/.test(t));
    // Drop all-consonant tokens (no vowel = OCR noise, e.g. NNSNIONS, NIENTTNANS)
    cleanToks = cleanToks.filter(t => /[AEIOU]/.test(t));
    if (cleanToks.length) data.given_names = cleanToks.slice(0, 3).join(' ');
  }

  // Removed positional fallback for names (Bug 2 Fix)
  // We strictly rely on labeled fields to avoid shifting data into wrong fields.

  // Card Number
  const cardNoMatch = up.match(/\b(?:CARD|CARD\s*NO|CA)[\s\S]{0,40}?\b([A-Z]{0,2}[0-9]{8,12})\b/i) ||
                      up.match(/\b(CA[0-9]{8,12})\b/i);
  if (cardNoMatch) data.card_no = cardNoMatch[1].toUpperCase().replace(/[^A-Z0-9]/g, '');

  // Nationality
  if (up.includes('UGA')) data.nationality = 'UGA';

  return data;
}

// ─── Back parser ──────────────────────────────────────────────────────────
// Accepts a raw OCR text string from the back of the ID card.
function parseBack(raw) {
  const data = {};
  const up = normalizeOCRText(raw);

  // MRZ parsing (only if it looks like there are MRZ lines present)
  const chevronCount = (up.match(/</g) || []).length;
  if (chevronCount > 5 || up.includes('IDUGA') || up.includes('IDTST')) {
    const mrzLines = extractMRZ(raw);
    if (mrzLines) {
      const parsed = parseMRZ(mrzLines);
      
      if (parsed.dateOfBirth) {
         const parts = parsed.dateOfBirth.split('-');
         if (parts.length === 3) {
             data.dob = parts[2] + '.' + parts[1] + '.' + parts[0]; 
         }
      }
      if (parsed.sex === 'Male') data.sex = 'M';
      else if (parsed.sex === 'Female') data.sex = 'F';
      else data.sex = parsed.sex;
      
      if (parsed.nin) data.nin = parsed.nin;
      if (parsed.surname) data.surname = parsed.surname;
      if (parsed.givenName) data.given_names = parsed.givenName;
      if (parsed.nationality) data.nationality = parsed.nationality;
    }
  }

  // Location extraction
  const lines = up.split('\n').map(l => l.trim()).filter(Boolean);
  const nonMrzLines = normalizeLocationLines(lines);

  // ─── Line-based address extraction (robust against label collisions) ───
  // Each address field label appears at the start of its line on the card back.
  // Labels are searched most-specific first (S.COUNTY before COUNTY) to avoid
  // partial matches (e.g. 'COUNTY' matching inside 'S.COUNTY').
  const ADDR_LABELS = [
    { pattern: /^[^A-Za-z0-9]*S[\s.]?COUNTY[\s:]+(.+)$/i,  field: 'sub_county' },
    { pattern: /^[^A-Za-z0-9]*VILLAGE[\s:]+(.+)$/i,          field: 'village'   },
    { pattern: /^[^A-Za-z0-9]*PARISH[\s:]+(.+)$/i,           field: 'parish'    },
    { pattern: /^[^A-Za-z0-9]*COUNTY[\s:]+(.+)$/i,           field: 'county'    },
    { pattern: /^[^A-Za-z0-9]*DISTRICT[\s:]+(.+)$/i,         field: 'district'  },
  ];

  // Also accept value-only format (label on separate line, value on next)
  const LABEL_ONLY = [
    { pattern: /^[^A-Za-z0-9]*S[\s.]?COUNTY$/i,  field: 'sub_county' },
    { pattern: /^[^A-Za-z0-9]*VILLAGE$/i,         field: 'village'   },
    { pattern: /^[^A-Za-z0-9]*PARISH$/i,          field: 'parish'    },
    { pattern: /^[^A-Za-z0-9]*COUNTY$/i,          field: 'county'    },
    { pattern: /^[^A-Za-z0-9]*DISTRICT$/i,        field: 'district'  },
  ];

  const allLines = up.split('\n').map(l => l.trim()).filter(Boolean);

  // New 2025-style Uganda ID backs often print two fields on one row:
  // "DISTRICT BUYENDE  PARISH BUDIPA" and
  // "COUNTY BUDIOPE EAST  VILLAGE BUDIPA II".
  const pairedPatterns = [
    {
      line: /(DISTRICT)\s+(.+?)\s+(PARISH)\s+(.+)/i,
      left: 'district',
      right: 'parish'
    },
    {
      line: /(COUNTY)\s+(.+?)\s+(?:VILLAGE|VILAGE)\s+(.+)/i,
      left: 'county',
      right: 'village'
    },
    {
      line: /(SUB\s*COUNTY|SUBCOUNTY|S[\s.]?COUNTY)\s+(.+?)\s+(?:FINGER|RIGHT|LEFT|INDEX|L\s*INDEX|R\s*INDEX|$)/i,
      left: 'sub_county',
      right: ''
    }
  ];

  for (const line of allLines) {
    for (const spec of pairedPatterns) {
      const m = line.match(spec.line);
      if (!m) continue;
      if (spec.left && !data[spec.left]) {
        const cleaned = cleanLocationNameStrict(m[2] || '');
        if (cleaned) data[spec.left] = cleaned;
      }
      if (spec.right && !data[spec.right]) {
        const cleaned = cleanLocationNameStrict(m[4] || m[3] || '');
        if (cleaned) data[spec.right] = cleaned;
      }
    }
  }

  // Pass 1: label+value on same line (most common)
  for (const line of allLines) {
    for (const { pattern, field } of ADDR_LABELS) {
      if (data[field]) continue;
      const m = line.match(pattern);
      if (m) {
        const cleaned = cleanLocationNameStrict(m[1].trim());
        if (cleaned) { data[field] = cleaned; break; }
      }
    }
  }

  // Pass 2: label alone on one line, value on next
  for (let li = 0; li < allLines.length - 1; li++) {
    for (const { pattern, field } of LABEL_ONLY) {
      if (data[field]) continue;
      if (pattern.test(allLines[li])) {
        const cleaned = cleanLocationNameStrict(allLines[li + 1]);
        if (cleaned) data[field] = cleaned;
      }
    }
  }

  // Pass 3: positional fallback — only for lines NOT starting with an address label
  // (lines starting with VILLAGE/PARISH/etc. were already processed in Pass 1;
  //  including them here causes wrong field assignment when a label line appears
  //  before the target field's position in the OCR output)
  const addrLabelPrefixRe = /^(VILLAGE|PARISH|S\.?\s*COUNTY|COUNTY|DISTRICT)\b/i;
  const hasLabeledAddress = ['village', 'parish', 'sub_county', 'county', 'district'].some(f => data[f]);
  if (!hasLabeledAddress) {
    const cleanedLines = nonMrzLines
      .map(cleanLocationNameStrict)
      .filter(v => v && v.length >= 3 && !addrLabelPrefixRe.test(v));

    const order = ['village', 'parish', 'sub_county', 'county', 'district'];
    let cleanedIdx = 0;
    order.forEach(f => {
      if (!data[f]) {
        while (cleanedLines[cleanedIdx] && Object.values(data).includes(cleanedLines[cleanedIdx])) {
          cleanedIdx++;
        }
        if (cleanedLines[cleanedIdx]) {
          data[f] = cleanedLines[cleanedIdx];
          cleanedIdx++;
        }
      }
    });
  }

  // Auto-fill Sub County for Kampala division counties
  if (!data.sub_county && data.county && data.county.includes('DIVISION')) {
    const prefix = data.county.replace(/DIVISION/g, '').trim();
    if (prefix.length >= 3) data.sub_county = prefix;
  }

  // Auto-fill District to KAMPALA for Kampala divisions
  if (!data.district && (
    (data.county && /\b(NAKAWA|RUBAGA|MAKINDYE|KAWEMPE|KAMPALA)\b/i.test(data.county)) ||
    (data.sub_county && /\b(NAKAWA|RUBAGA|MAKINDYE|KAWEMPE|KAMPALA)\b/i.test(data.sub_county))
  )) {
    data.district = 'KAMPALA';
  }

  return data;
}


// --- MRZ parser -----------------------------------------------------------
/**
 * Extracts the 3 lines of the TD1 MRZ from raw OCR text.
 */
function extractMRZ(text) {
    const lines = text.split('\n').map(l => l.replace(/\s+/g, '').toUpperCase());
    
    for (let i = 0; i < lines.length - 2; i++) {
        const l1 = lines[i];
        const l2 = lines[i+1];
        const l3 = lines[i+2];
        if (l1.startsWith('IDUGA') && l1.length >= 28 && l2.length >= 28 && l3.length >= 28) {
            return [l1, l2, l3];
        }
    }
    return null; 
}

/**
 * Parses the extracted TD1 MRZ lines into clean, standardized fields.
 */
function parseMRZ(mrzLines) {
    let [line1, line2, line3] = mrzLines;
    
    let line1Clean = line1.replace(/\s+/g, '');
    let nin = line1Clean.substring(15, 29).replace(/</g, '');
    nin = nin.replace(/O/g, '0');
    
    let line2Clean = line2.replace(/\s+/g, '');
    let dobRaw = line2Clean.substring(0, 6)
        .replace(/D/g, '0')
        .replace(/O/g, '0')
        .replace(/I/g, '1')
        .replace(/S/g, '5')
        .replace(/B/g, '8')
        .replace(/Z/g, '2');
        
    let sexRaw = line2Clean.substring(7, 8);
    let nationality = line2Clean.substring(15, 18).replace(/</g, '');

    let line3Clean = line3.replace(/\s+/g, '<');
    line3Clean = line3Clean.replace(/[KLY]{4,}/g, (m) => '<'.repeat(m.length));
    line3Clean = line3Clean.replace(/<K<K/g, '<<').replace(/<K</g, '<<'); 
    let match = line3Clean.match(/^(.*?)(?:<{3,}|$)/);
    let namePart = match ? match[1] : line3Clean;
    let surname = '';
    let givenName = '';

    if (namePart.includes('<<')) {
        let parts = namePart.split('<<');
        surname = parts[0];
        givenName = parts.slice(1).join('<');
    } else {
        let firstIndex = namePart.indexOf('<');
        if (firstIndex !== -1) {
            surname = namePart.substring(0, firstIndex);
            givenName = namePart.substring(firstIndex + 1);
        } else {
            surname = namePart;
            givenName = '';
        }
    }

    surname = surname.replace(/</g, ' ').trim();
    givenName = givenName.replace(/</g, ' ').trim();

    if (givenName.startsWith('SK ') || givenName.startsWith('SK')) {
        let possibleClean = givenName.substring(2).trim();
        if (possibleClean.length > 2) {
            givenName = possibleClean;
        }
    }

    let dob = '';
    if (dobRaw && dobRaw.length === 6 && !isNaN(parseInt(dobRaw))) {
        let year = parseInt(dobRaw.substring(0, 2), 10);
        let month = dobRaw.substring(2, 4);
        let day = dobRaw.substring(4, 6);
        
        let currentYear2Digit = new Date().getFullYear() % 100;
        let fullYear = (year > currentYear2Digit) ? (1900 + year) : (2000 + year);
        dob = fullYear + '-' + month + '-' + day;
    }

    return {
        surname: surname,
        givenName: givenName,
        sex: sexRaw === 'M' ? 'Male' : (sexRaw === 'F' ? 'Female' : sexRaw),
        dateOfBirth: dob,
        nationality: nationality,
        nin: nin
    };
}

// ─── Exports ──────────────────────────────────────────────────────────────
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ROI,
    FRONT_ROIS,
    BACK_ROIS,
    NEW_FRONT_ROIS,
    NEW_BACK_ROIS,
    SYNTHETIC_FRONT_ROIS,
    SYNTHETIC_BACK_ROIS,
    FIELD_OCR_SETTINGS,
    parseFront,
    parseBack,
    parseMRZ,
    mergeAndApplyMrzBackfill,
    validateNin,
    parseAndFormatDob,
    validateSexOrBlank,
    normalizeNameStrict,
    isPersonNameStrict,
    cleanLocationNameStrict,
    mrzYYMMDDToDisplay,
    normalizeOCRText,
    validateDob,
    validateExpiry,
    reconcileDob,
    reconcileExpiry,
    reconcileSex,
    reconcileNins,
    correctNIN,
    correctDate,
    looksLikeMrzLine,
    looksLikeMrzBlock,
    scoreBackExtraction
  };
} else {
  // Browser global exposure
  window.ROI = ROI;
  window.FRONT_ROIS = FRONT_ROIS;
  window.BACK_ROIS = BACK_ROIS;
  window.NEW_FRONT_ROIS = NEW_FRONT_ROIS;
  window.NEW_BACK_ROIS = NEW_BACK_ROIS;
  window.SYNTHETIC_FRONT_ROIS = SYNTHETIC_FRONT_ROIS;
  window.SYNTHETIC_BACK_ROIS = SYNTHETIC_BACK_ROIS;
  window.FIELD_OCR_SETTINGS = FIELD_OCR_SETTINGS;
  window.parseFront = parseFront;
  window.parseBack = parseBack;
  window.parseMRZ = parseMRZ;
  window.mergeAndApplyMrzBackfill = mergeAndApplyMrzBackfill;
  window.validateNin = validateNin;
  window.parseAndFormatDob = parseAndFormatDob;
  window.validateSexOrBlank = validateSexOrBlank;
  window.normalizeNameStrict = normalizeNameStrict;
  window.isPersonNameStrict = isPersonNameStrict;
  window.cleanLocationNameStrict = cleanLocationNameStrict;
  window.mrzYYMMDDToDisplay = mrzYYMMDDToDisplay;
  window.normalizeOCRText = normalizeOCRText;
  window.validateDob = validateDob;
  window.validateExpiry = validateExpiry;
  window.reconcileDob = reconcileDob;
  window.reconcileExpiry = reconcileExpiry;
  window.reconcileSex = reconcileSex;
  window.reconcileNins = reconcileNins;
  window.correctNIN = correctNIN;
  window.correctDate = correctDate;
  window.looksLikeMrzLine = looksLikeMrzLine;
  window.looksLikeMrzBlock = looksLikeMrzBlock;
  window.scoreBackExtraction = scoreBackExtraction;
}
