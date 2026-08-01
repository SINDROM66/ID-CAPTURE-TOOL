(function (global) {
  "use strict";

  // --------------------------------------------------------------------
  // Payload layout
  // --------------------------------------------------------------------

  const IDX_SURNAME = 0;
  const IDX_GIVEN_NAME = 1;
  const IDX_OTHER_NAME = 2;
  const IDX_DOB = 3;
  const IDX_ISSUED = 4;
  const IDX_EXPIRES = 5;
  const IDX_NIN = 6;
  const IDX_CARD_NUMBER = 7;
  const IDX_MINUTIAE = 8;
  const MIN_FIELDS = 8;

  // C = citizen, and the second character encodes sex.
  const NIN_PATTERN = /^([A-Z])([MF])(\d{2})([0-9A-Z]{10})$/;

  const SEX_CODES = { M: "Male", F: "Female" };

  const BIOMETRIC_TAG = "[FNG]";

  // Each minutia is a fixed-width record: X(2) Y(2) angle(1), big-endian,
  // sorted ascending by X. A short header precedes the array.
  const MINUTIA_RECORD_BYTES = 5;

  // --------------------------------------------------------------------
  // Scanner tuning
  // --------------------------------------------------------------------

  const DARK_THRESHOLD = 110; // pixel value below which we call a pixel "ink"
  const MIN_ROW_INK = 50; // ink pixels needed to count a row as part of a symbol
  const MIN_COL_INK = 5;
  const QUIET_ZONE_PX = 20; // margin added around the detected symbol

  // Upscale factors to try, in order. 2x is the usual winner: PDF417 wants
  // roughly 2-3 pixels per narrow module. Larger is NOT better — on the
  // reference image 3x and 4x both failed where 2x decoded perfectly.
  const SCALE_LADDER = [2, 1, 3];

  // --------------------------------------------------------------------
  // Errors
  // --------------------------------------------------------------------

  class CardParseError extends Error {
    // The payload could not be interpreted as a card record.
    constructor(message) {
      super(message);
      this.name = "CardParseError";
    }
  }

  class ScanError extends Error {
    // No structurally valid payload could be read from the image.
    constructor(message) {
      super(message);
      this.name = "ScanError";
    }
  }

  // --------------------------------------------------------------------
  // Data model
  // --------------------------------------------------------------------

  class Fingerprint {
    // Metadata about a biometric section. Templates are never interpreted.
    constructor() {
      this.fingerIndex = null;
      this.minutiaeCount = null;
      this.minutiaeBytes = null;
      this.sealedBlockBytes = null;
    }

    toDict() {
      return {
        finger_index: this.fingerIndex,
        minutiae_count: this.minutiaeCount,
        minutiae_bytes: this.minutiaeBytes,
        sealed_block_bytes: this.sealedBlockBytes,
      };
    }
  }

  class CardRecord {
    constructor({
      surname,
      givenName,
      otherName,
      dateOfBirth,
      issueDate,
      expiryDate,
      nin,
      sex,
      cardNumber,
      fingerprint = new Fingerprint(),
      warnings = [],
      source = null,
      raw = "",
    }) {
      this.surname = surname;
      this.givenName = givenName;
      this.otherName = otherName;
      this.dateOfBirth = dateOfBirth;
      this.issueDate = issueDate;
      this.expiryDate = expiryDate;
      this.nin = nin;
      this.sex = sex;
      this.cardNumber = cardNumber;
      this.fingerprint = fingerprint;
      this.warnings = warnings;
      this.source = source;

      // The full payload, including biometric templates. Kept non-enumerable
      // so JSON.stringify / console.log / toDict() never surface it.
      Object.defineProperty(this, "raw", {
        value: raw,
        enumerable: false,
        writable: false,
      });
    }

    get fullName() {
      return [this.surname, this.givenName, this.otherName]
        .filter(Boolean)
        .join(" ");
    }

    get isExpired() {
      return this.expiryDate.getTime() < utcToday().getTime();
    }

    age(on) {
      const ref = on || utcToday();
      const hadBirthday =
        ref.getUTCMonth() > this.dateOfBirth.getUTCMonth() ||
        (ref.getUTCMonth() === this.dateOfBirth.getUTCMonth() &&
          ref.getUTCDate() >= this.dateOfBirth.getUTCDate());
      return (
        ref.getUTCFullYear() -
        this.dateOfBirth.getUTCFullYear() -
        (hadBirthday ? 0 : 1)
      );
    }

    toDict() {
      return {
        surname: this.surname,
        given_name: this.givenName,
        other_name: this.otherName,
        full_name: this.fullName,
        date_of_birth: isoDate(this.dateOfBirth),
        issue_date: isoDate(this.issueDate),
        expiry_date: isoDate(this.expiryDate),
        nin: this.nin,
        sex: this.sex,
        card_number: this.cardNumber,
        age: this.age(),
        is_expired: this.isExpired,
        fingerprint: this.fingerprint.toDict(),
        warnings: [...this.warnings],
        source: this.source,
      };
    }
  }

  function utcToday() {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  function isoDate(d) {
    const y = String(d.getUTCFullYear()).padStart(4, "0");
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  // --------------------------------------------------------------------
  // Payload helpers
  // --------------------------------------------------------------------

  /**
   * Decode base64 that may be missing its padding.
   *
   * Note: no canonical-form check. Real cards carry non-canonical base64 —
   * the final group's unused low bits are not always zero — so re-encoding
   * yields a different last character. Charset validation is the gate.
   */
  function b64Decode(value) {
    const cleaned = (value || "").replace(/\s+/g, "");
    const padded = cleaned + "=".repeat((4 - (cleaned.length % 4)) % 4);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(padded)) {
      throw new CardParseError("invalid base64 payload: unexpected characters");
    }
    try {
      const binary = atob(padded);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    } catch (exc) {
      throw new CardParseError(`invalid base64 payload: ${exc.message}`);
    }
  }

  // Name fields are base64 ASCII; tolerate a plaintext field as a fallback.
  function decodeName(value, label) {
    const raw = (value || "").trim();
    if (!raw) return "";
    try {
      const bytes = b64Decode(raw);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return text.trim().toUpperCase();
    } catch (exc) {
      if (/^[A-Za-z '\-]+$/.test(raw)) return raw.toUpperCase();
      throw new CardParseError(`could not decode ${label} field`);
    }
  }

  function parseDate(value, label) {
    const raw = (value || "").trim();
    if (!/^\d{8}$/.test(raw)) {
      throw new CardParseError(
        `${label} must be 8 digits (DDMMYYYY), got ${JSON.stringify(raw)}`
      );
    }
    const day = parseInt(raw.slice(0, 2), 10);
    const month = parseInt(raw.slice(2, 4), 10);
    const year = parseInt(raw.slice(4, 8), 10);
    const d = new Date(Date.UTC(year, month - 1, day));
    // Date.UTC silently rolls over invalid components (e.g. day 31 in a
    // 30-day month) instead of throwing, so verify it round-trips.
    if (
      d.getUTCFullYear() !== year ||
      d.getUTCMonth() !== month - 1 ||
      d.getUTCDate() !== day
    ) {
      throw new CardParseError(
        `${label} is not a valid DDMMYYYY date: ${JSON.stringify(raw)}`
      );
    }
    return d;
  }

  // Split the head fields from any [FNG] biometric sections.
  function splitSections(raw) {
    const text = (raw || "").trim();
    if (!text) throw new CardParseError("empty input");
    const parts = text.split(BIOMETRIC_TAG);
    const head = parts[0];
    const tail = parts.slice(1);
    return [head.split(";"), tail];
  }

  function parseFingerprint(headBlob, sections) {
    const fp = new Fingerprint();

    if (headBlob) {
      try {
        fp.minutiaeBytes = b64Decode(headBlob).length;
      } catch (exc) {
        // an unreadable template is not a parse failure
      }
    }

    if (sections.length) {
      const parts = sections[0].split(";");
      if (parts.length > 0 && /^\d+$/.test(parts[0].trim())) {
        fp.fingerIndex = parseInt(parts[0], 10);
      }
      if (parts.length > 1 && /^\d+$/.test(parts[1].trim())) {
        fp.minutiaeCount = parseInt(parts[1], 10);
      }
      if (parts.length > 2 && parts[2].trim()) {
        try {
          fp.sealedBlockBytes = b64Decode(parts[2]).length;
        } catch (exc) {
          // ignore
        }
      }
    }

    return fp;
  }

  // Break a NIN into its components. Returns {} if it does not match.
  function parseNin(nin) {
    const match = NIN_PATTERN.exec((nin || "").trim().toUpperCase());
    if (!match) return {};
    return {
      prefix: match[1],
      sexCode: match[2],
      birthYearShort: match[3],
      serial: match[4],
    };
  }

  // --------------------------------------------------------------------
  // Parsing
  // --------------------------------------------------------------------

  /**
   * Parse a payload string into a CardRecord.
   *
   * options.strict = true turns consistency warnings (NIN/DOB mismatch, bad
   * date ordering, expired card) into a thrown CardParseError instead of
   * collecting them on record.warnings.
   */
  function parseCard(raw, { strict = false, source = null } = {}) {
    const [fields, biometricSections] = splitSections(raw);

    if (fields.length < MIN_FIELDS) {
      throw new CardParseError(
        `expected at least ${MIN_FIELDS} fields, found ${fields.length}`
      );
    }

    const warnings = [];

    const surname = decodeName(fields[IDX_SURNAME], "surname");
    const givenName = decodeName(fields[IDX_GIVEN_NAME], "given name");
    const otherName = decodeName(fields[IDX_OTHER_NAME], "other name");

    const dob = parseDate(fields[IDX_DOB], "date of birth");
    const issued = parseDate(fields[IDX_ISSUED], "issue date");
    const expires = parseDate(fields[IDX_EXPIRES], "expiry date");

    const nin = fields[IDX_NIN].trim().toUpperCase();
    const cardNumber = fields[IDX_CARD_NUMBER].trim();

    const parts = parseNin(nin);
    let sex;
    if (!parts.prefix) {
      warnings.push(`NIN "${nin}" does not match the expected 14-character layout`);
      sex = "Unknown";
    } else {
      sex = SEX_CODES[parts.sexCode] || "Unknown";
      const dobYY = String(dob.getUTCFullYear() % 100).padStart(2, "0");
      if (dobYY !== parts.birthYearShort) {
        warnings.push(
          `NIN birth year '${parts.birthYearShort}' does not match date of birth year ${dob.getUTCFullYear()}`
        );
      }
    }

    if (issued.getTime() <= dob.getTime()) {
      warnings.push("issue date is not after the date of birth");
    }
    if (expires.getTime() <= issued.getTime()) {
      warnings.push("expiry date is not after the issue date");
    }
    if (expires.getTime() < utcToday().getTime()) {
      warnings.push(`card expired on ${isoDate(expires)}`);
    }

    const headBlob = fields.length > IDX_MINUTIAE ? fields[IDX_MINUTIAE] : "";
    const fingerprint = parseFingerprint(headBlob, biometricSections);

    if (
      fingerprint.minutiaeCount !== null &&
      fingerprint.minutiaeBytes !== null &&
      fingerprint.minutiaeBytes % MINUTIA_RECORD_BYTES !== 0
    ) {
      warnings.push("minutiae block length is not a multiple of the record width");
    }

    if (strict && warnings.length) {
      throw new CardParseError(warnings.join("; "));
    }

    return new CardRecord({
      surname,
      givenName,
      otherName,
      dateOfBirth: dob,
      issueDate: issued,
      expiryDate: expires,
      nin,
      sex,
      cardNumber,
      fingerprint,
      warnings,
      source,
      raw: (raw || "").trim(),
    });
  }

  // --------------------------------------------------------------------
  // Scanning (browser: canvas + @zxing/library)
  // --------------------------------------------------------------------

  function requireZXing() {
    if (typeof global.ZXing === "undefined") {
      throw new ScanError(
        "scanning needs @zxing/library loaded as a global `ZXing`. Add " +
          '<script src="js/vendor/zxing.umd.min.js"></script> (vendored ' +
          "for offline use) before js/ug-id-parser.js."
      );
    }
  }

  // Load any accepted source type into a fresh canvas. Accepts an
  // HTMLCanvasElement (used as-is), an HTMLImageElement/HTMLVideoElement,
  // a File/Blob, or a data/object URL string.
  async function toCanvas(source) {
    if (source instanceof HTMLCanvasElement) {
      return { canvas: source, label: "<canvas>" };
    }

    if (source instanceof HTMLImageElement) {
      return { canvas: drawToCanvas(source, source.naturalWidth, source.naturalHeight), label: source.src || "<img>" };
    }

    if (source instanceof HTMLVideoElement) {
      return { canvas: drawToCanvas(source, source.videoWidth, source.videoHeight), label: "<video frame>" };
    }

    if (source instanceof Blob) {
      const img = await blobToImage(source);
      const label = source.name || "<blob>";
      return { canvas: drawToCanvas(img, img.naturalWidth, img.naturalHeight), label };
    }

    if (typeof source === "string") {
      const img = await urlToImage(source);
      return { canvas: drawToCanvas(img, img.naturalWidth, img.naturalHeight), label: source };
    }

    throw new ScanError(
      "unsupported image source: pass a <canvas>, <img>, <video>, File/Blob, or URL string"
    );
  }

  function drawToCanvas(imageLike, width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(imageLike, 0, 0, width, height);
    return canvas;
  }

  function blobToImage(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = (err) => {
        URL.revokeObjectURL(url);
        reject(new ScanError(`could not load image: ${err}`));
      };
      img.src = url;
    });
  }

  function urlToImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = (err) => reject(new ScanError(`could not open ${url} as an image: ${err}`));
      img.src = url;
    });
  }

  /**
   * Find the densest horizontal band of ink and return its bounding box.
   *
   * A PDF417 symbol is far denser than surrounding print, so a projection
   * profile locates it without any detector model.
   * Returns [left, top, right, bottom] in pixel coordinates, or null.
   */
  function findSymbolBbox(canvas) {
    const { width, height } = canvas;
    const ctx = canvas.getContext("2d");
    const data = ctx.getImageData(0, 0, width, height).data;

    const ink = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const grey = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      ink[p] = grey < DARK_THRESHOLD ? 1 : 0;
    }

    const rowInk = new Int32Array(height);
    for (let y = 0; y < height; y++) {
      let sum = 0;
      const base = y * width;
      for (let x = 0; x < width; x++) sum += ink[base + x];
      rowInk[y] = sum;
    }

    const rows = [];
    for (let y = 0; y < height; y++) if (rowInk[y] > MIN_ROW_INK) rows.push(y);
    if (!rows.length) return null;

    const bands = [];
    let start = rows[0];
    let prev = rows[0];
    for (let i = 1; i < rows.length; i++) {
      const y = rows[i];
      if (y - prev > 15) {
        bands.push([start, prev]);
        start = y;
      }
      prev = y;
    }
    bands.push([start, prev]);

    let top = bands[0][0];
    let bottom = bands[0][1];
    let bestSum = -1;
    for (const [s, e] of bands) {
      let sum = 0;
      for (let y = s; y <= e; y++) sum += rowInk[y];
      if (sum > bestSum) {
        bestSum = sum;
        top = s;
        bottom = e;
      }
    }

    const colInk = new Int32Array(width);
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let y = top; y <= bottom; y++) sum += ink[y * width + x];
      colInk[x] = sum;
    }

    const cols = [];
    for (let x = 0; x < width; x++) if (colInk[x] > MIN_COL_INK) cols.push(x);
    if (!cols.length) return null;

    return [
      Math.max(0, cols[0] - QUIET_ZONE_PX),
      Math.max(0, top - QUIET_ZONE_PX),
      Math.min(width, cols[cols.length - 1] + QUIET_ZONE_PX),
      Math.min(height, bottom + QUIET_ZONE_PX),
    ];
  }

  /**
   * Return bounding boxes for ALL ink bands, sorted by total ink sum
   * descending (densest first).
   *
   * The reference module picks a single band (the densest). That breaks when
   * a secondary ink feature — the MRZ on the Uganda ID back — has higher
   * aggregate ink than the barcode band (because the MRZ runs the full card
   * width while the barcode occupies only the right half). This function
   * preserves the same projection algorithm but lets the caller iterate over
   * all candidate bands so ZXing's structural rejection (looksLikeCardPayload)
   * acts as the tiebreaker instead of raw ink density.
   *
   * findSymbolBbox is kept unchanged because it is part of the public API and
   * the test harness uses it directly.
   *
   * Returns [] if no ink bands are found.
   */
  function findAllSymbolBboxes(canvas) {
    const { width, height } = canvas;
    const ctx = canvas.getContext("2d");
    const data = ctx.getImageData(0, 0, width, height).data;

    const ink = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const grey = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      ink[p] = grey < DARK_THRESHOLD ? 1 : 0;
    }

    const rowInk = new Int32Array(height);
    for (let y = 0; y < height; y++) {
      let sum = 0;
      const base = y * width;
      for (let x = 0; x < width; x++) sum += ink[base + x];
      rowInk[y] = sum;
    }

    const rows = [];
    for (let y = 0; y < height; y++) if (rowInk[y] > MIN_ROW_INK) rows.push(y);
    if (!rows.length) return [];

    const bands = [];
    let start = rows[0];
    let prev  = rows[0];
    for (let i = 1; i < rows.length; i++) {
      const y = rows[i];
      if (y - prev > 15) { bands.push([start, prev]); start = y; }
      prev = y;
    }
    bands.push([start, prev]);

    // Sort bands by total ink descending so the densest is tried first,
    // matching the reference module's preference order.
    bands.sort((a, b) => {
      let sa = 0, sb = 0;
      for (let y = a[0]; y <= a[1]; y++) sa += rowInk[y];
      for (let y = b[0]; y <= b[1]; y++) sb += rowInk[y];
      return sb - sa;
    });

    const bboxes = [];
    for (const [top, bottom] of bands) {
      const colInk = new Int32Array(width);
      for (let x = 0; x < width; x++) {
        let sum = 0;
        for (let y = top; y <= bottom; y++) sum += ink[y * width + x];
        colInk[x] = sum;
      }
      const cols = [];
      for (let x = 0; x < width; x++) if (colInk[x] > MIN_COL_INK) cols.push(x);
      if (!cols.length) continue;

      bboxes.push([
        Math.max(0, cols[0] - QUIET_ZONE_PX),
        Math.max(0, top - QUIET_ZONE_PX),
        Math.min(width, cols[cols.length - 1] + QUIET_ZONE_PX),
        Math.min(height, bottom + QUIET_ZONE_PX),
      ]);
    }
    return bboxes;
  }

  /**
   * Cheap structural check used to reject corrupt reads.
   *
   * A phone photo of a laminated card can produce a read the decoder
   * reports as valid but whose text is corrupt, so error-correction
   * passing is not an integrity guarantee. This is the acceptance test
   * for the decode loop.
   */
  function looksLikeCardPayload(text) {
    if (!text || !text.includes(BIOMETRIC_TAG)) return false;

    const fields = text.split(BIOMETRIC_TAG)[0].split(";");
    if (fields.length < MIN_FIELDS) return false;

    for (const value of fields.slice(0, 3)) {
      const cleaned = value.trim();
      if (!cleaned) continue;
      let decoded;
      try {
        decoded = new TextDecoder("ascii", { fatal: true }).decode(b64Decode(cleaned));
      } catch (exc) {
        return false;
      }
      if (!/^[A-Z '\-]+$/.test(decoded.trim().toUpperCase())) return false;
    }

    if (![3, 4, 5].every((i) => /^\d{8}$/.test((fields[i] || "").trim()))) return false;
    if (!parseNin(fields[6]).prefix) return false;

    return true;
  }

  function cropCanvas(canvas, [left, top, right, bottom]) {
    const w = right - left;
    const h = bottom - top;
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    out.getContext("2d").drawImage(canvas, left, top, w, h, 0, 0, w, h);
    return out;
  }

  function toGreyscale(canvas) {
    const out = document.createElement("canvas");
    out.width = canvas.width;
    out.height = canvas.height;
    const ctx = out.getContext("2d");
    ctx.drawImage(canvas, 0, 0);
    const imgData = ctx.getImageData(0, 0, out.width, out.height);
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      const grey = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      d[i] = d[i + 1] = d[i + 2] = grey;
    }
    ctx.putImageData(imgData, 0, 0);
    return out;
  }

  // Histogram stretch — nearest JS equivalent of PIL's ImageOps.autocontrast.
  function autocontrast(canvas) {
    const out = document.createElement("canvas");
    out.width = canvas.width;
    out.height = canvas.height;
    const ctx = out.getContext("2d");
    ctx.drawImage(canvas, 0, 0);
    const imgData = ctx.getImageData(0, 0, out.width, out.height);
    const d = imgData.data;

    let lo = 255;
    let hi = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] < lo) lo = d[i];
      if (d[i] > hi) hi = d[i];
    }
    const range = hi - lo;
    if (range > 0) {
      for (let i = 0; i < d.length; i += 4) {
        const v = ((d[i] - lo) * 255) / range;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
    }
    ctx.putImageData(imgData, 0, 0);
    return out;
  }

  // Note: canvas drawImage with imageSmoothingQuality='high' is a decent
  // stand-in for PIL's LANCZOS upscaling but not identical — if the 2x
  // rung of the ladder underperforms in the field, this is the first
  // place to tune.
  function scaleCanvas(canvas, factor) {
    if (factor === 1) return canvas;
    const out = document.createElement("canvas");
    out.width = canvas.width * factor;
    out.height = canvas.height * factor;
    const ctx = out.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(canvas, 0, 0, out.width, out.height);
    return out;
  }

  /**
   * Return a new canvas rotated 90° clockwise.
   *
   * PDF417 is a horizontal symbol: a phone held portrait over a
   * landscape ID card delivers the barcode at 90° relative to the
   * sensor rows. The Python reference module handles this via
   * zxingcpp's try_rotate=True; here we replicate that by rotating
   * the canvas before calling readBarcode.
   */
  function rotateCanvas90(canvas) {
    const out = document.createElement("canvas");
    out.width  = canvas.height;
    out.height = canvas.width;
    const ctx = out.getContext("2d");
    ctx.translate(out.width, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(canvas, 0, 0);
    return out;
  }

  /**
   * Yield (label, canvas) for 0°, 90°, 180°, 270° — matching the
   * reference module's try_rotate=True iteration order.
   */
  function* rotations(canvas) {
    let c = canvas;
    for (const deg of [0, 90, 180, 270]) {
      yield [`${deg}°`, c];
      c = rotateCanvas90(c);
    }
  }

  function* variants(cropCanvas) {
    const grey = toGreyscale(cropCanvas);
    for (const factor of SCALE_LADDER) {
      const scaled = scaleCanvas(grey, factor);
      yield [`grey x${factor}`, scaled];
      yield [`autocontrast x${factor}`, autocontrast(scaled)];
    }
  }

  function readBarcode(canvas) {
    const { width, height } = canvas;


    const luminanceSource = new global.ZXing.HTMLCanvasElementLuminanceSource(canvas);
    const binarizer = new global.ZXing.HybridBinarizer(luminanceSource);
    const bitmap = new global.ZXing.BinaryBitmap(binarizer);
    const reader = new global.ZXing.PDF417Reader();
    try {
      const result = reader.decode(bitmap);
      return result.getText();
    } catch (exc) {
      return null; // NotFoundException / ChecksumException / FormatException
    }
  }

  /**
   * Decode the PDF417 barcode and return { payload, source }.
   *
   * `source` may be a <canvas>, <img>, <video> frame, File/Blob, or URL
   * string. Throws ScanError if nothing valid is found.
   */
  async function scanCardImage(source, { debug = false } = {}) {
    requireZXing();
    const { canvas, label } = await toCanvas(source);

    // Build region list: all detected bands (densest first) then full frame.
    //
    // The reference module picks one band (max ink sum). That fails on the
    // Uganda ID back because the MRZ band has higher aggregate ink than the
    // barcode band. We now try every band in density order, letting
    // looksLikeCardPayload act as the structural tiebreaker. The full-frame
    // fallback is preserved as the final option as in the reference module.
    const bboxes = findAllSymbolBboxes(canvas);
    if (debug) {
      try {
        console.debug(`findAllSymbolBboxes bboxes: ${JSON.stringify(bboxes)}`);
      } catch (e) { console.debug('findAllSymbolBboxes bboxes: (unserializable)'); }
    }
    const regions = bboxes.map((bbox, i) => [`band ${i + 1}`, cropCanvas(canvas, bbox)]);
    regions.push(["full frame", canvas]); // always last, matches reference module
    if (debug) {
      console.debug(`findAllSymbolBboxes: ${bboxes.length} band(s) found, trying each before full frame`);
    }

    for (const [regionLabel, region] of regions) {
      for (const [variantLabel, candidate] of variants(region)) {
        // Try all 4 orientations per variant — mirrors zxingcpp try_rotate=True.
        // Portrait phone over landscape card = barcode arrives at 90°; without
        // this loop @zxing/library PDF417Reader sees it at a single orientation.
        for (const [rotLabel, rotated] of rotations(candidate)) {
          const text = readBarcode(rotated);
          if (text === null) {
            if (debug) console.debug(`${regionLabel} / ${variantLabel} / ${rotLabel}: no read`);
            continue;
          }
          if (looksLikeCardPayload(text)) {
            if (debug) console.debug(`${regionLabel} / ${variantLabel} / ${rotLabel}: OK, ${text.length} chars`);
            return { payload: text, source: label };
          }
          if (debug) {
            console.debug(
              `${regionLabel} / ${variantLabel} / ${rotLabel}: decoded ${text.length} chars but FAILED validation (corrupt read)`
            );
          }
        }
      }
    }

    throw new ScanError(
      "no valid PDF417 payload found. Re-shoot the card: fill the frame, " +
        "hold the sensor parallel to the card, diffuse light to kill glare on " +
        "the laminate, and keep the whole symbol including quiet zones inside " +
        "the frame."
    );
  }

  // --------------------------------------------------------------------
  // Combined entry points
  // --------------------------------------------------------------------

  /**
   * Scan an image of the card back and return the parsed CardRecord.
   *   const record = await parseCardImage(canvas);
   */
  async function parseCardImage(source, { strict = false, debug = false } = {}) {
    const { payload, source: label } = await scanCardImage(source, { debug });
    return parseCard(payload, { strict, source: label });
  }

  /**
   * Accept either an image source or a raw payload string and return a
   * CardRecord. Convenient when input provenance varies.
   */
  async function readCard(source, { strict = false, debug = false } = {}) {
    if (typeof source === "string") {
      if (source.includes(BIOMETRIC_TAG) || source.includes(";")) {
        return parseCard(source, { strict, source: "<string>" });
      }
    }
    return parseCardImage(source, { strict, debug });
  }

  // --------------------------------------------------------------------
  // Display
  // --------------------------------------------------------------------

  const MONTHS = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];

  function formatDate(d) {
    return `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }

  function render(record) {
    const lines = [
      `Surname      : ${record.surname}`,
      `Given name   : ${record.givenName}`,
      `Other name   : ${record.otherName}`,
      `Sex          : ${record.sex}`,
      `Date of birth: ${formatDate(record.dateOfBirth)} (age ${record.age()})`,
      `Issued       : ${formatDate(record.issueDate)}`,
      `Expires      : ${formatDate(record.expiryDate)}${record.isExpired ? " [EXPIRED]" : ""}`,
      `NIN          : ${record.nin}`,
      `Card number  : ${record.cardNumber}`,
    ];
    const fp = record.fingerprint;
    if (fp.fingerIndex !== null || fp.minutiaeBytes !== null) {
      lines.push(
        `Biometrics   : finger ${fp.fingerIndex}, ${fp.minutiaeCount} minutiae, ` +
          `${fp.minutiaeBytes} B template, ${fp.sealedBlockBytes} B sealed block`
      );
    }
    if (record.source) lines.push(`Source       : ${record.source}`);
    for (const warning of record.warnings) lines.push(`WARNING      : ${warning}`);
    return lines.join("\n");
  }

  // --------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------

  global.UgIdParser = {
    // errors
    CardParseError,
    ScanError,
    // data model
    Fingerprint,
    CardRecord,
    // parsing
    parseNin,
    parseCard,
    // scanning (async — all touch the camera/canvas pipeline)
    findSymbolBbox,
    findAllSymbolBboxes,
    looksLikeCardPayload,
    scanCardImage,
    parseCardImage,
    readCard,
    // display
    render,
  };
})(typeof window !== "undefined" ? window : globalThis);
