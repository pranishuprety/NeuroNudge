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
const categoryStatsEl = document.getElementById("categoryStats");
const saveMoodBtn = document.getElementById("saveMood");
const pingBtn = document.getElementById("ping");
const settingsBtn = document.getElementById("settingsBtn");
const menuToggleBtn = document.getElementById("menuToggle");
const menuCloseBtn = document.getElementById("menuClose");
const sidePanelEl = document.getElementById("sidePanel");
const panelBackdropEl = document.getElementById("panelBackdrop");

function setPanelOpen(isOpen) {
  if (!sidePanelEl || !panelBackdropEl) return;
  sidePanelEl.classList.toggle("open", isOpen);
  panelBackdropEl.classList.toggle("visible", isOpen);
  sidePanelEl.setAttribute("aria-hidden", isOpen ? "false" : "true");
  panelBackdropEl.setAttribute("aria-hidden", isOpen ? "false" : "true");
  if (isOpen) {
    if (!sidePanelEl.hasAttribute("tabindex")) {
      sidePanelEl.setAttribute("tabindex", "-1");
    }
    sidePanelEl.focus({ preventScroll: true });
  } else {
    menuToggleBtn?.focus();
  }
}

if (menuToggleBtn) {
  menuToggleBtn.addEventListener("click", () => setPanelOpen(true));
}

if (menuCloseBtn) {
  menuCloseBtn.addEventListener("click", () => setPanelOpen(false));
}

if (panelBackdropEl) {
  panelBackdropEl.addEventListener("click", () => setPanelOpen(false));
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setPanelOpen(false);
});

const EIGHT_HOURS_SECONDS = 8 * 3600;
const NUDGE_DISPLAY_LIMIT = 5;
const CATEGORY_SYMBOLS = {
  Productive: "✅",
  Distracting: "⚠️",
  Neutral: "•"
};

async function refresh() {
  const storage = await chrome.storage.local.get([
    "focusState",
    "currentState",
    "userMood",
    "privacyMode",
    "nudgeLog",
    "dailySummary",
    "dailyTimeLog",
    "kpmLog",
    "kpmLive",
    "flowLog",
    "categorizationRules"
  ]);

  const today = todayKey();
  const sum = storage.dailySummary?.[today];
  const ruleCache = buildRuleCache(storage.categorizationRules || {});
  let focusSeconds = 0;
  let allSites = [];
  let topSites = [];
  let categorySeconds = { Productive: 0, Distracting: 0, Neutral: 0 };

  if (sum) {
    const productiveSeconds = Math.max(0, Math.round(sum.classes?.Productive || 0));
    const distractingSeconds = Math.max(0, Math.round(sum.classes?.Distracting || 0));
    const neutralSeconds = Math.max(0, Math.round(sum.classes?.Neutral || 0));
    focusSeconds = productiveSeconds + distractingSeconds + neutralSeconds;
    categorySeconds = {
      Productive: productiveSeconds,
      Distracting: distractingSeconds,
      Neutral: neutralSeconds
    };
    allSites = (sum.topHosts || []).map((entry) => ({
      host: entry.host,
      seconds: Math.max(0, Math.round(entry?.seconds || 0))
    }));
    topSites = allSites.slice(0, 5)
      .map((entry) => ({
        host: entry.host,
        seconds: Math.max(0, Math.round(entry?.seconds || 0)),
        minutes: Math.max(1, Math.round((entry?.seconds || 0) / 60))
      }));
  } else {
    allSites = await getTodaySummary(storage.dailyTimeLog);
    focusSeconds = allSites.reduce((total, entry) => total + (entry.seconds || 0), 0);
    allSites.forEach((entry) => {
      const base = classifyBase(entry.host, ruleCache);
      categorySeconds[base] = (categorySeconds[base] || 0) + Math.max(0, entry.seconds || 0);
    });
    topSites = allSites.slice(0, 5);
  }

  const decoratedTopSites = topSites.map((site) => {
    const base = classifyBase(site.host, ruleCache);
    return {
      ...site,
      category: base,
      symbol: CATEGORY_SYMBOLS[base] || CATEGORY_SYMBOLS.Neutral
    };
  });

  const idleSeconds = Math.max(0, EIGHT_HOURS_SECONDS - focusSeconds);
  const progressTotal = focusSeconds + idleSeconds || 1;
  const focusPct = Math.min(100, Math.round((focusSeconds / progressTotal) * 100));

  focusBarEl.style.width = `${focusPct}%`;
  focusTimeEl.textContent = `Focus: ${formatMinutes(focusSeconds)}`;
  idleTimeEl.textContent = `Idle: ${formatMinutes(idleSeconds)}`;

  if (decoratedTopSites.length === 0) {
    siteListEl.innerHTML = `<li><em class="muted">No data yet.</em></li>`;
  } else {
    siteListEl.innerHTML = decoratedTopSites
      .map(
        (site) =>
          `<li><span>${site.symbol} ${site.host} <span class="muted tag">(${site.category})</span></span><strong>${Math.max(1, site.minutes)}m</strong></li>`
      )
      .join("");
  }

  if (!sum) {
    // ensure categorySeconds filled when summary missing
    decoratedTopSites.forEach((site) => {
      if (!(site.category in categorySeconds)) {
        categorySeconds[site.category] = 0;
      }
    });
  }

  if (categoryStatsEl) {
    const categories = ["Productive", "Distracting", "Neutral"];
    categoryStatsEl.innerHTML = categories
      .map((category) => {
        const seconds = Math.max(0, Math.round(categorySeconds[category] || 0));
        return `<div class="category-stat"><div class="category-label"><span class="category-symbol">${CATEGORY_SYMBOLS[category] || CATEGORY_SYMBOLS.Neutral}</span>${category}</div><strong>${formatMinutes(seconds)}</strong></div>`;
      })
      .join("");
  }

  const state = storage.focusState || storage.currentState || "steady";
  stateEl.textContent = sum?.kpm ? `${state} · ${Math.round(sum.kpm.minuteAvg5)} K/min` : state;

  const nudgeLog = Array.isArray(storage.nudgeLog) ? storage.nudgeLog : [];
  const todaysNudges = nudgeLog.filter((item) => item.day === today);
  nudgeCountEl.textContent = `Today: ${todaysNudges.length} nudges`;
  const flowLog = Array.isArray(storage.flowLog) ? storage.flowLog : [];
  const flows = flowLog.filter((entry) => entry.type === "end").slice(0, 2);
  renderNudges(nudgeLog, flows);

  const kpmSnapshot = summarizeKpm(storage.kpmLog, storage.kpmLive, storage.privacyMode);
  if (kpmAvgEl) kpmAvgEl.textContent = kpmSnapshot.avg5.toString();
  if (kpmTotalEl) kpmTotalEl.textContent = kpmSnapshot.total.toString();
  if (kpmStatusEl) kpmStatusEl.textContent = kpmSnapshot.status;

  moodSelect.value = storage.userMood || "neutral";
  privacyToggle.checked = Boolean(storage.privacyMode);
}

function renderNudges(log, flows = []) {
  if (!log || log.length === 0) {
    const flowMarkup = flowsToMarkup(flows);
    nudgeListEl.innerHTML =
      flowMarkup || `<li class="muted">No nudges yet.</li>`;
    return;
  }
  const flowMarkup = flowsToMarkup(flows);
  const list = log.slice(0, NUDGE_DISPLAY_LIMIT);
  const nudgeMarkup = list
    .map((entry) => `<li>${sanitize(entry.message || "")}<span>${entry.time || formatClock(entry.at)} · ${entry.state || ""}</span></li>`)
    .join("");
  nudgeListEl.innerHTML = flowMarkup + nudgeMarkup;
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

function flowsToMarkup(flows) {
  if (!flows || flows.length === 0) return "";
  const human = (ms = 0) => `${Math.max(1, Math.round(ms / 60000))}m`;
  return flows
    .map((flow) => `<li>Flow: ${human(flow.durationMs)} <span>${formatClock(flow.at)}</span></li>`)
    .join("");
}

function buildRuleCache(rules = {}) {
  const exact = new Map();
  const regex = [];
  Object.keys(rules).forEach((key) => {
    const value = rules[key];
    if (!key || typeof value !== "string") return;
    if (/[*.+?^${}()|[\]\\]/.test(key)) {
      try {
        regex.push([new RegExp(key, "i"), value]);
      } catch {
        // ignore invalid regex
      }
    } else {
      exact.set(key.toLowerCase(), value);
    }
  });
  return { exact, regex };
}

function classifyHostWithRules(host = "", cache) {
  if (!cache) cache = { exact: new Map(), regex: [] };
  if (!host) return "Neutral";
  const lookup = host.toLowerCase();
  if (cache.exact.has(lookup)) return cache.exact.get(lookup) || "Neutral";
  for (const [rx, value] of cache.regex) {
    if (rx.test(host)) return value;
  }
  return "Neutral";
}

function classifyBase(host, cache) {
  const base = (classifyHostWithRules(host, cache).split(":")[0] || "Neutral").trim();
  if (base === "Productive" || base === "Distracting") return base;
  return "Neutral";
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
