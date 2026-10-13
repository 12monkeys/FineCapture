(() => {
  const FC_VERSION = 5;
  if (window.__FC__?.version === FC_VERSION) return;
  if (window.__FC__?.onMessage) {
    chrome.runtime.onMessage.removeListener(window.__FC__.onMessage);
  }

  const STATE = {
    picking: false,
    targets: [],
    selectedId: null,
    capture: null,
    hiddenFixed: [],
    hideFixedOverlays: true
  };

  function onMessage(message, _sender, sendResponse) {
    handleMessage(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  chrome.runtime.onMessage.addListener(onMessage);
  window.__FC__ = { version: FC_VERSION, onMessage };
  window.__FINECAPTURE_LOADED__ = true;

  async function handleMessage(message) {
    switch (message?.type) {
      case "PING":
        return { ok: true, version: FC_VERSION };
      case "LIST_SCROLL_TARGETS":
        return { ok: true, targets: listScrollTargets() };
      case "START_PICKER":
        return startPicker();
      case "STOP_PICKER":
        stopPicker();
        return { ok: true };
      case "HIGHLIGHT_TARGET":
        highlightTarget(message.targetId);
        return { ok: true };
      case "PREPARE_CAPTURE":
        return prepareCapture(message.targetId, message.hideFixedOverlays !== false);
      case "SCROLL_TO_STEP":
        return scrollToStep(message.targetId, message.step, message.metrics);
      case "CLEANUP_CAPTURE":
        cleanupCapture();
        return { ok: true };
      case "EXTRACT_TEXT":
        return extractTextCapture(message.targetId);
      default:
        return { ok: false, error: "Mensaje desconocido." };
    }
  }

  function listScrollTargets() {
    const targets = [];

    const docEl = document.documentElement;
    const body = document.body;
    const pageScrollHeight = Math.max(
      docEl.scrollHeight,
      body?.scrollHeight || 0,
      docEl.offsetHeight,
      body?.offsetHeight || 0
    );
    const pageClientHeight = window.innerHeight;

    targets.push({
      id: "document",
      label: "Página completa (ventana)",
      kind: "document",
      scrollHeight: pageScrollHeight,
      clientHeight: pageClientHeight,
      scrollable: pageScrollHeight > pageClientHeight + 2,
      selectorHint: "html / body"
    });

    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode;
    let index = 0;

    while (node) {
      if (node instanceof HTMLElement && isElementScrollable(node)) {
        index += 1;
        const rect = node.getBoundingClientRect();
        targets.push({
          id: `el-${index}`,
          label: describeElement(node, index),
          kind: "element",
          scrollHeight: node.scrollHeight,
          clientHeight: node.clientHeight,
          scrollable: true,
          selectorHint: shortSelector(node),
          rect: { width: Math.round(rect.width), height: Math.round(rect.height) }
        });
        node.__fineCaptureId = `el-${index}`;
      }
      node = walker.nextNode();
    }

    // Keep only meaningful scroll areas (limit noise)
    return targets.filter((t) => t.kind === "document" || t.scrollHeight > t.clientHeight + 20).slice(0, 40);
  }

  function isElementScrollable(el) {
    if (!el || el === document.documentElement || el === document.body) return false;
    const style = getComputedStyle(el);
    const oy = style.overflowY;
    return /(auto|scroll|overlay)/.test(oy) && el.scrollHeight > el.clientHeight + 2;
  }

  function describeElement(el, index) {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : "";
    const cls = el.classList?.[0] ? `.${el.classList[0]}` : "";
    const role = el.getAttribute("role");
    const name = [tag, id, cls].join("") + (role ? ` [role=${role}]` : "");
    return `Zona ${index}: ${name}`;
  }

  function shortSelector(el) {
    const tag = el.tagName.toLowerCase();
    if (el.id) return `${tag}#${el.id}`;
    if (el.classList?.length) return `${tag}.${[...el.classList].slice(0, 2).join(".")}`;
    return tag;
  }

  function resolveTarget(targetId) {
    if (!targetId || targetId === "document") {
      return { kind: "document", el: null };
    }
    const all = document.querySelectorAll("*");
    for (const el of all) {
      if (el.__fineCaptureId === targetId) return { kind: "element", el };
    }
    // Rebuild map if needed
    listScrollTargets();
    for (const el of document.querySelectorAll("*")) {
      if (el.__fineCaptureId === targetId) return { kind: "element", el };
    }
    throw new Error("No se encontró el contenedor seleccionado. Vuelve a listar las zonas.");
  }

  function startPicker() {
    stopPicker();
    STATE.picking = true;
    STATE.targets = listScrollTargets();

    const root = document.createElement("div");
    root.id = "finecapture-picker-root";
    root.innerHTML = `
      <div class="fc-picker-banner">
        <strong>FineCapture</strong>
        <span>Haz clic en la zona con scroll que quieres capturar. Esc cancela.</span>
        <button type="button" class="fc-picker-cancel">Cancelar</button>
      </div>
    `;
    document.documentElement.appendChild(root);

    STATE.targets.forEach((t) => {
      if (t.kind === "document") return;
      const target = resolveTarget(t.id);
      if (!target.el) return;
      const badge = document.createElement("button");
      badge.type = "button";
      badge.className = "fc-picker-badge";
      badge.textContent = t.label.replace(/^Zona /, "#");
      badge.dataset.targetId = t.id;
      positionBadge(badge, target.el);
      root.appendChild(badge);
      badge.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        finishPick(t.id);
      });
    });

    // Document option as floating chip
    const docChip = document.createElement("button");
    docChip.type = "button";
    docChip.className = "fc-picker-doc";
    docChip.textContent = "Capturar página completa";
    docChip.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      finishPick("document");
    });
    root.appendChild(docChip);

    root.querySelector(".fc-picker-cancel")?.addEventListener("click", () => {
      stopPicker();
      chrome.runtime.sendMessage({ type: "PICK_CANCELLED" }).catch(() => {});
    });

    STATE._onKey = (e) => {
      if (e.key === "Escape") {
        stopPicker();
        chrome.runtime.sendMessage({ type: "PICK_CANCELLED" }).catch(() => {});
      }
    };
    window.addEventListener("keydown", STATE._onKey, true);

    return { ok: true, targets: STATE.targets };
  }

  function positionBadge(badge, el) {
    const rect = el.getBoundingClientRect();
    badge.style.top = `${Math.max(8, rect.top + window.scrollY + 8)}px`;
    badge.style.left = `${Math.max(8, rect.left + window.scrollX + 8)}px`;
  }

  function finishPick(targetId) {
    STATE.selectedId = targetId;
    stopPicker();
    highlightTarget(targetId);
    chrome.storage.session.set({ fineCaptureSelectedTarget: targetId }).catch(() => {});
    chrome.runtime.sendMessage({ type: "PICK_RESULT", targetId }).catch(() => {});
  }

  function stopPicker() {
    STATE.picking = false;
    document.getElementById("finecapture-picker-root")?.remove();
    if (STATE._onKey) {
      window.removeEventListener("keydown", STATE._onKey, true);
      STATE._onKey = null;
    }
  }

  function highlightTarget(targetId) {
    document.querySelector(".fc-highlight-ring")?.remove();
    const ring = document.createElement("div");
    ring.className = "fc-highlight-ring";
    document.documentElement.appendChild(ring);

    const place = () => {
      if (targetId === "document") {
        ring.style.top = `${window.scrollY}px`;
        ring.style.left = `${window.scrollX}px`;
        ring.style.width = `${window.innerWidth}px`;
        ring.style.height = `${window.innerHeight}px`;
        return;
      }
      const { el } = resolveTarget(targetId);
      if (!el) return;
      const rect = el.getBoundingClientRect();
      ring.style.top = `${rect.top + window.scrollY}px`;
      ring.style.left = `${rect.left + window.scrollX}px`;
      ring.style.width = `${rect.width}px`;
      ring.style.height = `${rect.height}px`;
    };

    place();
    setTimeout(() => ring.remove(), 1600);
  }

  function prepareCapture(targetId, hideFixedOverlays = true) {
    cleanupCapture();
    const target = resolveTarget(targetId);
    STATE.hideFixedOverlays = Boolean(hideFixedOverlays);

    if (target.kind === "document") {
      const scrollEl = document.scrollingElement || document.documentElement;
      const totalHeight = Math.max(
        document.documentElement.scrollHeight,
        document.body?.scrollHeight || 0
      );
      const viewportH = window.innerHeight;
      const viewportW = window.innerWidth;
      const steps = Math.max(1, Math.ceil(totalHeight / viewportH));

      STATE.capture = {
        kind: "document",
        scrollEl,
        originalScroll: { x: window.scrollX, y: window.scrollY },
        totalHeight,
        viewportH,
        viewportW
      };

      window.scrollTo(0, 0);
      scrollEl.scrollTop = 0;

      if (STATE.hideFixedOverlays) {
        collectOverlayElements(null);
        setOverlaysHidden(true);
      }

      return {
        ok: true,
        metrics: {
          label: "Página completa (ventana)",
          steps,
          totalHeight,
          viewportH,
          viewportW,
          kind: "document",
          hideFixedOverlays: STATE.hideFixedOverlays,
          hiddenOverlayCount: STATE.hiddenFixed.length
        }
      };
    }

    const el = target.el;
    const totalHeight = el.scrollHeight;
    const viewportH = el.clientHeight;
    const rect = el.getBoundingClientRect();
    const steps = Math.max(1, Math.ceil(totalHeight / viewportH));

    STATE.capture = {
      kind: "element",
      el,
      originalScroll: el.scrollTop,
      pageScroll: { x: window.scrollX, y: window.scrollY },
      totalHeight,
      viewportH,
      viewportW: el.clientWidth
    };

    // Bring element into view horizontally/vertically for stable cropping
    el.scrollIntoView({ block: "center", inline: "nearest" });
    el.scrollTop = 0;

    if (STATE.hideFixedOverlays) {
      collectOverlayElements(el);
      setOverlaysHidden(true);
    }

    return {
      ok: true,
      metrics: {
        label: describeElement(el, Number(String(targetId).replace("el-", "")) || 1),
        steps,
        totalHeight,
        viewportH,
        viewportW: el.clientWidth,
        kind: "element",
        hideFixedOverlays: STATE.hideFixedOverlays,
        hiddenOverlayCount: STATE.hiddenFixed.length,
        initialRect: {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height
        }
      }
    };
  }

  function scrollToStep(targetId, step, metrics) {
    const cap = STATE.capture;
    if (!cap) throw new Error("Captura no preparada.");

    // Option on: hide overlays on every slice. Option off: leave page as-is.
    if (STATE.hideFixedOverlays) {
      setOverlaysHidden(true);
    }

    if (cap.kind === "document") {
      const y = Math.min(step * metrics.viewportH, Math.max(0, metrics.totalHeight - metrics.viewportH));
      window.scrollTo(0, y);
      const actualY = window.scrollY;
      const prevY = step === 0 ? 0 : Math.min((step - 1) * metrics.viewportH, Math.max(0, metrics.totalHeight - metrics.viewportH));
      const overlapCss = step === 0 ? 0 : Math.max(0, prevY + metrics.viewportH - actualY);

      const remaining = metrics.totalHeight - actualY;
      const height = Math.min(metrics.viewportH, remaining);

      return {
        ok: true,
        crop: {
          x: 0,
          y: 0,
          width: metrics.viewportW,
          height,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight
        },
        overlap: overlapCss
      };
    }

    const el = cap.el;
    const y = Math.min(step * metrics.viewportH, Math.max(0, metrics.totalHeight - metrics.viewportH));
    el.scrollTop = y;
    const actualY = el.scrollTop;
    const prevY = step === 0 ? 0 : Math.min((step - 1) * metrics.viewportH, Math.max(0, metrics.totalHeight - metrics.viewportH));
    const overlapCss = step === 0 ? 0 : Math.max(0, prevY + metrics.viewportH - actualY);

    const rect = el.getBoundingClientRect();
    const remaining = metrics.totalHeight - actualY;
    const visibleH = Math.min(el.clientHeight, remaining);

    return {
      ok: true,
      crop: {
        x: Math.max(0, rect.left),
        y: Math.max(0, rect.top),
        width: Math.min(rect.width, window.innerWidth - Math.max(0, rect.left)),
        height: Math.min(visibleH, window.innerHeight - Math.max(0, rect.top)),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight
      },
      overlap: overlapCss
    };
  }

  function isFineCaptureUi(el) {
    return Boolean(
      el.closest?.("#finecapture-picker-root") ||
      el.classList?.contains("fc-highlight-ring") ||
      el.id === "finecapture-picker-root"
    );
  }

  function shouldSkipOverlay(el, scrollTarget) {
    if (!el || el === document.body || el === document.documentElement) return true;
    if (isFineCaptureUi(el)) return true;
    if (scrollTarget) {
      if (el === scrollTarget) return true;
      // Never hide ancestors of the scroller (would blank the capture).
      if (el.contains(scrollTarget)) return true;
    }
    return false;
  }

  function parseEdge(style, name) {
    const raw = style[name];
    if (!raw || raw === "auto") return null;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : null;
  }

  function isPinnedToEdge(style) {
    const edges = ["top", "right", "bottom", "left"];
    return edges.some((name) => {
      const n = parseEdge(style, name);
      return n !== null && Math.abs(n) <= 2;
    });
  }

  /** Absolute bars/FABs that behave like fixed (e.g. Pos(a) B(0) W(100%)). */
  function isAbsoluteOverlay(el, style, rect) {
    if (style.position !== "absolute") return false;
    if (!isPinnedToEdge(style)) return false;

    const z = parseInt(style.zIndex, 10);
    const hasZ = Number.isFinite(z) && z >= 1;
    const nearViewportTop = rect.top <= 8;
    const nearViewportBottom = rect.bottom >= window.innerHeight - 8;
    const nearViewportLeft = rect.left <= 8;
    const nearViewportRight = rect.right >= window.innerWidth - 8;
    const nearEdge = nearViewportTop || nearViewportBottom || nearViewportLeft || nearViewportRight;
    const wideBar = rect.width >= window.innerWidth * 0.35 && rect.height >= 28 && rect.height <= window.innerHeight * 0.55;
    const floatingChip = rect.width >= 28 && rect.height >= 28 && rect.width <= window.innerWidth * 0.5;

    if (wideBar && nearEdge) return true;
    if (floatingChip && nearEdge && (hasZ || nearViewportBottom || nearViewportTop)) return true;
    if (hasZ && nearEdge && (wideBar || floatingChip)) return true;
    return false;
  }

  function rememberOverlay(el, seen) {
    if (!el || seen.has(el)) return;
    seen.add(el);
    STATE.hiddenFixed.push({
      el,
      visibility: el.style.getPropertyValue("visibility"),
      visibilityPriority: el.style.getPropertyPriority("visibility"),
      opacity: el.style.getPropertyValue("opacity"),
      opacityPriority: el.style.getPropertyPriority("opacity"),
      pointerEvents: el.style.getPropertyValue("pointer-events"),
      pointerEventsPriority: el.style.getPropertyPriority("pointer-events"),
      hidden: false
    });
  }

  /**
   * Elements whose viewport position barely changes when the capture target scrolls
   * are visually "fixed" even with position:absolute (common in SPA shells).
   */
  function findViewportAnchored(scrollTarget) {
    const maxScroll = scrollTarget
      ? scrollTarget.scrollHeight - scrollTarget.clientHeight
      : Math.max(
          document.documentElement.scrollHeight,
          document.body?.scrollHeight || 0
        ) - window.innerHeight;

    if (maxScroll < 40) return [];

    const delta = Math.min(140, Math.floor(maxScroll));
    const samples = [];
    const nodes = document.querySelectorAll("body *");

    for (const el of nodes) {
      if (!(el instanceof HTMLElement) || shouldSkipOverlay(el, scrollTarget)) continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (parseFloat(style.opacity || "1") === 0) continue;

      const pos = style.position;
      if (pos !== "fixed" && pos !== "sticky" && pos !== "absolute") continue;

      const rect = el.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) continue;
      if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) {
        continue;
      }

      samples.push({ el, top: rect.top, left: rect.left });
    }

    const before = scrollTarget ? scrollTarget.scrollTop : window.scrollY;
    if (scrollTarget) scrollTarget.scrollTop = before + delta;
    else window.scrollTo(window.scrollX, before + delta);

    const anchored = [];
    for (const sample of samples) {
      const rect = sample.el.getBoundingClientRect();
      if (Math.abs(rect.top - sample.top) <= 1.5 && Math.abs(rect.left - sample.left) <= 1.5) {
        anchored.push(sample.el);
      }
    }

    if (scrollTarget) scrollTarget.scrollTop = before;
    else window.scrollTo(window.scrollX, before);

    return anchored;
  }

  function collectOverlayElements(scrollTarget) {
    STATE.hiddenFixed = [];
    const seen = new Set();
    const all = document.querySelectorAll("body *");

    for (const el of all) {
      if (!(el instanceof HTMLElement) || shouldSkipOverlay(el, scrollTarget)) continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;

      const rect = el.getBoundingClientRect();
      if (rect.width < 2 && rect.height < 2) continue;

      const pos = style.position;
      if (pos === "fixed" || pos === "sticky" || isAbsoluteOverlay(el, style, rect)) {
        rememberOverlay(el, seen);
      }
    }

    for (const el of findViewportAnchored(scrollTarget)) {
      if (shouldSkipOverlay(el, scrollTarget)) continue;
      rememberOverlay(el, seen);
    }
  }

  function setOverlaysHidden(hidden) {
    for (const item of STATE.hiddenFixed) {
      if (hidden && !item.hidden) {
        item.el.style.setProperty("visibility", "hidden", "important");
        item.el.style.setProperty("opacity", "0", "important");
        item.el.style.setProperty("pointer-events", "none", "important");
        item.el.setAttribute("data-finecapture-hidden", "1");
        item.hidden = true;
      } else if (!hidden && item.hidden) {
        restoreStyleProp(item.el, "visibility", item.visibility, item.visibilityPriority);
        restoreStyleProp(item.el, "opacity", item.opacity, item.opacityPriority);
        restoreStyleProp(item.el, "pointer-events", item.pointerEvents, item.pointerEventsPriority);
        item.el.removeAttribute("data-finecapture-hidden");
        item.hidden = false;
      }
    }
  }

  function restoreStyleProp(el, name, value, priority) {
    if (value) {
      el.style.setProperty(name, value, priority || "");
    } else {
      el.style.removeProperty(name);
    }
  }

  function restoreFixedElements() {
    setOverlaysHidden(false);
    STATE.hiddenFixed = [];
  }

  function cleanupCapture() {
    restoreFixedElements();
    if (!STATE.capture) return;
    if (STATE.capture.kind === "document") {
      window.scrollTo(STATE.capture.originalScroll.x, STATE.capture.originalScroll.y);
    } else if (STATE.capture.el) {
      STATE.capture.el.scrollTop = STATE.capture.originalScroll;
      window.scrollTo(STATE.capture.pageScroll.x, STATE.capture.pageScroll.y);
    }
    STATE.capture = null;
  }

  function extractTextCapture(targetId) {
    const target = resolveTarget(targetId || "document");
    const root = target.kind === "document"
      ? (document.body || document.documentElement)
      : target.el;

    if (!root) {
      return { ok: false, error: "No se encontró el nodo para extraer texto." };
    }

    const markdown = extractStructuredText(root, { markdown: true });
    const text = extractStructuredText(root, { markdown: false });
    const label = target.kind === "document"
      ? "Página completa (ventana)"
      : describeElement(root, Number(String(targetId).replace("el-", "")) || 1);

    if (!text.trim()) {
      return { ok: false, error: "No hay texto visible en la zona seleccionada." };
    }

    return {
      ok: true,
      result: {
        text,
        markdown,
        charCount: text.length,
        lineCount: text.split(/\n/).length,
        label
      }
    };
  }

  const TEXT_SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "PATH", "CANVAS",
    "IFRAME", "OBJECT", "EMBED", "VIDEO", "AUDIO", "SOURCE", "TRACK"
  ]);

  const TEXT_BLOCK_TAGS = new Set([
    "DIV", "P", "SECTION", "ARTICLE", "MAIN", "ASIDE", "HEADER", "FOOTER",
    "NAV", "UL", "OL", "DL", "LI", "BLOCKQUOTE", "FIGURE", "FIGCAPTION",
    "TR", "TABLE", "THEAD", "TBODY", "TFOOT", "DD", "DT", "FORM", "FIELDSET"
  ]);

  function isVisibleForText(el) {
    if (!(el instanceof Element)) return true;
    if (isFineCaptureUi(el)) return false;
    if (TEXT_SKIP_TAGS.has(el.tagName)) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    if (el.hidden) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (parseFloat(style.opacity || "1") === 0) return false;
    return true;
  }

  function normalizeSpace(value) {
    return String(value || "").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim();
  }

  function collapseBlankLines(value) {
    return String(value || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function leafText(el) {
    return normalizeSpace(el.innerText || el.textContent || "");
  }

  function hasStructuralChildren(el) {
    return [...el.children].some((child) => {
      if (!isVisibleForText(child)) return false;
      const tag = child.tagName;
      if (/^H[1-6]$/.test(tag) || tag === "LI" || tag === "BR" || tag === "HR" || tag === "PRE") {
        return true;
      }
      if (TEXT_BLOCK_TAGS.has(tag)) return true;
      const role = child.getAttribute("role");
      return role === "heading" || role === "listitem" || role === "article" || role === "row";
    });
  }

  /**
   * Walks only the selected DOM subtree and keeps titles / block structure
   * (useful for chats, threads and article-like layouts).
   */
  function extractStructuredText(root, { markdown }) {
    const lines = [];

    const pushBlank = () => {
      if (lines.length && lines[lines.length - 1] !== "") lines.push("");
    };

    const pushLine = (line) => {
      const value = String(line || "").replace(/\s+$/g, "");
      if (!value) return;
      lines.push(value);
    };

    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = normalizeSpace(node.textContent);
        if (t) pushLine(t);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node;
      if (!isVisibleForText(el)) return;

      const tag = el.tagName;
      const role = el.getAttribute("role") || "";

      if (tag === "BR") {
        pushBlank();
        return;
      }

      if (tag === "HR") {
        pushBlank();
        pushLine(markdown ? "---" : "————————");
        pushBlank();
        return;
      }

      if (/^H[1-6]$/.test(tag) || role === "heading") {
        const level = /^H[1-6]$/.test(tag)
          ? Number(tag[1])
          : Math.min(6, Math.max(1, Number(el.getAttribute("aria-level")) || 2));
        const text = leafText(el);
        if (text) {
          pushBlank();
          pushLine(markdown ? `${"#".repeat(level)} ${text}` : text);
          pushBlank();
        }
        return;
      }

      if (tag === "LI" || role === "listitem") {
        const text = leafText(el);
        if (text) pushLine(markdown ? `- ${text}` : text);
        return;
      }

      if (tag === "PRE") {
        const text = String(el.textContent || "").replace(/\s+$/g, "");
        if (text) {
          pushBlank();
          if (markdown) {
            pushLine("```");
            text.split("\n").forEach((line) => lines.push(line));
            pushLine("```");
          } else {
            text.split("\n").forEach((line) => lines.push(line));
          }
          pushBlank();
        }
        return;
      }

      // Chat/message-like or simple block with only inline content → one text unit.
      const structural = hasStructuralChildren(el);
      if (!structural && (TEXT_BLOCK_TAGS.has(tag) || role === "article" || role === "row")) {
        const text = leafText(el);
        if (text) {
          pushLine(text);
          pushBlank();
        }
        return;
      }

      if (structural || TEXT_BLOCK_TAGS.has(tag) || role === "article" || role === "list" || role === "feed") {
        for (const child of el.childNodes) walk(child);
        pushBlank();
        return;
      }

      // Inline wrappers: unwrap children without forcing new blocks.
      for (const child of el.childNodes) walk(child);
    };

    walk(root);
    return collapseBlankLines(lines.join("\n"));
  }
})();
