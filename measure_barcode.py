from PIL import Image
import numpy as np

img = Image.open(r"nssf-id-capture\test\test_back.jpg")
width, height = img.size

# Convert to grayscale using the exact luma coefficients
data = np.array(img)
if len(data.shape) == 3:
    r, g, b = data[:,:,0], data[:,:,1], data[:,:,2]
    grey = 0.299 * r + 0.587 * g + 0.114 * b
else:
    grey = data

DARK_THRESHOLD = 110
ink = (grey < DARK_THRESHOLD).astype(int)

MIN_ROW_INK = 50
row_ink = np.sum(ink, axis=1)

rows = np.where(row_ink > MIN_ROW_INK)[0]
if len(rows) == 0:
    print("No rows found with enough ink")
    exit(1)

bands = []
start = rows[0]
prev = rows[0]
for y in rows[1:]:
    if y - prev > 15:
        bands.append((start, prev))
        start = y
    prev = y
bands.append((start, prev))

top, bottom = bands[0]
best_sum = -1
for s, e in bands:
    band_sum = np.sum(row_ink[s:e+1])
    if band_sum > best_sum:
        best_sum = band_sum
        top, bottom = s, e

MIN_COL_INK = 5
col_ink = np.sum(ink[top:bottom+1, :], axis=0)
cols = np.where(col_ink > MIN_COL_INK)[0]

if len(cols) == 0:
    print("No columns found with enough ink")
    exit(1)

QUIET_ZONE_PX = 20
left = max(0, cols[0] - QUIET_ZONE_PX)
right = min(width, cols[-1] + QUIET_ZONE_PX)
bbox_top = max(0, top - QUIET_ZONE_PX)
bbox_bottom = min(height, bottom + QUIET_ZONE_PX)

bbox_width = right - left
bbox_height = bbox_bottom - bbox_top

# Barcode columns = 12 columns, 17 modules per column = 204 modules.
# We deduct quiet zones (40px total) from the bounding box to get the pure symbol width.
symbol_width = cols[-1] - cols[0]
modules = 204
ppm = symbol_width / modules

print(f"Image Resolution: {width}x{height}")
print(f"Detected Bounding Box: [{left}, {bbox_top}, {right}, {bbox_bottom}]")
print(f"Bounding Box Dimensions: {bbox_width}x{bbox_height} px")
print(f"Isolated Symbol Width (excluding quiet zones): {symbol_width} px")
print(f"Codeword Columns: 12 (17 modules/col = 204 modules total)")
print(f"Estimated Pixels per Module (PPM): {ppm:.3f}")
