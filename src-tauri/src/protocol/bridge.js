(function () {
  "use strict";
  if (window.__biocnBridge) return;
  window.__biocnBridge = true;

  var root = document.documentElement;
  var state = {
    mode: "scrolled",
    columns: "auto",
    page: 0,
    totalPages: 1,
    spreadWidth: window.innerWidth || 800,
    initialized: false,
    lastParagraph: null,
    slideRaf: 0,
    suppressClickUntil: 0,
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

  function applyPrefs(prefs) {
    if (!prefs) return;
    var anchorBefore = state.initialized ? findVisibleParagraph() : null;
    var ratioBefore = state.initialized ? currentRatio() : null;

    root.setAttribute("data-theme", prefs.theme || "auto");
    root.setAttribute("data-mode", prefs.viewMode || "scrolled");
    root.setAttribute("data-biocn", prefs.coloringEnabled === false ? "off" : "on");
    root.setAttribute("data-palette", prefs.coloringPalette || "default");
    root.style.setProperty("--reader-font-size", (prefs.fontSize || 17) + "px");
    root.style.setProperty("--reader-line-height", String(prefs.lineHeight || 1.9));
    state.mode = prefs.viewMode === "paginated" ? "paginated" : "scrolled";
    state.columns = prefs.columns || "auto";

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
    var gap = vw < 540 ? 36 : 56;
    var padX = Math.floor(gap / 2);
    var padY = vw < 540 ? 20 : 28;
    var maxSpread = cols === 2 ? 1160 : 760;
    var spread = Math.min(vw, maxSpread);
    var colWidth = Math.max(180, Math.floor((spread - cols * gap) / cols));
    // Recompute exact spread so `cols * colWidth + cols * gap === spread` (exact integer stride).
    spread = cols * (colWidth + gap);

    root.style.setProperty("--page-pad-x", padX + "px");
    root.style.setProperty("--page-pad-y", padY + "px");
    root.style.setProperty("--spread-width", spread + "px");
    root.style.setProperty("--col-width", colWidth + "px");
    root.style.setProperty("--col-gap", gap + "px");

    state.spreadWidth = spread;
    recountPages();
  }

  function clearPaginated() {
    cancelSlide();
    if (document.body) {
      document.body.scrollLeft = 0;
    }
    state.page = 0;
    state.totalPages = 1;
  }

  function recountPages() {
    if (state.mode !== "paginated" || !document.body) return;
    var sw = document.body.scrollWidth || state.spreadWidth;
    var stride = state.spreadWidth || window.innerWidth || 1;
    // Small epsilon avoids phantom trailing blank page from 1px subpixel rounding.
    state.totalPages = Math.max(1, Math.ceil((sw - 2) / stride));
    if (state.page >= state.totalPages) {
      state.page = state.totalPages - 1;
      cancelSlide();
      document.body.scrollLeft = state.page * stride;
    }
  }

  function goToPage(page, animate) {
    if (state.mode !== "paginated" || !document.body) return;
    recountPages();
    var clamped = Math.max(0, Math.min(state.totalPages - 1, page));
    state.page = clamped;
    var targetLeft = clamped * state.spreadWidth;
    if (animate) {
      animateScrollLeft(targetLeft, 220);
    } else {
      cancelSlide();
      document.body.scrollLeft = targetLeft;
    }
    reportProgress();
  }

  function step(direction) {
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
    if (direction === "next") {
      if (cur >= maxScroll - 4) {
        post({ type: "turn", direction: "next" });
      } else {
        window.scrollTo({ top: Math.min(maxScroll, cur + Math.floor(vh * 0.85)), behavior: "smooth" });
      }
    } else {
      if (cur <= 4) {
        post({ type: "turn", direction: "prev" });
      } else {
        window.scrollTo({ top: Math.max(0, cur - Math.floor(vh * 0.85)), behavior: "smooth" });
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
    var tpl = document.createElement("template");
    for (var i = 0; i < patches.length; i++) {
      var item = patches[i];
      var el = document.querySelector('span[data-br="' + item.key + '"]');
      if (!el) continue;
      tpl.innerHTML = item.html;
      el.replaceWith(tpl.content);
    }
  }

  // Host → Iframe commands
  window.addEventListener("message", function (event) {
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
    }
  });

  // Throttled scroll reporting in scrolled mode
  var scrollTimer = 0;
  window.addEventListener(
    "scroll",
    function () {
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
  window.addEventListener(
    "touchstart",
    function (event) {
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

  // Intercept all internal/external links
  document.addEventListener("click", function (event) {
    if (Date.now() < state.suppressClickUntil) {
      event.preventDefault();
      return;
    }
    var target = event.target;
    var anchor = target && target.closest ? target.closest("a[href]") : null;
    if (anchor) {
      var raw = anchor.getAttribute("href");
      if (!raw) return;
      event.preventDefault();
      if (raw.charAt(0) === "#") {
        scrollToAnchor(decodeURIComponent(raw.slice(1)));
        return;
      }
      if (/^(https?:|mailto:|tel:)/i.test(raw)) {
        post({ type: "external", href: raw });
        return;
      }
      post({ type: "link", href: raw });
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
