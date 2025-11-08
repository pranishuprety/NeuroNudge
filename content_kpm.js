// content_kpm.js
// Privacy-safe typing heartbeat for Step 2.
// Counts keys, batches every 5s, pauses when page hidden, non-http(s), or privacyMode enabled.
(() => {
  function resolveEffectiveOrigin() {
    if (/^https?:/.test(location.protocol)) {
      return location.origin;
    }
    if (location.protocol === "about:" && document.location?.ancestorOrigins?.length) {
      const ancestor = Array.from(document.location.ancestorOrigins).find((origin) => /^https?:/.test(origin));
      return ancestor || null;
    }
    return null;
  }

  const effectiveOrigin = resolveEffectiveOrigin();
  if (!effectiveOrigin) return;

  let count = 0;
  let pageVisible = !document.hidden;
  let privacyMode = false;

  // Initial privacy flag + react to changes
  chrome.storage.local.get("privacyMode").then(({ privacyMode: pm }) => {
    privacyMode = Boolean(pm);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.privacyMode) {
      privacyMode = Boolean(changes.privacyMode.newValue);
    }
  });

  document.addEventListener("visibilitychange", () => {
    pageVisible = !document.hidden;
  });

  // Count only; never read which key
  window.addEventListener(
    "keydown",
    () => {
      if (pageVisible && !privacyMode) count++;
    },
    { passive: true }
  );

  // Batch-send every 5s if anything happened
  setInterval(() => {
    if (!pageVisible || privacyMode || count <= 0) return;
    chrome.runtime
      .sendMessage({ type: "kpm:batch", count, ts: Date.now(), origin: effectiveOrigin })
      .catch((error) => console.warn("[KPM] send failed", error));
    count = 0;
  }, 5000);
})();
