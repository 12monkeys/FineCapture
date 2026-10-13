const targetSelect = document.getElementById("targetSelect");
const scaleRange = document.getElementById("scaleRange");
const scaleValue = document.getElementById("scaleValue");
const statusEl = document.getElementById("status");
const progressWrap = document.getElementById("progressWrap");
const progressBar = document.getElementById("progressBar");
const captureBtn = document.getElementById("captureBtn");
const miniPreview = document.getElementById("miniPreview");
const thumb = document.getElementById("thumb");
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
      setStatus(`Capturando… ${message.current}/${message.total}`);
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

  await loadTargets();
  await showLastCapture();
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

async function ensureContent(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
  } catch {
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
  setStatus("Preparando captura…");

  try {
    selectedTargetId = targetSelect.value;
    const response = await chrome.runtime.sendMessage({
      type: "START_CAPTURE",
      payload: {
        targetId: selectedTargetId,
        scale: Number(scaleRange.value)
      }
    });

    if (!response?.ok) throw new Error(response?.error || "Captura fallida.");
    renderPreview(response.result);
    setStatus("Captura lista.", "ok");
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
  thumb.src = result.dataUrl;
  dims.textContent = `${result.width}×${result.height} · ${result.scalePercent}%`;
}

async function openPreview() {
  await chrome.runtime.sendMessage({ type: "OPEN_PREVIEW" });
}
