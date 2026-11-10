(() => {
  const FC_VERSION = 13;
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
    pickerIndex: 0,
    navLockUntil: 0,
    scrollBehaviorRestore: null
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
      case "RESOLVE_SELECTION":
        return resolveSelection(message.meta || message);
      case "DESCRIBE_TARGET":
        return describeTargetResponse(message.targetId);
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
    const preserveId = STATE.selectedId && STATE.selectedId !== "document" ? STATE.selectedId : null;
    let preserveEl = preserveId ? STATE.elById.get(preserveId) : null;
    if (preserveId && (!preserveEl || !preserveEl.isConnected)) {
      preserveEl = findElementByStoredId(preserveId);
    }

    STATE.elById = new Map();
    const targets = [];
    const usedIds = new Set(["document"]);

    const docEl = document.documentElement;
    const body = document.body;
    const pageScrollHeight = Math.max(
      docEl.scrollHeight,
      body?.scrollHeight || 0,
      docEl.offsetHeight,
      body?.offsetHeight || 0
    );
    const pageClientHeight = window.innerHeight;

    targets.push(buildDocumentTarget(pageScrollHeight, pageClientHeight));

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
      let id;
      if (preserveEl && item.el === preserveEl && preserveId) {
        id = preserveId;
      } else {
        do {
          index += 1;
          id = `el-${index}`;
        } while (usedIds.has(id) || (preserveId && id === preserveId && item.el !== preserveEl));
      }
      usedIds.add(id);
      targets.push(buildElementTarget(item.el, id, item));
    }

    if (preserveEl?.isConnected && !STATE.elById.has(preserveId)) {
      const overflow = isOverflowScrollable(preserveEl);
      targets.push(
        buildElementTarget(preserveEl, preserveId, {
          overflow,
          score: scoreCaptureContainer(preserveEl),
          scrollHeight: Math.max(preserveEl.scrollHeight, preserveEl.offsetHeight),
          clientHeight: overflow ? preserveEl.clientHeight : pageClientHeight
        })
      );
    }

    return targets;
  }

  function buildDocumentTarget(pageScrollHeight, pageClientHeight) {
    return {
      id: "document",
      label: "Página completa (ventana)",
      kind: "document",
      kindLabel: "página",
      scrollHeight: pageScrollHeight,
      clientHeight: pageClientHeight,
      scrollable: pageScrollHeight > pageClientHeight + 2,
      selectorHint: "html / body",
      score: 0,
      nesting: 0,
      childCount: 0,
      sizeLabel: `${pageClientHeight}px alto`
    };
  }

  function buildElementTarget(el, id, item) {
    const rect = el.getBoundingClientRect();
    const overflow = Boolean(item?.overflow ?? isOverflowScrollable(el));
    const kind = overflow ? "element" : "region";
    const containerKind = classifyContainer(el);
    const kids = [...el.children].filter(isMeaningfulChild).length;
    const w = Math.round(rect.width || el.offsetWidth || 0);
    const h = Math.round(Math.max(el.offsetHeight, el.scrollHeight) || 0);
    registerTargetEl(el, id);
    return {
      id,
      label: describeElement(el),
      kind,
      kindLabel: kindLabelEs(containerKind),
      containerKind,
      scrollHeight: item?.scrollHeight ?? Math.max(el.scrollHeight, el.offsetHeight),
      clientHeight: item?.clientHeight ?? (overflow ? el.clientHeight : window.innerHeight),
      scrollable: overflow || Math.max(el.scrollHeight, el.offsetHeight) > window.innerHeight + 2,
      selectorHint: friendlyHint(el),
      score: Math.round(item?.score ?? scoreCaptureContainer(el)),
      rect: { width: w, height: h },
      nesting: nestingDepth(el),
      childCount: kids,
      sizeLabel: `${w}×${h}`,
      fingerprint: elementFingerprint(el)
    };
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
    const label = describeElement(item.el);
    return `${index + 1}/${total} · ${label}`;
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
    let n = STATE.elById.size + 1;
    let id = `el-${n}`;
    while (STATE.elById.has(id)) {
      n += 1;
      id = `el-${n}`;
    }
    const overflow = isOverflowScrollable(el);
    const descriptor = buildElementTarget(el, id, {
      overflow,
      score: scoreCaptureContainer(el),
      scrollHeight: Math.max(el.scrollHeight, el.offsetHeight),
      clientHeight: overflow ? el.clientHeight : window.innerHeight
    });
    STATE.targets = targets;
    STATE.targets.push(descriptor);
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

  /** Full content height of a region (grids/lists), not just the visible client box. */
  function measureElementContentHeight(el) {
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    let height = Math.max(el.scrollHeight || 0, el.offsetHeight || 0, rect.height || 0);
    try {
      let maxChildBottom = 0;
      const kids = el.children;
      for (let i = 0; i < kids.length; i++) {
        const child = kids[i];
        if (!(child instanceof HTMLElement)) continue;
        if (!isMeaningfulChild(child)) continue;
        const top = child.offsetTop || 0;
        const h = Math.max(child.offsetHeight || 0, child.scrollHeight || 0);
        maxChildBottom = Math.max(maxChildBottom, top + h);
      }
      height = Math.max(height, maxChildBottom);
    } catch {
      /* ignore */
    }
    return Math.max(1, Math.round(height));
  }

  /**
   * CSS scroll-behavior:smooth makes scrollTo/scrollTop async. Capture reads crop
   * immediately, so overlap becomes ~viewport and stitching collapses to one slice.
   */
  function beginInstantScroll() {
    if (STATE.scrollBehaviorRestore) return;
    const html = document.documentElement;
    const body = document.body;
    STATE.scrollBehaviorRestore = {
      html: html.style.getPropertyValue("scroll-behavior"),
      htmlPriority: html.style.getPropertyPriority("scroll-behavior"),
      body: body ? body.style.getPropertyValue("scroll-behavior") : "",
      bodyPriority: body ? body.style.getPropertyPriority("scroll-behavior") : ""
    };
    html.style.setProperty("scroll-behavior", "auto", "important");
    if (body) body.style.setProperty("scroll-behavior", "auto", "important");
  }

  function endInstantScroll() {
    const saved = STATE.scrollBehaviorRestore;
    if (!saved) return;
    const html = document.documentElement;
    const body = document.body;
    if (saved.html) html.style.setProperty("scroll-behavior", saved.html, saved.htmlPriority || "");
    else html.style.removeProperty("scroll-behavior");
    if (body) {
      if (saved.body) body.style.setProperty("scroll-behavior", saved.body, saved.bodyPriority || "");
      else body.style.removeProperty("scroll-behavior");
    }
    STATE.scrollBehaviorRestore = null;
  }

  function setWindowScrollY(y) {
    const top = Math.max(0, y);
    const se = document.scrollingElement || document.documentElement;
    try {
      window.scrollTo({ top, left: window.scrollX, behavior: "instant" });
    } catch {
      window.scrollTo(window.scrollX, top);
    }
    if (se) se.scrollTop = top;
    if (Math.abs(window.scrollY - top) > 2 && se) {
      se.scrollTop = top;
    }
    return window.scrollY;
  }

  function setElementScrollTop(el, y) {
    if (!el) return 0;
    const top = Math.max(0, y);
    const prev = el.style.getPropertyValue("scroll-behavior");
    const prevPri = el.style.getPropertyPriority("scroll-behavior");
    el.style.setProperty("scroll-behavior", "auto", "important");
    el.scrollTop = top;
    if (prev) el.style.setProperty("scroll-behavior", prev, prevPri || "");
    else el.style.removeProperty("scroll-behavior");
    return el.scrollTop;
  }

  /** Prefer an overflow parent only if it can actually reveal the full region height. */
  function pickRegionScrollParent(el, totalHeight) {
    const parent = findNearestOverflowScroller(el);
    if (!parent) return null;
    const parentRect = parent.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const regionTop = elRect.top - parentRect.top + parent.scrollTop;
    const maxScroll = Math.max(0, parent.scrollHeight - parent.clientHeight);
    const need = Math.max(0, regionTop + totalHeight - parent.clientHeight);
    if (maxScroll + 2 < need) return null;
    return parent;
  }

  function isHashedClass(name) {
    if (!name || name.length > 48) return true;
    if (/^(css-|sc-|emotion-|jsx-|svelte-)/i.test(name)) return true;
    if (/^[a-z]{1,3}[-_][a-z0-9]{5,}$/i.test(name) && /\d/.test(name)) return true;
    if (/[a-f0-9]{6,}/i.test(name) && !/^(xs|sm|md|lg|xl|2xl)/i.test(name)) return true;
    if (/^_[A-Za-z0-9]+/.test(name)) return true;
    return false;
  }

  function stableClasses(el, limit = 2) {
    if (!el?.classList?.length) return [];
    return [...el.classList].filter((c) => !isHashedClass(c)).slice(0, limit);
  }

  function nestingDepth(el) {
    let depth = 0;
    let n = el?.parentElement;
    while (n && n !== document.documentElement && n !== document.body) {
      depth += 1;
      n = n.parentElement;
    }
    return depth;
  }

  function classifyContainer(el) {
    if (!(el instanceof HTMLElement)) return "region";
    const style = getComputedStyle(el);
    const overflow = isOverflowScrollable(el);
    const role = (el.getAttribute("role") || "").toLowerCase();
    const aria = (el.getAttribute("aria-label") || "").toLowerCase();
    const cls = typeof el.className === "string" ? el.className.toLowerCase() : "";
    const hint = `${aria} ${cls} ${role} ${el.id || ""}`.toLowerCase();
    const kids = [...el.children].filter(isMeaningfulChild).length;

    if (/chat|message|messages|conversation|thread|inbox/.test(hint) || role === "log") return "chat";
    if (style.display === "grid" || style.display === "inline-grid" || role === "grid") return "grid";
    if (role === "list" || role === "feed" || role === "directory" || /timeline|feed|list/.test(hint)) return "list";
    if (/result|results|product|products|catalog|cards|itemcard|item-card/.test(hint)) return "results";
    if (role === "main" || el.tagName === "MAIN") return "main";
    if (el.tagName === "ARTICLE" || role === "article") return "article";
    if (overflow) return "scroll";
    if (kids >= 6) return "list";
    return "region";
  }

  function kindLabelEs(kind) {
    const map = {
      chat: "Chat / mensajes",
      grid: "Contenedor grid",
      list: "Lista",
      scroll: "Zona con scroll",
      results: "Región de resultados",
      main: "Contenido principal",
      article: "Artículo",
      region: "Región",
      document: "Página completa",
      element: "Zona con scroll"
    };
    return map[kind] || "Zona";
  }

  function friendlyHint(el) {
    if (!el) return "";
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.slice(0, 40);
    const role = el.getAttribute("role");
    if (el.id && !/^[a-z]?[a-f0-9-]{8,}$/i.test(el.id)) return `#${el.id}`;
    const classes = stableClasses(el, 1);
    if (classes.length) return `.${classes[0]}`;
    if (role) return `role=${role}`;
    return el.tagName.toLowerCase();
  }

  function describeElement(el) {
    if (!el || el === document.documentElement || el === document.body) {
      return "Página completa (ventana)";
    }
    const containerKind = classifyContainer(el);
    const kids = [...el.children].filter(isMeaningfulChild).length;
    const rect = el.getBoundingClientRect();
    const w = Math.round(rect.width || el.offsetWidth || 0);
    const h = Math.round(Math.max(el.offsetHeight, el.scrollHeight) || 0);
    const depth = nestingDepth(el);
    const aria = (el.getAttribute("aria-label") || "").trim();
    const parts = [kindLabelEs(containerKind)];
    if (aria) parts.push(`«${aria.slice(0, 36)}»`);
    else if (kids >= 2) parts.push(`${kids} elementos`);
    if (w || h) parts.push(`${w}×${h}`);
    if (depth > 2) parts.push(`anidado ${depth}`);
    return parts.join(" · ");
  }

  function shortSelector(el) {
    const tag = el.tagName.toLowerCase();
    if (el.id && !isHashedClass(el.id)) return `${tag}#${el.id}`;
    const classes = stableClasses(el, 2);
    if (classes.length) return `${tag}.${classes.join(".")}`;
    return tag;
  }

  function elementFingerprint(el) {
    if (!(el instanceof HTMLElement)) return null;
    const rect = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || "",
      role: el.getAttribute("role") || "",
      aria: (el.getAttribute("aria-label") || "").slice(0, 80),
      classes: stableClasses(el, 3),
      kids: [...el.children].filter(isMeaningfulChild).length,
      w: Math.round(rect.width || el.offsetWidth || 0),
      h: Math.round(Math.max(el.offsetHeight, el.scrollHeight) || 0),
      nesting: nestingDepth(el)
    };
  }

  function fingerprintScore(el, fp) {
    if (!el || !fp) return -Infinity;
    let score = 0;
    if (el.tagName.toLowerCase() !== fp.tag) return -Infinity;
    if (fp.id) {
      if (el.id === fp.id) score += 100;
      else return -Infinity;
    }
    if (fp.role) score += (el.getAttribute("role") || "") === fp.role ? 20 : -8;
    if (fp.aria) {
      const aria = el.getAttribute("aria-label") || "";
      score += aria === fp.aria ? 30 : aria.includes(fp.aria.slice(0, 12)) ? 10 : -5;
    }
    const classes = new Set(stableClasses(el, 6));
    const matched = (fp.classes || []).filter((c) => classes.has(c)).length;
    score += matched * 12;
    const kids = [...el.children].filter(isMeaningfulChild).length;
    score += Math.max(0, 14 - Math.abs(kids - (fp.kids || 0)));
    const rect = el.getBoundingClientRect();
    const w = Math.round(rect.width || el.offsetWidth || 0);
    const h = Math.round(Math.max(el.offsetHeight, el.scrollHeight) || 0);
    if (fp.w) score += Math.max(0, 16 - Math.abs(w - fp.w) / Math.max(40, fp.w / 8));
    if (fp.h) score += Math.max(0, 16 - Math.abs(h - fp.h) / Math.max(80, fp.h / 10));
    score += Math.max(0, 8 - Math.abs(nestingDepth(el) - (fp.nesting || 0)));
    return score;
  }

  function findElementByFingerprint(fp) {
    if (!fp) return null;
    let best = null;
    let bestScore = 40;
    if (fp.id) {
      const byId = document.getElementById(fp.id);
      if (byId instanceof HTMLElement && fingerprintScore(byId, fp) > 40) return byId;
    }
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode;
    while (node) {
      if (node instanceof HTMLElement && node.tagName.toLowerCase() === fp.tag) {
        const score = fingerprintScore(node, fp);
        if (score > bestScore) {
          bestScore = score;
          best = node;
        }
      }
      node = walker.nextNode();
    }
    return best;
  }

  function findElementByStoredId(targetId) {
    if (!targetId || targetId === "document") return null;
    for (const el of document.querySelectorAll("*")) {
      if (el.__fineCaptureId === targetId && el instanceof HTMLElement) return el;
    }
    return null;
  }

  function selectionMetaFor(targetId) {
    if (!targetId || targetId === "document") {
      return {
        targetId: "document",
        label: "Página completa (ventana)",
        kind: "document",
        kindLabel: "página",
        fingerprint: null
      };
    }
    const el = STATE.elById.get(targetId) || findElementByStoredId(targetId);
    if (!el) {
      return { targetId, label: targetId, kind: "region", kindLabel: "región", fingerprint: null };
    }
    const overflow = isOverflowScrollable(el);
    const containerKind = classifyContainer(el);
    return {
      targetId,
      label: describeElement(el),
      kind: overflow ? "element" : "region",
      kindLabel: kindLabelEs(containerKind),
      containerKind,
      fingerprint: elementFingerprint(el),
      sizeLabel: (() => {
        const rect = el.getBoundingClientRect();
        return `${Math.round(rect.width || 0)}×${Math.round(Math.max(el.offsetHeight, el.scrollHeight) || 0)}`;
      })(),
      nesting: nestingDepth(el),
      childCount: [...el.children].filter(isMeaningfulChild).length
    };
  }

  function persistSelection(meta) {
    STATE.selectedId = meta.targetId;
    chrome.storage.session
      .set({
        fineCaptureSelectedTarget: meta.targetId,
        fineCaptureSelectedMeta: meta
      })
      .catch(() => {});
  }

  function resolveSelection(meta) {
    const incoming = meta || {};
    const targetId = incoming.targetId || incoming.id || "document";
    if (targetId === "document" && !incoming.fingerprint) {
      STATE.selectedId = "document";
      const resolved = selectionMetaFor("document");
      persistSelection(resolved);
      return { ok: true, ...resolved };
    }

    let el = null;
    if (targetId && targetId !== "document") {
      el = STATE.elById.get(targetId);
      if (!el?.isConnected) el = findElementByStoredId(targetId);
    }
    if (!el?.isConnected && incoming.fingerprint) {
      el = findElementByFingerprint(incoming.fingerprint);
    }
    if (!el?.isConnected) {
      listScrollTargets();
      if (targetId && targetId !== "document") {
        el = STATE.elById.get(targetId) || findElementByStoredId(targetId);
      }
      if (!el?.isConnected && incoming.fingerprint) {
        el = findElementByFingerprint(incoming.fingerprint);
      }
    }
    if (!el?.isConnected) {
      return { ok: false, error: "No se pudo reencontrar la zona elegida. Vuelve a seleccionarla en la página." };
    }

    const id = ensureTargetForElement(el);
    STATE.selectedId = id;
    const resolved = selectionMetaFor(id);
    persistSelection(resolved);
    return { ok: true, ...resolved };
  }

  function describeTargetResponse(targetId) {
    try {
      if (targetId && targetId !== "document" && !STATE.elById.get(targetId)) {
        listScrollTargets();
      }
      const meta = selectionMetaFor(targetId || "document");
      return { ok: true, ...meta };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
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
      badge.textContent = (t.kindLabel || t.label).slice(0, 42);
      badge.title = t.label;
      badge.dataset.targetId = t.id;
      positionBadge(badge, target.el);
      root.appendChild(badge);
      const pickBadge = (e) => {
        killNavEvent(e);
        finishPick(t.id);
      };
      badge.addEventListener("pointerdown", pickBadge);
      badge.addEventListener("click", pickBadge);
    });

    const docChip = document.createElement("button");
    docChip.type = "button";
    docChip.className = "fc-picker-doc";
    docChip.textContent = "Capturar página completa";
    const pickDoc = (e) => {
      killNavEvent(e);
      finishPick("document");
    };
    docChip.addEventListener("pointerdown", pickDoc);
    docChip.addEventListener("click", pickDoc);
    root.appendChild(docChip);

    root.querySelector(".fc-picker-cancel")?.addEventListener("click", (e) => {
      killNavEvent(e);
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
        const kids = [...item.el.children].filter(isMeaningfulChild).length;
        const kind = kindLabelEs(classifyContainer(item.el));
        chip.textContent = kind.length > 28 ? `${kind.slice(0, 26)}…` : kind;
        chip.title = levelLabel(item, i, chain.length);
        const meta = document.createElement("span");
        meta.className = "fc-level-meta";
        meta.textContent = kids ? `${kids}` : item.overflow ? "⌀" : "·";
        chip.appendChild(meta);
        chip.addEventListener("pointerdown", (e) => {
          killNavEvent(e);
          STATE.pickerIndex = i;
          renderLevelStrip();
          placeHover(selectedEl());
        });
        chip.addEventListener("click", (e) => {
          killNavEvent(e);
          STATE.pickerIndex = i;
          renderLevelStrip();
          placeHover(selectedEl());
        });
        chip.addEventListener("dblclick", (e) => {
          killNavEvent(e);
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

    const isPickerChrome = (target) =>
      Boolean(target?.closest?.("#finecapture-picker-root"));

    STATE._onMove = (e) => {
      if (isPickerChrome(e.target)) {
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

    // Confirm on pointerdown so SPA/link navigation never starts (Wallapop cards, etc.).
    STATE._onPointerDown = (e) => {
      if (!STATE.picking) return;
      if (isPickerChrome(e.target)) return;
      if (e.button != null && e.button !== 0) return;
      killNavEvent(e);
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      setChainFromHit(hit);
      confirmCurrentLevel();
    };

    // Swallow follow-up mouse/click/auxclick so anchors and routers never navigate.
    STATE._onSuppressNav = (e) => {
      if (!STATE.picking) return;
      if (isPickerChrome(e.target) && e.type !== "submit") return;
      killNavEvent(e);
    };

    STATE._onClick = (e) => {
      if (!STATE.picking) return;
      if (isPickerChrome(e.target)) return;
      killNavEvent(e);
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
        e.preventDefault();
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
    window.addEventListener("pointerdown", STATE._onPointerDown, true);
    window.addEventListener("mousedown", STATE._onSuppressNav, true);
    window.addEventListener("mouseup", STATE._onSuppressNav, true);
    window.addEventListener("click", STATE._onClick, true);
    window.addEventListener("auxclick", STATE._onSuppressNav, true);
    window.addEventListener("dblclick", STATE._onSuppressNav, true);
    window.addEventListener("submit", STATE._onSuppressNav, true);
    document.addEventListener("click", STATE._onClick, true);
    window.addEventListener("keydown", STATE._onKey, true);
    window.addEventListener("wheel", STATE._onWheel, { capture: true, passive: false });

    return { ok: true, targets: STATE.targets };
  }

  function killNavEvent(e) {
    if (!e) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation?.();
  }

  function positionBadge(badge, el) {
    const rect = el.getBoundingClientRect();
    badge.style.top = `${Math.max(8, rect.top + window.scrollY + 8)}px`;
    badge.style.left = `${Math.max(8, rect.left + window.scrollX + 8)}px`;
  }

  function finishPick(targetId) {
    const meta = selectionMetaFor(targetId);
    persistSelection(meta);
    // Keep swallowing the synthetic click/mouseup that follows pointerdown,
    // otherwise Wallapop/SPA cards navigate after the picker already closed.
    armNavLock(700);
    stopPicker({ keepNavLock: true });
    highlightTarget(meta.targetId);
    chrome.runtime
      .sendMessage({
        type: "PICK_RESULT",
        targetId: meta.targetId,
        label: meta.label,
        kind: meta.kind,
        kindLabel: meta.kindLabel,
        fingerprint: meta.fingerprint,
        meta
      })
      .catch(() => {});
  }

  function armNavLock(ms = 700) {
    STATE.navLockUntil = Date.now() + ms;
    if (STATE._onNavLock) return;
    STATE._onNavLock = (e) => {
      if (Date.now() > STATE.navLockUntil) {
        clearNavLock();
        return;
      }
      killNavEvent(e);
    };
    for (const type of ["click", "auxclick", "mouseup", "mousedown", "pointerup", "dblclick", "submit"]) {
      window.addEventListener(type, STATE._onNavLock, true);
      document.addEventListener(type, STATE._onNavLock, true);
    }
    if (STATE._navLockTimer) clearTimeout(STATE._navLockTimer);
    STATE._navLockTimer = setTimeout(() => clearNavLock(), ms + 50);
  }

  function clearNavLock() {
    STATE.navLockUntil = 0;
    if (STATE._navLockTimer) {
      clearTimeout(STATE._navLockTimer);
      STATE._navLockTimer = null;
    }
    if (!STATE._onNavLock) return;
    for (const type of ["click", "auxclick", "mouseup", "mousedown", "pointerup", "dblclick", "submit"]) {
      window.removeEventListener(type, STATE._onNavLock, true);
      document.removeEventListener(type, STATE._onNavLock, true);
    }
    STATE._onNavLock = null;
  }

  function stopPicker(options = {}) {
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
    if (STATE._onPointerDown) {
      window.removeEventListener("pointerdown", STATE._onPointerDown, true);
      STATE._onPointerDown = null;
    }
    if (STATE._onSuppressNav) {
      window.removeEventListener("mousedown", STATE._onSuppressNav, true);
      window.removeEventListener("mouseup", STATE._onSuppressNav, true);
      window.removeEventListener("auxclick", STATE._onSuppressNav, true);
      window.removeEventListener("dblclick", STATE._onSuppressNav, true);
      window.removeEventListener("submit", STATE._onSuppressNav, true);
      STATE._onSuppressNav = null;
    }
    if (STATE._onClick) {
      window.removeEventListener("click", STATE._onClick, true);
      document.removeEventListener("click", STATE._onClick, true);
      STATE._onClick = null;
    }
    if (STATE._onWheel) {
      window.removeEventListener("wheel", STATE._onWheel, true);
      STATE._onWheel = null;
    }
    if (!options.keepNavLock) clearNavLock();
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
    beginInstantScroll();
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
        viewportW,
        lastContentEnd: 0
      };

      setWindowScrollY(0);

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
    const label = describeElement(el);

    // Overflow scrollport: scroll the element itself and crop to its box.
    if (isOverflowScrollable(el)) {
      const totalHeight = Math.max(el.scrollHeight, measureElementContentHeight(el));
      const viewportH = Math.max(1, el.clientHeight);
      const rect = el.getBoundingClientRect();
      const steps = Math.max(1, Math.ceil(totalHeight / viewportH));

      STATE.capture = {
        kind: "element",
        el,
        originalScroll: el.scrollTop,
        pageScroll: { x: window.scrollX, y: window.scrollY },
        totalHeight,
        viewportH,
        viewportW: el.clientWidth,
        lastContentEnd: 0
      };

      el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      setElementScrollTop(el, 0);

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
    const totalHeight = measureElementContentHeight(el);
    const pageScroll = { x: window.scrollX, y: window.scrollY };
    const scrollParent = pickRegionScrollParent(el, totalHeight);

    if (STATE.hideFixedOverlays) {
      collectOverlayElements(scrollParent || null);
      setOverlaysHidden(true);
    }

    if (scrollParent) {
      const parentRect = scrollParent.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const regionTop = elRect.top - parentRect.top + scrollParent.scrollTop;
      // Step by how much of the parent is actually visible in the browser viewport.
      const visibleParentH = Math.max(
        1,
        Math.min(parentRect.bottom, window.innerHeight) - Math.max(0, parentRect.top)
      );
      const viewportH = Math.max(1, Math.min(scrollParent.clientHeight, visibleParentH, window.innerHeight));
      const viewportW = Math.max(1, Math.min(el.clientWidth || elRect.width, scrollParent.clientWidth, window.innerWidth));
      // +2 slack: short first crops (sticky headers) need extra steps when advancing by lastContentEnd.
      const steps = Math.max(1, Math.ceil(totalHeight / viewportH) + 2);

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
        viewportW,
        lastContentEnd: 0
      };

      setElementScrollTop(scrollParent, Math.max(0, regionTop));
      try {
        el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
      } catch {
        el.scrollIntoView({ block: "nearest", inline: "nearest" });
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
          scrollMode: "parent",
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
    const steps = Math.max(1, Math.ceil(totalHeight / viewportH) + 2);

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
      viewportW,
      lastContentEnd: 0
    };

    setWindowScrollY(Math.max(0, regionTop));

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
        scrollMode: "document",
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
    beginInstantScroll();

    // Option on: hide overlays on every slice. Option off: leave page as-is.
    if (STATE.hideFixedOverlays) {
      setOverlaysHidden(true);
    }

    if (cap.kind === "document") {
      const y = Math.min(step * metrics.viewportH, Math.max(0, metrics.totalHeight - metrics.viewportH));
      const actualY = setWindowScrollY(y);
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
    const actualY = setElementScrollTop(el, y);
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
    const viewportH = Math.max(1, metrics.viewportH || window.innerHeight);
    const totalHeight = Math.max(1, metrics.totalHeight || cap.totalHeight || 1);
    const maxOffset = Math.max(0, totalHeight - 1);
    // Advance from the last accepted content end to avoid gaps when the first crop is shorter than viewportH.
    const desiredOffset =
      step === 0 ? 0 : Math.min(Math.max(0, Number(cap.lastContentEnd) || step * viewportH), maxOffset);

    // Live-anchor each step so regionTop cannot go stale after layout/overlay changes.
    if (cap.scrollMode === "parent" && cap.scrollEl) {
      const parent = cap.scrollEl;
      const parentRect = parent.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const regionTop = elRect.top - parentRect.top + parent.scrollTop;
      cap.regionTop = regionTop;
      setElementScrollTop(parent, regionTop + desiredOffset);
      try {
        parent.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
      } catch {
        parent.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    } else {
      const elRect = el.getBoundingClientRect();
      const liveTop = elRect.top + window.scrollY;
      cap.regionTop = liveTop;
      setWindowScrollY(liveTop + desiredOffset);
    }

    const rect = el.getBoundingClientRect();
    const cropX = Math.max(0, rect.left);
    const cropY = Math.max(0, rect.top);
    const cropRight = Math.min(window.innerWidth, rect.right);
    const cropBottom = Math.min(window.innerHeight, rect.bottom);
    const width = Math.max(1, cropRight - cropX);
    // Window-relative: captureVisibleTab is always the browser viewport.
    // contentOffset = how far into the element the crop top is.
    const contentOffset = Math.max(0, cropY - rect.top);
    const remaining = Math.max(0, totalHeight - contentOffset);
    let height = Math.max(0, cropBottom - cropY);
    height = Math.max(1, Math.min(height, remaining, viewportH));

    // Overlap from previous accepted content end (stable even if scroll was clamped).
    const prevEnd = Number(cap.lastContentEnd) || 0;
    const overlapCss = step === 0 ? 0 : Math.max(0, Math.min(height, prevEnd - contentOffset));
    const nextEnd = contentOffset + height;
    const stuck = step > 0 && nextEnd <= prevEnd + 1;
    cap.lastContentEnd = Math.max(prevEnd, nextEnd);

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
      overlap: overlapCss,
      contentOffset,
      desiredOffset,
      done: stuck || nextEnd >= totalHeight - 1
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
    if (STATE.capture) {
      if (STATE.capture.kind === "document") {
        setWindowScrollY(STATE.capture.originalScroll.y);
        window.scrollTo(STATE.capture.originalScroll.x, STATE.capture.originalScroll.y);
      } else if (STATE.capture.kind === "region") {
        if (STATE.capture.scrollMode === "parent" && STATE.capture.scrollEl) {
          setElementScrollTop(STATE.capture.scrollEl, STATE.capture.originalScroll);
        }
        if (STATE.capture.pageScroll) {
          setWindowScrollY(STATE.capture.pageScroll.y);
          window.scrollTo(STATE.capture.pageScroll.x, STATE.capture.pageScroll.y);
        } else if (STATE.capture.scrollMode === "document" && STATE.capture.originalScroll) {
          setWindowScrollY(STATE.capture.originalScroll.y);
          window.scrollTo(STATE.capture.originalScroll.x, STATE.capture.originalScroll.y);
        }
      } else if (STATE.capture.el) {
        setElementScrollTop(STATE.capture.el, STATE.capture.originalScroll);
        window.scrollTo(STATE.capture.pageScroll.x, STATE.capture.pageScroll.y);
      }
      STATE.capture = null;
    }
    endInstantScroll();
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
      : describeElement(root);

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
