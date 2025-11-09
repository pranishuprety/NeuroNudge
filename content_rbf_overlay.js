// content_rbf_overlay.js
// Lightweight predictive banner overlay injected on risky hosts.
(() => {
  if (!/^https?:$/.test(location.protocol)) return;

  let bannerEl = null;
  let minutesLabel = null;
  let inputEl = null;
  let hideTimeout = null;
  let statusEl = null;

  function ensureContainer() {
    if (bannerEl) return bannerEl;
    bannerEl = document.createElement("div");
    bannerEl.setAttribute("data-rbf-overlay", "1");
    bannerEl.style.cssText = [
      "position:fixed",
      "top:0",
      "left:50%",
      "transform:translateX(-50%)",
      "z-index:2147483646",
      "background:rgba(16,18,27,0.92)",
      "color:#f6f7fb",
      "padding:10px 14px",
      "border-radius:0 0 10px 10px",
      "box-shadow:0 6px 16px rgba(12,12,15,0.4)",
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      "font-size:13px",
      "line-height:1.4",
      "display:flex",
      "gap:12px",
      "align-items:center",
      "max-width:620px",
      "width:calc(100% - 40px)",
      "pointer-events:auto"
    ].join(";");

    minutesLabel = document.createElement("div");
    minutesLabel.style.flex = "1";
    bannerEl.appendChild(minutesLabel);

    inputEl = document.createElement("input");
    inputEl.type = "text";
    inputEl.placeholder = "Optional: note your next step…";
    inputEl.style.cssText = [
      "flex:1",
      "min-width:120px",
      "padding:6px 8px",
      "border-radius:6px",
      "border:1px solid rgba(255,255,255,0.25)",
      "background:rgba(0,0,0,0.35)",
      "color:#f6f7fb"
    ].join(";");
    bannerEl.appendChild(inputEl);

    const buttonRow = document.createElement("div");
    buttonRow.style.display = "flex";
    buttonRow.style.gap = "8px";
    bannerEl.appendChild(buttonRow);

    function makeButton(label) {
      const btn = document.createElement("button");
      btn.textContent = label;
      btn.style.cssText = [
        "border:none",
        "border-radius:6px",
        "padding:6px 12px",
        "font-weight:600",
        "cursor:pointer",
        "background:#5b7bff",
        "color:#fff",
        "transition:background 0.2s ease"
      ].join(";");
      btn.onmouseenter = () => {
        btn.style.background = "#4c6af0";
      };
      btn.onmouseleave = () => {
        btn.style.background = "#5b7bff";
      };
      return btn;
    }

    const startBtn = makeButton("Start reset");
    startBtn.addEventListener("click", () => {
      const note = inputEl.value.trim();
      chrome.runtime.sendMessage({ type: "rbf:startReset", note }).catch(() => {});
      queueHide();
    });

    const remindBtn = makeButton("Remind in 5");
    remindBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "rbf:remind", minutes: 5 }).catch(() => {});
      queueHide();
    });

    const ignoreBtn = makeButton("Ignore 30m");
    ignoreBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "rbf:ignore", minutes: 30 }).catch(() => {});
      queueHide();
    });

    buttonRow.append(startBtn, remindBtn, ignoreBtn);
    (document.body || document.documentElement).appendChild(bannerEl);
    return bannerEl;
  }

  function ensureStatus() {
    if (statusEl) return statusEl;
    statusEl = document.createElement("div");
    statusEl.setAttribute("data-rbf-status", "1");
    statusEl.style.cssText = [
      "position:fixed",
      "right:18px",
      "bottom:18px",
      "z-index:2147483645",
      "background:rgba(10,15,28,0.92)",
      "color:#e2e8f0",
      "padding:10px 12px",
      "border-radius:10px",
      "box-shadow:0 10px 24px rgba(8,12,24,0.4)",
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      "font-size:13px",
      "line-height:1.4",
      "max-width:320px",
      "pointer-events:none"
    ].join(";");
    (document.body || document.documentElement).appendChild(statusEl);
    return statusEl;
  }

  function updateStatus(payload) {
    if (!payload || typeof payload !== "object") return;
    const container = ensureStatus();
    const safeMinutes = Math.max(0, Number(payload.minutes ?? 0));
    const safeConfidence = Math.round(Math.max(0, Math.min(1, Number(payload.confidence ?? 0))) * 100);
    const host = payload.host || location.hostname;
    let copy = "";
    switch (payload.signal) {
      case "drop":
        copy = `⚠️ Focus dip in ~${safeMinutes} min on ${host}. Tap “Start reset” to kick Nova’s 90s ritual. (${safeConfidence}% confidence)`;
        break;
      case "flow":
        copy = `🔥 Momentum strong on ${host}. Ride it for ~${safeMinutes} more min. Nova stands by if you need a reset. (${safeConfidence}% confidence)`;
        break;
      case "snoozed":
        copy = `😌 RBF snoozed for ~${safeMinutes} min. Banner quiet until then; Nova automation paused.`;
        break;
      case "off":
        copy = "RBF paused (privacy mode or no active tab). Nova automation idle.";
        break;
      default:
        copy = safeMinutes
          ? `Tracking focus on ${host}. Forecast horizon ~${safeMinutes} min. Nova reset ready if needed.`
          : "Tracking focus quietly. Nova reset ready when you are.";
        break;
    }
    container.textContent = copy;
  }

  function queueHide(delayMs = 400) {
    clearTimeout(hideTimeout);
    hideTimeout = setTimeout(() => {
      hideBanner();
    }, delayMs);
  }

  function hideBanner() {
    if (bannerEl && bannerEl.parentNode) {
      bannerEl.parentNode.removeChild(bannerEl);
    }
    bannerEl = null;
    minutesLabel = null;
    inputEl = null;
  }

  function showBanner(minutes, confidence) {
    const container = ensureContainer();
    if (!container) return;
    const safeMinutes = Math.max(1, Number(minutes) || 1);
    const safeConfidence = Math.round(Math.max(0, Math.min(1, Number(confidence) || 0.6)) * 100);
    if (minutesLabel) {
      minutesLabel.textContent = `Focus may dip in ~${safeMinutes} min. Take a 90s reset? (${safeConfidence}% confidence)`;
    }
    if (inputEl && document.activeElement !== inputEl) {
      inputEl.value = "";
    }
    container.style.display = "flex";
    clearTimeout(hideTimeout);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || typeof message !== "object") return;
    if (message.type === "rbf:show") {
      showBanner(message.minutes, message.confidence);
    }
    if (message.type === "rbf:hide") {
      hideBanner();
    }
    if (message.type === "rbf:status") {
      updateStatus(message);
    }
  });
})();
