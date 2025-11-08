const NUDGE_INTERVAL_MINUTES = 20;
let lastState = "active";

chrome.runtime.onInstalled.addListener(() => {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "NeuroNudge",
    message: "Installed! Let’s keep you balanced."
  });
});

setInterval(() => {
  chrome.idle.queryState(60, (state) => {
    if (state !== lastState) {
      lastState = state;
      chrome.storage.local.set({ lastState, lastChange: Date.now() });
      console.log("Idle state:", state);
    }
  });
}, 10000);

const nudges = [
  "Take 2 minutes to stretch.",
  "Deep breath — reset focus.",
  "Quick win: finish one tiny task.",
  "Eyes off screen for 30 seconds.",
  "Great streak! Hydrate now."
];

function showNudge() {
  const nudge = nudges[Math.floor(Math.random() * nudges.length)];
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "NeuroNudge",
    message: nudge
  });
  chrome.storage.local.get(["nudgeCount"], (res) => {
    chrome.storage.local.set({ nudgeCount: (res.nudgeCount || 0) + 1 });
  });
}

setInterval(showNudge, NUDGE_INTERVAL_MINUTES * 60 * 1000);
