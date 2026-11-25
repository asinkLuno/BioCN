(function () {
  "use strict";
  if (window.__biocnBridge) return;
  window.__biocnBridge = true;

  var root = document.documentElement;
  var state = {
    mode: "scrolled",
    columns: "auto",
    activeCols: 1,
    margin: "normal",
    pageAnimation: true,
    page: 0,
    totalPages: 1,
    spreadWidth: window.innerWidth || 800,
    initialized: false,
    lastParagraph: null,
    slideRaf: 0,
    suppressClickUntil: 0,
    typography: "book",
    spacified: false,
  };

  function cancelSlide() {
    if (state.slideRaf) {
      cancelAnimationFrame(state.slideRaf);
      state.slideRaf = 0;
    }
  }

  function animateScrollLeft(target, duration) {
    cancelSlide();
    if (!document.body) return;
    var start = document.body.scrollLeft;
    var delta = target - start;
    if (!duration || Math.abs(delta) < 1 || typeof requestAnimationFrame === "undefined") {
      document.body.scrollLeft = target;
      return;
    }
    var t0 = performance.now();
    function tick(now) {
      var elapsed = now - t0;
      var p = Math.min(1, elapsed / duration);
      // Cubic ease-out for crisp page turn feel
      var eased = 1 - Math.pow(1 - p, 3);
      document.body.scrollLeft = Math.round(start + delta * eased);
      if (p < 1) {
        state.slideRaf = requestAnimationFrame(tick);
      } else {
        document.body.scrollLeft = target;
        state.slideRaf = 0;
      }
    }
    state.slideRaf = requestAnimationFrame(tick);
  }

  function post(msg) {
    try {
      window.parent.postMessage(Object.assign({ source: "biocn-reader" }, msg), "*");
    } catch (_) {
      // Parent detached
    }
  }

  // 「现代中文」/「传统书刊」的老 WebView 兜底(issue #2):不认 CSS 的
  // text-spacing-trim / text-autospace 时,用与赫蹏同名的行内包裹元素补上
  // 中西文之间的空隙和全角标点挤压,样式见 reader.css 里受 data-typography 门控的规则。
  // shortcut: 两条属性共用一个检测(text-spacing-trim);只支持挤压、不支持自动加空的
  // WebView 会两样都拿不到,真遇到了再分开检测。
  var CJK_RE =
    /[\u2e80-\u2eff\u2f00-\u2fdf\u3040-\u309f\u30a0-\u30fa\u30fc-\u30ff\u3100-\u312f\u3200-\u32ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
  var LATIN_RUN_RE = /[A-Za-z0-9\u00c0-\u00ff\u0370-\u03ff]+/g;
  var PUNCT_STOP = "。．，、：；！？⁇‼";
  var PUNCT_OPEN = "「『（《〈【〖〔［｛";
  var PUNCT_CLOSE = "」』）》〉】〗〕］｝";
  var PUNCT_SEP = "·・‧";
  var PUNCT_QUOTE = "“‘”’";
  var SPACING_SKIP_TAGS = {
    script: 1,
    style: 1,
    code: 1,
    pre: 1,
    kbd: 1,
    samp: 1,
    textarea: 1,
    svg: 1,
    math: 1,
    "heti-spacing": 1,
    "heti-adjacent": 1,
  };
  var SPACING_BLOCKS = "p, li, dd, dt, blockquote, td, th, figcaption, h1, h2, h3, h4, h5, h6";
  var SHOW_TEXT = 4;
  var FILTER_ACCEPT = 1;
  var FILTER_REJECT = 2;
  var spacingFallback = false;
  try {
    spacingFallback = !(
      window.CSS &&
      typeof window.CSS.supports === "function" &&
      window.CSS.supports("text-spacing-trim", "space-all")
    );
  } catch (_) {
    spacingFallback = true;
  }

  function spacingElement(tag, className, text) {
    var el = document.createElement(tag);
    el.className = className;
    el.appendChild(document.createTextNode(text));
    return el;
  }

  function adjacentClass(a, b) {
    var open = PUNCT_OPEN.indexOf(b) >= 0;
    var close = PUNCT_CLOSE.indexOf(b) >= 0;
    if (
      (PUNCT_STOP.indexOf(a) >= 0 && (open || close)) ||
      (PUNCT_OPEN.indexOf(a) >= 0 && open) ||
      (PUNCT_CLOSE.indexOf(a) >= 0 && close)
    ) {
      return "heti-adjacent-half";
    }
    if (
      (PUNCT_SEP.indexOf(a) >= 0 && open) ||
      (PUNCT_CLOSE.indexOf(a) >= 0 && PUNCT_SEP.indexOf(b) >= 0)
    ) {
      return "heti-adjacent-quarter";
    }
    if (
      (PUNCT_STOP.indexOf(a) >= 0 && PUNCT_QUOTE.indexOf(b) >= 0) ||
      (a === "“" && open)
    ) {
      return "heti-adjacent-quarter";
    }
    return "";
  }

  // 不进也不穿透:脚本样式等,以及渐进着色/进度锚点(靠属性定位,内容不能动)。
  function skippedForSpacing(el) {
    if (SPACING_SKIP_TAGS[(el.nodeName || "").toLowerCase()]) return true;
    return !!(
      el.getAttribute &&
      (el.getAttribute("data-br") !== null || el.getAttribute("data-bp") !== null)
    );
  }

  // 取元素某一侧最外层的可见字符,空文本节点往下顺延。
  function edgeChar(el, dir) {
    if (el.nodeType === 3) {
      var value = el.nodeValue;
      if (!value) return "";
      return dir < 0 ? value.slice(-1) : value.charAt(0);
    }
    if (el.nodeType !== 1 || skippedForSpacing(el)) return "";
    var node = el;
    while (node) {
      node = dir < 0 ? node.lastChild : node.firstChild;
      if (!node) return "";
      if (node.nodeType === 3) return edgeChar(node, dir);
      if (node.nodeType !== 1 || skippedForSpacing(node)) return "";
    }
    return "";
  }

  // 跨行内元素找紧邻的字符,碰到所属块级容器就停(不跨段落加空)。
  function outerChars(node, block) {
    return function (dir) {
      var cur = node;
      while (cur && cur !== block) {
        var sib = dir < 0 ? cur.previousSibling : cur.nextSibling;
        while (sib) {
          var ch = edgeChar(sib, dir);
          if (ch) return ch;
          sib = dir < 0 ? sib.previousSibling : sib.nextSibling;
        }
        cur = cur.parentNode;
      }
      return "";
    };
  }

  // 相邻全角标点挤压:把前一个标点单独包起来,靠负外边距收回半个字宽。
  function appendAdjacent(frag, text) {
    var last = 0;
    var changed = false;
    for (var i = 0; i < text.length - 1; i++) {
      var cls = adjacentClass(text.charAt(i), text.charAt(i + 1));
      if (!cls) continue;
      if (i > last) frag.appendChild(document.createTextNode(text.slice(last, i)));
      frag.appendChild(spacingElement("heti-adjacent", cls, text.charAt(i)));
      last = i + 1;
      changed = true;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return changed;
  }

  // 中西文加空:整段西文(字母/数字)前后是汉字时包一层,两侧分别是两种外边距。
  // outer(dir) 取本节点之外的相邻字符,用来覆盖「中文<em>abc</em>中文」这种整段
  // 西文被行内元素包住的常见排法。
  function spacifyText(text, outer) {
    if (!text) return null;
    var frag = document.createDocumentFragment();
    var last = 0;
    var changed = false;
    var m;
    LATIN_RUN_RE.lastIndex = 0;
    while ((m = LATIN_RUN_RE.exec(text))) {
      var end = m.index + m[0].length;
      var before = m.index > 0 ? text.charAt(m.index - 1) : outer(-1);
      var after = end < text.length ? text.charAt(end) : outer(1);
      var cls = "";
      if (CJK_RE.test(before)) cls += " heti-spacing-end";
      if (CJK_RE.test(after)) cls += " heti-spacing-start";
      if (!cls) continue;
      if (m.index > last && appendAdjacent(frag, text.slice(last, m.index))) changed = true;
      frag.appendChild(spacingElement("heti-spacing", cls.slice(1), m[0]));
      changed = true;
      last = end;
    }
    if (appendAdjacent(frag, text.slice(last))) changed = true;
    return changed ? frag : null;
  }

  function spacifyBlock(block) {
    if (!block) return false;
    var nodes = [];
    var walker = document.createTreeWalker(block, SHOW_TEXT, {
      acceptNode: function (node) {
        var p = node.parentNode;
        while (p && p !== block) {
          if (skippedForSpacing(p)) return FILTER_REJECT;
          p = p.parentNode;
        }
        return FILTER_ACCEPT;
      },
    });
    var n;
    while ((n = walker.nextNode())) nodes.push(n);
    var changed = false;
    for (var i = 0; i < nodes.length; i++) {
      var frag = spacifyText(nodes[i].nodeValue, outerChars(nodes[i], block));
      if (!frag) continue;
      nodes[i].parentNode.replaceChild(frag, nodes[i]);
      changed = true;
    }
    return changed;
  }

  function spacifyBlocks(blocks) {
    if (!spacingFallback || state.typography === "book") return false;
    var changed = false;
    for (var i = 0; i < blocks.length; i++) {
      if (spacifyBlock(blocks[i])) changed = true;
    }
    return changed;
  }

  // 补了空隙等于改了行宽:分页下要重算列高,并保住当前段落不跳。
  var pendingLayout = 0;
  function scheduleLayout() {
    if (pendingLayout) return;
    pendingLayout = requestAnimationFrame(function () {
      pendingLayout = 0;
      if (state.mode !== "paginated") return;
      var p = state.lastParagraph !== null ? state.lastParagraph : findVisibleParagraph();
      layoutPaginated();
      if (p !== null) scrollToParagraph(p);
      reportProgress();
    });
  }

  function applyPrefs(prefs) {
    if (!prefs) return;
    var anchorBefore = state.initialized ? findVisibleParagraph() : null;
    var ratioBefore = state.initialized ? currentRatio() : null;

    root.setAttribute("data-theme", prefs.theme || "auto");
    root.setAttribute("data-mode", prefs.viewMode || "scrolled");
    var typography =
      prefs.typography === "heti-modern" || prefs.typography === "heti-classic"
        ? prefs.typography
        : "book";
    root.setAttribute("data-typography", typography);
    root.setAttribute("data-font", prefs.fontFamily === "serif" ? "serif" : "default");
    root.setAttribute(
      "data-margin",
      prefs.pageMargin === "compact" || prefs.pageMargin === "wide" ? prefs.pageMargin : "normal",
    );
    root.setAttribute("data-align", prefs.textAlign === "justify" ? "justify" : "default");
    root.setAttribute("data-dim-images", prefs.dimImagesInDark === false ? "off" : "on");
    var colors = prefs.svoColors || {};
    var hexRe = /^#[0-9a-fA-F]{6}$/;
    var initialSvoStyle = document.getElementById("biocn-svo-override");
    if (initialSvoStyle) {
      initialSvoStyle.remove();
    }
    var roleVars = [
      ["subject", "--svo-subject"],
      ["predicate", "--svo-predicate"],
      ["object", "--svo-object"],
    ];
    for (var i = 0; i < roleVars.length; i++) {
      var val = colors[roleVars[i][0]];
      if (typeof val === "string" && hexRe.test(val)) {
        root.style.setProperty(roleVars[i][1], val);
      } else {
        root.style.removeProperty(roleVars[i][1]);
      }
    }
    root.style.setProperty("--reader-font-size", (prefs.fontSize || 17) + "px");
    root.style.setProperty("--reader-line-height", String(prefs.lineHeight || 1.9));
    root.style.setProperty(
      "--reader-para-spacing",
      String(typeof prefs.paragraphSpacing === "number" ? prefs.paragraphSpacing : 0.8) + "em",
    );
    state.mode = prefs.viewMode === "paginated" ? "paginated" : "scrolled";
    state.columns = prefs.columns || "auto";
    state.margin =
      prefs.pageMargin === "compact" || prefs.pageMargin === "wide" ? prefs.pageMargin : "normal";
    state.pageAnimation = prefs.pageAnimation !== false;
    state.typography = typography;

    // 只在首次切到中文排版时全量补一次(幂等),字号滑块重绘不再重走 DOM。
    if (spacingFallback && !state.spacified && typography !== "book") {
      spacifyBlocks(document.querySelectorAll(SPACING_BLOCKS));
      state.spacified = true;
    }

    if (state.mode === "paginated") {
      layoutPaginated();
    } else {
      clearPaginated();
    }

    if (state.initialized) {
      if (anchorBefore !== null) {
        scrollToParagraph(anchorBefore);
      } else if (ratioBefore !== null) {
        seekToRatio(ratioBefore);
      }
      reportProgress();
    }
  }

  function layoutPaginated() {
    var vw = window.innerWidth || 800;
    var cols = state.columns === 1 || state.columns === 2 ? state.columns : vw >= 920 ? 2 : 1;
    var gap, padY, maxSpread;
    if (state.margin === "compact") {
      gap = vw < 540 ? 24 : 36;
      padY = vw < 540 ? 14 : 20;
      maxSpread = cols === 2 ? 1280 : 880;
    } else if (state.margin === "wide") {
      gap = vw < 540 ? 48 : 80;
      padY = vw < 540 ? 28 : 40;
      maxSpread = cols === 2 ? 1020 : 660;
    } else {
      gap = vw < 540 ? 36 : 56;
      padY = vw < 540 ? 20 : 28;
      maxSpread = cols === 2 ? 1160 : 760;
    }
    var padX = Math.floor(gap / 2);
    var spread = Math.min(vw, maxSpread);
    var colWidth = Math.max(180, Math.floor((spread - cols * gap) / cols));
    // Recompute exact spread so `cols * colWidth + cols * gap === spread` (exact integer stride).
    spread = cols * (colWidth + gap);

    root.style.setProperty("--page-pad-x", padX + "px");
    root.style.setProperty("--page-pad-y", padY + "px");
    root.style.setProperty("--spread-width", spread + "px");
    root.style.setProperty("--col-width", colWidth + "px");
    root.style.setProperty("--col-gap", gap + "px");

    state.activeCols = cols;
    state.spreadWidth = spread;
    recountPages();
  }

  function removePageTail() {
    var tail = document.getElementById("biocn-page-tail");
    if (tail && tail.parentNode) {
      tail.parentNode.removeChild(tail);
    }
  }

  function ensurePageTail(count) {
    if (!document.body) return null;
    var tail = document.getElementById("biocn-page-tail");
    if (!tail) {
      tail = document.createElement("div");
      tail.id = "biocn-page-tail";
      tail.setAttribute("aria-hidden", "true");
      document.body.appendChild(tail);
    } else if (tail !== document.body.lastElementChild) {
      document.body.appendChild(tail);
    }
    while (tail.children.length < count) {
      var col = document.createElement("div");
      col.className = "biocn-page-tail-col";
      col.textContent = "\u00a0";
      tail.appendChild(col);
    }
    while (tail.children.length > count) {
      tail.removeChild(tail.lastChild);
    }
    return tail;
  }

  function clearPaginated() {
    cancelSlide();
    removePageTail();
    if (document.body) {
      document.body.scrollLeft = 0;
    }
    state.page = 0;
    state.totalPages = 1;
  }

  function recountPages() {
    if (state.mode !== "paginated" || !document.body) return;
    var savedScrollLeft = document.body.scrollLeft;
    var existingTail = document.getElementById("biocn-page-tail");
    if (existingTail) {
      existingTail.style.display = "none";
    }
    var sw = document.body.scrollWidth || state.spreadWidth;
    var stride = state.spreadWidth || window.innerWidth || 1;
    // Small epsilon avoids phantom trailing blank page from 1px subpixel rounding.
    state.totalPages = Math.max(1, Math.ceil((sw - 2) / stride));

    // Append invisible trailing columns when paginated spans >1 page so the
    // last page can always scroll to `(totalPages - 1) * stride` without the
    // browser clamping short of `padding-right` or an odd 2-column spread.
    if (state.totalPages > 1) {
      var tail = ensurePageTail(state.activeCols || 1);
      if (tail) tail.style.display = "block";
    } else if (existingTail) {
      existingTail.style.display = "none";
    }

    var maxPageScroll = Math.max(0, (state.totalPages - 1) * stride);
    if (state.page >= state.totalPages) {
      state.page = state.totalPages - 1;
      cancelSlide();
      document.body.scrollLeft = state.page * stride;
    } else if (document.body.scrollLeft !== savedScrollLeft) {
      document.body.scrollLeft = Math.min(savedScrollLeft, maxPageScroll);
    }
  }

  function prefersReducedMotion() {
    return (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function goToPage(page, animate) {
    if (state.mode !== "paginated" || !document.body) return;
    recountPages();
    var clamped = Math.max(0, Math.min(state.totalPages - 1, page));
    state.page = clamped;
    var targetLeft = clamped * state.spreadWidth;
    if (animate && state.pageAnimation && !prefersReducedMotion()) {
      animateScrollLeft(targetLeft, 220);
    } else {
      cancelSlide();
      document.body.scrollLeft = targetLeft;
    }
    reportProgress();
  }

  function step(direction) {
    if (hoveredFootnoteAnchor) {
      cancelPendingHover();
      hoveredFootnoteAnchor = null;
    }
    if (state.mode === "paginated") {
      recountPages();
      if (direction === "next") {
        if (state.page < state.totalPages - 1) {
          goToPage(state.page + 1, true);
        } else {
          post({ type: "turn", direction: "next" });
        }
      } else {
        if (state.page > 0) {
          goToPage(state.page - 1, true);
        } else {
          post({ type: "turn", direction: "prev" });
        }
      }
      return;
    }
    // Scrolled mode: step by 85% of viewport height; turn chapter at boundaries.
    var vh = window.innerHeight || 600;
    var maxScroll = Math.max(0, root.scrollHeight - vh);
    var cur = window.scrollY || root.scrollTop || 0;
    var scrollBehavior = state.pageAnimation && !prefersReducedMotion() ? "smooth" : "auto";
    if (direction === "next") {
      if (cur >= maxScroll - 4) {
        post({ type: "turn", direction: "next" });
      } else {
        window.scrollTo({
          top: Math.min(maxScroll, cur + Math.floor(vh * 0.85)),
          behavior: scrollBehavior,
        });
      }
    } else {
      if (cur <= 4) {
        post({ type: "turn", direction: "prev" });
      } else {
        window.scrollTo({
          top: Math.max(0, cur - Math.floor(vh * 0.85)),
          behavior: scrollBehavior,
        });
      }
    }
  }

  function scrollToElement(el) {
    if (!el) return false;
    if (state.mode === "paginated" && document.body) {
      recountPages();
      var bodyRect = document.body.getBoundingClientRect();
      var elRect = el.getBoundingClientRect();
      var offsetInScroll = elRect.left - bodyRect.left + document.body.scrollLeft;
      var targetPage = Math.floor(Math.max(0, offsetInScroll) / state.spreadWidth);
      goToPage(targetPage);
      return true;
    }
    var rect = el.getBoundingClientRect();
    var targetY = Math.max(0, (window.scrollY || root.scrollTop || 0) + rect.top - 16);
    window.scrollTo(0, targetY);
    reportProgress();
    return true;
  }

  function scrollToAnchor(anchor) {
    if (!anchor) return false;
    var el =
      document.getElementById(anchor) ||
      document.getElementsByName(anchor)[0] ||
      null;
    return scrollToElement(el);
  }

  function scrollToParagraph(pIndex) {
    if (pIndex === null || pIndex === undefined) return false;
    var el = document.querySelector('span[data-bp="' + pIndex + '"]');
    return scrollToElement(el);
  }

  function seekToRatio(ratio) {
    var clamped = Math.max(0, Math.min(1, Number(ratio) || 0));
    if (state.mode === "paginated") {
      recountPages();
      var target = Math.round(clamped * (state.totalPages - 1));
      goToPage(target);
      return;
    }
    var maxScroll = Math.max(0, root.scrollHeight - (window.innerHeight || 0));
    window.scrollTo(0, Math.round(clamped * maxScroll));
    reportProgress();
  }

  function currentRatio() {
    if (state.mode === "paginated") {
      return state.totalPages <= 1 ? 0 : state.page / (state.totalPages - 1);
    }
    var maxScroll = Math.max(0, root.scrollHeight - (window.innerHeight || 0));
    if (maxScroll <= 0) return 0;
    return Math.max(0, Math.min(1, (window.scrollY || root.scrollTop || 0) / maxScroll));
  }

  function findVisibleParagraph() {
    var anchors = document.querySelectorAll("span[data-bp]");
    if (!anchors.length) return null;
    if (state.mode === "paginated" && document.body) {
      var bodyRect = document.body.getBoundingClientRect();
      var firstOnPage = null;
      var lastBefore = null;
      for (var i = 0; i < anchors.length; i++) {
        var r = anchors[i].getBoundingClientRect();
        var relX = r.left - bodyRect.left;
        if (relX >= -2 && relX < state.spreadWidth) {
          firstOnPage = Number(anchors[i].getAttribute("data-bp"));
          break;
        }
        if (relX < 0) {
          lastBefore = Number(anchors[i].getAttribute("data-bp"));
        }
      }
      return firstOnPage !== null ? firstOnPage : lastBefore;
    }
    var best = null;
    for (var j = 0; j < anchors.length; j++) {
      var top = anchors[j].getBoundingClientRect().top;
      if (top >= -12) {
        best = Number(anchors[j].getAttribute("data-bp"));
        break;
      }
      best = Number(anchors[j].getAttribute("data-bp"));
    }
    return best;
  }

  function reportProgress() {
    var ratio = currentRatio();
    var p = findVisibleParagraph();
    state.lastParagraph = p;
    post({
      type: "progress",
      mode: state.mode,
      page: state.mode === "paginated" ? state.page : 0,
      totalPages: state.mode === "paginated" ? state.totalPages : 1,
      ratio: ratio,
      paragraphIndex: p,
    });
  }

  function applyPatches(patches) {
    if (!Array.isArray(patches) || !patches.length) return;
    var keyRe = /^\d+-\d+$/;
    var tpl = document.createElement("template");
    var touched = [];
    for (var i = 0; i < patches.length; i++) {
      var item = patches[i];
      if (!item || typeof item.key !== "string" || !keyRe.test(item.key)) continue;
      var el = document.querySelector('span[data-br="' + item.key + '"]');
      if (!el) continue;
      var host = el.parentNode;
      if (!host) continue;
      tpl.innerHTML = item.html;
      host.replaceChild(tpl.content, el);
      if (touched.indexOf(host) < 0) touched.push(host);
    }
    // 补进去的空隙会改变行宽,分页下要重算并保住当前位置。
    if (spacifyBlocks(touched)) scheduleLayout();
  }

  function reloadSerifFont() {
    var id = "biocn-serif-reload";
    var existing = document.getElementById(id);
    if (existing && existing.parentNode) {
      existing.parentNode.removeChild(existing);
    }
    var style = document.createElement("style");
    style.id = id;
    style.textContent =
      '@font-face { font-family: "BioCN Source Han Serif"; font-style: normal; font-weight: 400; font-display: swap; src: url("/__biocn__/fonts/SourceHanSerifSC-Regular.woff2?v=' +
      Date.now() +
      '") format("woff2"); }';
    (document.head || document.documentElement).appendChild(style);
    if (document.fonts && typeof document.fonts.load === "function") {
      document.fonts
        .load('16px "BioCN Source Han Serif"')
        .then(function () {
          if (state.mode === "paginated") {
            var p = state.lastParagraph !== null ? state.lastParagraph : findVisibleParagraph();
            layoutPaginated();
            if (p !== null) scrollToParagraph(p);
            reportProgress();
          }
        })
        .catch(function () {});
    }
  }

  // Host → Iframe commands
  window.addEventListener("message", function (event) {
    if (event.source && event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.source !== "biocn-host") return;
    switch (data.type) {
      case "init":
        applyPrefs(data.prefs);
        state.initialized = true;
        requestAnimationFrame(function () {
          if (state.mode === "paginated") layoutPaginated();
          var target = data.target || {};
          var landed = false;
          if (target.anchor) {
            landed = scrollToAnchor(target.anchor);
          } else if (target.edge === "end") {
            seekToRatio(1);
            landed = true;
          } else if (target.paragraphIndex !== null && target.paragraphIndex !== undefined) {
            landed = scrollToParagraph(target.paragraphIndex);
          }
          if (!landed && typeof target.ratio === "number" && target.ratio > 0) {
            seekToRatio(target.ratio);
          }
          reportProgress();
          requestAnimationFrame(function () {
            post({ type: "painted" });
          });
        });
        break;
      case "prefs":
        applyPrefs(data.prefs);
        break;
      case "patch":
        applyPatches(data.patches);
        break;
      case "step":
        step(data.direction);
        break;
      case "seek":
        seekToRatio(data.ratio);
        break;
      case "jump":
        if (data.anchor) scrollToAnchor(data.anchor);
        else if (data.paragraphIndex !== null && data.paragraphIndex !== undefined) {
          scrollToParagraph(data.paragraphIndex);
        }
        break;
      case "resolve-footnote":
        if (typeof data.requestId === "number" && data.href && data.anchor) {
          resolveRemoteFootnoteRequest(data.requestId, data.href, data.anchor);
        }
        break;
      case "font-ready":
        reloadSerifFont();
        break;
    }
  });

  // Throttled scroll reporting in scrolled mode
  var scrollTimer = 0;
  window.addEventListener(
    "scroll",
    function () {
      if (hoveredFootnoteAnchor) {
        cancelPendingHover();
        hoveredFootnoteAnchor = null;
      }
      if (state.mode !== "scrolled" || !state.initialized) return;
      if (scrollTimer) return;
      scrollTimer = requestAnimationFrame(function () {
        scrollTimer = 0;
        reportProgress();
      });
    },
    { passive: true }
  );

  // Re-layout on window resize (preserving current paragraph anchor)
  var resizeTimer = 0;
  window.addEventListener("resize", function () {
    if (!state.initialized) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      var p = state.lastParagraph !== null ? state.lastParagraph : findVisibleParagraph();
      if (state.mode === "paginated") {
        layoutPaginated();
        if (p !== null) scrollToParagraph(p);
      }
      reportProgress();
    }, 80);
  });

  // Mouse wheel & trackpad horizontal/vertical swipe paging in paginated mode
  var wheelLock = 0;
  var wheelAccum = 0;
  var wheelResetTimer = 0;
  window.addEventListener(
    "wheel",
    function (event) {
      if (state.mode !== "paginated") return;
      if (Math.abs(event.deltaY) < 2 && Math.abs(event.deltaX) < 2) return;
      event.preventDefault();
      var now = Date.now();
      if (now < wheelLock) return;
      var delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      wheelAccum += delta;
      clearTimeout(wheelResetTimer);
      wheelResetTimer = setTimeout(function () {
        wheelAccum = 0;
      }, 140);
      if (Math.abs(wheelAccum) >= 24) {
        var dir = wheelAccum > 0 ? "next" : "prev";
        wheelAccum = 0;
        wheelLock = now + 280;
        step(dir);
      }
    },
    { passive: false }
  );

  // Touch swipe & live 1:1 drag-follow paging (Android / touchscreens)
  var drag = null;
  var lastTouchAt = 0;
  window.addEventListener(
    "touchstart",
    function (event) {
      lastTouchAt = Date.now();
      if (event.touches.length !== 1) {
        drag = null;
        return;
      }
      var t = event.touches[0];
      if (state.mode === "paginated") {
        cancelSlide();
        recountPages();
      }
      drag = {
        startX: t.clientX,
        startY: t.clientY,
        lastX: t.clientX,
        time: Date.now(),
        baseScroll: state.page * state.spreadWidth,
        axis: null,
      };
    },
    { passive: true }
  );

  window.addEventListener(
    "touchmove",
    function (event) {
      if (!drag || event.touches.length !== 1) return;
      var t = event.touches[0];
      var dx = t.clientX - drag.startX;
      var dy = t.clientY - drag.startY;
      drag.lastX = t.clientX;

      if (!drag.axis) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        drag.axis = Math.abs(dx) > Math.abs(dy) * 1.15 ? "x" : "y";
      }
      if (drag.axis !== "x") return;

      if (state.mode === "paginated" && document.body) {
        event.preventDefault();
        var maxScroll = Math.max(0, (state.totalPages - 1) * state.spreadWidth);
        var desired = drag.baseScroll - dx;
        // Clamp within valid scroll range (soft resistance at chapter boundaries)
        if (desired < 0) desired = 0;
        else if (desired > maxScroll) desired = maxScroll;
        document.body.scrollLeft = Math.round(desired);
      }
    },
    { passive: false }
  );

  function finishTouch(event, cancelled) {
    if (!drag) return;
    var active = drag;
    drag = null;
    if (active.axis !== "x") return;

    state.suppressClickUntil = Date.now() + 350;
    if (cancelled) {
      if (state.mode === "paginated") goToPage(state.page, true);
      return;
    }

    var endX =
      event.changedTouches && event.changedTouches.length
        ? event.changedTouches[0].clientX
        : active.lastX;
    var dx = endX - active.startX;
    var dt = Math.max(1, Date.now() - active.time);
    var velocity = Math.abs(dx) / dt;

    if (state.mode === "paginated") {
      var threshold = Math.max(36, state.spreadWidth * 0.18);
      if (Math.abs(dx) >= threshold || (Math.abs(dx) >= 24 && velocity >= 0.35)) {
        step(dx < 0 ? "next" : "prev");
      } else {
        goToPage(state.page, true);
      }
      return;
    }

    // Scrolled mode: deliberate horizontal swipe turns previous/next chapter.
    if (dt < 500 && Math.abs(dx) >= 64) {
      post({ type: "turn", direction: dx < 0 ? "next" : "prev" });
    }
  }

  window.addEventListener(
    "touchend",
    function (event) {
      finishTouch(event, false);
    },
    { passive: true }
  );
  window.addEventListener(
    "touchcancel",
    function (event) {
      finishTouch(event, true);
    },
    { passive: true }
  );

  // Footnote detection, extraction, and same-origin cross-chapter resolution
  var footnoteDocCache = Object.create(null);
  var footnoteDocOrder = [];
  var NOTE_MARKER_RE =
    /^(\[?\d{1,3}\]?|\(\d{1,3}\)|（\d{1,3}）|【\d{1,3}】|〔\d{1,3}〕|［\d{1,3}］|\{\d{1,3}\}|[①-⑳㉑-㊿⑴-⒇⒈-⒛]+|[*†‡§※]+|(?:注|译注|原注|编者注)\s*[\[（(【〔]?\d*[①-⑳㉑-㊿]?[\]）)】〕]?|(?:注释|脚注|见注)\s*[\[（(【〔]?(?:\d+|[①-⑳㉑-㊿])[\]）)】〕]?)$/;
  var NOTE_ID_RE =
    /^(fn|ftn|footnote|endnote|rearnote|note|en|ref|n|zhushi|zhu|comment)[-_:.]?\d/i;
  var NOTE_CLASS_RE =
    /(?:^|[\s_-])(noteref|footnote|endnote|rearnote|fnref|duokan-footnote)(?:$|[\s_-])/i;
  var NOTE_CONTAINER_CLASS_RE =
    /(?:^|[\s_-])(footnote|endnote|rearnote|duokan-footnote-item|duokan-footnote-content)(?:$|[\s_-])/i;
  var BACKLINK_TEXT_RE =
    /^(↩|↩︎|↩️|↵|↑|▲|△|⬆|⇧|⏎|«|‹|返回|回到正文|back|\[back\])$/i;

  function safeDecode(value) {
    try {
      return decodeURIComponent(value);
    } catch (_) {
      return value;
    }
  }

  function getEpubType(el) {
    if (!el || !el.getAttribute) return "";
    var val = el.getAttribute("epub:type");
    if (val) return val;
    if (el.getAttributeNS) {
      try {
        val = el.getAttributeNS("http://www.idpf.org/2007/ops", "type");
        if (val) return val;
      } catch (_) {
        // Ignore namespace errors
      }
    }
    return "";
  }

  function hasToken(str, tokens) {
    if (!str) return false;
    var parts = String(str).toLowerCase().trim().split(/\s+/);
    for (var i = 0; i < parts.length; i++) {
      for (var j = 0; j < tokens.length; j++) {
        if (parts[i] === tokens[j]) return true;
      }
    }
    return false;
  }

  function isFootnoteContainer(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === "ASIDE") return true;
    if (
      hasToken(getEpubType(el), [
        "footnote",
        "endnote",
        "rearnote",
        "note",
        "glossary",
        "biblioentry",
      ])
    ) {
      return true;
    }
    if (
      hasToken(el.getAttribute("role"), [
        "doc-footnote",
        "doc-endnote",
        "doc-rearnote",
        "doc-biblioentry",
      ])
    ) {
      return true;
    }
    var cls = typeof el.className === "string" ? el.className : "";
    return Boolean(cls && NOTE_CONTAINER_CLASS_RE.test(cls));
  }

  function isBacklink(anchor) {
    if (!anchor) return false;
    if (
      hasToken(getEpubType(anchor), ["backlink"]) ||
      hasToken(anchor.getAttribute("role"), ["doc-backlink"])
    ) {
      return true;
    }
    if (
      hasToken(getEpubType(anchor), ["noteref", "biblioref", "glossref", "annoref"]) ||
      hasToken(anchor.getAttribute("role"), ["doc-noteref", "doc-biblioref", "doc-glossref"])
    ) {
      return false;
    }
    var cur = anchor.parentElement;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      if (isFootnoteContainer(cur)) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  function isNoterefLink(anchor, anchorId) {
    if (!anchor || isBacklink(anchor)) return false;
    if (
      hasToken(getEpubType(anchor), ["noteref", "biblioref", "glossref", "annoref"]) ||
      hasToken(anchor.getAttribute("role"), ["doc-noteref", "doc-biblioref", "doc-glossref"])
    ) {
      return true;
    }
    if (
      (anchor.closest && anchor.closest("sup")) ||
      (anchor.querySelector && anchor.querySelector("sup"))
    ) {
      return true;
    }
    var cls = typeof anchor.className === "string" ? anchor.className : "";
    if (cls && NOTE_CLASS_RE.test(cls)) return true;
    var parentCls =
      anchor.parentElement && typeof anchor.parentElement.className === "string"
        ? anchor.parentElement.className
        : "";
    if (parentCls && NOTE_CLASS_RE.test(parentCls)) return true;

    var text = (anchor.textContent || "").trim();
    if (text.length > 0 && text.length <= 12 && NOTE_MARKER_RE.test(text)) {
      return true;
    }
    if (
      text.length === 0 &&
      anchor.querySelector &&
      anchor.querySelector("img") &&
      anchorId &&
      NOTE_ID_RE.test(anchorId)
    ) {
      return true;
    }
    return false;
  }

  function getFootnoteLabel(anchor) {
    var text = anchor ? (anchor.textContent || "").trim().replace(/\s+/g, " ") : "";
    if (!text && anchor && anchor.querySelector) {
      var img = anchor.querySelector("img[alt]");
      if (img) text = (img.getAttribute("alt") || "").trim();
    }
    if (!text) return "注释";
    return text.length > 24 ? text.slice(0, 24) + "…" : text;
  }

  function findAnchorTarget(doc, anchorId) {
    if (!doc || !anchorId) return null;
    var el = doc.getElementById(anchorId);
    if (el) return el;
    if (doc.getElementsByName) {
      var named = doc.getElementsByName(anchorId);
      if (named && named.length > 0) return named[0];
    }
    return null;
  }

  function isFootnoteTarget(target) {
    if (!target || target.nodeType !== 1) return false;
    if (isFootnoteContainer(target)) return true;
    var inlineTags = {
      A: 1,
      SPAN: 1,
      SUP: 1,
      SUB: 1,
      B: 1,
      STRONG: 1,
      EM: 1,
      I: 1,
      SMALL: 1,
    };
    if (inlineTags[target.tagName] && target.parentElement) {
      if (isFootnoteContainer(target.parentElement)) return true;
      if (
        target.parentElement.parentElement &&
        isFootnoteContainer(target.parentElement.parentElement)
      ) {
        return true;
      }
    }
    return false;
  }

  function isReasonableNoteContainer(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === "BODY" || el.tagName === "HTML") return false;
    if (el.querySelector && el.querySelector("h1, h2, h3")) return false;
    var textLen = (el.textContent || "").trim().length;
    if (textLen > 4000) {
      var idChildren = 0;
      for (var i = 0; i < el.children.length; i++) {
        if (el.children[i].id) idChildren++;
      }
      if (idChildren > 3) return false;
    }
    return true;
  }

  function resolveFootnoteBlock(doc, target) {
    if (!target || target.nodeType !== 1) return null;
    var tag = target.tagName;
    if (tag === "BODY" || tag === "HTML" || /^H[1-6]$/.test(tag)) return null;

    if (tag === "DT") {
      var next = target.nextElementSibling;
      if (next && next.tagName === "DD") {
        var wrap = doc.createElement("div");
        wrap.appendChild(target.cloneNode(true));
        wrap.appendChild(next.cloneNode(true));
        return wrap;
      }
      return null;
    }

    if (
      tag === "ASIDE" ||
      tag === "LI" ||
      tag === "BLOCKQUOTE" ||
      tag === "DD" ||
      tag === "P" ||
      tag === "TR"
    ) {
      return target;
    }

    if (tag === "DIV" || tag === "SECTION" || tag === "ARTICLE") {
      return isReasonableNoteContainer(target) ? target : null;
    }

    // Inline target (e.g. `<a id="fn1">` or `<span id="fn1">`) inside a note block.
    var block = target.closest
      ? target.closest("aside, li, p, dd, blockquote, tr")
      : null;
    if (block && block !== doc.body) {
      return block;
    }

    // Empty anchor immediately preceding a note paragraph: `<a id="fn1"></a><p>...</p>`
    var trimmedTarget = (target.textContent || "").trim();
    if (!trimmedTarget && target.nextElementSibling) {
      var sib = target.nextElementSibling;
      if (
        (sib.tagName === "P" ||
          sib.tagName === "ASIDE" ||
          sib.tagName === "BLOCKQUOTE" ||
          sib.tagName === "DIV") &&
        isReasonableNoteContainer(sib)
      ) {
        return sib;
      }
    }

    var parent = target.parentElement;
    if (parent && parent.tagName === "DIV" && isReasonableNoteContainer(parent)) {
      var pCount = parent.querySelectorAll ? parent.querySelectorAll("p").length : 0;
      if (pCount <= 3) return parent;
    }
    return null;
  }

  function extractHashId(href) {
    if (!href) return "";
    var idx = href.indexOf("#");
    if (idx < 0) return "";
    return safeDecode(href.slice(idx + 1));
  }

  function extractFootnoteHtml(doc, anchorId, sourceAnchor, requireTargetSemantics) {
    var target = findAnchorTarget(doc, anchorId);
    if (!target) return null;

    var block = resolveFootnoteBlock(doc, target);
    if (!block) return null;

    var explicitTarget = isFootnoteTarget(target) || isFootnoteContainer(block);
    if (requireTargetSemantics && !explicitTarget) {
      var hasBacklinkInside = Boolean(
        block.querySelector &&
          block.querySelector(
            'a[role="doc-backlink"], a[epub\\:type~="backlink"], a[href*="#"]'
          )
      );
      if (!hasBacklinkInside && !NOTE_ID_RE.test(anchorId)) {
        return null;
      }
    }

    var clone = block.cloneNode(true);

    // Strip non-content / active elements (host still strictly sanitizes too).
    var forbidden = clone.querySelectorAll(
      "script, style, iframe, frame, frameset, object, embed, link, meta, base, form, input, button, select, textarea"
    );
    for (var f = 0; f < forbidden.length; f++) {
      if (forbidden[f].parentNode) forbidden[f].parentNode.removeChild(forbidden[f]);
    }

    // Collect clicked reference ids so matching backlinks in the footnote can be stripped.
    var sourceIds = Object.create(null);
    if (sourceAnchor) {
      if (sourceAnchor.id) sourceIds[sourceAnchor.id] = true;
      var sName = sourceAnchor.getAttribute("name");
      if (sName) sourceIds[sName] = true;
      if (sourceAnchor.parentElement && sourceAnchor.parentElement.id) {
        sourceIds[sourceAnchor.parentElement.id] = true;
      }
    }

    var links = clone.querySelectorAll("a");
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      var aHref = a.getAttribute("href");
      if (!aHref) {
        // Unwrap pure anchor tags (`<a id="fn1"></a>` or `<a name="fn1">1.</a>`)
        if (a.parentNode) {
          while (a.firstChild) {
            a.parentNode.insertBefore(a.firstChild, a);
          }
          a.parentNode.removeChild(a);
        }
        continue;
      }
      var aText = (a.textContent || "").trim();
      var aHash = extractHashId(aHref);
      var isBack =
        hasToken(getEpubType(a), ["backlink"]) ||
        hasToken(a.getAttribute("role"), ["doc-backlink"]) ||
        Boolean(aHash && sourceIds[aHash]) ||
        BACKLINK_TEXT_RE.test(aText);
      if (isBack && a.parentNode) {
        var wrapper = a.parentElement;
        a.parentNode.removeChild(a);
        if (
          wrapper &&
          wrapper !== clone &&
          (wrapper.tagName === "SUP" || wrapper.tagName === "SPAN") &&
          !(wrapper.textContent || "").trim() &&
          !wrapper.querySelector("img") &&
          wrapper.parentNode
        ) {
          wrapper.parentNode.removeChild(wrapper);
        }
      }
    }

    var text = (clone.textContent || "").trim();
    var hasImg = Boolean(clone.querySelector && clone.querySelector("img"));
    if (!text && !hasImg) return null;
    if (text.length > 8000 && !explicitTarget) return null;

    var tag = clone.tagName;
    if (tag === "LI" || tag === "ASIDE" || tag === "DD" || tag === "DIV" || tag === "SECTION") {
      return clone.innerHTML;
    }
    return clone.outerHTML;
  }

  function fetchFootnoteDocument(docUrl) {
    if (footnoteDocCache[docUrl]) {
      return Promise.resolve(footnoteDocCache[docUrl]);
    }
    if (typeof fetch !== "function" || typeof DOMParser !== "function") {
      return Promise.resolve(null);
    }
    return fetch(docUrl)
      .then(function (res) {
        if (!res || !res.ok) return null;
        return res.text();
      })
      .then(function (html) {
        if (!html) return null;
        var parsed = new DOMParser().parseFromString(html, "text/html");
        if (!parsed) return null;
        footnoteDocCache[docUrl] = parsed;
        footnoteDocOrder.push(docUrl);
        if (footnoteDocOrder.length > 8) {
          var oldest = footnoteDocOrder.shift();
          delete footnoteDocCache[oldest];
        }
        return parsed;
      })
      .catch(function () {
        return null;
      });
  }

  function resolveRemoteFootnoteRequest(requestId, rawHref, anchorId) {
    var resolvedUrl;
    try {
      resolvedUrl = new URL(rawHref, window.location.href);
    } catch (_) {
      post({
        type: "footnote-result",
        requestId: requestId,
        href: rawHref,
        anchor: anchorId,
        found: false,
      });
      return;
    }
    if (resolvedUrl.origin !== window.location.origin) {
      post({
        type: "footnote-result",
        requestId: requestId,
        href: rawHref,
        anchor: anchorId,
        found: false,
      });
      return;
    }
    var docUrl = resolvedUrl.origin + resolvedUrl.pathname;
    var docPromise =
      resolvedUrl.pathname === window.location.pathname
        ? Promise.resolve(document)
        : fetchFootnoteDocument(docUrl);
    docPromise.then(function (doc) {
      var html = doc ? extractFootnoteHtml(doc, anchorId, null, true) : null;
      if (html) {
        post({
          type: "footnote-result",
          requestId: requestId,
          href: rawHref,
          anchor: anchorId,
          found: true,
          label: "注释",
          html: html,
        });
      } else {
        post({
          type: "footnote-result",
          requestId: requestId,
          href: rawHref,
          anchor: anchorId,
          found: false,
        });
      }
    });
  }

  function readAnchorRect(anchor) {
    if (!anchor || typeof anchor.getBoundingClientRect !== "function") return undefined;
    var r = anchor.getBoundingClientRect();
    if (!r || (!r.width && !r.height)) return undefined;
    if (
      !Number.isFinite(r.top) ||
      !Number.isFinite(r.bottom) ||
      !Number.isFinite(r.left) ||
      !Number.isFinite(r.right)
    ) {
      return undefined;
    }
    return {
      top: r.top,
      bottom: r.bottom,
      left: r.left,
      right: r.right,
    };
  }

  function postFootnoteMessage(payload) {
    var msg = {
      type: "footnote",
      href: payload.href,
      anchor: payload.anchor,
      label: payload.label,
      html: payload.html,
      sameChapter: payload.sameChapter,
      trigger: payload.trigger,
    };
    if (payload.rect) msg.rect = payload.rect;
    post(msg);
  }

  var hoveredFootnoteAnchor = null;
  var hoverTimer = null;
  var hoverSeq = 0;
  var HOVER_OPEN_DELAY_MS = 120;

  function cancelPendingHover() {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    hoverSeq += 1;
  }

  function resolveLinkTarget(raw) {
    if (!raw || /^(https?:|mailto:|tel:)/i.test(raw)) return null;
    if (raw.charAt(0) === "#") {
      return {
        sameChapter: true,
        fragmentId: safeDecode(raw.slice(1)),
        docUrl: null,
      };
    }
    var resolvedUrl = null;
    try {
      resolvedUrl = new URL(raw, window.location.href);
    } catch (_) {
      return null;
    }
    var fragmentId = resolvedUrl.hash ? safeDecode(resolvedUrl.hash.slice(1)) : "";
    if (!fragmentId || resolvedUrl.origin !== window.location.origin) {
      return null;
    }
    if (resolvedUrl.pathname === window.location.pathname) {
      return {
        sameChapter: true,
        fragmentId: fragmentId,
        docUrl: null,
      };
    }
    return {
      sameChapter: false,
      fragmentId: fragmentId,
      docUrl: resolvedUrl.origin + resolvedUrl.pathname,
    };
  }

  function tryExtractFootnote(anchor, raw, trigger, expectedHoverSeq, onMiss) {
    var info = resolveLinkTarget(raw);
    if (!info || !info.fragmentId || isBacklink(anchor)) {
      if (onMiss) onMiss(info);
      return;
    }

    var rect = readAnchorRect(anchor);
    if (info.sameChapter) {
      var target = findAnchorTarget(document, info.fragmentId);
      if (target && (isNoterefLink(anchor, info.fragmentId) || isFootnoteTarget(target))) {
        var sameHtml = extractFootnoteHtml(document, info.fragmentId, anchor, false);
        if (sameHtml) {
          postFootnoteMessage({
            href: raw,
            anchor: info.fragmentId,
            label: getFootnoteLabel(anchor),
            html: sameHtml,
            sameChapter: true,
            trigger: trigger,
            rect: rect,
          });
          return;
        }
      }
      if (onMiss) onMiss(info);
      return;
    }

    var isNoteref = isNoterefLink(anchor, info.fragmentId);
    var allowHoverRemote = trigger === "hover" && NOTE_ID_RE.test(info.fragmentId);
    if (info.docUrl && (isNoteref || allowHoverRemote)) {
      var label = getFootnoteLabel(anchor);
      fetchFootnoteDocument(info.docUrl).then(function (doc) {
        if (trigger === "hover" && expectedHoverSeq !== hoverSeq) return;
        var remoteHtml = doc ? extractFootnoteHtml(doc, info.fragmentId, anchor, !isNoteref) : null;
        if (remoteHtml) {
          postFootnoteMessage({
            href: raw,
            anchor: info.fragmentId,
            label: label,
            html: remoteHtml,
            sameChapter: false,
            trigger: trigger,
            rect: readAnchorRect(anchor) || rect,
          });
        } else if (onMiss) {
          onMiss(info);
        }
      });
      return;
    }

    if (onMiss) onMiss(info);
  }

  function handleInternalLink(anchor, raw) {
    var rect = readAnchorRect(anchor);
    tryExtractFootnote(anchor, raw, "click", 0, function (info) {
      if (info && info.sameChapter) {
        scrollToAnchor(info.fragmentId);
        return;
      }
      var msg = { type: "link", href: raw };
      if (rect) msg.rect = rect;
      post(msg);
    });
  }

  // Hover preview for EPUB footnotes (desktop / pointer devices)
  document.addEventListener("mouseover", function (event) {
    if (Date.now() - lastTouchAt < 700) return;
    var target = event.target;
    var anchor = target && target.closest ? target.closest("a[href]") : null;
    if (!anchor || anchor === hoveredFootnoteAnchor) return;
    var raw = anchor.getAttribute("href");
    var info = resolveLinkTarget(raw);
    if (!info || !info.fragmentId || isBacklink(anchor)) return;
    if (info.sameChapter) {
      var localTarget = findAnchorTarget(document, info.fragmentId);
      if (!localTarget || (!isNoterefLink(anchor, info.fragmentId) && !isFootnoteTarget(localTarget))) {
        return;
      }
    } else if (!isNoterefLink(anchor, info.fragmentId) && !NOTE_ID_RE.test(info.fragmentId)) {
      return;
    }

    cancelPendingHover();
    hoveredFootnoteAnchor = anchor;
    var seq = hoverSeq;
    hoverTimer = setTimeout(function () {
      hoverTimer = null;
      if (seq !== hoverSeq) return;
      tryExtractFootnote(anchor, raw, "hover", seq, null);
    }, HOVER_OPEN_DELAY_MS);
  });

  document.addEventListener("mouseout", function (event) {
    if (!hoveredFootnoteAnchor) return;
    if (event.relatedTarget && hoveredFootnoteAnchor.contains(event.relatedTarget)) {
      return;
    }
    if (event.target && !hoveredFootnoteAnchor.contains(event.target)) {
      return;
    }
    cancelPendingHover();
    hoveredFootnoteAnchor = null;
    post({ type: "footnote-leave" });
  });

  // Intercept all internal/external links
  document.addEventListener("click", function (event) {
    if (Date.now() < state.suppressClickUntil) {
      event.preventDefault();
      return;
    }
    var target = event.target;
    var anchor = target && target.closest ? target.closest("a[href]") : null;
    if (anchor) {
      cancelPendingHover();
      hoveredFootnoteAnchor = null;
      var raw = anchor.getAttribute("href");
      if (!raw) return;
      event.preventDefault();
      if (/^(https?:|mailto:|tel:)/i.test(raw)) {
        post({ type: "external", href: raw });
        return;
      }
      handleInternalLink(anchor, raw);
      return;
    }

    if (event.button !== 0) return;
    if (
      target &&
      target.closest &&
      target.closest("button, input, textarea, select, summary, audio, video, label")
    ) {
      return;
    }

    var sel = window.getSelection && window.getSelection();
    if (sel && String(sel).trim().length > 0) return;

    var w = window.innerWidth || 1;
    var x = event.clientX;
    if (state.mode === "paginated") {
      if (x < w * 0.22) {
        step("prev");
      } else if (x > w * 0.78) {
        step("next");
      } else {
        post({ type: "tap" });
      }
    } else if (x >= w * 0.15 && x <= w * 0.85) {
      post({ type: "tap" });
    }
  });

  // Keyboard navigation
  document.addEventListener("keydown", function (event) {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    var key = event.key;
    if (key === "Escape") {
      event.preventDefault();
      post({ type: "key", key: "Escape" });
    } else if (key === "ArrowRight" || key === "PageDown" || (key === " " && !event.shiftKey)) {
      if (state.mode === "paginated" || key === "ArrowRight") {
        event.preventDefault();
        if (state.mode === "paginated") step("next");
        else post({ type: "turn", direction: "next" });
      }
    } else if (key === "ArrowLeft" || key === "PageUp" || (key === " " && event.shiftKey)) {
      if (state.mode === "paginated" || key === "ArrowLeft") {
        event.preventDefault();
        if (state.mode === "paginated") step("prev");
        else post({ type: "turn", direction: "prev" });
      }
    }
  });

  // Recount pages once images finish decoding in paginated mode
  window.addEventListener("load", function () {
    if (state.mode === "paginated" && state.initialized) {
      layoutPaginated();
      reportProgress();
    }
  });

  function signalReady() {
    post({ type: "ready" });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", signalReady, { once: true });
  } else {
    signalReady();
  }
})();
