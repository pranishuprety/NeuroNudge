// popup.js
// Presents the Phase 4 dashboard: summarizes focus vs idle, top sites, mood &
// privacy controls, and the most recent nudges while keeping everything local.

const stateEl = document.getElementById("stateValue");
const nudgeCountEl = document.getElementById("nudgeCount");
const focusBarEl = document.getElementById("focusBar");
const focusTimeEl = document.getElementById("focusTime");
const idleTimeEl = document.getElementById("idleTime");
const siteListEl = document.getElementById("siteList");
const moodSelect = document.getElementById("mood");
const privacyToggle = document.getElementById("privacyToggle");
const kpmAvgEl = document.getElementById("kpmAvg");
const kpmTotalEl = document.getElementById("kpmTotal");
const kpmStatusEl = document.getElementById("kpmStatus");
const nudgeListEl = document.getElementById("nudgeList");
const saveMoodBtn = document.getElementById("saveMood");
const pingBtn = document.getElementById("ping");
const settingsBtn = document.getElementById("settingsBtn");

const EIGHT_HOURS_SECONDS = 8 * 3600;
const NUDGE_DISPLAY_LIMIT = 5;

async function refresh() {
  const storage = await chrome.storage.local.get([
    "focusState",
    "currentState",
    "userMood",
    "privacyMode",
    "nudgeLog",
    "dailyTimeLog",
    "kpmLog",
    "kpmLive"
  ]);

  const todaySites = await getTodaySummary(storage.dailyTimeLog);
  const focusSeconds = todaySites.reduce((sum, entry) => sum + entry.seconds, 0);
  const idleSeconds = Math.max(0, EIGHT_HOURS_SECONDS - focusSeconds);
  const progressTotal = focusSeconds + idleSeconds || 1;
  const focusPct = Math.min(100, Math.round((focusSeconds / progressTotal) * 100));

  focusBarEl.style.width = `${focusPct}%`;
  focusTimeEl.textContent = `Focus: ${formatMinutes(focusSeconds)}`;
  idleTimeEl.textContent = `Idle: ${formatMinutes(idleSeconds)}`;

  const topSites = todaySites.slice(0, 5);
  if (topSites.length === 0) {
    siteListEl.innerHTML = `<li><em class="muted">No data yet.</em></li>`;
  } else {
    siteListEl.innerHTML = topSites
      .map((site) => `<li><span>${site.host}</span><strong>${Math.max(1, site.minutes)}m</strong></li>`)
      .join("");
  }

  const state = storage.focusState || storage.currentState || "steady";
  stateEl.textContent = state;

  const nudgeLog = Array.isArray(storage.nudgeLog) ? storage.nudgeLog : [];
  const todaysNudges = nudgeLog.filter((item) => item.day === todayKey());
  nudgeCountEl.textContent = `Today: ${todaysNudges.length} nudges`;
  renderNudges(nudgeLog);

  const kpmSnapshot = summarizeKpm(storage.kpmLog, storage.kpmLive, storage.privacyMode);
  if (kpmAvgEl) kpmAvgEl.textContent = kpmSnapshot.avg5.toString();
  if (kpmTotalEl) kpmTotalEl.textContent = kpmSnapshot.total.toString();
  if (kpmStatusEl) kpmStatusEl.textContent = kpmSnapshot.status;

  moodSelect.value = storage.userMood || "neutral";
  privacyToggle.checked = Boolean(storage.privacyMode);
}

function renderNudges(log) {
  if (!log || log.length === 0) {
    nudgeListEl.innerHTML = `<li class="muted">No nudges yet.</li>`;
    return;
  }
  const list = log.slice(0, NUDGE_DISPLAY_LIMIT);
  nudgeListEl.innerHTML = list
    .map((entry) => `<li>${sanitize(entry.message || "")}<span>${entry.time || formatClock(entry.at)} · ${entry.state || ""}</span></li>`)
    .join("");
}

async function getTodaySummary(passedLog) {
  const log =
    passedLog ??
    (await chrome.storage.local.get("dailyTimeLog")).dailyTimeLog ??
    {};
  const dayData = log?.[todayKey()] || {};
  return Object.entries(dayData)
    .map(([host, payload]) => {
      const seconds = Math.max(0, Math.round(payload?.seconds || 0));
      return {
        host,
        seconds,
        minutes: Math.max(0, Math.round(seconds / 60))
      };
    })
    .filter((entry) => entry.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds);
}

function summarizeKpm(kpmLog = {}, kpmLive = {}, privacyEnabled = false) {
  const todayKeyStr = todayKey();
  const today = kpmLog?.[todayKeyStr] || {};
  const minutes = { ...(today.minutes || {}) };
  const storedTotal = Math.max(0, Math.round(today.rollup?.totalKeys || 0));
  const pendingMinute = typeof kpmLive?.minuteTs === "number" ? kpmLive.minuteTs : null;
  const pendingCount = Math.max(0, Math.round(kpmLive?.pending || 0));
  const pendingIsToday =
    pendingMinute && new Date(pendingMinute).toISOString().split("T")[0] === todayKeyStr;
  if (pendingIsToday && pendingCount > 0) {
    minutes[pendingMinute] = (minutes[pendingMinute] || 0) + pendingCount;
  }
  const now = Date.now();
  const floorNow = now - (now % (60 * 1000));
  let buckets = 0;
  let sum = 0;
  for (let i = 0; i < 5; i += 1) {
    const ts = floorNow - i * 60 * 1000;
    if (minutes[ts]) {
      sum += Number(minutes[ts]) || 0;
      buckets += 1;
    }
  }
  const avg = buckets ? Math.round(sum / buckets) : 0;
  const total = storedTotal + (pendingIsToday ? pendingCount : 0);
  const lastMinuteCount = Math.round(minutes[floorNow] || 0);
  const status = privacyEnabled
    ? "Privacy mode active — typing paused."
    : total > 0
      ? `Last minute: ${lastMinuteCount} keys`
      : "No typing detected yet.";
  return {
    avg5: avg,
    total,
    status
  };
}

function todayKey() {
  return new Date().toISOString().split("T")[0];
}

function formatMinutes(seconds = 0) {
  return `${Math.max(0, Math.round(seconds / 60))}m`;
}

function formatClock(timestamp) {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function sanitize(str = "") {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

saveMoodBtn.addEventListener("click", async () => {
  const mood = moodSelect.value;
  const { moodLog = [] } = await chrome.storage.local.get("moodLog");
  const updated = [{ mood, at: Date.now() }, ...moodLog].slice(0, 50);
  await chrome.storage.local.set({ userMood: mood, moodLog: updated });
  saveMoodBtn.textContent = "Saved!";
  setTimeout(() => (saveMoodBtn.textContent = "Save Mood"), 1500);
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

function openOptionsPanel() {
  const fallback = () => chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
  if (typeof chrome.runtime.openOptionsPage !== "function") {
    fallback();
    return;
  }
  const maybePromise = chrome.runtime.openOptionsPage(() => {
    if (chrome.runtime.lastError) fallback();
  });
  if (maybePromise && typeof maybePromise.catch === "function") {
    maybePromise.catch(fallback);
  }
}

if (settingsBtn) {
  settingsBtn.addEventListener("click", openOptionsPanel);
}

refresh();
setInterval(refresh, 15000);
