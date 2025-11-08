const statusEl = document.getElementById("status");
const nudgesEl = document.getElementById("nudges");
const moodSel = document.getElementById("mood");

function refresh() {
  chrome.storage.local.get(["lastState", "nudgeCount", "userMood"], (res) => {
    statusEl.textContent = "Status: " + (res.lastState || "unknown");
    nudgesEl.textContent = "Total nudges: " + (res.nudgeCount || 0);
    if (res.userMood) moodSel.value = res.userMood;
  });
}

document.getElementById("saveMood").addEventListener("click", () => {
  chrome.storage.local.set({ userMood: moodSel.value }, refresh);
});

document.getElementById("ping").addEventListener("click", () => {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "NeuroNudge",
    message: "Mini break — relax shoulders & eyes!"
  });
  chrome.storage.local.get(["nudgeCount"], (res) => {
    chrome.storage.local.set({ nudgeCount: (res.nudgeCount || 0) + 1 }, refresh);
  });
});

refresh();
setInterval(refresh, 5000);
