(() => {
  const FC_VERSION = 11;
  if (window.__FC__?.version === FC_VERSION) return;
  if (window.__FC__?.onMessage) {
    chrome.runtime.onMessage.removeListener(window.__FC__.onMessage);
  }

  const STATE = {
    picking: false,
    targets: [],
    elById: new Map(),
    selectedId: null,
    capture: null,
    hiddenFixed: [],
    hideFixedOverlays: true,
    pickerChain: [],
    pickerIndex: 0
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
        return extractTextCapture(message.targetId, {
          reverseOrder: Boolean(message.reverseOrder),
          expandCollapsed: Boolean(message.expandCollapsed)
        });
      case "EXPAND_COLLAPSED":
        return expandCollapsedContent(message.targetId);
      case "FIND_SLIDERS":
        return findSlidersInTarget(message.targetId);
      case "SLIDER_GO_TO":
        return goToSliderSlide(message.sliderId, message.index);
      case "SLIDER_RESTORE":
        return restoreSlider(message.sliderId);
      case "SLIDER_GEOMETRY":
        return getSliderGeometry(message.sliderId, message.targetId);
      default:
        return { ok: false, error: "Mensaje desconocido." };
    }
  }

  function listScrollTargets() {
    STATE.elById = new Map();
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
      selectorHint: "html / body",
      score: 0
    });

    const candidates = [];
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode;

    while (node) {
      if (node instanceof HTMLElement) {
        const overflow = isOverflowScrollable(node);
        const score = scoreCaptureContainer(node);
        const tall = Math.max(node.scrollHeight, node.offsetHeight) > pageClientHeight + 20;
        const contentRegion = !overflow && tall && score >= 32;

        if (overflow || contentRegion) {
          candidates.push({
            el: node,
            overflow,
            score: overflow ? score + 12 : score,
            scrollHeight: Math.max(node.scrollHeight, node.offsetHeight),
            clientHeight: overflow ? node.clientHeight : Math.min(node.clientHeight || pageClientHeight, pageClientHeight)
          });
        }
      }
      node = walker.nextNode();
    }

    const kept = dedupeCaptureCandidates(candidates);
    kept.sort((a, b) => b.score - a.score || b.scrollHeight - a.scrollHeight);

    let index = 0;
    for (const item of kept.slice(0, 36)) {
      index += 1;
      const id = `el-${index}`;
      const rect = item.el.getBoundingClientRect();
      registerTargetEl(item.el, id);
      targets.push({
        id,
        label: describeElement(item.el, index),
        kind: item.overflow ? "element" : "region",
        scrollHeight: item.scrollHeight,
        clientHeight: item.clientHeight,
        scrollable: item.overflow || item.scrollHeight > pageClientHeight + 2,
        selectorHint: shortSelector(item.el),
        score: Math.round(item.score),
        rect: { width: Math.round(rect.width), height: Math.round(rect.height) }
      });
    }

    return targets;
  }

  function registerTargetEl(el, id) {
    el.__fineCaptureId = id;
    STATE.elById.set(id, el);
  }

  function isOverflowScrollable(el) {
    if (!el || el === document.documentElement || el === document.body) return false;
    const style = getComputedStyle(el);
    const oy = style.overflowY;
    return /(auto|scroll|overlay)/.test(oy) && el.scrollHeight > el.clientHeight + 2;
  }

  /** @deprecated alias kept for older call sites */
  function isElementScrollable(el) {
    return isOverflowScrollable(el);
  }

  function isMeaningfulChild(el) {
    if (!(el instanceof HTMLElement) || isFineCaptureUi(el)) return false;
    const tag = el.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE" || tag === "BR" || tag === "HR") {
      return false;
    }
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return el.offsetWidth > 8 && el.offsetHeight > 8;
  }

  /**
   * Universal score for capture containers (grids, lists, chats, feeds, articles).
   * Prefers parents that wrap many similar items over tiny sidebars or single cards.
   */
  function scoreCaptureContainer(el) {
    if (!(el instanceof HTMLElement)) return -Infinity;
    if (el === document.body || el === document.documentElement) return -1000;
    if (isFineCaptureUi(el)) return -Infinity;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pageH = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
    const w = el.offsetWidth || el.getBoundingClientRect().width;
    const h = Math.max(el.offsetHeight, el.scrollHeight);
    if (w < 72 || h < 72) return -100;

    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return -Infinity;

    let score = 0;
    const area = w * Math.min(h, pageH);
    score += Math.log10(area + 1) * 6;

    if (h > vh * 0.85) score += 12;
    if (h > vh * 1.4) score += 18;
    if (h > vh * 2.5) score += 10;
    if (w > vw * 0.32 && w < vw * 0.96) score += 12;
    if (w >= vw * 0.5) score += 6;

    if (isOverflowScrollable(el)) score += 28;

    const kids = [...el.children].filter(isMeaningfulChild);
    const n = kids.length;
    if (n >= 3) score += Math.min(n, 60);
    if (n >= 8) score += 12;

    const heights = kids.map((k) => k.offsetHeight).filter((hh) => hh > 24);
    if (heights.length >= 3) {
      const sorted = [...heights].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)] || 1;
      const similar = heights.filter((hh) => Math.abs(hh - median) / median < 0.55).length;
      score += similar * 3.5;
    }

    if (style.display === "grid" || style.display === "inline-grid") score += 32;
    if (style.display === "flex") {
      const dir = style.flexDirection || "";
      if (dir.includes("column") && n >= 3) score += 14;
      if ((dir === "row" || dir === "row-reverse") && n >= 4) score += 10;
    }

    const role = (el.getAttribute("role") || "").toLowerCase();
    if (["list", "feed", "grid", "main", "log", "directory"].includes(role)) score += 26;
    if (role === "listitem" || role === "article" || role === "row") score -= 18;

    const aria = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("aria-labelledby") || ""}`.toLowerCase();
    const cls = typeof el.className === "string" ? el.className.toLowerCase() : "";
    const hint = `${aria} ${cls}`;
    if (/itemcard|item-card|result|results|grid|list|feed|message|messages|chat|conversation|thread|timeline|content|main|products|cards|catalog/.test(hint)) {
      score += 24;
    }
    if (/sidebar|aside|filter|nav|menu|cookie|banner|footer|header|toolbar/.test(hint)) {
      score -= 22;
    }

    // Thin side columns / filter rails
    if (w < vw * 0.28) score -= 28;
    if (h < vh * 0.45 && !isOverflowScrollable(el)) score -= 12;

    // Near full-page wrappers: prefer a more specific inner container
    if (w > vw * 0.97 && h > pageH * 0.82) score -= 45;
    if (n <= 2 && h > vh) {
      const grand = kids.reduce((acc, k) => acc + [...k.children].filter(isMeaningfulChild).length, 0);
      if (grand >= 4) score += Math.min(grand, 28);
      else score -= 8;
    }

    return score;
  }

  function dedupeCaptureCandidates(candidates) {
    const ranked = [...candidates].sort((a, b) => b.score - a.score || b.scrollHeight - a.scrollHeight);
    const keep = [];

    for (const item of ranked) {
      const betterDescendant = keep.find((k) => item.el.contains(k.el) && k.el !== item.el);
      if (betterDescendant) continue;

      const weakerAncestorIdx = keep.findIndex((k) => k.el.contains(item.el) && k.el !== item.el);
      if (weakerAncestorIdx >= 0) {
        if (item.score > keep[weakerAncestorIdx].score + 6) {
          keep.splice(weakerAncestorIdx, 1);
        } else {
          continue;
        }
      }

      const nestedSame = keep.find(
        (k) => (k.el.contains(item.el) || item.el.contains(k.el)) && Math.abs(k.score - item.score) <= 6
      );
      if (nestedSame) continue;

      keep.push(item);
    }

    return keep;
  }

  /**
   * Ancestor chain of capture candidates, ordered general → specific (outer → inner).
   * Lets the user pick section vs grid vs single card.
   */
  function collectAncestorChain(start) {
    let el = start instanceof Element ? start : null;
    if (el && el.nodeType !== Node.ELEMENT_NODE) el = el.parentElement;
    while (el && isFineCaptureUi(el)) el = el.parentElement;
    if (!el) return [];

    const raw = [];
    let node = el;
    while (node && node !== document.documentElement && node !== document.body) {
      if (node instanceof HTMLElement) {
        const score = scoreCaptureContainer(node);
        const overflow = isOverflowScrollable(node);
        const vh = window.innerHeight;
        const tall = Math.max(node.scrollHeight, node.offsetHeight) > vh + 20;
        if (overflow || score >= 16 || (tall && score >= 8)) {
          raw.push({ el: node, score, overflow });
        }
      }
      node = node.parentElement;
    }

    // raw is inner → outer; reverse to general → specific
    raw.reverse();

    const chain = [];
    for (const item of raw) {
      const prev = chain[chain.length - 1];
      if (prev) {
        const pr = prev.el.getBoundingClientRect();
        const r = item.el.getBoundingClientRect();
        const similar =
          Math.abs(pr.width - r.width) < 10 &&
          Math.abs(pr.height - r.height) < 28 &&
          Math.abs((prev.el.offsetHeight || 0) - (item.el.offsetHeight || 0)) < 40;
        if (similar) {
          if (item.score > prev.score + 3) chain[chain.length - 1] = item;
          continue;
        }
      }
      chain.push(item);
    }

    if (!chain.length && el instanceof HTMLElement) {
      chain.push({ el, score: scoreCaptureContainer(el), overflow: isOverflowScrollable(el) });
    }

    // Cap long chains: keep ends + highest scores
    if (chain.length > 8) {
      const scored = chain.map((item, index) => ({ item, index, score: item.score }));
      scored.sort((a, b) => b.score - a.score);
      const keepIdx = new Set([0, chain.length - 1, ...scored.slice(0, 6).map((s) => s.index)]);
      return chain.filter((_, i) => keepIdx.has(i));
    }

    return chain;
  }

  function bestIndexInChain(chain) {
    if (!chain.length) return 0;
    let best = 0;
    let bestScore = -Infinity;
    chain.forEach((item, i) => {
      if (item.score > bestScore) {
        bestScore = item.score;
        best = i;
      }
    });
    return best;
  }

  function chainsEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    return a.every((item, i) => item.el === b[i]?.el);
  }

  /** Walk ancestors from a clicked node and pick the best capture container. */
  function pickBestContainer(start) {
    const chain = collectAncestorChain(start);
    if (!chain.length) return null;
    return chain[bestIndexInChain(chain)].el;
  }

  function levelLabel(item, index, total) {
    const hint = shortSelector(item.el);
    const role = item.el.getAttribute("role");
    const aria = item.el.getAttribute("aria-label");
    const kids = [...item.el.children].filter(isMeaningfulChild).length;
    const kind = item.overflow ? "scroll" : "región";
    const detail = aria ? aria.slice(0, 28) : role ? `role=${role}` : `${kids} hijos`;
    return `${index + 1}/${total} · ${hint} · ${detail} · ${kind}`;
  }

  function ensureTargetForElement(el) {
    if (!el) return null;
    if (el.__fineCaptureId && STATE.elById.get(el.__fineCaptureId) === el) {
      return el.__fineCaptureId;
    }
    const targets = listScrollTargets();
    if (el.__fineCaptureId && STATE.elById.get(el.__fineCaptureId) === el) {
      return el.__fineCaptureId;
    }
    const id = `el-${STATE.elById.size + 1}`;
    registerTargetEl(el, id);
    const overflow = isOverflowScrollable(el);
    STATE.targets = targets;
    STATE.targets.push({
      id,
      label: describeElement(el, STATE.elById.size),
      kind: overflow ? "element" : "region",
      scrollHeight: Math.max(el.scrollHeight, el.offsetHeight),
      clientHeight: overflow ? el.clientHeight : window.innerHeight,
      scrollable: overflow || Math.max(el.scrollHeight, el.offsetHeight) > window.innerHeight + 2,
      selectorHint: shortSelector(el),
      score: Math.round(scoreCaptureContainer(el))
    });
    return id;
  }

  function findNearestOverflowScroller(el) {
    let n = el?.parentElement;
    while (n && n !== document.documentElement) {
      if (n === document.body) break;
      if (isOverflowScrollable(n)) return n;
      n = n.parentElement;
    }
    return null;
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
    const mapped = STATE.elById.get(targetId);
    if (mapped?.isConnected) return { kind: "element", el: mapped };

    for (const el of document.querySelectorAll("*")) {
      if (el.__fineCaptureId === targetId) {
        STATE.elById.set(targetId, el);
        return { kind: "element", el };
      }
    }
    listScrollTargets();
    const again = STATE.elById.get(targetId);
    if (again?.isConnected) return { kind: "element", el: again };
    for (const el of document.querySelectorAll("*")) {
      if (el.__fineCaptureId === targetId) return { kind: "element", el };
    }
    throw new Error("No se encontró el contenedor seleccionado. Vuelve a listar las zonas.");
  }

  function startPicker() {
    stopPicker();
    STATE.picking = true;
    STATE.pickerChain = [];
    STATE.pickerIndex = 0;
    STATE.targets = listScrollTargets();

    const root = document.createElement("div");
    root.id = "finecapture-picker-root";
    root.innerHTML = `
      <div class="fc-picker-banner">
        <strong>FineCapture</strong>
        <span>Pasa el ratón, usa la rueda o ↑↓ para el nivel (general → específico). Clic / Enter confirma. Esc cancela.</span>
        <button type="button" class="fc-picker-cancel">Cancelar</button>
      </div>
      <div class="fc-level-strip" hidden>
        <div class="fc-level-hint">Nivel de captura</div>
        <div class="fc-level-chips" role="listbox" aria-label="Niveles de contenedor"></div>
      </div>
      <div class="fc-hover-ring" hidden></div>
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
      badge.title = `${t.selectorHint} · score ${t.score ?? "—"} · ${t.kind}`;
      badge.dataset.targetId = t.id;
      positionBadge(badge, target.el);
      root.appendChild(badge);
      badge.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        finishPick(t.id);
      });
    });

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

    const hoverRing = root.querySelector(".fc-hover-ring");
    const levelStrip = root.querySelector(".fc-level-strip");
    const levelChips = root.querySelector(".fc-level-chips");

    const placeHover = (el) => {
      if (!hoverRing) return;
      if (!el) {
        hoverRing.hidden = true;
        return;
      }
      const rect = el.getBoundingClientRect();
      hoverRing.hidden = false;
      hoverRing.style.top = `${rect.top + window.scrollY}px`;
      hoverRing.style.left = `${rect.left + window.scrollX}px`;
      hoverRing.style.width = `${Math.max(0, rect.width)}px`;
      hoverRing.style.height = `${Math.max(0, rect.height)}px`;
    };

    const selectedEl = () => STATE.pickerChain[STATE.pickerIndex]?.el || null;

    const renderLevelStrip = () => {
      if (!levelStrip || !levelChips) return;
      const chain = STATE.pickerChain;
      if (!chain.length) {
        levelStrip.hidden = true;
        levelChips.innerHTML = "";
        return;
      }
      levelStrip.hidden = false;
      levelChips.innerHTML = "";
      chain.forEach((item, i) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = `fc-level-chip${i === STATE.pickerIndex ? " is-active" : ""}`;
        chip.setAttribute("role", "option");
        chip.setAttribute("aria-selected", i === STATE.pickerIndex ? "true" : "false");
        const short = shortSelector(item.el);
        const kids = [...item.el.children].filter(isMeaningfulChild).length;
        chip.textContent = short.length > 34 ? `${short.slice(0, 32)}…` : short;
        chip.title = levelLabel(item, i, chain.length);
        const meta = document.createElement("span");
        meta.className = "fc-level-meta";
        meta.textContent = kids ? `${kids}` : item.overflow ? "⌀" : "·";
        chip.appendChild(meta);
        chip.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          STATE.pickerIndex = i;
          renderLevelStrip();
          placeHover(selectedEl());
        });
        chip.addEventListener("dblclick", (e) => {
          e.preventDefault();
          e.stopPropagation();
          confirmCurrentLevel();
        });
        levelChips.appendChild(chip);
      });
    };

    const setChainFromHit = (hit) => {
      const chain = collectAncestorChain(hit);
      if (!chain.length) {
        STATE.pickerChain = [];
        STATE.pickerIndex = 0;
        renderLevelStrip();
        placeHover(null);
        return;
      }
      if (!chainsEqual(chain, STATE.pickerChain)) {
        STATE.pickerChain = chain;
        STATE.pickerIndex = bestIndexInChain(chain);
      } else {
        STATE.pickerIndex = Math.min(STATE.pickerIndex, chain.length - 1);
      }
      renderLevelStrip();
      placeHover(selectedEl());
    };

    const cycleLevel = (delta) => {
      if (!STATE.pickerChain.length) return;
      const n = STATE.pickerChain.length;
      STATE.pickerIndex = (STATE.pickerIndex + delta + n) % n;
      renderLevelStrip();
      placeHover(selectedEl());
    };

    const confirmCurrentLevel = () => {
      const el = selectedEl();
      if (!el) return;
      const id = ensureTargetForElement(el);
      if (id) finishPick(id);
    };

    STATE._onMove = (e) => {
      if (e.target?.closest?.("#finecapture-picker-root")) {
        // Keep ring on current level while using strip/banner; don't clear.
        if (e.target.closest(".fc-level-strip, .fc-picker-banner, .fc-picker-doc, .fc-picker-badge, .fc-picker-cancel")) {
          placeHover(selectedEl());
          return;
        }
        placeHover(null);
        return;
      }
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      setChainFromHit(hit);
    };

    STATE._onClick = (e) => {
      if (e.target?.closest?.("#finecapture-picker-root")) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      setChainFromHit(hit);
      confirmCurrentLevel();
    };

    STATE._onWheel = (e) => {
      if (!STATE.picking || !STATE.pickerChain.length) return;
      if (e.target?.closest?.(".fc-picker-banner, .fc-picker-doc, .fc-picker-cancel")) return;
      e.preventDefault();
      e.stopPropagation();
      cycleLevel(e.deltaY > 0 ? 1 : -1);
    };

    STATE._onKey = (e) => {
      if (e.key === "Escape") {
        stopPicker();
        chrome.runtime.sendMessage({ type: "PICK_CANCELLED" }).catch(() => {});
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowRight" || e.key === "]") {
        e.preventDefault();
        cycleLevel(1);
        return;
      }
      if (e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "[") {
        e.preventDefault();
        cycleLevel(-1);
        return;
      }
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        confirmCurrentLevel();
      }
    };

    window.addEventListener("mousemove", STATE._onMove, true);
    window.addEventListener("click", STATE._onClick, true);
    window.addEventListener("keydown", STATE._onKey, true);
    window.addEventListener("wheel", STATE._onWheel, { capture: true, passive: false });

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
    STATE.pickerChain = [];
    STATE.pickerIndex = 0;
    document.getElementById("finecapture-picker-root")?.remove();
    if (STATE._onKey) {
      window.removeEventListener("keydown", STATE._onKey, true);
      STATE._onKey = null;
    }
    if (STATE._onMove) {
      window.removeEventListener("mousemove", STATE._onMove, true);
      STATE._onMove = null;
    }
    if (STATE._onClick) {
      window.removeEventListener("click", STATE._onClick, true);
      STATE._onClick = null;
    }
    if (STATE._onWheel) {
      window.removeEventListener("wheel", STATE._onWheel, true);
      STATE._onWheel = null;
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
    const label = describeElement(el, Number(String(targetId).replace("el-", "")) || 1);

    // Overflow scrollport: scroll the element itself and crop to its box.
    if (isOverflowScrollable(el)) {
      const totalHeight = el.scrollHeight;
      const viewportH = el.clientHeight;
      const rect = el.getBoundingClientRect();
      const steps = Math.max(1, Math.ceil(totalHeight / Math.max(1, viewportH)));

      STATE.capture = {
        kind: "element",
        el,
        originalScroll: el.scrollTop,
        pageScroll: { x: window.scrollX, y: window.scrollY },
        totalHeight,
        viewportH,
        viewportW: el.clientWidth
      };

      el.scrollIntoView({ block: "center", inline: "nearest" });
      el.scrollTop = 0;

      if (STATE.hideFixedOverlays) {
        collectOverlayElements(el);
        setOverlaysHidden(true);
      }

      return {
        ok: true,
        metrics: {
          label,
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

    // Region mode: tall non-overflow container (grids/lists/feeds).
    // Scroll the document or nearest overflow parent and crop to the element.
    return prepareRegionCapture(el, label);
  }

  function prepareRegionCapture(el, label) {
    const totalHeight = Math.max(el.scrollHeight, el.offsetHeight);
    const scrollParent = findNearestOverflowScroller(el);
    const pageScroll = { x: window.scrollX, y: window.scrollY };

    if (scrollParent) {
      const parentRect = scrollParent.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const regionTop = elRect.top - parentRect.top + scrollParent.scrollTop;
      const viewportH = Math.max(1, scrollParent.clientHeight);
      const viewportW = Math.max(1, Math.min(el.clientWidth || elRect.width, scrollParent.clientWidth));
      const steps = Math.max(1, Math.ceil(totalHeight / viewportH));

      STATE.capture = {
        kind: "region",
        el,
        scrollEl: scrollParent,
        scrollMode: "parent",
        originalScroll: scrollParent.scrollTop,
        pageScroll,
        regionTop,
        totalHeight,
        viewportH,
        viewportW
      };

      scrollParent.scrollTop = Math.max(0, regionTop);
      el.scrollIntoView({ block: "nearest", inline: "nearest" });

      if (STATE.hideFixedOverlays) {
        collectOverlayElements(scrollParent);
        setOverlaysHidden(true);
      }

      const rect = el.getBoundingClientRect();
      return {
        ok: true,
        metrics: {
          label,
          steps,
          totalHeight,
          viewportH,
          viewportW,
          kind: "region",
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

    const elRect = el.getBoundingClientRect();
    const regionTop = elRect.top + window.scrollY;
    const viewportH = Math.max(1, window.innerHeight);
    const viewportW = Math.max(1, Math.min(el.offsetWidth || elRect.width, window.innerWidth));
    const steps = Math.max(1, Math.ceil(totalHeight / viewportH));

    STATE.capture = {
      kind: "region",
      el,
      scrollEl: document.scrollingElement || document.documentElement,
      scrollMode: "document",
      originalScroll: pageScroll,
      pageScroll,
      regionTop,
      totalHeight,
      viewportH,
      viewportW
    };

    window.scrollTo(window.scrollX, Math.max(0, regionTop));

    if (STATE.hideFixedOverlays) {
      collectOverlayElements(null);
      setOverlaysHidden(true);
    }

    const rect = el.getBoundingClientRect();
    return {
      ok: true,
      metrics: {
        label,
        steps,
        totalHeight,
        viewportH,
        viewportW,
        kind: "region",
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

    if (cap.kind === "region") {
      return scrollRegionStep(cap, step, metrics);
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

  function scrollRegionStep(cap, step, metrics) {
    const el = cap.el;
    const maxOffset = Math.max(0, metrics.totalHeight - metrics.viewportH);
    const desiredOffset = Math.min(step * metrics.viewportH, maxOffset);
    const prevOffset = step === 0 ? 0 : Math.min((step - 1) * metrics.viewportH, maxOffset);

    let actualOffset;
    if (cap.scrollMode === "parent" && cap.scrollEl) {
      const targetTop = cap.regionTop + desiredOffset;
      cap.scrollEl.scrollTop = targetTop;
      actualOffset = Math.max(0, cap.scrollEl.scrollTop - cap.regionTop);
    } else {
      const targetY = cap.regionTop + desiredOffset;
      window.scrollTo(window.scrollX, targetY);
      actualOffset = Math.max(0, window.scrollY - cap.regionTop);
    }

    const overlapCss = step === 0 ? 0 : Math.max(0, prevOffset + metrics.viewportH - actualOffset);
    const rect = el.getBoundingClientRect();
    const remaining = Math.max(0, metrics.totalHeight - actualOffset);

    const cropX = Math.max(0, rect.left);
    const cropY = Math.max(0, rect.top);
    const cropRight = Math.min(window.innerWidth, rect.right);
    const cropBottom = Math.min(window.innerHeight, rect.bottom);
    const width = Math.max(1, cropRight - cropX);
    const height = Math.max(1, Math.min(remaining, cropBottom - cropY, metrics.viewportH));

    return {
      ok: true,
      crop: {
        x: cropX,
        y: cropY,
        width,
        height,
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
    } else if (STATE.capture.kind === "region") {
      if (STATE.capture.scrollMode === "parent" && STATE.capture.scrollEl) {
        STATE.capture.scrollEl.scrollTop = STATE.capture.originalScroll;
      }
      if (STATE.capture.pageScroll) {
        window.scrollTo(STATE.capture.pageScroll.x, STATE.capture.pageScroll.y);
      } else if (STATE.capture.scrollMode === "document" && STATE.capture.originalScroll) {
        window.scrollTo(STATE.capture.originalScroll.x, STATE.capture.originalScroll.y);
      }
    } else if (STATE.capture.el) {
      STATE.capture.el.scrollTop = STATE.capture.originalScroll;
      window.scrollTo(STATE.capture.pageScroll.x, STATE.capture.pageScroll.y);
    }
    STATE.capture = null;
  }

  const SLIDER_STATE = {
    byId: new Map()
  };

  const MAX_SLIDERS = 2;
  const MAX_SLIDES = 16;

  function getCaptureRoot(targetId) {
    const target = resolveTarget(targetId || "document");
    if (target.kind === "document") {
      return { kind: "document", el: null, root: document.body || document.documentElement };
    }
    return { kind: "element", el: target.el, root: target.el };
  }

  function isSlideCandidate(el) {
    if (!(el instanceof HTMLElement) || isFineCaptureUi(el)) return false;
    if (el.tagName === "SCRIPT" || el.tagName === "STYLE" || el.tagName === "NOSCRIPT") return false;
    const style = getComputedStyle(el);
    // Keep aria-hidden / off-canvas slides: carousels hide inactive ones on purpose.
    if (style.display === "none") return false;
    return el.offsetWidth >= 8 || el.offsetHeight >= 8 || el.getBoundingClientRect().width >= 8;
  }

  function findSlides(root) {
    const specific = root.querySelectorAll(
      ".keen-slider__slide, .swiper-slide, .slick-slide, .splide__slide, .glider-slide, [aria-roledescription='slide'], [id^='carousel-item-'], [class*='carousel-item' i], [class*='slider__slide' i]"
    );
    if (specific.length >= 2) {
      return [...specific].filter((el) => isSlideCandidate(el));
    }

    const track =
      root.querySelector(".swiper-wrapper, .slick-track, .splide__list, .embla__container, .glider-track, .owl-stage") ||
      root;
    const kids = [...track.children].filter((el) => isSlideCandidate(el));
    if (kids.length >= 2) {
      const widths = kids.map((el) => el.getBoundingClientRect().width).filter((w) => w > 20);
      if (widths.length >= 2) {
        const avg = widths.reduce((a, b) => a + b, 0) / widths.length;
        const similar = kids.filter((el) => {
          const w = el.getBoundingClientRect().width;
          return w > avg * 0.55 && w < avg * 1.45;
        });
        if (similar.length >= 2) return similar;
      }
    }
    return kids.length >= 2 ? kids : [];
  }

  function parseDeclaredSlideCount(slides) {
    for (const slide of slides) {
      const label = slide.getAttribute("aria-label") || "";
      const match = label.match(/(\d+)\s*(?:of|de)\s*(\d+)/i);
      if (match) return Number(match[2]);
    }
    return slides.length;
  }

  function findNextControl(root) {
    const scope = root.parentElement || root;
    return (
      root.querySelector(
        ".swiper-button-next, .slick-next, .splide__arrow--next, .owl-next, .glider-next, [aria-label*='next' i], [aria-label*='siguiente' i], button[class*='next' i], [data-action='next']"
      ) ||
      scope.querySelector(
        ".swiper-button-next, .slick-next, .splide__arrow--next, .owl-next, .glider-next, [aria-label*='next' i], [aria-label*='siguiente' i], button[class*='next' i], [data-action='next']"
      ) ||
      null
    );
  }

  function findPrevControl(root) {
    const scope = root.parentElement || root;
    return (
      root.querySelector(
        ".swiper-button-prev, .slick-prev, .splide__arrow--prev, .owl-prev, .glider-prev, [aria-label*='prev' i], [aria-label*='anterior' i], button[class*='prev' i], [data-action='prev']"
      ) ||
      scope.querySelector(
        ".swiper-button-prev, .slick-prev, .splide__arrow--prev, .owl-prev, .glider-prev, [aria-label*='prev' i], [aria-label*='anterior' i], button[class*='prev' i], [data-action='prev']"
      ) ||
      null
    );
  }

  function findDots(root, slideCount) {
    const scope = root.parentElement || root;
    const dots = [
      ...root.querySelectorAll(
        ".swiper-pagination-bullet, .slick-dots button, .slick-dots li, .splide__pagination__page, .owl-dot, [aria-label*='slide' i][role='button'], [aria-label*='Go to slide' i]"
      ),
      ...scope.querySelectorAll(
        "[role='tab'], [class*='bullet' i], [class*='indicator' i], [class*='pageIndicator' i]"
      )
    ].filter((el) => el instanceof HTMLElement);
    if (dots.length >= 2) return dots.slice(0, Math.max(slideCount, dots.length));
    return dots;
  }

  function isKeenLike(el) {
    const cls = String(el.className || "").toLowerCase();
    return cls.includes("keen-slider") || cls.includes("profilecard__slider") || Boolean(el.querySelector(":scope > .keen-slider__slide"));
  }

  function looksLikeSlider(el) {
    if (!(el instanceof HTMLElement) || isFineCaptureUi(el)) return false;
    const cls = `${el.className || ""} ${el.getAttribute("aria-roledescription") || ""}`.toLowerCase();
    const roleDesc = (el.getAttribute("aria-roledescription") || "").toLowerCase();
    if (roleDesc === "carousel" || roleDesc === "slider") return true;
    if (/(swiper|slick|splide|embla|glider|carousel|keen-slider|owl-carousel|profilecard__slider)/.test(cls)) return true;
    if (el.getAttribute("data-carousel") != null || el.getAttribute("data-slider") != null) return true;
    if (isKeenLike(el)) return true;

    const style = getComputedStyle(el);
    const ox = style.overflowX;
    const horizontal =
      /(auto|scroll|overlay)/.test(ox) &&
      el.scrollWidth > el.clientWidth + 40 &&
      el.scrollHeight <= el.clientHeight * 1.25;
    if (horizontal && findSlides(el).length >= 2) return true;
    return false;
  }

  function scoreSlider(el, slides) {
    const rect = el.getBoundingClientRect();
    let score = slides.length * 10;
    if (rect.width >= 180 && rect.height >= 80) score += 20;
    if (el.swiper) score += 40;
    if (isKeenLike(el)) score += 50;
    if (findNextControl(el) || findDots(el, slides.length).length >= 2) score += 25;
    const cls = String(el.className || "").toLowerCase();
    if (/(swiper|slick|splide|carousel|keen-slider|profilecard__slider)/.test(cls)) score += 30;
    return score;
  }

  function findSliderApi(el) {
    if (!el) return null;
    if (el.swiper && typeof el.swiper.slideTo === "function") {
      return { type: "swiper", api: el.swiper };
    }
    const seen = new Set();
    const inspect = (obj) => {
      if (!obj || typeof obj !== "object" || seen.has(obj)) return null;
      seen.add(obj);
      if (typeof obj.moveToIdx === "function") return { type: "keen", api: obj };
      if (typeof obj.moveTo === "function" && obj.track) return { type: "keen", api: obj };
      return null;
    };

    const direct = inspect(el);
    if (direct) return direct;

    for (const key of Object.keys(el)) {
      try {
        const found = inspect(el[key]);
        if (found) return found;
      } catch {
        /* ignore */
      }
    }

    // React fiber props sometimes hold the instance.
    for (const key of Object.keys(el)) {
      if (!key.startsWith("__reactFiber") && !key.startsWith("__reactInternalInstance") && !key.startsWith("__reactProps")) {
        continue;
      }
      try {
        const fiber = el[key];
        const memo = fiber?.memoizedProps || fiber?.pendingProps;
        const found = inspect(memo?.slider) || inspect(memo?.instance) || inspect(memo?.keenSlider);
        if (found) return found;
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  function slideHasVisual(slide) {
    if (!slide) return false;
    if (slide.querySelector("img[src], video[src], canvas")) return true;
    const nodes = [slide, ...slide.querySelectorAll("*")];
    for (const node of nodes) {
      if (!(node instanceof Element)) continue;
      const bg = getComputedStyle(node).backgroundImage;
      if (bg && bg !== "none" && /url\(/i.test(bg)) return true;
    }
    return false;
  }

  async function waitForSlideContent(slide, timeoutMs = 1800) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (slideHasVisual(slide)) return true;
      await new Promise((r) => setTimeout(r, 120));
    }
    return slideHasVisual(slide);
  }

  function dispatchPointClick(el, clientX, clientY) {
    const target = document.elementFromPoint(clientX, clientY) || el;
    const base = { bubbles: true, cancelable: true, clientX, clientY, view: window };
    target.dispatchEvent(new PointerEvent("pointerdown", { ...base, pointerId: 1, pointerType: "mouse", buttons: 1 }));
    target.dispatchEvent(new MouseEvent("mousedown", { ...base, buttons: 1 }));
    target.dispatchEvent(new PointerEvent("pointerup", { ...base, pointerId: 1, pointerType: "mouse", buttons: 0 }));
    target.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0 }));
    target.dispatchEvent(new MouseEvent("click", base));
  }

  function clickSliderSide(el, direction) {
    const rect = el.getBoundingClientRect();
    const x = direction === "next"
      ? rect.left + rect.width * 0.88
      : rect.left + rect.width * 0.12;
    const y = rect.top + rect.height * 0.45;
    dispatchPointClick(el, x, y);
  }

  function findSlidersInTarget(targetId) {
    SLIDER_STATE.byId.clear();
    const { root } = getCaptureRoot(targetId);
    if (!root) return { ok: false, error: "Sin raíz de captura." };

    const selectors = [
      '[aria-roledescription="carousel"]',
      '[aria-roledescription="slider"]',
      ".keen-slider",
      ".profileCard__slider",
      "[class*='profileCard__slider']",
      ".swiper",
      ".swiper-container",
      ".slick-slider",
      ".splide",
      ".embla",
      ".glider",
      ".owl-carousel",
      ".carousel",
      '[class*="carousel" i]',
      '[class*="slider" i]'
    ];

    const candidates = new Set();
    for (const sel of selectors) {
      try {
        root.querySelectorAll(sel).forEach((el) => candidates.add(el));
      } catch {
        /* invalid selector on some engines for i flag — ignore */
      }
    }

    // Also scan for horizontal scroll tracks inside root.
    root.querySelectorAll("*").forEach((el) => {
      if (looksLikeSlider(el)) candidates.add(el);
    });

    const ranked = [];
    for (const el of candidates) {
      if (!(el instanceof HTMLElement) || !looksLikeSlider(el)) continue;
      // Prefer outermost carousel wrappers, skip nested slides.
      if (el.closest && [...candidates].some((other) => other !== el && other.contains(el) && looksLikeSlider(other))) {
        // keep inner only if outer has fewer slides — skip nested for now
        const parentSlider = [...candidates].find((other) => other !== el && other.contains(el) && looksLikeSlider(other));
        if (parentSlider) continue;
      }
      const slides = findSlides(el);
      if (slides.length < 2) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 120 || rect.height < 60) continue;
      ranked.push({
        el,
        slides,
        score: scoreSlider(el, slides)
      });
    }

    ranked.sort((a, b) => b.score - a.score);
    const selected = ranked.slice(0, MAX_SLIDERS);
    const sliders = selected.map((item, index) => {
      const id = `slider-${index + 1}`;
      const declared = parseDeclaredSlideCount(item.slides);
      const slideCount = Math.min(MAX_SLIDES, Math.max(item.slides.length, declared));
      // Keep enough slide nodes; if aria says 7 but only 7 nodes exist, fine.
      const slides = item.slides.slice(0, slideCount);
      SLIDER_STATE.byId.set(id, {
        id,
        el: item.el,
        slides,
        originalIndex: detectActiveSlideIndex(item.el, slides),
        next: findNextControl(item.el),
        prev: findPrevControl(item.el),
        dots: findDots(item.el, slideCount),
        keenLike: isKeenLike(item.el),
        api: findSliderApi(item.el)
      });
      return {
        id,
        label: `Slider ${index + 1} (${slideCount} slides)`,
        slideCount,
        selectorHint: shortSelector(item.el),
        engine: isKeenLike(item.el) ? "keen" : "generic"
      };
    });

    return { ok: true, sliders };
  }

  function detectActiveSlideIndex(root, slides) {
    const byAria = slides.findIndex((el) => el.getAttribute("aria-hidden") === "false");
    if (byAria >= 0) return byAria;

    const active = slides.findIndex((el) =>
      el.classList.contains("swiper-slide-active") ||
      el.classList.contains("slick-active") ||
      el.classList.contains("is-active") ||
      el.classList.contains("keen-slider__slide--active") ||
      el.getAttribute("aria-current") === "true"
    );
    if (active >= 0) return active;

    // Fallback: slide whose center is closest to the viewport/slider center.
    const rootRect = root.getBoundingClientRect();
    const centerX = rootRect.left + rootRect.width / 2;
    let best = 0;
    let bestDist = Infinity;
    slides.forEach((el, idx) => {
      const rect = el.getBoundingClientRect();
      const dist = Math.abs(rect.left + rect.width / 2 - centerX);
      if (dist < bestDist) {
        bestDist = dist;
        best = idx;
      }
    });
    return best;
  }

  async function stepSliderToward(slider, targetIndex) {
    const root = slider.el;
    let current = detectActiveSlideIndex(root, slider.slides);
    if (current === targetIndex) return true;

    const apiInfo = slider.api || findSliderApi(root);
    if (apiInfo?.type === "swiper") {
      apiInfo.api.slideTo(targetIndex, 0);
      await new Promise((r) => setTimeout(r, 200));
      return detectActiveSlideIndex(root, slider.slides) === targetIndex;
    }
    if (apiInfo?.type === "keen" && typeof apiInfo.api.moveToIdx === "function") {
      apiInfo.api.moveToIdx(targetIndex, true);
      await new Promise((r) => setTimeout(r, 260));
      return detectActiveSlideIndex(root, slider.slides) === targetIndex;
    }

    if (slider.dots[targetIndex]) {
      slider.dots[targetIndex].click();
      await new Promise((r) => setTimeout(r, 260));
      if (detectActiveSlideIndex(root, slider.slides) === targetIndex) return true;
    }

    // Keen / Tinder profile cards: tap right/left side of the photo.
    const maxSteps = slider.slides.length + 4;
    for (let step = 0; step < maxSteps; step += 1) {
      current = detectActiveSlideIndex(root, slider.slides);
      if (current === targetIndex) return true;

      if (current < targetIndex) {
        if (slider.next) slider.next.click();
        else clickSliderSide(root, "next");
      } else {
        if (slider.prev) slider.prev.click();
        else clickSliderSide(root, "prev");
      }
      await new Promise((r) => setTimeout(r, 280));
    }

    return detectActiveSlideIndex(root, slider.slides) === targetIndex;
  }

  async function goToSliderSlide(sliderId, index) {
    const slider = SLIDER_STATE.byId.get(sliderId);
    if (!slider) return { ok: false, error: "Slider no encontrado. Vuelve a detectar." };

    const i = Math.max(0, Math.min(slider.slides.length - 1, Number(index) || 0));
    slider.el.scrollIntoView({ block: "center", inline: "nearest" });
    await new Promise((r) => setTimeout(r, 80));

    const moved = await stepSliderToward(slider, i);
    const slide = slider.slides[i];
    if (slide) {
      await waitForSlideContent(slide, moved ? 2000 : 900);
    }

    // Re-check after lazy paint; one more nudge if still wrong.
    if (detectActiveSlideIndex(slider.el, slider.slides) !== i) {
      await stepSliderToward(slider, i);
      if (slide) await waitForSlideContent(slide, 1200);
    }

    const activeIndex = detectActiveSlideIndex(slider.el, slider.slides);
    const rect = slider.el.getBoundingClientRect();
    return {
      ok: true,
      moved: activeIndex === i,
      activeIndex,
      crop: {
        x: Math.max(0, rect.left),
        y: Math.max(0, rect.top),
        width: Math.min(rect.width, window.innerWidth - Math.max(0, rect.left)),
        height: Math.min(rect.height, window.innerHeight - Math.max(0, rect.top)),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight
      },
      index: i,
      hasVisual: slide ? slideHasVisual(slide) : false
    };
  }

  function restoreSlider(sliderId) {
    const slider = SLIDER_STATE.byId.get(sliderId);
    if (!slider) return { ok: true };
    return goToSliderSlide(sliderId, slider.originalIndex);
  }

  function getSliderGeometry(sliderId, targetId) {
    const slider = SLIDER_STATE.byId.get(sliderId);
    if (!slider) return { ok: false, error: "Slider no encontrado." };
    const { kind, el: captureEl } = getCaptureRoot(targetId);
    const rect = slider.el.getBoundingClientRect();

    let top;
    let left;
    if (kind === "document") {
      top = rect.top + window.scrollY;
      left = rect.left + window.scrollX;
    } else {
      const rootRect = captureEl.getBoundingClientRect();
      top = rect.top - rootRect.top + captureEl.scrollTop;
      left = rect.left - rootRect.left + captureEl.scrollLeft;
    }

    return {
      ok: true,
      geometry: {
        top,
        left,
        width: rect.width,
        height: rect.height
      }
    };
  }

  const EXPAND_TEXT_RE =
    /^\s*(ver m[aá]s|mostrar m[aá]s|ver todo|mostrar todo|leer m[aá]s|expandir|desplegar|show more|see more|read more|view more|load more|show all|see all|expand|more)\s*$/i;
  const EXPAND_CONTAINS_RE =
    /\b(ver m[aá]s|mostrar m[aá]s|leer m[aá]s|show more|see more|read more|load more|view more)\b/i;
  const EXPAND_SKIP_RE =
    /\b(cerrar|close|cancel|login|log in|sign in|sign up|register|cookie|aceptar todo|reject|decline|comprar|buy|share|compartir|siguiente|next|prev|anterior)\b/i;

  function isSafeExpandControl(el) {
    if (!(el instanceof HTMLElement) || isFineCaptureUi(el)) return false;
    if (!isVisibleForText(el) && el.tagName !== "SUMMARY") {
      // summary can be visible even if details content is hidden
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
    }
    if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;
    if (el.closest("form") && (el.type === "submit" || el.getAttribute("type") === "submit")) return false;

    const tag = el.tagName;
    if (tag === "A") {
      const href = el.getAttribute("href") || "";
      if (href && !href.startsWith("#") && !href.startsWith("javascript:") && href !== "") {
        // Allow in-page hash only; skip real navigations.
        if (/^https?:/i.test(href) || href.startsWith("/") || href.startsWith("mailto:")) return false;
      }
    }

    const label = normalizeSpace(
      `${el.innerText || ""} ${el.getAttribute("aria-label") || ""} ${el.title || ""} ${el.getAttribute("data-testid") || ""}`
    );
    if (EXPAND_SKIP_RE.test(label)) return false;
    return true;
  }

  function controlledPanelIsCollapsed(control) {
    const id = control.getAttribute("aria-controls");
    if (!id) return null;
    const panel = document.getElementById(id);
    if (!panel) return null;
    const style = getComputedStyle(panel);
    if (panel.hidden || panel.getAttribute("aria-hidden") === "true") return true;
    if (style.display === "none" || style.visibility === "hidden") return true;
    if (style.maxHeight === "0px" || style.height === "0px") return true;
    return false;
  }

  function collectExpandTargets(root) {
    const targets = [];
    const seen = new Set();

    const add = (el, reason) => {
      if (!el || seen.has(el) || !isSafeExpandControl(el)) return;
      seen.add(el);
      targets.push({ el, reason });
    };

    root.querySelectorAll("details:not([open]) > summary").forEach((el) => add(el, "details"));

    root.querySelectorAll('[aria-expanded="false"]').forEach((el) => {
      if (!isSafeExpandControl(el)) return;
      const collapsed = controlledPanelIsCollapsed(el);
      if (collapsed === false) return;
      add(el, "aria-expanded");
    });

    root.querySelectorAll("button, a, [role='button'], summary, span[tabindex], div[tabindex]").forEach((el) => {
      if (!(el instanceof HTMLElement)) return;
      const label = normalizeSpace(
        `${el.innerText || ""} ${el.getAttribute("aria-label") || ""} ${el.title || ""}`
      );
      if (!label || label.length > 48) return;
      if (EXPAND_TEXT_RE.test(label) || (label.length <= 24 && EXPAND_CONTAINS_RE.test(label))) {
        add(el, "label");
      }
    });

    root.querySelectorAll(
      '[class*="show-more" i], [class*="showMore" i], [class*="read-more" i], [class*="readMore" i], [class*="ver-mas" i], [class*="verMas" i], [data-action*="expand" i], [data-testid*="show-more" i], [data-testid*="read-more" i]'
    ).forEach((el) => add(el, "class"));

    return targets;
  }

  async function expandCollapsedContent(targetId) {
    const target = resolveTarget(targetId || "document");
    const root = target.kind === "document"
      ? (document.body || document.documentElement)
      : target.el;
    if (!root) return { ok: false, error: "Sin nodo para expandir." };

    // Native details first (no click needed).
    let openedDetails = 0;
    root.querySelectorAll("details:not([open])").forEach((details) => {
      details.open = true;
      openedDetails += 1;
    });

    let clicked = 0;
    const maxClicks = 40;
    const maxPasses = 4;

    for (let pass = 0; pass < maxPasses && clicked < maxClicks; pass += 1) {
      const batch = collectExpandTargets(root);
      if (!batch.length) break;

      for (const item of batch) {
        if (clicked >= maxClicks) break;
        try {
          if (item.el.getAttribute("aria-expanded") === "true") continue;
          if (item.el.closest("details[open]") && item.el.tagName === "SUMMARY") continue;
          item.el.click();
          clicked += 1;
          await new Promise((r) => setTimeout(r, 90));
        } catch {
          /* ignore failed clicks */
        }
      }

      await new Promise((r) => setTimeout(r, 160));
    }

    return {
      ok: true,
      expanded: {
        details: openedDetails,
        clicks: clicked
      }
    };
  }

  function extractTextCapture(targetId, options = {}) {
    const reverseOrder = Boolean(options.reverseOrder);
    const target = resolveTarget(targetId || "document");
    const root = target.kind === "document"
      ? (document.body || document.documentElement)
      : target.el;

    if (!root) {
      return { ok: false, error: "No se encontró el nodo para extraer texto." };
    }

    // expandCollapsed is handled by background before EXTRACT_TEXT when requested.

    const markdown = extractStructuredText(root, { markdown: true, reverseOrder });
    const text = extractStructuredText(root, { markdown: false, reverseOrder });
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
        label,
        reverseOrder
      }
    };
  }

  /** Reverse message/section blocks while keeping each block's internal lines intact. */
  function reverseTextBlocks(value) {
    const blocks = String(value || "")
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .filter(Boolean);
    return blocks.reverse().join("\n\n");
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
  function extractStructuredText(root, { markdown, reverseOrder }) {
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
    let output = collapseBlankLines(lines.join("\n"));
    // Chats often render newest→oldest in the DOM; reverse message blocks for reading order.
    if (reverseOrder) {
      output = reverseTextBlocks(output);
    }
    return output;
  }
})();
