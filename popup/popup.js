const targetSelect = document.getElementById("targetSelect");
const scaleRange = document.getElementById("scaleRange");
const scaleValue = document.getElementById("scaleValue");
const hideFixed = document.getElementById("hideFixed");
const expandSliders = document.getElementById("expandSliders");
const expandCollapsed = document.getElementById("expandCollapsed");
const reverseText = document.getElementById("reverseText");
const scalePanel = document.getElementById("scalePanel");
const textPanel = document.getElementById("textPanel");
const cleanPanel = document.getElementById("cleanPanel");
const modeHint = document.getElementById("modeHint");
const statusEl = document.getElementById("status");
const progressWrap = document.getElementById("progressWrap");
const progressBar = document.getElementById("progressBar");
const captureBtn = document.getElementById("captureBtn");
const miniPreview = document.getElementById("miniPreview");
const thumb = document.getElementById("thumb");
const textThumb = document.getElementById("textThumb");
const dims = document.getElementById("dims");

let selectedTargetId = "document";

init();

async function init() {
  scaleRange.addEventListener("input", syncScaleLabel);
  syncScaleLabel();

  document.getElementById("refreshTargets").addEventListener("click", () => loadTargets());
  document.getElementById("pickOnPage").addEventListener("click", pickOnPage);
  document.getElementById("openPreview").addEventListener("click", openPreview);
  captureBtn.addEventListener("click", runCapture);
  hideFixed.addEventListener("change", () => {
    chrome.storage.local.set({ fineCaptureHideFixed: hideFixed.checked });
  });
  expandSliders.addEventListener("change", () => {
    chrome.storage.local.set({ fineCaptureExpandSliders: expandSliders.checked });
  });
  reverseText.addEventListener("change", () => {
    chrome.storage.local.set({ fineCaptureReverseText: reverseText.checked });
  });
  expandCollapsed.addEventListener("change", () => {
    chrome.storage.local.set({ fineCaptureExpandCollapsed: expandCollapsed.checked });
  });
  document.querySelectorAll('input[name="captureMode"]').forEach((el) => {
    el.addEventListener("change", onModeChange);
  });
  targetSelect.addEventListener("change", () => {
    selectedTargetId = targetSelect.value;
    chrome.storage.session.set({ fineCaptureSelectedTarget: selectedTargetId });
    highlightSelected();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "CAPTURE_PROGRESS") {
      const pct = Math.round((message.current / message.total) * 100);
      progressWrap.classList.remove("hidden");
      progressBar.style.width = `${pct}%`;
      const phaseLabel = message.phase === "slider" ? "Slides" : "Página";
      setStatus(`${phaseLabel}… ${message.current}/${message.total}`);
    }
    if (message?.type === "PICK_RESULT") {
      selectedTargetId = message.targetId;
      ensureOptionSelected(message.targetId);
      setStatus("Zona seleccionada en la página.", "ok");
    }
    if (message?.type === "PICK_CANCELLED") {
      setStatus("Selección cancelada.");
    }
  });

  const stored = await chrome.storage.session.get("fineCaptureSelectedTarget");
  if (stored?.fineCaptureSelectedTarget) {
    selectedTargetId = stored.fineCaptureSelectedTarget;
  }

  const prefs = await chrome.storage.local.get([
    "fineCaptureHideFixed",
    "fineCaptureMode",
    "fineCaptureExpandSliders",
    "fineCaptureReverseText",
    "fineCaptureExpandCollapsed"
  ]);
  if (typeof prefs.fineCaptureHideFixed === "boolean") {
    hideFixed.checked = prefs.fineCaptureHideFixed;
  }
  if (typeof prefs.fineCaptureExpandSliders === "boolean") {
    expandSliders.checked = prefs.fineCaptureExpandSliders;
  }
  if (typeof prefs.fineCaptureReverseText === "boolean") {
    reverseText.checked = prefs.fineCaptureReverseText;
  }
  if (typeof prefs.fineCaptureExpandCollapsed === "boolean") {
    expandCollapsed.checked = prefs.fineCaptureExpandCollapsed;
  }
  if (prefs.fineCaptureMode === "text" || prefs.fineCaptureMode === "image") {
    const radio = document.querySelector(`input[name="captureMode"][value="${prefs.fineCaptureMode}"]`);
    if (radio) radio.checked = true;
  }

  syncModeUi();
  await loadTargets();
  await showLastCapture();
}

function getMode() {
  return document.querySelector('input[name="captureMode"]:checked')?.value || "image";
}

function onModeChange() {
  chrome.storage.local.set({ fineCaptureMode: getMode() });
  syncModeUi();
}

function syncModeUi() {
  const textMode = getMode() === "text";
  scalePanel.classList.toggle("hidden", textMode);
  cleanPanel.classList.toggle("hidden", textMode);
  textPanel.classList.toggle("hidden", !textMode);
  captureBtn.textContent = textMode ? "Extraer texto" : "Capturar";
  modeHint.textContent = textMode
    ? "Extrae solo el texto del DOM de la zona (ideal para chats). Respeta títulos y bloques."
    : "Captura visual con scroll automático.";
}

function syncScaleLabel() {
  scaleValue.textContent = `${scaleRange.value}%`;
}

function setStatus(text, kind = "") {
  statusEl.textContent = text || "";
  statusEl.className = `status${kind ? ` ${kind}` : ""}`;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

const CONTENT_SCRIPT_VERSION = 9;

async function ensureContent(tabId) {
  let needsInject = true;
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { type: "PING" });
    needsInject = ping?.version !== CONTENT_SCRIPT_VERSION;
  } catch {
    needsInject = true;
  }
  if (needsInject) {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["content/content.css"] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content/content.js"] });
  }
}

async function loadTargets() {
  try {
    const tab = await getActiveTab();
    if (!tab?.id) throw new Error("Sin pestaña activa.");
    await ensureContent(tab.id);
    const res = await chrome.tabs.sendMessage(tab.id, { type: "LIST_SCROLL_TARGETS" });
    if (!res?.ok) throw new Error(res?.error || "No se pudieron listar zonas.");

    targetSelect.innerHTML = "";
    for (const t of res.targets) {
      const opt = document.createElement("option");
      opt.value = t.id;
      const sizeHint = t.kind === "document"
        ? `${t.scrollHeight}px alto`
        : `${t.scrollHeight}px · ${t.selectorHint}`;
      opt.textContent = `${t.label} — ${sizeHint}`;
      targetSelect.appendChild(opt);
    }

    if (![...targetSelect.options].some((o) => o.value === selectedTargetId)) {
      selectedTargetId = "document";
    }
    targetSelect.value = selectedTargetId;
    setStatus(`${res.targets.length} zona(s) detectada(s).`);
  } catch (error) {
    setStatus(String(error.message || error), "error");
  }
}

function ensureOptionSelected(targetId) {
  if (![...targetSelect.options].some((o) => o.value === targetId)) {
    const opt = document.createElement("option");
    opt.value = targetId;
    opt.textContent = targetId === "document" ? "Página completa (ventana)" : targetId;
    targetSelect.appendChild(opt);
  }
  targetSelect.value = targetId;
}

async function highlightSelected() {
  try {
    const tab = await getActiveTab();
    await ensureContent(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: "HIGHLIGHT_TARGET", targetId: selectedTargetId });
  } catch {
    /* ignore */
  }
}

async function pickOnPage() {
  try {
    const tab = await getActiveTab();
    await ensureContent(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: "START_PICKER" });
    setStatus("Elige una zona en la página…");
    window.close();
  } catch (error) {
    setStatus(String(error.message || error), "error");
  }
}

async function runCapture() {
  captureBtn.disabled = true;
  progressWrap.classList.remove("hidden");
  progressBar.style.width = "0%";
  const mode = getMode();
  setStatus(mode === "text" ? "Extrayendo texto…" : "Preparando captura…");

  try {
    selectedTargetId = targetSelect.value;
    const response = await chrome.runtime.sendMessage({
      type: "START_CAPTURE",
      payload: {
        mode,
        targetId: selectedTargetId,
        scale: Number(scaleRange.value),
        hideFixedOverlays: hideFixed.checked,
        expandSliders: expandSliders.checked,
        reverseTextOrder: reverseText.checked,
        expandCollapsed: expandCollapsed.checked
      }
    });

    if (!response?.ok) throw new Error(response?.error || "Captura fallida.");
    renderPreview(response.result);
    setStatus(mode === "text" ? "Texto extraído." : "Captura lista.", "ok");
    progressBar.style.width = "100%";
  } catch (error) {
    setStatus(String(error.message || error), "error");
  } finally {
    captureBtn.disabled = false;
  }
}

async function showLastCapture() {
  const response = await chrome.runtime.sendMessage({ type: "GET_LAST_CAPTURE" });
  if (response?.ok && response.result) {
    renderPreview(response.result);
  }
}

function renderPreview(result) {
  miniPreview.classList.remove("hidden");
  const isText = result.kind === "text";

  thumb.classList.toggle("hidden", isText);
  textThumb.classList.toggle("hidden", !isText);

  if (isText) {
    textThumb.textContent = result.text.slice(0, 1200) + (result.text.length > 1200 ? "…" : "");
    dims.textContent = `${result.charCount} chars · ${result.lineCount} líneas`;
  } else {
    thumb.src = result.dataUrl;
    dims.textContent = `${result.width}×${result.height} · ${result.scalePercent}%`;
  }
}

async function openPreview() {
  await chrome.runtime.sendMessage({ type: "OPEN_PREVIEW" });
}
