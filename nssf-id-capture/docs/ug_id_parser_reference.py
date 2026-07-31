"""
Read a Ugandan national ID card: scan the PDF417 barcode on the back of the
card and return a parsed CardRecord.

    from ug_id_parser import parse_card_image
    record = parse_card_image("scans/card_back.jpg")
    record.surname            # 'LYOMOKI'
    record.sex                # 'Male'
    record.date_of_birth      # datetime.date(2000, 9, 13)
    record.to_dict()          # JSON-ready

The same record can be built from a payload string you already have:

    from ug_id_parser import parse_card
    record = parse_card("TFlPTU9LSQ==;U0FNVUVM;...")

Barcode payload format (semicolon-delimited, biometrics appended):

    <surname_b64>;<given_b64>;<other_b64>;<dob>;<issued>;<expires>;
    <nin>;<card_number>;<minutiae_b64>[FNG]<finger>;<count>;<block_b64>

Dates are DDMMYYYY. Name fields are base64 ASCII. Sex and birth year are
derived from the NIN, not carried as separate fields.

The symbology is PDF417, a stacked linear code — NOT QR or Data Matrix. ZBar
and pyzbar cannot read it at all; zxing-cpp can.

    pip install zxing-cpp pillow numpy

Those three are needed only for scanning. Parsing a payload string works with
the standard library alone, so this module imports them lazily.

CLI:
    python ug_id_parser.py scans/card_back.jpg
    python ug_id_parser.py "TFlPTU9LSQ==;U0FNVUVM;..." --json
    python ug_id_parser.py --debug   # uses CARD_IMAGE_PATH
"""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import os
import re
import sys
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path

# Scanning dependencies are optional: parsing a string must work without them.
try:
    import numpy as np
    import zxingcpp
    from PIL import Image, ImageOps

    SCANNING_AVAILABLE = True
    _IMPORT_ERROR: str | None = None
except ImportError as exc:  # pragma: no cover - environment dependent
    SCANNING_AVAILABLE = False
    _IMPORT_ERROR = str(exc)

# --------------------------------------------------------------------------
# Default input
# --------------------------------------------------------------------------
# Point this at the file you are working with, then call parse_card_image()
# with no arguments. An explicit argument always wins, and the CARD_IMAGE_PATH
# environment variable overrides this literal.
CARD_IMAGE_PATH: str | os.PathLike[str] | None = None

# --------------------------------------------------------------------------
# Payload layout
# --------------------------------------------------------------------------
DATE_FORMAT = "%d%m%Y"

IDX_SURNAME = 0
IDX_GIVEN_NAME = 1
IDX_OTHER_NAME = 2
IDX_DOB = 3
IDX_ISSUED = 4
IDX_EXPIRES = 5
IDX_NIN = 6
IDX_CARD_NUMBER = 7
IDX_MINUTIAE = 8
MIN_FIELDS = 8

# C = citizen, and the second character encodes sex.
NIN_PATTERN = re.compile(
    r"^(?P<prefix>[A-Z])(?P<sex>[MF])(?P<yy>\d{2})(?P<serial>[0-9A-Z]{10})$"
)

SEX_CODES = {"M": "Male", "F": "Female"}

BIOMETRIC_TAG = "[FNG]"
# Each minutia is a fixed-width record: X(2) Y(2) angle(1), big-endian,
# sorted ascending by X. A short header precedes the array.
MINUTIA_RECORD_BYTES = 5

# --------------------------------------------------------------------------
# Scanner tuning
# --------------------------------------------------------------------------
DARK_THRESHOLD = 110  # pixel value below which we call a pixel "ink"
MIN_ROW_INK = 50  # ink pixels needed to count a row as part of a symbol
MIN_COL_INK = 5
QUIET_ZONE_PX = 20  # margin added around the detected symbol

# Upscale factors to try, in order. 2x is the usual winner: PDF417 wants
# roughly 2-3 pixels per narrow module. Larger is NOT better — on the
# reference image 3x and 4x both failed where 2x decoded perfectly.
SCALE_LADDER = (2, 1, 3)


class CardParseError(ValueError):
    """The payload could not be interpreted as a card record."""


class ScanError(RuntimeError):
    """No structurally valid payload could be read from the image."""


# --------------------------------------------------------------------------
# Data model
# --------------------------------------------------------------------------
@dataclass
class Fingerprint:
    """Metadata about a biometric section. Templates are not interpreted."""

    finger_index: int | None = None
    minutiae_count: int | None = None
    minutiae_bytes: int | None = None
    sealed_block_bytes: int | None = None

    def __repr__(self) -> str:  # never echo template contents
        return (
            f"Fingerprint(finger_index={self.finger_index}, "
            f"minutiae_count={self.minutiae_count})"
        )

    def to_dict(self) -> dict:
        return {
            "finger_index": self.finger_index,
            "minutiae_count": self.minutiae_count,
            "minutiae_bytes": self.minutiae_bytes,
            "sealed_block_bytes": self.sealed_block_bytes,
        }


@dataclass
class CardRecord:
    surname: str
    given_name: str
    other_name: str
    date_of_birth: date
    issue_date: date
    expiry_date: date
    nin: str
    sex: str
    card_number: str
    fingerprint: Fingerprint = field(default_factory=Fingerprint)
    warnings: list[str] = field(default_factory=list)
    source: str | None = None
    # The full payload, including biometric templates. Kept off repr() and
    # to_dict() so it cannot leak into a log line or a stack trace.
    raw: str = field(default="", repr=False)

    @property
    def full_name(self) -> str:
        return " ".join(p for p in (self.surname, self.given_name, self.other_name) if p)

    @property
    def is_expired(self) -> bool:
        return self.expiry_date < date.today()

    def age(self, on: date | None = None) -> int:
        ref = on or date.today()
        had_birthday = (ref.month, ref.day) >= (
            self.date_of_birth.month,
            self.date_of_birth.day,
        )
        return ref.year - self.date_of_birth.year - (0 if had_birthday else 1)

    def to_dict(self) -> dict:
        return {
            "surname": self.surname,
            "given_name": self.given_name,
            "other_name": self.other_name,
            "full_name": self.full_name,
            "date_of_birth": self.date_of_birth.isoformat(),
            "issue_date": self.issue_date.isoformat(),
            "expiry_date": self.expiry_date.isoformat(),
            "nin": self.nin,
            "sex": self.sex,
            "card_number": self.card_number,
            "age": self.age(),
            "is_expired": self.is_expired,
            "fingerprint": self.fingerprint.to_dict(),
            "warnings": list(self.warnings),
            "source": self.source,
        }


# --------------------------------------------------------------------------
# Payload helpers
# --------------------------------------------------------------------------
def _b64_decode(value: str) -> bytes:
    """
    Decode base64 that may be missing its padding.

    Note: no canonical-form check. Real cards carry non-canonical base64 —
    the final group's unused low bits are not always zero — so re-encoding
    yields a different last character. Charset validation is the gate.
    """
    cleaned = re.sub(r"\s+", "", value)
    padded = cleaned + "=" * (-len(cleaned) % 4)
    if not re.fullmatch(r"[A-Za-z0-9+/]*={0,2}", padded):
        raise CardParseError("invalid base64 payload: unexpected characters")
    try:
        return base64.b64decode(padded)
    except (binascii.Error, ValueError) as exc:
        raise CardParseError(f"invalid base64 payload: {exc}") from exc


def _decode_name(value: str, label: str) -> str:
    """Name fields are base64 ASCII; tolerate a plaintext field as a fallback."""
    raw = (value or "").strip()
    if not raw:
        return ""
    try:
        text = _b64_decode(raw).decode("utf-8")
    except (CardParseError, UnicodeDecodeError):
        if re.fullmatch(r"[A-Za-z '\-]+", raw):
            return raw.upper()
        raise CardParseError(f"could not decode {label} field")
    return text.strip().upper()


def _parse_date(value: str, label: str) -> date:
    raw = (value or "").strip()
    if not re.fullmatch(r"\d{8}", raw):
        raise CardParseError(f"{label} must be 8 digits (DDMMYYYY), got {raw!r}")
    try:
        return datetime.strptime(raw, DATE_FORMAT).date()
    except ValueError as exc:
        raise CardParseError(f"{label} is not a valid DDMMYYYY date: {raw!r}") from exc


def _split_sections(raw: str) -> tuple[list[str], list[str]]:
    """Split the head fields from any [FNG] biometric sections."""
    text = (raw or "").strip()
    if not text:
        raise CardParseError("empty input")
    head, *tail = text.split(BIOMETRIC_TAG)
    return head.split(";"), tail


def _parse_fingerprint(head_blob: str, sections: list[str]) -> Fingerprint:
    fp = Fingerprint()
    if head_blob:
        try:
            fp.minutiae_bytes = len(_b64_decode(head_blob))
        except CardParseError:
            pass  # an unreadable template is not a parse failure
    if sections:
        parts = sections[0].split(";")
        if len(parts) > 0 and parts[0].strip().isdigit():
            fp.finger_index = int(parts[0])
        if len(parts) > 1 and parts[1].strip().isdigit():
            fp.minutiae_count = int(parts[1])
        if len(parts) > 2 and parts[2].strip():
            try:
                fp.sealed_block_bytes = len(_b64_decode(parts[2]))
            except CardParseError:
                pass
    return fp


def parse_nin(nin: str) -> dict:
    """Break a NIN into its components. Returns {} if it does not match."""
    match = NIN_PATTERN.match((nin or "").strip().upper())
    if not match:
        return {}
    return {
        "prefix": match.group("prefix"),
        "sex_code": match.group("sex"),
        "birth_year_short": match.group("yy"),
        "serial": match.group("serial"),
    }


# --------------------------------------------------------------------------
# Parsing
# --------------------------------------------------------------------------
def parse_card(raw: str, *, strict: bool = False, source: str | None = None) -> CardRecord:
    """
    Parse a payload string into a CardRecord.

    strict=True turns consistency warnings (NIN/DOB mismatch, bad date
    ordering, expired card) into CardParseError instead of collecting them.
    """
    fields, biometric_sections = _split_sections(raw)
    if len(fields) < MIN_FIELDS:
        raise CardParseError(f"expected at least {MIN_FIELDS} fields, found {len(fields)}")

    warnings: list[str] = []

    surname = _decode_name(fields[IDX_SURNAME], "surname")
    given_name = _decode_name(fields[IDX_GIVEN_NAME], "given name")
    other_name = _decode_name(fields[IDX_OTHER_NAME], "other name")

    dob = _parse_date(fields[IDX_DOB], "date of birth")
    issued = _parse_date(fields[IDX_ISSUED], "issue date")
    expires = _parse_date(fields[IDX_EXPIRES], "expiry date")

    nin = fields[IDX_NIN].strip().upper()
    card_number = fields[IDX_CARD_NUMBER].strip()

    parts = parse_nin(nin)
    if not parts:
        warnings.append(f"NIN {nin!r} does not match the expected 14-character layout")
        sex = "Unknown"
    else:
        sex = SEX_CODES.get(parts["sex_code"], "Unknown")
        if f"{dob.year % 100:02d}" != parts["birth_year_short"]:
            warnings.append(
                f"NIN birth year '{parts['birth_year_short']}' does not match "
                f"date of birth year {dob.year}"
            )

    if issued <= dob:
        warnings.append("issue date is not after the date of birth")
    if expires <= issued:
        warnings.append("expiry date is not after the issue date")
    if expires < date.today():
        warnings.append(f"card expired on {expires.isoformat()}")

    head_blob = fields[IDX_MINUTIAE] if len(fields) > IDX_MINUTIAE else ""
    fingerprint = _parse_fingerprint(head_blob, biometric_sections)

    if (
        fingerprint.minutiae_count is not None
        and fingerprint.minutiae_bytes is not None
        and fingerprint.minutiae_bytes % MINUTIA_RECORD_BYTES != 0
    ):
        warnings.append("minutiae block length is not a multiple of the record width")

    if strict and warnings:
        raise CardParseError("; ".join(warnings))

    return CardRecord(
        surname=surname,
        given_name=given_name,
        other_name=other_name,
        date_of_birth=dob,
        issue_date=issued,
        expiry_date=expires,
        nin=nin,
        sex=sex,
        card_number=card_number,
        fingerprint=fingerprint,
        warnings=warnings,
        source=source,
        raw=(raw or "").strip(),
    )


# --------------------------------------------------------------------------
# Scanning
# --------------------------------------------------------------------------
def _require_scanning() -> None:
    if not SCANNING_AVAILABLE:
        raise ScanError(
            "scanning needs zxing-cpp, pillow and numpy "
            f"(import failed: {_IMPORT_ERROR}). Install with: "
            "pip install zxing-cpp pillow numpy"
        )


def resolve_image_path(source: str | os.PathLike[str] | None = None) -> Path:
    """
    Work out which file to read, in precedence order:
    explicit argument -> CARD_IMAGE_PATH env var -> CARD_IMAGE_PATH constant

    Expands ~ and resolves relative paths, and reports the absolute path it
    actually looked at rather than whatever was typed.
    """
    candidate = source or os.environ.get("CARD_IMAGE_PATH") or CARD_IMAGE_PATH
    if not candidate:
        raise ScanError(
            "no image path given. Pass one to parse_card_image(), set the "
            "CARD_IMAGE_PATH constant at the top of this module, or export "
            "CARD_IMAGE_PATH in the environment."
        )
    path = Path(candidate).expanduser().resolve()
    if not path.exists():
        raise ScanError(f"no such file: {path}")
    if path.is_dir():
        raise ScanError(f"{path} is a directory, not an image file")
    return path


def find_symbol_bbox(image) -> tuple[int, int, int, int] | None:
    """
    Find the densest horizontal band of ink and return its bounding box.

    A PDF417 symbol is far denser than surrounding print, so a projection
    profile locates it without any detector model.
    """
    _require_scanning()
    grey = np.asarray(image.convert("L"))
    ink = grey < DARK_THRESHOLD
    row_ink = ink.sum(axis=1)
    rows = np.flatnonzero(row_ink > MIN_ROW_INK)
    if rows.size == 0:
        return None

    bands: list[tuple[int, int]] = []
    start = prev = rows[0]
    for y in rows[1:]:
        if y - prev > 15:
            bands.append((start, prev))
            start = y
        prev = y
    bands.append((start, prev))

    top, bottom = max(bands, key=lambda b: row_ink[b[0] : b[1] + 1].sum())

    col_ink = ink[top : bottom + 1].sum(axis=0)
    cols = np.flatnonzero(col_ink > MIN_COL_INK)
    if cols.size == 0:
        return None

    w, h = image.size
    return (
        max(0, int(cols.min()) - QUIET_ZONE_PX),
        max(0, top - QUIET_ZONE_PX),
        min(w, int(cols.max()) + QUIET_ZONE_PX),
        min(h, bottom + QUIET_ZONE_PX),
    )


def looks_like_card_payload(text: str) -> bool:
    """
    Cheap structural check used to reject corrupt reads.

    A phone photo of a laminated card can produce a read the decoder reports
    as valid but whose text is corrupt, so Reed-Solomon passing is not an
    integrity guarantee. This is the acceptance test for the decode loop.
    """
    if not text or BIOMETRIC_TAG not in text:
        return False

    fields = text.split(BIOMETRIC_TAG)[0].split(";")
    if len(fields) < MIN_FIELDS:
        return False

    for value in fields[0:3]:
        cleaned = value.strip()
        if not cleaned:
            continue
        try:
            decoded = _b64_decode(cleaned).decode("ascii")
        except (CardParseError, UnicodeDecodeError):
            return False
        if not re.fullmatch(r"[A-Z '\-]+", decoded.strip().upper()):
            return False

    if not all(re.fullmatch(r"\d{8}", fields[i].strip()) for i in (3, 4, 5)):
        return False
    if not parse_nin(fields[6]):
        return False

    return True


def _variants(crop):
    grey = crop.convert("L")
    for factor in SCALE_LADDER:
        scaled = (
            grey
            if factor == 1
            else grey.resize((grey.width * factor, grey.height * factor), Image.LANCZOS)
        )
        yield f"grey x{factor}", scaled
        yield f"autocontrast x{factor}", ImageOps.autocontrast(scaled)


def _read(image) -> str | None:
    try:
        results = zxingcpp.read_barcodes(
            image, formats=zxingcpp.BarcodeFormat.PDF417, try_rotate=True
        )
    except TypeError:  # older zxing-cpp without these kwargs
        results = zxingcpp.read_barcodes(image)
    return results[0].text if results else None


def scan_card_image(source=None, *, debug: bool = False) -> tuple[str, str]:
    """
    Decode the PDF417 barcode and return (payload, source_label).

    `source` may be a path, a Path, an already-open PIL Image, or None to fall
    back to CARD_IMAGE_PATH. Raises ScanError if nothing valid is found.
    """
    _require_scanning()

    if isinstance(source, Image.Image):
        image = source
        label = "<PIL.Image>"
    else:
        path = resolve_image_path(source)
        label = str(path)
        if debug:
            print(f"reading {path}", file=sys.stderr)
        try:
            image = Image.open(path)
        except OSError as exc:
            raise ScanError(f"could not open {path} as an image: {exc}") from exc

    bbox = find_symbol_bbox(image)
    regions = [("cropped", image.crop(bbox))] if bbox else []
    regions.append(("full frame", image))  # fallback if localisation missed

    for region_label, region in regions:
        for variant_label, candidate in _variants(region):
            text = _read(candidate)
            if text is None:
                if debug:
                    print(f"  {region_label} / {variant_label}: no read", file=sys.stderr)
                continue
            if looks_like_card_payload(text):
                if debug:
                    print(
                        f"  {region_label} / {variant_label}: OK, {len(text)} chars",
                        file=sys.stderr,
                    )
                return text, label
            if debug:
                print(
                    f"  {region_label} / {variant_label}: decoded {len(text)} chars "
                    "but FAILED validation (corrupt read)",
                    file=sys.stderr,
                )

    raise ScanError(
        "no valid PDF417 payload found. Re-shoot the card: fill the frame, "
        "hold the sensor parallel to the card, diffuse light to kill glare on "
        "the laminate, and keep the whole symbol including quiet zones inside "
        "the frame."
    )


# --------------------------------------------------------------------------
# Combined entry point
# --------------------------------------------------------------------------
def parse_card_image(
    source=None, *, strict: bool = False, debug: bool = False
) -> CardRecord:
    """
    Scan an image of the card back and return the parsed CardRecord.

        record = parse_card_image("scans/card_back.jpg")
        record.surname, record.sex, record.date_of_birth

    `source` may be a path, a Path, an open PIL Image, or None to fall back to
    CARD_IMAGE_PATH. The payload is kept on record.raw.
    """
    payload, label = scan_card_image(source, debug=debug)
    return parse_card(payload, strict=strict, source=label)


def read_card(source, *, strict: bool = False, debug: bool = False) -> CardRecord:
    """
    Accept either an image path or a payload string and return a CardRecord.

    Convenient when input provenance varies (a scanner in one branch, a
    pre-captured string from an upstream service in another).
    """
    if isinstance(source, (str, os.PathLike)):
        text = str(source)
        if BIOMETRIC_TAG in text or (";" in text and not Path(text).expanduser().exists()):
            return parse_card(text, strict=strict, source="<string>")
    return parse_card_image(source, strict=strict, debug=debug)


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def render(record: CardRecord) -> str:
    lines = [
        f"Surname      : {record.surname}",
        f"Given name   : {record.given_name}",
        f"Other name   : {record.other_name}",
        f"Sex          : {record.sex}",
        f"Date of birth: {record.date_of_birth:%d %b %Y} (age {record.age()})",
        f"Issued       : {record.issue_date:%d %b %Y}",
        f"Expires      : {record.expiry_date:%d %b %Y}"
        + (" [EXPIRED]" if record.is_expired else ""),
        f"NIN          : {record.nin}",
        f"Card number  : {record.card_number}",
    ]
    fp = record.fingerprint
    if fp.finger_index is not None or fp.minutiae_bytes is not None:
        lines.append(
            f"Biometrics   : finger {fp.finger_index}, "
            f"{fp.minutiae_count} minutiae, "
            f"{fp.minutiae_bytes} B template, "
            f"{fp.sealed_block_bytes} B sealed block"
        )
    if record.source:
        lines.append(f"Source       : {record.source}")
    for warning in record.warnings:
        lines.append(f"WARNING      : {warning}")
    return "\n".join(lines)


# Kept as an alias so older callers that imported the private name still work.
_render = render


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Read a Ugandan national ID card from an image or a payload string."
    )
    ap.add_argument(
        "source",
        nargs="?",
        default=None,
        help="path to a photo of the card back, or the raw payload string "
        "(default: the CARD_IMAGE_PATH constant or env var)",
    )
    ap.add_argument("--json", action="store_true", help="emit JSON")
    ap.add_argument("--raw", action="store_true", help="print the payload string only")
    ap.add_argument("--strict", action="store_true", help="fail on consistency warnings")
    ap.add_argument("--debug", action="store_true", help="log each decode attempt")
    args = ap.parse_args(argv)

    try:
        record = read_card(args.source, strict=args.strict, debug=args.debug)
    except (ScanError, CardParseError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if args.raw:
        print(record.raw)
    elif args.json:
        print(json.dumps(record.to_dict(), indent=2))
    else:
        print(render(record))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
