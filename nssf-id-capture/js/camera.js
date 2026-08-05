// camera.js
// Handles WebRTC live video feed and OpenCV.js edge-AI auto-capture.

let videoStream = null;
let animationFrameId = null;
let captureSide = null;
let goodFramesCount = 0;
const REQUIRED_GOOD_FRAMES = 10;

const overlay = document.getElementById('camera-overlay');
const video = document.getElementById('camera-video');
const canvas = document.getElementById('camera-canvas');
const msg = document.getElementById('camera-msg');
const btnCancel = document.getElementById('btn-camera-cancel');
const btnManual = document.getElementById('btn-camera-manual');

btnCancel.addEventListener('click', stopCamera);
btnManual.addEventListener('click', () => {
  manualCapture();
});

async function startCamera(side) {
  captureSide = side;
  goodFramesCount = 0;
  overlay.classList.add('active');
  msg.textContent = "Requesting camera...";
  
  try {
    const constraints = {
      video: {
        facingMode: 'environment',
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: false
    };
    videoStream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = videoStream;
    
    video.onloadedmetadata = () => {
      video.play();
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      msg.textContent = "Align ID Card in frame...";
      
      if (typeof window.ensureOpenCvLoaded === 'function') {
        window.ensureOpenCvLoaded().then((loaded) => {
          if (loaded) {
            animationFrameId = requestAnimationFrame(processVideoFrame);
          } else {
            msg.textContent = "OpenCV unavailable. Use Manual Capture.";
          }
        });
      } else {
         animationFrameId = requestAnimationFrame(processVideoFrame);
      }
    };
  } catch (err) {
    let errMsg = err.message || err.name || String(err);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        errMsg = "Secure context (HTTPS) required or not supported.";
    }
    console.error("Camera access failed:", errMsg, err);
    msg.textContent = "Camera access failed: " + errMsg + ". Falling back to native camera...";
    
    setTimeout(() => {
      stopCamera();
      const fallbackInput = document.getElementById(`input-${captureSide}-camera`);
      if (fallbackInput) fallbackInput.click();
    }, 2000);
  }
}

function stopCamera() {
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
  if (videoStream) {
    videoStream.getTracks().forEach(track => track.stop());
    videoStream = null;
  }
  overlay.classList.remove('active');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function processVideoFrame() {
  if (!videoStream || video.paused || video.ended) return;

  const ctx = canvas.getContext('2d');
  const w = video.videoWidth;
  const h = video.videoHeight;
  
  if (w === 0 || h === 0) {
    animationFrameId = requestAnimationFrame(processVideoFrame);
    return;
  }
  
  const scale = 400 / Math.max(w, h);
  const sw = Math.floor(w * scale);
  const sh = Math.floor(h * scale);
  
  const offCanvas = document.createElement('canvas');
  offCanvas.width = sw;
  offCanvas.height = sh;
  const offCtx = offCanvas.getContext('2d', { willReadFrequently: true });
  offCtx.drawImage(video, 0, 0, sw, sh);

  try {
    let src = cv.imread(offCanvas);
    let gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);

    let lap = new cv.Mat();
    cv.Laplacian(gray, lap, cv.CV_64F);
    let mean = new cv.Mat();
    let stddev = new cv.Mat();
    cv.meanStdDev(lap, mean, stddev);
    let variance = stddev.data64F[0] * stddev.data64F[0];
    
    lap.delete(); mean.delete(); stddev.delete();

    if (variance < 100) {
      msg.textContent = "Hold still. Image is blurry.";
      goodFramesCount = 0;
      drawBox(ctx, w, h, 'red');
      src.delete(); gray.delete();
      animationFrameId = requestAnimationFrame(processVideoFrame);
      return;
    }

    let blurred = new cv.Mat();
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
    
    let edges = new cv.Mat();
    cv.Canny(blurred, edges, 75, 200);

    let contours = new cv.MatVector();
    let hierarchy = new cv.Mat();
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let maxArea = 0;
    let bestRect = null;

    for (let i = 0; i < contours.size(); i++) {
      let cnt = contours.get(i);
      let area = cv.contourArea(cnt);
      if (area > (sw * sh * 0.2)) {
        let approx = new cv.Mat();
        let peri = cv.arcLength(cnt, true);
        cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
        
        if (approx.rows === 4) {
          if (area > maxArea) {
            maxArea = area;
            bestRect = approx.clone();
          }
        }
        approx.delete();
      }
    }

    blurred.delete(); edges.delete(); contours.delete(); hierarchy.delete();

    if (bestRect) {
      goodFramesCount++;
      msg.textContent = "Perfect. Hold still... (" + goodFramesCount + "/10)";
      drawBox(ctx, w, h, '#00ff00');
      
      if (goodFramesCount >= REQUIRED_GOOD_FRAMES) {
        src.delete(); gray.delete(); bestRect.delete();
        autoCapture();
        return;
      }
      bestRect.delete();
    } else {
      goodFramesCount = 0;
      msg.textContent = "Align ID Card within the frame.";
      drawBox(ctx, w, h, 'rgba(255,255,255,0.5)');
    }

    src.delete(); gray.delete();
  } catch (err) {
    console.error("OpenCV processing error:", err);
  }

  animationFrameId = requestAnimationFrame(processVideoFrame);
}

function drawBox(ctx, w, h, color) {
  ctx.clearRect(0, 0, w, h);
  const marginX = w * 0.1;
  const marginY = h * 0.2;
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.strokeRect(marginX, marginY, w - (marginX * 2), h - (marginY * 2));
}

function autoCapture() {
  console.log("Auto-capture triggered for", captureSide);
  msg.textContent = "Captured!";
  performCapture();
}

function manualCapture() {
  console.log("Manual capture triggered for", captureSide);
  performCapture();
}

function performCapture() {
  const c = document.createElement('canvas');
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  const ctx = c.getContext('2d');
  ctx.drawImage(video, 0, 0, c.width, c.height);
  
  c.toBlob((blob) => {
    if (!blob) {
      console.error("Failed to create blob from camera frame");
      stopCamera();
      return;
    }
    
    const file = new File([blob], "capture_" + captureSide + "_" + Date.now() + ".jpg", { type: 'image/jpeg' });
    
    if (captureSide === 'barcode') {
       if (typeof window.handleBarcodeFile === 'function') {
         const fakeInput = { files: [file] };
         window.handleBarcodeFile(fakeInput);
       }
    } else {
       if (typeof window.handleFile === 'function') {
         const fakeInput = { files: [file] };
         window.handleFile(captureSide, fakeInput);
       }
    }
    
    stopCamera();
    
    setTimeout(() => {
       if (captureSide !== 'barcode' && typeof window.runOCR === 'function') {
         window.runOCR(captureSide);
       }
    }, 500);

  }, 'image/jpeg', 0.95);
}

window.startCamera = startCamera;
