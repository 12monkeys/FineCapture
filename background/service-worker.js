const CAPTURE_STORE_KEY = "fineCaptureLast";
let lastCaptureMemory = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "START_CAPTURE") {
    startCapture(message.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === "GET_LAST_CAPTURE") {
    if (lastCaptureMemory) {
      sendResponse({ ok: true, result: lastCaptureMemory });
      return false;
    }
    chrome.storage.session.get(CAPTURE_STORE_KEY).then((data) => {
      sendResponse({ ok: true, result: data[CAPTURE_STORE_KEY] || null });
    });
    return true;
  }

  if (message?.type === "OPEN_PREVIEW") {
    chrome.tabs.create({ url: chrome.runtime.getURL("preview/preview.html") });
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No hay una pestaña activa.");
  if (!tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://") || tab.url.startsWith("edge://") || tab.url.startsWith("about:")) {
    throw new Error("Esta página no se puede capturar (URL restringida del navegador).");
  }
  return tab;
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
  } catch {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["content/content.css"] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content/content.js"] });
    await wait(80);
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startCapture(payload) {
  const tab = await getActiveTab();
  await ensureContentScript(tab.id);

  const scale = clamp(Number(payload?.scale ?? 100), 10, 100) / 100;
  const targetId = payload?.targetId ?? "document";

  const prep = await chrome.tabs.sendMessage(tab.id, {
    type: "PREPARE_CAPTURE",
    targetId
  });

  if (!prep?.ok) {
    throw new Error(prep?.error || "No se pudo preparar la captura.");
  }

  const metrics = prep.metrics;
  const slices = [];
  const totalSteps = metrics.steps;

  try {
    for (let i = 0; i < totalSteps; i++) {
      const positioned = await chrome.tabs.sendMessage(tab.id, {
        type: "SCROLL_TO_STEP",
        targetId,
        step: i,
        metrics
      });

      if (!positioned?.ok) {
        throw new Error(positioned?.error || `Error al hacer scroll en el paso ${i + 1}.`);
      }

      await wait(120);

      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: "png"
      });

      slices.push({
        dataUrl,
        crop: positioned.crop,
        overlap: positioned.overlap || 0,
        isLast: i === totalSteps - 1
      });

      await chrome.runtime.sendMessage({
        type: "CAPTURE_PROGRESS",
        current: i + 1,
        total: totalSteps
      }).catch(() => {});
    }
  } finally {
    await chrome.tabs.sendMessage(tab.id, { type: "CLEANUP_CAPTURE", targetId }).catch(() => {});
  }

  const stitched = await stitchInTab(tab.id, slices, scale);

  const result = {
    dataUrl: stitched.dataUrl,
    width: stitched.width,
    height: stitched.height,
    scalePercent: Math.round(scale * 100),
    targetLabel: metrics.label,
    pageTitle: tab.title || "captura",
    capturedAt: Date.now()
  };

  lastCaptureMemory = result;
  try {
    await chrome.storage.session.set({ [CAPTURE_STORE_KEY]: result });
  } catch {
    // Capturas muy grandes pueden superar la cuota de storage; la memoria del SW sigue sirviendo el preview.
  }

  await chrome.tabs.create({ url: chrome.runtime.getURL("preview/preview.html") });
  return result;
}

async function stitchInTab(tabId, slices, scale) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: stitchSlicesInPage,
    args: [slices, scale]
  });

  if (!result?.ok) {
    throw new Error(result?.error || "Error al unir las capturas.");
  }
  return result;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/**
 * Runs inside the page isolated world — has DOM/Canvas.
 */
async function stitchSlicesInPage(slices, scale) {
  const MAX_CANVAS = 16384;

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("No se pudo leer una captura parcial."));
      img.src = dataUrl;
    });
  }

  try {
    if (!slices?.length) {
      return { ok: false, error: "No hay fragmentos para unir." };
    }

    const images = [];
    for (const slice of slices) {
      images.push(await loadImage(slice.dataUrl));
    }

    const dpr = images[0].width / (slices[0].crop.viewportWidth || images[0].width);
    const crop0 = slices[0].crop;
    const outWidthCss = crop0.width;
    const outHeightCss = slices.reduce((sum, slice, i) => {
      if (i === 0) return slice.crop.height;
      const add = slice.crop.height - (slice.overlap || 0);
      return sum + Math.max(0, add);
    }, 0);

    let targetW = Math.round(outWidthCss * dpr * scale);
    let targetH = Math.round(outHeightCss * dpr * scale);

    if (targetW > MAX_CANVAS || targetH > MAX_CANVAS) {
      const fit = Math.min(MAX_CANVAS / targetW, MAX_CANVAS / targetH, 1);
      targetW = Math.max(1, Math.floor(targetW * fit));
      targetH = Math.max(1, Math.floor(targetH * fit));
      scale = scale * fit;
    }

    const canvas = document.createElement("canvas");
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { ok: false, error: "Canvas no disponible." };

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    let destY = 0;
    for (let i = 0; i < slices.length; i++) {
      const slice = slices[i];
      const img = images[i];
      const c = slice.crop;
      const overlap = slice.overlap || 0;

      const srcX = Math.round(c.x * dpr);
      const srcY = Math.round(c.y * dpr);
      const srcW = Math.round(c.width * dpr);
      const fullSrcH = Math.round(c.height * dpr);
      const overlapPx = Math.round(overlap * dpr);
      const srcH = i === 0 ? fullSrcH : Math.max(1, fullSrcH - overlapPx);
      const srcYAdj = i === 0 ? srcY : srcY + overlapPx;

      const drawW = Math.round(srcW * scale);
      const drawH = Math.round(srcH * scale);

      ctx.drawImage(
        img,
        srcX,
        Math.min(srcYAdj, img.height - 1),
        Math.min(srcW, img.width - srcX),
        Math.min(srcH, img.height - srcYAdj),
        0,
        destY,
        drawW,
        drawH
      );

      destY += drawH;
    }

    // Trim canvas if rounding left empty space at bottom
    if (destY > 0 && destY < canvas.height) {
      const trimmed = document.createElement("canvas");
      trimmed.width = canvas.width;
      trimmed.height = destY;
      trimmed.getContext("2d").drawImage(canvas, 0, 0);
      return {
        ok: true,
        dataUrl: trimmed.toDataURL("image/png"),
        width: trimmed.width,
        height: trimmed.height
      };
    }

    return {
      ok: true,
      dataUrl: canvas.toDataURL("image/png"),
      width: canvas.width,
      height: canvas.height
    };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}
