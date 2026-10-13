const CAPTURE_STORE_KEY = "fineCaptureLast";
/** Chrome enforces MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND (typically 2/s). */
const MIN_CAPTURE_INTERVAL_MS = 600;
const PAINT_SETTLE_MS = 180;
const CAPTURE_MAX_RETRIES = 4;

let lastCaptureMemory = null;
let lastCaptureVisibleAt = 0;

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

const CONTENT_SCRIPT_VERSION = 6;

async function ensureContentScript(tabId) {
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
    await wait(80);
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCaptureQuotaError(error) {
  const text = String(error?.message || error || "");
  return /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i.test(text);
}

async function captureVisibleTabThrottled(windowId) {
  let attempt = 0;
  while (true) {
    const elapsed = Date.now() - lastCaptureVisibleAt;
    if (elapsed < MIN_CAPTURE_INTERVAL_MS) {
      await wait(MIN_CAPTURE_INTERVAL_MS - elapsed);
    }

    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
      lastCaptureVisibleAt = Date.now();
      return dataUrl;
    } catch (error) {
      attempt += 1;
      if (!isCaptureQuotaError(error) || attempt > CAPTURE_MAX_RETRIES) {
        throw error;
      }
      // Back off harder if Chrome still rate-limits us.
      await wait(MIN_CAPTURE_INTERVAL_MS * (attempt + 1));
    }
  }
}

async function startCapture(payload) {
  const mode = payload?.mode === "text" ? "text" : "image";
  if (mode === "text") {
    return startTextCapture(payload);
  }
  return startImageCapture(payload);
}

async function saveCaptureResult(result) {
  lastCaptureMemory = result;
  try {
    await chrome.storage.session.set({ [CAPTURE_STORE_KEY]: result });
  } catch {
    // Capturas muy grandes pueden superar la cuota de storage; la memoria del SW sigue sirviendo el preview.
  }
  await chrome.tabs.create({ url: chrome.runtime.getURL("preview/preview.html") });
  return result;
}

async function startTextCapture(payload) {
  const tab = await getActiveTab();
  await ensureContentScript(tab.id);

  const targetId = payload?.targetId ?? "document";
  const extracted = await chrome.tabs.sendMessage(tab.id, {
    type: "EXTRACT_TEXT",
    targetId
  });

  if (!extracted?.ok) {
    throw new Error(extracted?.error || "No se pudo extraer el texto.");
  }

  const result = {
    kind: "text",
    text: extracted.result.text,
    markdown: extracted.result.markdown,
    charCount: extracted.result.charCount,
    lineCount: extracted.result.lineCount,
    targetLabel: extracted.result.label,
    pageTitle: tab.title || "captura",
    capturedAt: Date.now()
  };

  return saveCaptureResult(result);
}

async function emitProgress(current, total, phase = "page") {
  await chrome.runtime.sendMessage({
    type: "CAPTURE_PROGRESS",
    current,
    total,
    phase
  }).catch(() => {});
}

async function captureSliderStrips(tab, targetId, scale) {
  const found = await chrome.tabs.sendMessage(tab.id, {
    type: "FIND_SLIDERS",
    targetId
  });

  if (!found?.ok || !found.sliders?.length) {
    return [];
  }

  const strips = [];

  for (const slider of found.sliders) {
    const slideSlices = [];
    for (let i = 0; i < slider.slideCount; i += 1) {
      const positioned = await chrome.tabs.sendMessage(tab.id, {
        type: "SLIDER_GO_TO",
        sliderId: slider.id,
        index: i
      });
      if (!positioned?.ok) {
        throw new Error(positioned?.error || `No se pudo mostrar el slide ${i + 1}.`);
      }

      await wait(PAINT_SETTLE_MS);
      const dataUrl = await captureVisibleTabThrottled(tab.windowId);
      slideSlices.push({
        dataUrl,
        crop: positioned.crop,
        overlap: 0,
        isLast: i === slider.slideCount - 1
      });

      await emitProgress(i + 1, slider.slideCount, "slider");
    }

    await chrome.tabs.sendMessage(tab.id, {
      type: "SLIDER_RESTORE",
      sliderId: slider.id
    }).catch(() => {});

    const stitchedSlides = await stitchInTab(tab.id, slideSlices, scale);
    const geometry = await chrome.tabs.sendMessage(tab.id, {
      type: "SLIDER_GEOMETRY",
      sliderId: slider.id,
      targetId
    });

    if (!geometry?.ok) {
      throw new Error(geometry?.error || "No se pudo medir el slider.");
    }

    strips.push({
      id: slider.id,
      label: slider.label,
      dataUrl: stitchedSlides.dataUrl,
      width: stitchedSlides.width,
      height: stitchedSlides.height,
      geometry: geometry.geometry
    });
  }

  return strips;
}

async function startImageCapture(payload) {
  const tab = await getActiveTab();
  await ensureContentScript(tab.id);

  const scale = clamp(Number(payload?.scale ?? 100), 10, 100) / 100;
  const targetId = payload?.targetId ?? "document";
  const hideFixedOverlays = payload?.hideFixedOverlays !== false;
  const expandSliders = Boolean(payload?.expandSliders);

  let sliderStrips = [];
  if (expandSliders) {
    sliderStrips = await captureSliderStrips(tab, targetId, scale);
  }

  const prep = await chrome.tabs.sendMessage(tab.id, {
    type: "PREPARE_CAPTURE",
    targetId,
    hideFixedOverlays
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

      await wait(PAINT_SETTLE_MS);
      const dataUrl = await captureVisibleTabThrottled(tab.windowId);

      slices.push({
        dataUrl,
        crop: positioned.crop,
        overlap: positioned.overlap || 0,
        isLast: i === totalSteps - 1
      });

      await emitProgress(i + 1, totalSteps, "page");
    }
  } finally {
    await chrome.tabs.sendMessage(tab.id, { type: "CLEANUP_CAPTURE", targetId }).catch(() => {});
  }

  let stitched = await stitchInTab(tab.id, slices, scale);

  if (sliderStrips.length) {
    stitched = await compositeSlidersInTab(tab.id, stitched, sliderStrips, scale);
  }

  const result = {
    kind: "image",
    dataUrl: stitched.dataUrl,
    width: stitched.width,
    height: stitched.height,
    scalePercent: Math.round(scale * 100),
    targetLabel: metrics.label,
    pageTitle: tab.title || "captura",
    capturedAt: Date.now(),
    expandedSliders: sliderStrips.map((s) => s.label)
  };

  return saveCaptureResult(result);
}

async function compositeSlidersInTab(tabId, pageImage, sliderStrips, scale) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: compositeSliderStripsInPage,
    args: [pageImage, sliderStrips, scale]
  });

  if (!result?.ok) {
    throw new Error(result?.error || "Error al insertar los slides en la captura.");
  }
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

/**
 * Replaces each carousel region in the page capture with the vertically
 * stacked slides strip, shifting content below downward.
 */
async function compositeSliderStripsInPage(pageImage, sliderStrips, scale) {
  const MAX_CANVAS = 16384;

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("No se pudo leer una imagen para componer."));
      img.src = dataUrl;
    });
  }

  try {
    if (!pageImage?.dataUrl) {
      return { ok: false, error: "Falta la captura de página." };
    }

    const page = await loadImage(pageImage.dataUrl);
    const strips = [];
    for (const item of sliderStrips || []) {
      const img = await loadImage(item.dataUrl);
      strips.push({ ...item, img });
    }

    // Sort top-to-bottom so we can accumulate Y shift.
    strips.sort((a, b) => (a.geometry?.top || 0) - (b.geometry?.top || 0));

    // Geometry is CSS px; strip/page bitmaps are already at capture scale (≈ css * dpr * scale).
    let cssToPage = scale;
    if (strips[0]?.geometry?.width > 0 && strips[0].img.width > 0) {
      cssToPage = strips[0].img.width / Math.max(1, strips[0].geometry.width);
    }

    let extraHeight = 0;
    for (const strip of strips) {
      const regionH = Math.max(1, Math.round((strip.geometry?.height || 0) * cssToPage));
      extraHeight += Math.max(0, strip.img.height - regionH);
    }

    let outW = page.width;
    let outH = page.height + extraHeight;
    let fit = 1;
    if (outW > MAX_CANVAS || outH > MAX_CANVAS) {
      fit = Math.min(MAX_CANVAS / outW, MAX_CANVAS / outH, 1);
      outW = Math.max(1, Math.floor(outW * fit));
      outH = Math.max(1, Math.floor(outH * fit));
    }

    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { ok: false, error: "Canvas no disponible." };
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    let srcCursor = 0;
    let destCursor = 0;

    for (const strip of strips) {
      const top = Math.max(0, Math.round((strip.geometry?.top || 0) * cssToPage));
      const regionH = Math.max(1, Math.round((strip.geometry?.height || 0) * cssToPage));
      const safeTop = Math.min(page.height, Math.max(0, top));

      // Page segment above this carousel.
      const aboveH = Math.max(0, safeTop - srcCursor);
      if (aboveH > 0) {
        const dh = Math.round(aboveH * fit);
        ctx.drawImage(
          page,
          0,
          srcCursor,
          page.width,
          aboveH,
          0,
          destCursor,
          outW,
          dh
        );
        destCursor += dh;
        srcCursor += aboveH;
      }

      // Insert stacked slides (scaled to page width).
      const stripDrawH = Math.round(strip.img.height * fit);
      const stripDrawW = Math.round(strip.img.width * fit);
      const x = Math.max(0, Math.round(((strip.geometry?.left || 0) * cssToPage) * fit));
      ctx.drawImage(strip.img, 0, 0, strip.img.width, strip.img.height, x, destCursor, Math.min(stripDrawW, outW - x), stripDrawH);
      destCursor += stripDrawH;

      // Skip original carousel region in the page capture.
      srcCursor = Math.min(page.height, srcCursor + regionH);
    }

    // Remainder of the page.
    const rest = page.height - srcCursor;
    if (rest > 0) {
      const dh = Math.round(rest * fit);
      ctx.drawImage(page, 0, srcCursor, page.width, rest, 0, destCursor, outW, dh);
      destCursor += dh;
    }

    const finalH = Math.max(1, destCursor);
    if (finalH < canvas.height) {
      const trimmed = document.createElement("canvas");
      trimmed.width = canvas.width;
      trimmed.height = finalH;
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
