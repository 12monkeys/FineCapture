const previewImage = document.getElementById("previewImage");
const previewWrap = document.getElementById("previewWrap");
const empty = document.getElementById("empty");
const meta = document.getElementById("meta");
const downloadBtn = document.getElementById("downloadBtn");
const exportScale = document.getElementById("exportScale");
const exportScaleLabel = document.getElementById("exportScaleLabel");
const quality = document.getElementById("quality");
const qualityLabel = document.getElementById("qualityLabel");
const qualityBlock = document.getElementById("qualityBlock");
const statSource = document.getElementById("statSource");
const statCapture = document.getElementById("statCapture");
const statExport = document.getElementById("statExport");

let capture = null;
let sourceImage = null;

init();

async function init() {
  exportScale.addEventListener("input", updateExportStats);
  quality.addEventListener("input", () => {
    qualityLabel.textContent = Number(quality.value).toFixed(2);
  });
  document.querySelectorAll('input[name="format"]').forEach((el) => {
    el.addEventListener("change", syncQualityVisibility);
  });
  downloadBtn.addEventListener("click", download);
  syncQualityVisibility();

  const response = await chrome.runtime.sendMessage({ type: "GET_LAST_CAPTURE" });
  if (!response?.ok || !response.result) {
    return;
  }

  capture = response.result;
  sourceImage = await loadImage(capture.dataUrl);

  empty.classList.add("hidden");
  previewWrap.classList.remove("hidden");
  previewImage.src = capture.dataUrl;
  downloadBtn.disabled = false;

  const when = new Date(capture.capturedAt).toLocaleString();
  meta.textContent = `${capture.pageTitle} · ${when}`;
  statSource.textContent = capture.targetLabel || "—";
  statCapture.textContent = `${capture.width}×${capture.height} @ ${capture.scalePercent}%`;
  updateExportStats();
}

function syncQualityVisibility() {
  const format = getFormat();
  qualityBlock.classList.toggle("hidden", format === "png");
}

function getFormat() {
  return document.querySelector('input[name="format"]:checked')?.value || "png";
}

function updateExportStats() {
  exportScaleLabel.textContent = `${exportScale.value}%`;
  if (!capture) return;
  const s = Number(exportScale.value) / 100;
  const w = Math.max(1, Math.round(capture.width * s));
  const h = Math.max(1, Math.round(capture.height * s));
  statExport.textContent = `${w}×${h}`;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("No se pudo cargar la captura."));
    img.src = src;
  });
}

async function download() {
  if (!sourceImage || !capture) return;

  const format = getFormat();
  const scale = Number(exportScale.value) / 100;
  const width = Math.max(1, Math.round(sourceImage.width * scale));
  const height = Math.max(1, Math.round(sourceImage.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  if (format === "jpeg") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(sourceImage, 0, 0, width, height);

  const mime = format === "png" ? "image/png" : format === "webp" ? "image/webp" : "image/jpeg";
  const qualityValue = format === "png" ? undefined : Number(quality.value);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, qualityValue));
  if (!blob) {
    alert("No se pudo generar el archivo. Prueba otro formato o una escala menor.");
    return;
  }

  const ext = format === "jpeg" ? "jpg" : format;
  const safeTitle = String(capture.pageTitle || "captura")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .slice(0, 60)
    .trim() || "captura";
  const filename = `FineCapture-${safeTitle}-${width}x${height}.${ext}`;

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
