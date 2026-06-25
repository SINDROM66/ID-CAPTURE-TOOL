/* ═══════════════════════════════════════════════════════════════════════
   parser.js — Pure OCR parsing logic for Uganda National ID cards.
   Extracted from app.js for use in Node.js test harness.
   NO browser APIs: no document, Image, canvas, window, FileReader.
   Accepts raw OCR text strings as input.
   ═══════════════════════════════════════════════════════════════════════ */

'use strict';

// ─── Regex constants ──────────────────────────────────────────────────────
const NIN_REGEX = /^[CA][MF](\d{8}[A-Z0-9]{4}|\d{9}[A-Z0-9]{3})$/;

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
  return t.replace(/[KLCXVES<]+$/, match => {
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

function normalizeNinCandidate(candidate, dob) {
  let v = (candidate || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  // Extract a 14-character NIN candidate if present in a longer string, allowing OCR-garbled prefix and digits
  const match = v.match(/([CA1G0OI4L][MFN13PR0-9BH])([0-9OISBGDZEQRTYUPH]{9})([A-Z0-9]{3,8})/i);
  if (match) {
    let p = match[1];
    let d = match[2];
    let s = match[3].slice(0, 3);
    
    // Normalize prefix first character
    if (/[1G0OIL]/.test(p[0])) p = 'C' + p[1];
    else if (p[0] === '4') p = 'A' + p[1];
    else if (!/[CA]/.test(p[0])) p = 'C' + p[1];
    
    // Normalize prefix second character
    if (/[1NHK0OI8LH]/.test(p[1])) p = p[0] + 'M';
    else if (/[PRE35]/.test(p[1])) p = p[0] + 'F';
    else if (!/[MF]/.test(p[1])) p = p[0] + 'M';
    
    // DOB Year alignment for first two digits of digits group
    if (dob && dob.includes('.')) {
      const parts = dob.split('.');
      if (parts.length === 3) {
        const year = parts[2];
        if (year && year.length === 4) {
          const yy = year.slice(2);
          const dChars = d.split('');
          if (dChars[0] !== yy[0] && (dChars[0] === 'E' || dChars[0] === 'C' || !/[0-9]/.test(dChars[0]))) {
            dChars[0] = yy[0];
          }
          if (dChars[1] !== yy[1] && (dChars[1] === 'R' || dChars[1] === 'B' || !/[0-9]/.test(dChars[1]))) {
            dChars[1] = yy[1];
          }
          d = dChars.join('');
        }
      }
    }

    // Normalize digits (positions 2-10)
    const digitsMap = { 
      'O':'0', 'I':'1', 'S':'5', 'B':'8', 'G':'6', 'A':'4', 'Z':'2', 
      'D':'0', 'E':'0', 'Q':'0', 'R':'8', 'T':'7', 'Y':'7', 'U':'0', 
      'P':'9', 'H':'8' 
    };
    let cleanDigits = d.split('').map(c => digitsMap[c] || c).join('');
    
    // Normalize suffix (positions 11-13)
    const suffixMap = { '0':'O','1':'I','5':'S','8':'B','6':'G','4':'A','2':'Z','3':'J' };
    let cleanSuffix = s.split('').map(c => suffixMap[c] || c).join('');
    
    v = p + cleanDigits + cleanSuffix;
  }

  // Auto-correct duplicate first zero/O (15-character edge case e.g. CMO0... or CM00...)
  if (v.length === 15 && /^[CA][MF][0O]{2}/.test(v)) {
    v = v.slice(0, 2) + v.slice(3);
  }

  if (v.length !== 14) return v; // let validateNin reject it

  // Position-aware structural normalization
  const chars = v.split('');

  // Positions 0-1: must be letters (prefix CM / CF / AM / AF)
  for (let i = 0; i <= 1; i++) {
    if (DIGIT_TO_LETTER[chars[i]]) chars[i] = DIGIT_TO_LETTER[chars[i]];
  }
  // Double-check prefix corrections
  if (chars[0] === 'I' || chars[0] === '1' || chars[0] === 'O' || chars[0] === '0') chars[0] = 'C';
  if (chars[1] === 'N' || chars[1] === 'H' || chars[1] === 'K') chars[1] = 'M';

  // Apply DOB Year correction before standard letter-to-digit confusions
  if (dob && dob.includes('.')) {
    const parts = dob.split('.');
    if (parts.length === 3) {
      const year = parts[2];
      if (year && year.length === 4) {
        const yy = year.slice(2);
        if (chars[2] !== yy[0] && (!/[0-9]/.test(chars[2]) || chars[2] === 'E' || chars[2] === 'C')) {
          chars[2] = yy[0];
        }
        if (chars[3] !== yy[1] && (!/[0-9]/.test(chars[3]) || chars[3] === 'R' || chars[3] === 'B')) {
          chars[3] = yy[1];
        }
      }
    }
  }

  // Positions 2-10: must be digits
  const LETTER_TO_DIGIT_EXPANDED = { 
    'O':'0', 'I':'1', 'S':'5', 'B':'8', 'G':'6', 'A':'4', 'Z':'2', 
    'D':'0', 'E':'0', 'Q':'0', 'R':'8', 'T':'7', 'Y':'7', 'U':'0', 
    'P':'9', 'H':'8' 
  };
  for (let i = 2; i <= 10; i++) {
    if (LETTER_TO_DIGIT_EXPANDED[chars[i]]) chars[i] = LETTER_TO_DIGIT_EXPANDED[chars[i]];
  }

  // Positions 11-13: must be letters
  for (let i = 11; i <= 13; i++) {
    if (DIGIT_TO_LETTER[chars[i]]) chars[i] = DIGIT_TO_LETTER[chars[i]];
  }

  return chars.join('');
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
  return NIN_REGEX.test(v) ? v : '';
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

  return cleaned;
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

  // Dates: DOB = first, Expiry = second
  const dates = [];
  const dateMatches = up.matchAll(/\b\d{2}[.\/\-]\d{2}[.\/\-]\d{4}\b/g);
  for (const m of dateMatches) {
    const d = parseAndFormatDob(m[0]);
    if (d) dates.push(d);
  }
  if (dates[0]) data.dob = dates[0];
  if (dates[1]) data.expiry = dates[1];

  // NIN (uses DOB for prefix Year of Birth reconciliation if available)
  const words = up.split(/[\s|]+/).filter(Boolean);
  let nin = '';
  for (const w of words) {
    const candidate = validateNin(w, data.dob);
    if (candidate) { nin = candidate; break; }
  }
  if (nin) data.nin = nin;

  // Sex
  const sexMatch = up.match(/\bSEX\s+[\s\S]{0,60}\b([MF])\b/);
  const sex = sexMatch
    ? validateSexOrBlank(sexMatch[1])
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
    let slice = up.slice(givenPos, givenPos + 100);
    const boundaryMatch = slice.match(/\b(NATIONALITY|SEX|DATE|BIRTH|NIN|BATE|GARD|CARD)\b/);
    if (boundaryMatch) slice = slice.slice(0, boundaryMatch.index);
    const candidate = slice.replace(/\b(GIVEN|GIVER|GIVEM)\b/, ' ');
    const nm = normalizeNameStrict(candidate);
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

  // Fallback: scan lines (when labeled positions not found)
  if (!data.surname || !data.given_names) {
    const candidates = lines
      .filter(l => !l.includes('<'))
      .map(normalizeNameStrict)
      .filter(v => v && v.length >= 3)
      // Apply same quality gates as the labeled path:
      // - reject NIN-like CF/CM fragments (CMALWK, CFBH etc.)
      // - reject all-consonant tokens (NNSNIONS etc.)
      // - full name must have at least one vowel
      .filter(v => !/^C[MF][A-Z0-9]{1,8}$/.test(v.split(/\s+/)[0]))
      .filter(v => isPersonNameStrict(v));

    if (!data.surname && candidates.length >= 1) data.surname = candidates[0].split(/\s+/)[0];
    if (!data.given_names && candidates.length >= 2) data.given_names = candidates.slice(1, 2).join(' ');
  }

  // Card Number
  const cardNoMatch = up.match(/\b(?:CARD|CARD\s*NO)\s*[:\s]*([A-Z0-9]{9,10})\b/i);
  if (cardNoMatch) data.card_no = fixDigitsOnly(cardNoMatch[1]);

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
    Object.assign(data, parseMRZ(up));
  }

  // Location extraction
  const lines = up.split('\n').map(l => l.trim()).filter(Boolean);
  const nonMrzLines = normalizeLocationLines(lines);

  // ─── Line-based address extraction (robust against label collisions) ───
  // Each address field label appears at the start of its line on the card back.
  // Labels are searched most-specific first (S.COUNTY before COUNTY) to avoid
  // partial matches (e.g. 'COUNTY' matching inside 'S.COUNTY').
  const ADDR_LABELS = [
    { pattern: /^S[\s.]?COUNTY[\s:]+(.+)$/i,  field: 'sub_county' },
    { pattern: /^VILLAGE[\s:]+(.+)$/i,          field: 'village'   },
    { pattern: /^PARISH[\s:]+(.+)$/i,           field: 'parish'    },
    { pattern: /^COUNTY[\s:]+(.+)$/i,           field: 'county'    },
    { pattern: /^DISTRICT[\s:]+(.+)$/i,         field: 'district'  },
  ];

  // Also accept value-only format (label on separate line, value on next)
  const LABEL_ONLY = [
    { pattern: /^S[\s.]?COUNTY$/i,  field: 'sub_county' },
    { pattern: /^VILLAGE$/i,         field: 'village'   },
    { pattern: /^PARISH$/i,          field: 'parish'    },
    { pattern: /^COUNTY$/i,          field: 'county'    },
    { pattern: /^DISTRICT$/i,        field: 'district'  },
  ];

  const allLines = up.split('\n').map(l => l.trim()).filter(Boolean);

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

// ─── MRZ parser ───────────────────────────────────────────────────────────
// Accepts raw OCR text containing MRZ lines.
function parseMRZ(text) {
  const data = {};
  const norm = normalizeOCRText(text);
  const rawLines = norm.split('\n').map(l => l.trim()).filter(Boolean);

  const lines = rawLines
    .map(l => l.replace(/\s+/g, '').replace(/[^A-Z0-9<]/g, ''))
    .filter(l => l.length >= 15);

  function fixN(str) {
    return str.replace(/O/g,'0').replace(/I/g,'1').replace(/S/g,'5').replace(/B/g,'8');
  }

  // 1. Scoring-based line classification
  let line1 = '', line2 = '', line3 = '';
  const scoredLines = lines.map(l => {
    const numDigits = (l.match(/\d/g) || []).length;
    
    // Line 3 Score: mostly letters & chevrons
    let s3 = 0;
    if (numDigits < 5) s3 += 15;
    else if (numDigits >= 8) s3 -= 15;

    // Line 1 Score: starts with ID/1D/TST or contains NIN prefix
    let s1 = 0;
    const hasNinPrefix = /[CA1G0OI4][MFN13PR0-9]\d/.test(l);
    const startsWithId = /^(ID|1D|I0|TST)/i.test(l);
    if (startsWithId) s1 += 12;
    if (hasNinPrefix) s1 += 10;
    if (l.includes('TST')) s1 += 5;
    if (/^\d{6}/.test(l)) s1 -= 5;

    // Line 2 Score: starts with DOB date pattern, contains Sex, contains UGA
    let s2 = 0;
    const hasSexChar = /[0-9][MF<][0-9]/.test(l);
    if (hasSexChar) s2 += 12;
    if (/^[A-Z0-9]?\d{5}/.test(l)) s2 += 10;
    if (l.includes('UGA') && !startsWithId) s2 += 6;
    if (numDigits < 5) s2 -= 15;

    return { line: l, s1, s2, s3 };
  });

  // Assign Line 3: highest Line 3 score
  const candidates3 = [...scoredLines].sort((a, b) => b.s3 - a.s3);
  if (candidates3[0] && candidates3[0].s3 > 0) {
    line3 = candidates3[0].line;
  }

  // Assign Line 1 and 2 from remaining
  const remaining = scoredLines.filter(c => c.line !== line3);
  if (remaining.length >= 2) {
    const cand1 = [...remaining].sort((a, b) => b.s1 - a.s1);
    line1 = cand1[0].line;
    line2 = cand1.find(c => c.line !== line1)?.line || '';
  } else if (remaining.length === 1) {
    if (remaining[0].s1 >= remaining[0].s2) {
      line1 = remaining[0].line;
    } else {
      line2 = remaining[0].line;
    }
  }

  if (!line1 && !line2 && !line3 && lines.length >= 3) {
    line1 = lines[0];
    line2 = lines[1];
    line3 = lines[2];
  }

  // Parse Line 2: dob, sex, expiry (parsed first so DOB is available for Line 1 NIN year alignment)
  let mrzDob = '';
  if (line2) {
    const r2start = line2.search(/[0-9]/);
    const raw2trim = r2start >= 0 ? line2.slice(r2start) : line2;
    
    const dob = mrzYYMMDDToDisplay(fixN(raw2trim.slice(0, 6)), false);
    if (dob) {
      data.dob = dob;
      mrzDob = dob;
    }

    const ugaIdx = raw2trim.search(/[UT][GS][AT]/);
    let isCompactFormat = true;
    if (ugaIdx >= 15) {
      isCompactFormat = false;
    } else if (ugaIdx < 0) {
      isCompactFormat = !/[0-9]/.test(raw2trim[6] || '');
    }
    
    const sexPos     = isCompactFormat ? 6 : 7;
    const expiryStart = isCompactFormat ? 7 : 8;

    const sex = validateSexOrBlank(raw2trim[sexPos]);
    if (sex) data.sex = sex;
    
    const expiry = mrzYYMMDDToDisplay(fixN(raw2trim.slice(expiryStart, expiryStart + 6)), true);
    if (expiry) data.expiry = expiry;
  }

  // Parse Line 1: card_no & nin
  if (line1) {
    const cleanL1 = line1.replace(/^(ID|1D|IDTST|IDUGA)/, '');
    const cardNoRaw = fixDigitsOnly(cleanL1.slice(0, 12)).replace(/[^0-9]/g, '');
    if (cardNoRaw.length >= 7) {
      data.card_no = cardNoRaw.slice(0, 9);
    }
    
    const remainingStr = fixN(line1).replace(/</g, '');
    const ninMatch = remainingStr.match(/([CA1G0OI4L][MFN13PR0-9BH])([0-9OISBGDZEQRTYUPH]{9})([A-Z0-9]{3,8})/i);
    if (ninMatch) {
      let p1 = ninMatch[1].toUpperCase();
      const p2 = ninMatch[2];
      const p3 = ninMatch[3].slice(0, 3);
      
      if (/[1G0OIL]/.test(p1[0])) p1 = 'C' + p1[1];
      else if (p1[0] === '4') p1 = 'A' + p1[1];
      
      if (/[1NHK0OBH]/.test(p1[1])) p1 = p1[0] + 'M';
      else if (/[PRE35]/.test(p1[1])) p1 = p1[0] + 'F';
      
      const candidateNin = normalizeNinCandidate(p1 + p2 + p3, mrzDob);
      if (candidateNin.length === 14) {
        data.nin = candidateNin;
      }
    }
  }

  // Parse Line 3: Names
  if (line3) {
    const firstChevronIdx = line3.search(/<+/);
    let sRaw = '', gRaw = '';
    if (firstChevronIdx >= 0) {
      sRaw = line3.slice(0, firstChevronIdx);
      gRaw = line3.slice(firstChevronIdx).replace(/^<+/, '');
    } else {
      sRaw = line3;
    }
    
    if (firstChevronIdx >= 0 && gRaw.replace(/[^A-Z]/g, '').length > 0) {
      let sur = normalizeNameStrict(sRaw);
      let giv = normalizeNameStrict(gRaw);
      
      const FNAME_STOP = new Set(['NATIONAL','ID','CARD','REPUBLIC','UGANDA','GIVEN','NAME','GIVER','SUENAML','SURNAME','NATIONALITY','SEX','BIRTH','EXPIRY','HOLDER','SIGNATURE','DATE','OF','LS','LA','AS','IS','TO','BATH','MAME','BATE','ATIONALITY','OER','WONA','TEE','LAMERY']);
      if (giv) {
        const toks = giv.split(/\s+/).filter(Boolean).map(cleanMrzNameToken);
        let cleanToks = toks.filter(t => !FNAME_STOP.has(t) && t.length >= 2);
        cleanToks = cleanToks.filter(t => t.length > 2 || (t.length === 2 && /[AEIOU]/.test(t)));
        cleanToks = cleanToks.filter(t => !/^C[MF][A-Z0-9]{1,8}$/.test(t));
        cleanToks = cleanToks.filter(t => /[AEIOU]/.test(t) || t.length <= 2);
        giv = cleanToks.join(' ');
      }
      if (sur) {
        const toks = sur.split(/\s+/).filter(Boolean).map(cleanMrzNameToken);
        let cleanToks = toks.filter(t => !FNAME_STOP.has(t) && t.length >= 2);
        cleanToks = cleanToks.filter(t => t.length > 2 || (t.length === 2 && /[AEIOU]/.test(t)));
        cleanToks = cleanToks.filter(t => !/^C[MF][A-Z0-9]{1,8}$/.test(t));
        cleanToks = cleanToks.filter(t => /[AEIOU]/.test(t) || t.length <= 2);
        sur = cleanToks.join(' ');
      }

      if (isPersonNameStrict(sur)) data.surname = sur;
      if (giv) data.given_names = giv;
      data.nationality = 'UGA';
    }
  }

  return data;
}

const FRONT_ROIS = {
  surname:       { x: 0.3350, y: 0.3150, w: 0.1550, h: 0.0650 },
  given_names:   { x: 0.3350, y: 0.4250, w: 0.2400, h: 0.0550 },
  nationality:   { x: 0.3350, y: 0.5350, w: 0.0800, h: 0.0500 },
  sex:           { x: 0.5100, y: 0.5350, w: 0.0350, h: 0.0500 },
  dob:           { x: 0.6300, y: 0.5350, w: 0.1700, h: 0.0500 },
  nin:           { x: 0.3350, y: 0.6300, w: 0.2450, h: 0.0500 },
  card_no:       { x: 0.6300, y: 0.6400, w: 0.1750, h: 0.0450 },
  expiry:        { x: 0.3350, y: 0.7500, w: 0.1550, h: 0.0500 }
};

const BACK_ROIS = {
  address_block: { x: 0.02, y: 0.30, w: 0.50, h: 0.40 },
  mrz_line1:     { x: 0.005, y: 0.72, w: 0.99, h: 0.09 },
  mrz_line2:     { x: 0.005, y: 0.81, w: 0.99, h: 0.09 },
  mrz_line3:     { x: 0.005, y: 0.90, w: 0.99, h: 0.095 }
};

const SYNTHETIC_FRONT_ROIS = {
  surname:      { x: 0.4150, y: 0.1250, w: 0.3950, h: 0.0700 },
  given_names:  { x: 0.4150, y: 0.2070, w: 0.3950, h: 0.0700 },
  nationality:  { x: 0.2270, y: 0.3210, w: 0.0990, h: 0.0700 },
  sex:          { x: 0.3850, y: 0.3210, w: 0.0490, h: 0.0700 },
  dob:          { x: 0.4840, y: 0.3210, w: 0.1980, h: 0.0700 },
  nin:          { x: 0.2270, y: 0.4000, w: 0.4450, h: 0.0700 },
  card_no:      { x: 0.2270, y: 0.4830, w: 0.2170, h: 0.0700 },
  expiry:       { x: 0.4840, y: 0.4830, w: 0.1980, h: 0.0700 }
};

const SYNTHETIC_BACK_ROIS = {
  address_block: { x: 0.0158, y: 0.3072, w: 0.4051, h: 0.2978 },
  mrz_line1:     { x: 0.005, y: 0.72, w: 0.99, h: 0.09 },
  mrz_line2:     { x: 0.005, y: 0.81, w: 0.99, h: 0.09 },
  mrz_line3:     { x: 0.005, y: 0.90, w: 0.99, h: 0.095 }
};

const FIELD_OCR_SETTINGS = {
  surname:       { psm: '7', whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ -' },
  given_names:   { psm: '7', whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ -' },
  nationality:   { psm: '10', whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
  sex:           { psm: '10', whitelist: 'MF' },
  dob:           { psm: '7', whitelist: '0123456789.' },
  nin:           { psm: '7', whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' },
  expiry:        { psm: '7', whitelist: '0123456789.' },
  card_no:       { psm: '7', whitelist: '0123456789' },
  mrz_line1:     { psm: '7', whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<' },
  mrz_line2:     { psm: '7', whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<' },
  mrz_line3:     { psm: '7', whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<' },
  address_block: { psm: '6', whitelist: '' }
};

// ─── Merge + MRZ backfill ────────────────────────────────────────────────
function reconcileName(frontName, mrzName) {
  if (!frontName) return mrzName || '';
  if (!mrzName) return frontName || '';

  const fClean = frontName.toUpperCase().replace(/[^A-Z]/g, '');
  const mClean = mrzName.toUpperCase().replace(/[^A-Z]/g, '');

  if (fClean === mClean) return frontName;

  // 1. If one name contains the other as a substring (spaces removed), return the longer one
  if (mClean.includes(fClean)) return mrzName;
  if (fClean.includes(mClean)) return frontName;

  const fToks = frontName.toUpperCase().split(/\s+/).filter(Boolean);
  const mToks = mrzName.toUpperCase().split(/\s+/).filter(Boolean);

  // 2. If same number of tokens, reconcile token-by-token (handles prefix/suffix cut-offs in individual words)
  if (fToks.length === mToks.length) {
    const reconciled = [];
    for (let i = 0; i < fToks.length; i++) {
      const ft = fToks[i];
      const mt = mToks[i];
      
      if (ft === mt) {
        reconciled.push(ft);
      } else if (mt.startsWith(ft) || mt.endsWith(ft)) {
        reconciled.push(mt);
      } else if (ft.startsWith(mt) || ft.endsWith(mt)) {
        reconciled.push(ft);
      } else {
        reconciled.push(ft); // default fallback
      }
    }
    return reconciled.join(' ');
  }

  // 3. Fallback suffix/prefix check
  if (mClean.startsWith(fClean) || mClean.endsWith(fClean)) return mrzName;
  if (fClean.startsWith(mClean) || fClean.endsWith(mClean)) return frontName;

  return frontName;
}

// Accepts { front: {}, back: {} } and returns a merged flat result object.
function mergeAndApplyMrzBackfill(merged) {
  const front = merged.front || {};
  const back  = merged.back  || {};

  const mrz = {
    nin:         back.nin         || '',
    dob:         back.dob         || '',
    sex:         back.sex         || '',
    expiry:      back.expiry      || '',
    surname:     back.surname     || '',
    given_names: back.given_names || '',
    card_no:     back.card_no     || '',
  };

  let out = {
    surname:     '',
    given_names: '',
    sex:         '',
    dob:         '',
    nin:         '',
    expiry:      '',
    card_no:     '',
    nationality: '',
    village:     back.village     || '',
    parish:      back.parish      || '',
    sub_county:  back.sub_county  || '',
    county:      back.county      || '',
    district:    back.district    || '',
  };

  // Reconcile dates, sex, and NINs using prioritized accuracy rules
  out.dob         = reconcileDob(front.dob, mrz.dob);
  out.expiry      = reconcileExpiry(front.expiry, mrz.expiry);
  out.sex         = reconcileSex(front.sex, mrz.sex);
  out.nin         = reconcileNins(front.nin, mrz.nin, out.dob); // pass reconciled DOB for Year of Birth correction
  out.surname     = reconcileName(front.surname, mrz.surname);
  out.given_names = reconcileName(front.given_names, mrz.given_names);
  out.card_no     = front.card_no   || ''; // front only
  out.nationality = front.nationality || back.nationality || '';

  // Apply validations and corrections
  out.nin         = validateNin(out.nin) || out.nin;
  out.dob         = validateDob(out.dob) || out.dob;
  out.sex         = validateSexOrBlank(out.sex) || out.sex;
  out.expiry      = validateExpiry(out.expiry) || out.expiry;

  // Confidence scores
  const confidence = {};
  const fields = [
    { key: 'nin',         get: () => out.nin,         valid: v => !!validateNin(v),                                   mrz: mrz.nin         },
    { key: 'dob',         get: () => out.dob,         valid: v => !!validateDob(v),                                   mrz: mrz.dob         },
    { key: 'sex',         get: () => out.sex,         valid: v => !!validateSexOrBlank(v),                            mrz: mrz.sex         },
    { key: 'surname',     get: () => out.surname,     valid: v => isPersonNameStrict(normalizeNameStrict(v)),          mrz: mrz.surname     },
    { key: 'given_names', get: () => out.given_names, valid: v => isPersonNameStrict(normalizeNameStrict(v)),          mrz: mrz.given_names }
  ];

  for (const f of fields) {
    const val     = f.get();
    const mrzVal  = f.mrz;
    const passes  = f.valid(val);
    const matchesMrz = passes && mrzVal &&
      String(val).toUpperCase().trim() === String(mrzVal).toUpperCase().trim();

    let level = 'low';
    if (passes && matchesMrz)  level = 'high';
    else if (passes)           level = 'medium';
    confidence[f.key] = level;
  }

  out.confidence = confidence;
  return out;
}

function reconcileDob(frontDob, mrzDob) {
  const vFront = validateDob(frontDob);
  const vMrz   = validateDob(mrzDob);
  return vFront || vMrz || frontDob || mrzDob || '';
}

function reconcileExpiry(frontExpiry, mrzExpiry) {
  const vFront = validateExpiry(frontExpiry);
  const vMrz   = validateExpiry(mrzExpiry);
  return vFront || vMrz || frontExpiry || mrzExpiry || '';
}

function reconcileSex(frontSex, mrzSex) {
  const vFront = validateSexOrBlank(frontSex);
  const vMrz   = validateSexOrBlank(mrzSex);
  return vFront || vMrz || frontSex || mrzSex || '';
}

function reconcileNins(frontNin, mrzNin, dob) {
  const vFront = validateNin(frontNin, dob);
  const vMrz   = validateNin(mrzNin, dob);
  if (vFront && vMrz) {
    if (vFront === vMrz) return vFront;
    const chars = [];
    for (let i = 0; i < 14; i++) {
      const c1 = vFront[i];
      const c2 = vMrz[i];
      if (c1 === c2) {
        chars.push(c1);
        continue;
      }
      if (i < 2) {
        if (/[CMF]/.test(c1) && !/[CMF]/.test(c2)) chars.push(c1);
        else if (/[CMF]/.test(c2) && !/[CMF]/.test(c1)) chars.push(c2);
        else chars.push(c1);
      } else if (i >= 2 && i <= 10) {
        const isD1 = /[0-9]/.test(c1);
        const isD2 = /[0-9]/.test(c2);
        if (isD1 && !isD2) chars.push(c1);
        else if (isD2 && !isD1) chars.push(c2);
        else chars.push(c1);
      } else {
        const specific = { 'Q': 2, 'J': 2, 'U': 2, 'K': 2, 'X': 2, 'Z': 2 };
        const score1 = specific[c1] || 0;
        const score2 = specific[c2] || 0;
        if (score1 > score2) chars.push(c1);
        else if (score2 > score1) chars.push(c2);
        else chars.push(c1);
      }
    }
    const merged = chars.join('');
    return validateNin(merged, dob) || vFront;
  }
  
  const cleanFront = validateNin(frontNin, dob);
  const cleanMrz   = validateNin(mrzNin, dob);
  if (cleanFront) return cleanFront;
  if (cleanMrz) return cleanMrz;
  
  if (frontNin) {
    const cand = normalizeNinCandidate(frontNin, dob);
    if (validateNin(cand, dob)) return cand;
  }
  if (mrzNin) {
    const cand = normalizeNinCandidate(mrzNin, dob);
    if (validateNin(cand, dob)) return cand;
  }

  return frontNin || mrzNin || '';
}

// ─── Exports ──────────────────────────────────────────────────────────────
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    FRONT_ROIS,
    BACK_ROIS,
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
    reconcileNins
  };
} else {
  // Browser global exposure
  window.FRONT_ROIS = FRONT_ROIS;
  window.BACK_ROIS = BACK_ROIS;
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
}
