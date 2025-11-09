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
const insightToggleBtn = document.getElementById("insightToggle");
const mainViewEl = document.getElementById("mainView");
const insightViewEl = document.getElementById("insightView");
const goalStatusBadgeEl = document.getElementById("goalStatusBadge");
const goalProgressFillEl = document.getElementById("goalProgressFill");
const goalProgressLabelEl = document.getElementById("goalProgressLabel");
const goalDistractLabelEl = document.getElementById("goalDistractLabel");
const goalFlowLabelEl = document.getElementById("goalFlowLabel");
const goalCardEl = document.getElementById("goalCard");
const streakValueEl = document.getElementById("streakValue");
const scoreProductiveEl = document.getElementById("scoreProductive");
const scoreDistractingEl = document.getElementById("scoreDistracting");
const scoreFlowEl = document.getElementById("scoreFlow");
const scoreHistoryEl = document.getElementById("scoreHistory");

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

const INSIGHT_LABEL = "⚡ Pulse";
const MAIN_LABEL = "← Focus";

function setInsightOpen(isOpen) {
  if (!mainViewEl || !insightViewEl || !insightToggleBtn) return;
  mainViewEl.classList.toggle("hidden", isOpen);
  insightViewEl.classList.toggle("hidden", !isOpen);
  insightToggleBtn.setAttribute("aria-pressed", isOpen ? "true" : "false");
  if (isOpen) {
    insightToggleBtn.textContent = MAIN_LABEL;
  } else {
    insightToggleBtn.textContent = INSIGHT_LABEL;
  }
  insightToggleBtn.focus({ preventScroll: true });
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
  if (event.key === "Escape") {
    if (!insightViewEl?.classList?.contains("hidden")) {
      setInsightOpen(false);
    } else {
      setPanelOpen(false);
    }
  }
});

insightToggleBtn?.addEventListener("click", () => {
  const currentlyOpen = !insightViewEl?.classList?.contains("hidden");
  setInsightOpen(!currentlyOpen);
});
if (insightToggleBtn && !insightToggleBtn.hasAttribute("aria-pressed")) {
  insightToggleBtn.setAttribute("aria-pressed", "false");
  insightToggleBtn.textContent = INSIGHT_LABEL;
}

const EIGHT_HOURS_SECONDS = 8 * 3600;
const NUDGE_DISPLAY_LIMIT = 5;
const CATEGORY_SYMBOLS = {
  Productive: "✅",
  Distracting: "⚠️",
  Neutral: "•"
};
const DEFAULT_GOALS = {
  daily: {
    productiveSecTarget: 3 * 3600,
    distractingSecCap: 45 * 60,
    flowWindowsTarget: 2
  }
};
const GOAL_STATE_LABELS = {
  PASSING: "Passing",
  AT_RISK: "At risk",
  FAILING: "Failing"
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
    "categorizationRules",
    "goalStatus",
    "scoreboard"
  ]);
  const goalsConfig = await loadGoals();

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

  renderGoals(storage.goalStatus, goalsConfig, storage.scoreboard);
  renderScoreboard(storage.scoreboard);

  moodSelect.value = storage.userMood || "neutral";
  privacyToggle.checked = Boolean(storage.privacyMode);
}

function renderGoals(goalStatus, goalsConfig, scoreboard) {
  if (!goalProgressFillEl || !goalProgressLabelEl || !goalStatusBadgeEl) return;
  const goals = goalsConfig?.daily || DEFAULT_GOALS.daily;
  const stateKey = goalStatus?.state && GOAL_STATE_LABELS[goalStatus.state] ? goalStatus.state : "PASSING";
  const stateClass = goalStateToClass(stateKey);
  const pct = goalStatus?.pctProductive
    ? Math.round(Math.min(1, Math.max(0, goalStatus.pctProductive)) * 100)
    : 0;
  const targetSec = Math.max(0, Number(goals.productiveSecTarget) || 0);
  const remainingSec =
    targetSec > 0 ? Math.max(0, goalStatus?.productiveRemainingSec ?? targetSec) : 0;
  const todayStats = scoreboard?.today || {};
  const distractingUsedSec = Math.max(0, Math.round(todayStats.distractingSec || 0));
  const capSec = Math.max(0, Number(goals.distractingSecCap) || 0);
  const flowTarget = Math.max(0, Number(goals.flowWindowsTarget) || 0);
  const flowDone = goalStatus?.flowDone ?? todayStats.flowCount ?? 0;

  goalProgressFillEl.style.width = targetSec > 0 ? `${pct}%` : "0%";
  goalProgressFillEl.dataset.state = stateClass;
  if (goalCardEl) goalCardEl.dataset.state = stateClass;

  goalProgressLabelEl.textContent =
    targetSec > 0
      ? `${pct}% · ${remainingSec > 0 ? `${formatMinutes(remainingSec, "ceil")} left` : "Target met"}`
      : "No target set";

  goalStatusBadgeEl.textContent = GOAL_STATE_LABELS[stateKey] || "Passing";
  goalStatusBadgeEl.dataset.state = stateClass;

  if (goalDistractLabelEl) {
    const overage = Math.max(0, Math.round((goalStatus?.distractingOverSec || 0) / 60));
    goalDistractLabelEl.classList.toggle("goal-alert", overage > 0);
    if (overage > 0) {
      goalDistractLabelEl.textContent = `+${overage}m over cap`;
    } else if (capSec > 0) {
      goalDistractLabelEl.textContent = `${formatMinutes(distractingUsedSec)} of ${formatMinutes(capSec)} distracting`;
    } else {
      goalDistractLabelEl.textContent = "No distracting cap set";
    }
  }

  if (goalFlowLabelEl) {
    if (flowTarget > 0) {
      goalFlowLabelEl.textContent = `Flow windows: ${flowDone}/${flowTarget}`;
    } else {
      goalFlowLabelEl.textContent = `Flow windows: ${flowDone}`;
    }
  }
}

function renderScoreboard(scoreboard) {
  if (!streakValueEl || !scoreProductiveEl || !scoreDistractingEl || !scoreHistoryEl) return;
  if (!scoreboard) {
    streakValueEl.textContent = "Streak: 0 days";
    scoreProductiveEl.textContent = "0m";
    scoreDistractingEl.textContent = "0m";
    if (scoreFlowEl) scoreFlowEl.textContent = "0";
    scoreHistoryEl.innerHTML = `<li class="muted">No prior days yet.</li>`;
    return;
  }

  const today = scoreboard.today || {};
  const streak = scoreboard.streaks?.daysMetTarget || 0;
  streakValueEl.textContent = `Streak: ${streak} day${streak === 1 ? "" : "s"}`;
  scoreProductiveEl.textContent = formatMinutes(today.productiveSec || 0);
  scoreDistractingEl.textContent = formatMinutes(today.distractingSec || 0);
  if (scoreFlowEl) scoreFlowEl.textContent = String(today.flowCount ?? 0);

  const history = Array.isArray(scoreboard.history7d) ? scoreboard.history7d : [];
  if (history.length === 0) {
    scoreHistoryEl.innerHTML = `<li class="muted">No prior days yet.</li>`;
  } else {
    const items = history
      .slice(0, 5)
      .map((entry) => {
        const label = sanitize(formatHistoryDay(entry.day));
        const statusIcon = entry.met ? "✓" : "•";
        return `<li data-met="${entry.met ? "true" : "false"}"><span>${label}</span><span>${statusIcon} ${formatMinutes(
          entry.productiveSec || 0
        )}</span></li>`;
      })
      .join("");
    scoreHistoryEl.innerHTML = items;
  }
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

function formatMinutes(seconds = 0, rounding = "round") {
  const total = Number(seconds) || 0;
  if (total <= 0) return "0m";
  const minutes = total / 60;
  if (minutes < 1) return "<1m";
  if (rounding === "ceil") return `${Math.ceil(minutes)}m`;
  if (rounding === "floor") return `${Math.floor(minutes)}m`;
  return `${Math.round(minutes)}m`;
}

function formatClock(timestamp) {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function goalStateToClass(state = "PASSING") {
  return (state || "PASSING").toLowerCase().replace(/_/g, "-");
}

function formatHistoryDay(day) {
  if (!day) return "";
  const parsed = new Date(`${day}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return day;
  return parsed.toLocaleDateString([], { weekday: "short" });
}

async function loadGoals() {
  try {
    if (chrome?.storage?.sync) {
      const { goals } = await chrome.storage.sync.get("goals");
      return normalizeGoals(goals);
    }
  } catch (error) {
    console.warn("Failed to load goals from sync", error);
  }
  const { goals } = await chrome.storage.local.get("goals");
  return normalizeGoals(goals);
}

function normalizeGoals(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  const merged = {
    daily: {
      ...DEFAULT_GOALS.daily,
      ...(input.daily || {})
    }
  };
  const daily = merged.daily;
  daily.productiveSecTarget = Number.isFinite(daily.productiveSecTarget)
    ? Math.max(0, Number(daily.productiveSecTarget))
    : DEFAULT_GOALS.daily.productiveSecTarget;
  daily.distractingSecCap = Number.isFinite(daily.distractingSecCap)
    ? Math.max(0, Number(daily.distractingSecCap))
    : DEFAULT_GOALS.daily.distractingSecCap;
  daily.flowWindowsTarget = Number.isFinite(daily.flowWindowsTarget)
    ? Math.max(0, Number(daily.flowWindowsTarget))
    : DEFAULT_GOALS.daily.flowWindowsTarget;
  return { daily };
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

function parseRuleKeyForCache(rawKey) {
  if (!rawKey || typeof rawKey !== "string") return null;
  let base = rawKey.trim();
  const colonIndex = base.indexOf(":");
  if (colonIndex !== -1) {
    base = base.slice(0, colonIndex).trim();
  }
  if (!base) return null;
  if (/^https?:\/\//i.test(base)) {
    try {
      const parsed = new URL(base);
      base = parsed.hostname || parsed.host || base;
    } catch {
      base = base.replace(/^https?:\/\//i, "");
    }
  }
  base = base.replace(/^www\./i, "");
  base = base.replace(/\/.*$/, "");
  base = base.trim();
  if (!base) return null;
  const regexSpecial = /[*^$+?()[\]{}|\\]/;
  if (regexSpecial.test(base)) {
    try {
      return { type: "regex", value: new RegExp(base, "i") };
    } catch {
      return null;
    }
  }
  const lowered = base.toLowerCase();
  if (lowered.includes(":") && !lowered.includes("@")) {
    return { type: "exact", value: lowered };
  }
  if (lowered.includes(".")) {
    return { type: "domain", value: lowered };
  }
  return { type: "contains", value: lowered };
}

function buildRuleCache(rules = {}) {
  const exact = new Map();
  const domains = new Map();
  const contains = [];
  const regex = [];
  Object.keys(rules).forEach((key) => {
    const focusClass = rules[key];
    if (typeof focusClass !== "string") return;
    const parsed = parseRuleKeyForCache(key);
    if (!parsed) return;
    switch (parsed.type) {
      case "regex":
        regex.push([parsed.value, focusClass.trim()]);
        break;
      case "contains":
        contains.push([parsed.value, focusClass.trim()]);
        break;
      case "exact":
        exact.set(parsed.value, focusClass.trim());
        break;
      case "domain":
        domains.set(parsed.value, focusClass.trim());
        break;
      default:
        break;
    }
  });
  return { exact, domains, contains, regex };
}

function classifyHostWithRules(host = "", cache) {
  if (!cache) cache = { exact: new Map(), domains: new Map(), contains: [], regex: [] };
  if (!host) return "Neutral";
  const normalized = host.toLowerCase();
  if (cache.exact?.has(normalized)) return cache.exact.get(normalized) || "Neutral";
  if (cache.domains) {
    for (const [domain, value] of cache.domains.entries()) {
      if (normalized === domain || normalized.endsWith(`.${domain}`)) {
        return value;
      }
    }
  }
  if (cache.contains) {
    for (const [fragment, value] of cache.contains) {
      if (normalized.includes(fragment)) {
        return value;
      }
    }
  }
  if (cache.regex) {
    for (const [rx, value] of cache.regex) {
      try {
        if (rx.test(normalized)) return value;
      } catch {
        // ignore invalid regex evaluation
      }
    }
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
