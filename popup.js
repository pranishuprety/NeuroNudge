// popup.js
// Lightweight dashboard for NeuroNudge: shows the latest state, summarizes
// today’s focus vs idle time, captures mood + privacy preferences, and lets the
// user request an immediate nudge.

const stateEl = document.getElementById("stateValue");
const nudgeCountEl = document.getElementById("nudgeCount");
const focusBarEl = document.getElementById("focusBar");
const focusTimeEl = document.getElementById("focusTime");
const idleTimeEl = document.getElementById("idleTime");
const moodSelect = document.getElementById("mood");
const privacyToggle = document.getElementById("privacyToggle");
const nudgeListEl = document.getElementById("nudgeList");
const saveMoodBtn = document.getElementById("saveMood");
const pingBtn = document.getElementById("ping");

async function refresh() {
  const [{ focusState = "steady", nudgeCount = 0, userMood = "neutral", privacyMode = false, nudgeHistory = [] }, { activitySummary }] =
    await Promise.all([
      chrome.storage.local.get(["focusState", "nudgeCount", "userMood", "privacyMode", "nudgeHistory"]),
      chrome.storage.local.get("activitySummary")
    ]);

  stateEl.textContent = focusState;
  stateEl.dataset.state = focusState;
  nudgeCountEl.textContent = `Total nudges: ${nudgeCount}`;

  moodSelect.value = userMood;
  privacyToggle.checked = Boolean(privacyMode);

  const summary = activitySummary || {};
  const now = Date.now();
  let focusMs = summary.totalFocusMs || 0;
  let idleMs = summary.totalIdleMs || 0;
  if (summary.lastState === "active" && summary.lastActiveAt) {
    focusMs += Math.max(0, now - summary.lastActiveAt);
  } else if (summary.lastState === "idle" && summary.lastIdleAt) {
    idleMs += Math.max(0, now - summary.lastIdleAt);
  }
  const total = focusMs + idleMs || 1;
  const focusPct = Math.min(100, Math.round((focusMs / total) * 100));
  focusBarEl.style.width = `${focusPct}%`;
  focusTimeEl.textContent = `Focus: ${msToMinutes(focusMs)}m`;
  idleTimeEl.textContent = `Idle: ${msToMinutes(idleMs)}m`;

  renderNudges(nudgeHistory);
}

function renderNudges(history) {
  if (!history || history.length === 0) {
    nudgeListEl.innerHTML = "<li>No nudges yet.</li>";
    return;
  }
  const recent = history.slice(0, 3);
  nudgeListEl.innerHTML = recent
    .map(
      (entry) =>
        `<li>${sanitize(entry.message)}<span>${formatTime(entry.at)} · ${entry.state}</span></li>`
    )
    .join("");
}

function formatTime(timestamp) {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function msToMinutes(ms = 0) {
  return Math.round(ms / 60000);
}

function sanitize(str = "") {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

saveMoodBtn.addEventListener("click", async () => {
  await chrome.storage.local.set({ userMood: moodSelect.value });
  await refresh();
});

privacyToggle.addEventListener("change", async (event) => {
  await chrome.storage.local.set({ privacyMode: event.target.checked });
});

pingBtn.addEventListener("click", async () => {
  pingBtn.disabled = true;
  pingBtn.textContent = "Sending…";
  try {
    await chrome.runtime.sendMessage({ type: "nudges:trigger" });
  } catch (error) {
    console.error("Manual nudge failed", error);
  } finally {
    pingBtn.disabled = false;
    pingBtn.textContent = "Give me a nudge now";
    refresh();
  }
});

refresh();
setInterval(refresh, 15000);
