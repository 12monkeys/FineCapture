const previewImage = document.getElementById("previewImage");
const previewWrap = document.getElementById("previewWrap");
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
  document.querySelectorAll('input[name="textFormat"]').forEach((el) => {
    el.addEventListener("change", syncTextPreview);
  });
  downloadBtn.addEventListener("click", download);
  copyBtn.addEventListener("click", copyText);
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
    previewWrap.classList.add("hidden");
    textPreview.classList.remove("hidden");
    statCapture.textContent = `${capture.charCount} chars · ${capture.lineCount} líneas`;
    syncTextPreview();
    return;
  }

  imageControls.classList.remove("hidden");
  textControls.classList.add("hidden");
  copyBtn.classList.add("hidden");
  textPreview.classList.add("hidden");
  previewWrap.classList.remove("hidden");

  sourceImage = await loadImage(capture.dataUrl);
  previewImage.src = capture.dataUrl;
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

function safeFilename(title) {
  return String(title || "captura")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .slice(0, 60)
    .trim() || "captura";
}

async function copyText() {
  const body = getExportText();
  if (!body) return;
  await navigator.clipboard.writeText(body);
  copyBtn.textContent = "Copiado";
  setTimeout(() => {
    copyBtn.textContent = "Copiar texto";
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
  const filename = `FineCapture-${safeFilename(capture.pageTitle)}-${width}x${height}.${ext}`;

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
