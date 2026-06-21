Place bundled offline PaddleOCR ONNX assets here:

- det.onnx
- rec.onnx
- cls.onnx (optional angle classifier)
- keys.txt

Recommended production flow:
1. Export PaddleOCR mobile detection and recognition models to ONNX.
2. Quantize where accuracy remains acceptable.
3. Store model version in the APK assets.
4. Never download models at runtime.
