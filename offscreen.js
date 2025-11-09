/* eslint-disable no-console */

const activeAudio = new Set();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "elevenlabs:play") return false;
  const { payload } = message;
  if (!payload?.audioUrl) {
    sendResponse?.({ ok: false, error: "Missing audio payload." });
    return true;
  }
  const audio = new Audio(payload.audioUrl);
  audio.volume = typeof payload.volume === "number" ? payload.volume : 1;
  activeAudio.add(audio);
  const cleanup = () => {
    activeAudio.delete(audio);
    URL.revokeObjectURL(payload.audioUrl);
  };
  audio.addEventListener("ended", cleanup, { once: true });
  audio.addEventListener("error", (event) => {
    console.warn("[Offscreen] Audio playback error", event);
    cleanup();
  }, { once: true });
  audio.play().then(() => {
    sendResponse?.({ ok: true });
  }).catch((error) => {
    console.warn("[Offscreen] Failed to play audio", error);
    cleanup();
    sendResponse?.({ ok: false, error: error?.message || "Playback failed" });
  });
  return true;
});

// When background asks to close, stop all audio.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "elevenlabs:stopAll") {
    activeAudio.forEach((audio) => {
      try {
        audio.pause();
      } catch {
        // ignore
      }
      activeAudio.delete(audio);
    });
  }
});
