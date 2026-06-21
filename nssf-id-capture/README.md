# NSSF SmartLife Flexi — ID Capture Tool

A fully **offline** web application for NSSF field staff to capture Uganda National ID data
during SmartLife Flexi enrolment drives. No internet connection, no external API,
no cloud service — everything runs locally in the browser using Tesseract.js OCR.

---

## What it does

1. Field staff upload a photo of both sides of a member's National ID
2. Tesseract.js OCR engine reads the ID images locally on the device
3. Extracted data (NIN, name, DOB, expiry, village, district etc.) auto-fills a form
4. Staff review and correct any OCR errors, then add phone number and collection info
5. Record is saved to a session list
6. At the end of a session, all records export to a formatted `.xlsx` Excel file

---

## Project structure

```
nssf-id-capture/
├── index.html              ← Main app (open this in browser)
├── css/
│   └── style.css           ← Styles
├── js/
│   ├── app.js              ← App logic + OCR parsing
│   ├── xlsx.full.min.js    ← SheetJS (Excel export, offline)
│   ├── tesseract.min.js    ← Tesseract.js OCR engine (offline)
│   ├── worker.min.js       ← Tesseract worker thread
│   ├── tesseract-core-simd-lstm.wasm.js  ← WASM OCR core
│   └── tesseract-core-simd-lstm.wasm     ← WASM binary
├── lang-data/
│   └── eng.traineddata     ← English OCR language model (23 MB)
├── assets/
│   └── favicon.ico
└── README.md
```

---

## How to run

### Option A — VS Code Live Server (recommended)

1. Open the `nssf-id-capture` folder in VS Code
2. Install the **Live Server** extension (by Ritwick Dey) if not already installed
3. Right-click `index.html` → **Open with Live Server**
4. The app opens at `http://127.0.0.1:5500`

> **Why Live Server?** Tesseract.js loads `.wasm` and `.traineddata` files using
> `fetch()`, which requires an HTTP server. Opening `index.html` directly as a
> `file://` URL will block these requests due to browser security (CORS).
> Live Server provides a local HTTP server with one click.

### Option B — Python HTTP server

```bash
cd nssf-id-capture
python -m http.server 5500
```
Then open `http://localhost:5500` in your browser.

### Option C — Node.js HTTP server

```bash
cd nssf-id-capture
npx serve .
```
Then open the URL shown in the terminal.

---

## Usage guide

### Capturing an ID

1. Click the **Front of ID** panel → take a photo or upload an image file
2. Click the **Back of ID** panel → take a photo or upload the back
3. Click **Extract Data** — the OCR progress bar will run (takes 15–40 seconds)
4. Review every field in the form carefully
5. Add the member's **phone number** (not on the ID)
6. Add your name under **Collected By**
7. Click **Save Record**

### Tips for best OCR accuracy

- Take photos in good natural light — avoid glare on the card
- Hold the camera straight above the card, not at an angle
- Make sure the whole card is visible with no cropping
- The **raw OCR text** is shown at the bottom of the form — use this to manually
  correct any field the parser got wrong
- The NIN on Uganda IDs is the short code (e.g. `CM0003510932UXF`),
  NOT the long machine-readable string on the back

### Exporting records

1. Go to the **Records** tab
2. Click **Export Excel** → downloads `NSSF_SmartLife_YYYY-MM-DD.xlsx`
3. The file has two sheets: `NSSF SmartLife Data` (all records) and `Summary`

---

## Uganda National ID — field layout reference

### Front (may be photographed rotated 90°)
| Field | Example |
|---|---|
| SURNAME | LYOMOKI |
| GIVEN NAME | SAMUEL JUNIOR |
| SEX | M |
| NATIONALITY | UGA |
| NIN | CM0003510932UXF |
| DATE OF BIRTH | 13.09.2000 |
| DATE OF EXPIRY | 21.01.2029 |
| CARD NO. | 0119307246 |

### Back
| Field | Example |
|---|---|
| VILLAGE | VILLAGE 12 / NTINDA |
| PARISH | NTINDA |
| S.COUNTY | NAKAWA DIVISION |
| COUNTY | — |
| DISTRICT | KAMPALA |

> The back also has a long machine-readable zone (MRZ) string like
> `IDUGAO1930307246...LYOMOKI<<SAMUEL<JUNIOR<<<<<<` — this is **ignored** by the
> parser; only the printed label fields are extracted.

---

## Data fields exported to Excel

| Column | Source |
|---|---|
| S/N | Auto-numbered |
| SURNAME, GIVEN NAMES, FULL NAME | Front of ID |
| SEX, NATIONALITY | Front of ID |
| DATE OF BIRTH, DATE OF EXPIRY | Front of ID |
| NIN, CARD NUMBER | Front of ID |
| PHONE NUMBER | Entered manually by staff |
| VILLAGE, PARISH, SUB COUNTY, COUNTY, DISTRICT | Back of ID |
| DATE COLLECTED | Auto-filled (today's date) |
| COLLECTED BY | Entered manually by staff |
| NOTES / FLAGS | Any issues noted |

---

## Technical notes

- **Fully offline** after first load — no calls to any external server or API
- Data is stored **in-memory** for the session only — export before closing the tab
- Works on any modern browser: Chrome, Firefox, Edge, Safari
- Mobile-friendly — staff can use phones or tablets in the field
- OCR accuracy depends on photo quality; always verify extracted data visually

---

## Version

`v1.0` — June 2026  
Built for NSSF Uganda Enterprise & Growth Department  
SmartLife Flexi Enrolment Drive — Omoro District
