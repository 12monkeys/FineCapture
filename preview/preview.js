const previewWrap = document.getElementById("previewWrap");
const annotateCanvas = document.getElementById("annotateCanvas");
const textPreview = document.getElementById("textPreview");
const empty = document.getElementById("empty");
const meta = document.getElementById("meta");
const downloadBtn = document.getElementById("downloadBtn");
const copyBtn = document.getElementById("copyBtn");
const exportScale = document.getElementById("exportScale");
const exportScaleLabel = document.getElementById("exportScaleLabel");
const quality = document.getElementById("quality");
const qualityLabel = document.getElementById("qualityLabel");
const qualityBlock = document.getElementById("qualityBlock");
const imageControls = document.getElementById("imageControls");
const textControls = document.getElementById("textControls");
const statSource = document.getElementById("statSource");
const statCapture = document.getElementById("statCapture");
const statExport = document.getElementById("statExport");
const markerSize = document.getElementById("markerSize");
const markerSizeLabel = document.getElementById("markerSizeLabel");
const undoStrokeBtn = document.getElementById("undoStrokeBtn");
const clearStrokesBtn = document.getElementById("clearStrokesBtn");
const doneMarkerBtn = document.getElementById("doneMarkerBtn");

let capture = null;
let sourceImage = null;
let strokes = [];
let currentStroke = null;
let drawing = false;
let markerEnabled = true;

const ctx = annotateCanvas.getContext("2d");

init();

async function init() {
  exportScale.addEventListener("input", updateExportStats);
  quality.addEventListener("input", () => {
    qualityLabel.textContent = Number(quality.value).toFixed(2);
  });
  markerSize.addEventListener("input", () => {
    markerSizeLabel.textContent = markerSize.value;
  });
  document.querySelectorAll('input[name="format"]').forEach((el) => {
    el.addEventListener("change", syncQualityVisibility);
  });
  document.querySelectorAll('input[name="textFormat"]').forEach((el) => {
    el.addEventListener("change", syncTextPreview);
  });
  downloadBtn.addEventListener("click", download);
  copyBtn.addEventListener("click", onCopy);
  undoStrokeBtn.addEventListener("click", undoStroke);
  clearStrokesBtn.addEventListener("click", clearStrokes);
  doneMarkerBtn.addEventListener("click", applyMarkerDone);
  setupDrawing();
  syncQualityVisibility();

  const response = await chrome.runtime.sendMessage({ type: "GET_LAST_CAPTURE" });
  if (!response?.ok || !response.result) {
    return;
  }

  capture = response.result;
  empty.classList.add("hidden");
  downloadBtn.disabled = false;

  const when = new Date(capture.capturedAt).toLocaleString();
  meta.textContent = `${capture.pageTitle} · ${when}`;
  statSource.textContent = capture.targetLabel || "—";

  if (capture.kind === "text") {
    imageControls.classList.add("hidden");
    textControls.classList.remove("hidden");
    copyBtn.classList.remove("hidden");
    copyBtn.textContent = "Copiar texto";
    previewWrap.classList.add("hidden");
    textPreview.classList.remove("hidden");
    markerEnabled = false;
    statCapture.textContent = `${capture.charCount} chars · ${capture.lineCount} líneas`;
    syncTextPreview();
    return;
  }

  imageControls.classList.remove("hidden");
  textControls.classList.add("hidden");
  copyBtn.classList.remove("hidden");
  copyBtn.textContent = "Copiar imagen";
  textPreview.classList.add("hidden");
  previewWrap.classList.remove("hidden");

  sourceImage = await loadImage(capture.dataUrl);
  setupCanvasFromImage();
  redraw();
  syncMarkerButtons();
  statCapture.textContent = `${capture.width}×${capture.height} @ ${capture.scalePercent}%`;
  updateExportStats();
}

function setupCanvasFromImage() {
  annotateCanvas.width = sourceImage.width;
  annotateCanvas.height = sourceImage.height;
}

function setupDrawing() {
    const start = (e) => {
    if (!markerEnabled || capture?.kind === "text") return;
    e.preventDefault();
    drawing = true;
    try {
      annotateCanvas.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const point = getCanvasPoint(e);
    currentStroke = {
      color: getMarkerColor(),
      size: Number(markerSize.value),
      points: [point]
    };
    strokes.push(currentStroke);
    redraw();
    syncMarkerButtons();
    updateExportStats();
  };

  const move = (e) => {
    if (!drawing || !currentStroke) return;
    e.preventDefault();
    currentStroke.points.push(getCanvasPoint(e));
    redraw();
  };

  const end = () => {
    drawing = false;
    currentStroke = null;
    syncMarkerButtons();
  };

  annotateCanvas.addEventListener("pointerdown", start);
  annotateCanvas.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
  annotateCanvas.addEventListener("pointerleave", () => {
    // keep stroke if pointer leaves while pressed; pointerup will finish
  });
}

function getCanvasPoint(e) {
  const rect = annotateCanvas.getBoundingClientRect();
  const scaleX = annotateCanvas.width / Math.max(1, rect.width);
  const scaleY = annotateCanvas.height / Math.max(1, rect.height);
  const src = e.touches?.[0] || e;
  return {
    x: (src.clientX - rect.left) * scaleX,
    y: (src.clientY - rect.top) * scaleY
  };
}

function getMarkerColor() {
  return document.querySelector('input[name="markerColor"]:checked')?.value || "#e11d2e";
}

function redraw() {
  if (!ctx || !sourceImage) return;
  ctx.clearRect(0, 0, annotateCanvas.width, annotateCanvas.height);
  ctx.drawImage(sourceImage, 0, 0);
  for (const stroke of strokes) {
    drawStroke(stroke);
  }
}

function drawStroke(stroke) {
  if (!stroke?.points?.length) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.size;
  ctx.beginPath();
  ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
  for (let i = 1; i < stroke.points.length; i += 1) {
    ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
  }
  if (stroke.points.length === 1) {
    ctx.lineTo(stroke.points[0].x + 0.01, stroke.points[0].y);
  }
  ctx.stroke();
  ctx.restore();
}

function syncMarkerButtons() {
  const hasStrokes = strokes.length > 0;
  undoStrokeBtn.disabled = !hasStrokes;
  clearStrokesBtn.disabled = !hasStrokes;
  doneMarkerBtn.disabled = !hasStrokes;
}

function undoStroke() {
  strokes.pop();
  redraw();
  syncMarkerButtons();
}

function clearStrokes() {
  strokes = [];
  redraw();
  syncMarkerButtons();
}

async function applyMarkerDone() {
  if (!sourceImage || !strokes.length) return;

  // Bake current canvas (image + strokes) into the definitive capture.
  const dataUrl = annotateCanvas.toDataURL("image/png");
  sourceImage = await loadImage(dataUrl);
  strokes = [];
  setupCanvasFromImage();
  redraw();
  syncMarkerButtons();

  capture = {
    ...capture,
    kind: "image",
    dataUrl,
    width: sourceImage.width,
    height: sourceImage.height,
    annotatedAt: Date.now()
  };

  await chrome.runtime.sendMessage({
    type: "UPDATE_LAST_CAPTURE",
    payload: capture
  });

  statCapture.textContent = `${capture.width}×${capture.height} · anotada`;
  updateExportStats();

  doneMarkerBtn.textContent = "Hecho ✓";
  setTimeout(() => {
    doneMarkerBtn.textContent = "Hecho";
  }, 1200);
}

function syncQualityVisibility() {
  const format = getFormat();
  qualityBlock.classList.toggle("hidden", format === "png");
}

function getFormat() {
  return document.querySelector('input[name="format"]:checked')?.value || "png";
}

function getTextFormat() {
  return document.querySelector('input[name="textFormat"]:checked')?.value || "txt";
}

function getExportText() {
  if (!capture || capture.kind !== "text") return "";
  return getTextFormat() === "md" ? (capture.markdown || capture.text) : capture.text;
}

function syncTextPreview() {
  if (!capture || capture.kind !== "text") return;
  const body = getExportText();
  textPreview.textContent = body;
  statExport.textContent = getTextFormat() === "md" ? "Markdown (.md)" : "Texto (.txt)";
}

function updateExportStats() {
  exportScaleLabel.textContent = `${exportScale.value}%`;
  if (!capture || capture.kind === "text") return;
  const baseW = sourceImage?.width || capture.width;
  const baseH = sourceImage?.height || capture.height;
  const s = Number(exportScale.value) / 100;
  const w = Math.max(1, Math.round(baseW * s));
  const h = Math.max(1, Math.round(baseH * s));
  const pending = strokes.length ? " · con trazos" : "";
  statExport.textContent = `${w}×${h}${pending}`;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("No se pudo cargar la captura."));
    img.src = src;
  });
}

function safeFilename(title) {
  return String(title || "captura")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .slice(0, 60)
    .trim() || "captura";
}

async function onCopy() {
  if (capture?.kind === "text") {
    await copyText();
    return;
  }
  await copyImage();
}

async function copyText() {
  const body = getExportText();
  if (!body) return;
  await navigator.clipboard.writeText(body);
  flashCopyLabel("Texto copiado");
}

async function buildExportCanvas() {
  // Include unsaved strokes if any, so copy/download matches what you see.
  const scale = Number(exportScale.value) / 100;
  const width = Math.max(1, Math.round(annotateCanvas.width * scale));
  const height = Math.max(1, Math.round(annotateCanvas.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const exportCtx = canvas.getContext("2d");
  if (!exportCtx) return null;

  const format = getFormat();
  if (format === "jpeg") {
    exportCtx.fillStyle = "#ffffff";
    exportCtx.fillRect(0, 0, width, height);
  }

  exportCtx.imageSmoothingEnabled = true;
  exportCtx.imageSmoothingQuality = "high";
  exportCtx.drawImage(annotateCanvas, 0, 0, width, height);
  return canvas;
}

async function copyImage() {
  if (!sourceImage) return;
  const canvas = await buildExportCanvas();
  if (!canvas) return;

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) {
    alert("No se pudo copiar la imagen.");
    return;
  }

  try {
    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": blob })
    ]);
    flashCopyLabel("Imagen copiada");
  } catch (error) {
    alert(`No se pudo copiar la imagen: ${error.message || error}`);
  }
}

function flashCopyLabel(label) {
  const previous = copyBtn.textContent;
  copyBtn.textContent = label;
  setTimeout(() => {
    copyBtn.textContent = previous;
  }, 1200);
}

async function download() {
  if (!capture) return;

  if (capture.kind === "text") {
    const ext = getTextFormat() === "md" ? "md" : "txt";
    const body = getExportText();
    const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
    const filename = `FineCapture-${safeFilename(capture.pageTitle)}.${ext}`;
    const url = URL.createObjectURL(blob);
    try {
      await chrome.downloads.download({ url, filename, saveAs: true });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    }
    return;
  }

  if (!sourceImage) return;

  const canvas = await buildExportCanvas();
  if (!canvas) return;

  const format = getFormat();
  const mime = format === "png" ? "image/png" : format === "webp" ? "image/webp" : "image/jpeg";
  const qualityValue = format === "png" ? undefined : Number(quality.value);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, qualityValue));
  if (!blob) {
    alert("No se pudo generar el archivo. Prueba otro formato o una escala menor.");
    return;
  }

  const ext = format === "jpeg" ? "jpg" : format;
  const filename = `FineCapture-${safeFilename(capture.pageTitle)}-${canvas.width}x${canvas.height}.${ext}`;
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({
      url,
      filename,
      saveAs: true
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}
