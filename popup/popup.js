const targetSelect = document.getElementById("targetSelect");
const selectedZoneEl = document.getElementById("selectedZone");
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
let selectedMeta = {
  targetId: "document",
  label: "Página completa (ventana)",
  kind: "document",
  kindLabel: "página",
  fingerprint: null
};

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
    const opt = targetSelect.selectedOptions[0];
    selectedMeta = {
      targetId: selectedTargetId,
      label: opt?.dataset.label || opt?.textContent || selectedTargetId,
      kind: opt?.dataset.kind || (selectedTargetId === "document" ? "document" : "region"),
      kindLabel: opt?.dataset.kindLabel || "",
      fingerprint: opt?.dataset.fingerprint ? safeJsonParse(opt.dataset.fingerprint) : null
    };
    persistSelectedMeta(selectedMeta);
    showSelectedZone(selectedMeta.label);
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
      const meta = message.meta || {
        targetId: message.targetId,
        label: message.label,
        kind: message.kind,
        kindLabel: message.kindLabel,
        fingerprint: message.fingerprint
      };
      applySelectedMeta(meta);
      ensureOptionSelected(meta.targetId, meta.label, meta);
      showSelectedZone(meta.label);
      setStatus("Zona seleccionada en la página.", "ok");
    }
    if (message?.type === "PICK_CANCELLED") {
      setStatus("Selección cancelada.");
    }
  });

  const stored = await chrome.storage.session.get([
    "fineCaptureSelectedTarget",
    "fineCaptureSelectedMeta"
  ]);
  if (stored?.fineCaptureSelectedMeta?.targetId) {
    selectedMeta = stored.fineCaptureSelectedMeta;
    selectedTargetId = selectedMeta.targetId;
  } else if (stored?.fineCaptureSelectedTarget) {
    selectedTargetId = stored.fineCaptureSelectedTarget;
    selectedMeta = { ...selectedMeta, targetId: selectedTargetId };
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

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function applySelectedMeta(meta) {
  if (!meta?.targetId) return;
  selectedMeta = {
    targetId: meta.targetId,
    label: meta.label || meta.targetId,
    kind: meta.kind || (meta.targetId === "document" ? "document" : "region"),
    kindLabel: meta.kindLabel || "",
    fingerprint: meta.fingerprint || null,
    sizeLabel: meta.sizeLabel,
    nesting: meta.nesting,
    childCount: meta.childCount,
    containerKind: meta.containerKind
  };
  selectedTargetId = selectedMeta.targetId;
  persistSelectedMeta(selectedMeta);
}

function persistSelectedMeta(meta) {
  chrome.storage.session.set({
    fineCaptureSelectedTarget: meta.targetId,
    fineCaptureSelectedMeta: meta
  });
}

function showSelectedZone(label) {
  if (!selectedZoneEl) return;
  const text = label || selectedMeta.label || "";
  if (!text) {
    selectedZoneEl.textContent = "";
    selectedZoneEl.hidden = true;
    return;
  }
  selectedZoneEl.hidden = false;
  selectedZoneEl.textContent = `Zona elegida: ${text}`;
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

const CONTENT_SCRIPT_VERSION = 12;

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

function formatOptionLabel(t) {
  if (!t) return "Zona";
  if (t.kind === "document") {
    return t.label || "Página completa (ventana)";
  }
  // Prefer the content-script friendly label; avoid opaque class hashes.
  return t.label || `${t.kindLabel || "Zona"} · ${t.sizeLabel || `${t.scrollHeight}px`}`;
}

function fillOption(opt, t) {
  opt.value = t.id;
  opt.textContent = formatOptionLabel(t);
  opt.dataset.label = t.label || opt.textContent;
  opt.dataset.kind = t.kind || "";
  opt.dataset.kindLabel = t.kindLabel || "";
  if (t.fingerprint) opt.dataset.fingerprint = JSON.stringify(t.fingerprint);
  if (t.sizeLabel) opt.dataset.sizeLabel = t.sizeLabel;
  if (t.nesting != null) opt.dataset.nesting = String(t.nesting);
  if (t.childCount != null) opt.dataset.childCount = String(t.childCount);
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
      fillOption(opt, t);
      targetSelect.appendChild(opt);
    }

    const resolved = await chrome.tabs.sendMessage(tab.id, {
      type: "RESOLVE_SELECTION",
      meta: selectedMeta?.targetId ? selectedMeta : { targetId: selectedTargetId }
    });

    if (resolved?.ok) {
      applySelectedMeta(resolved);
      ensureOptionSelected(resolved.targetId, resolved.label, resolved);
    } else if (![...targetSelect.options].some((o) => o.value === selectedTargetId)) {
      selectedTargetId = "document";
      selectedMeta = {
        targetId: "document",
        label: "Página completa (ventana)",
        kind: "document",
        kindLabel: "página",
        fingerprint: null
      };
      persistSelectedMeta(selectedMeta);
    }

    targetSelect.value = selectedTargetId;
    showSelectedZone(selectedMeta.label);
    setStatus(`${res.targets.length} zona(s) detectada(s).`);
    await highlightSelected();
  } catch (error) {
    setStatus(String(error.message || error), "error");
  }
}

function ensureOptionSelected(targetId, label, meta = null) {
  if (!targetId) return;
  let opt = [...targetSelect.options].find((o) => o.value === targetId);
  if (!opt) {
    opt = document.createElement("option");
    fillOption(opt, {
      id: targetId,
      label: label || (targetId === "document" ? "Página completa (ventana)" : targetId),
      kind: meta?.kind || (targetId === "document" ? "document" : "region"),
      kindLabel: meta?.kindLabel,
      fingerprint: meta?.fingerprint,
      sizeLabel: meta?.sizeLabel,
      nesting: meta?.nesting,
      childCount: meta?.childCount
    });
    targetSelect.appendChild(opt);
  } else if (label) {
    opt.textContent = label;
    opt.dataset.label = label;
    if (meta?.kind) opt.dataset.kind = meta.kind;
    if (meta?.kindLabel) opt.dataset.kindLabel = meta.kindLabel;
    if (meta?.fingerprint) opt.dataset.fingerprint = JSON.stringify(meta.fingerprint);
  }
  targetSelect.value = targetId;
  selectedTargetId = targetId;
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
    // Close popup only; never reload or navigate the page tab.
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
    selectedTargetId = targetSelect.value || selectedTargetId;
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
