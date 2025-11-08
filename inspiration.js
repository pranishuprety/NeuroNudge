const modeBadgeEl = document.getElementById("modeBadge");
const modeTitleEl = document.getElementById("modeTitle");
const modeMessageEl = document.getElementById("modeMessage");
const progressFillEl = document.getElementById("progressFill");
const progressPrimaryEl = document.getElementById("progressPrimary");
const progressSecondaryEl = document.getElementById("progressSecondary");
const remainingStatEl = document.getElementById("remainingStat");
const distractStatEl = document.getElementById("distractStat");
const kpmStatEl = document.getElementById("kpmStat");
const streakStatEl = document.getElementById("streakStat");
const flowStatusEl = document.getElementById("flowStatus");
const distractingListEl = document.getElementById("distractingList");
const coachingTipEl = document.getElementById("coachingTip");
const resumeBtn = document.getElementById("resumeBtn");
const openOptionsBtn = document.getElementById("openOptions");

const DEFAULT_GOALS = {
  daily: {
    productiveSecTarget: 3 * 3600,
    distractingSecCap: 45 * 60,
    flowWindowsTarget: 2
  }
};

const MODE_CONFIG = {
  gentle: {
    badge: "Gentle Nudge",
    title: "Ease back into flow",
    message: "Small steps count. Clear the noise, pick one meaningful task, and take a five-minute stride.",
    tip: "Pick a single task, set a 5-minute pomodoro, and type anything to break inertia."
  },
  push: {
    badge: "Momentum Push",
    title: "You are close — finish the sprint",
    message: "The finish line is minutes away. Close the loop, note the win, and ride the streak.",
    tip: "Block the next 15 minutes for heads-down work. Update your task tracker when done."
  },
  interrupt: {
    badge: "Pattern Interrupt",
    title: "Let's break the distraction loop",
    message: "Deep breath, tab audit, and a quick reset. Reopen only the tab you need for the next focused move.",
    tip: "Close excess tabs, reopen the most relevant one, and jot the first action you’ll take."
  }
};

document.addEventListener("DOMContentLoaded", async () => {
  const params = new URLSearchParams(window.location.search);
  const mode = (params.get("mode") || "gentle").toLowerCase();
  applyMode(mode in MODE_CONFIG ? mode : "gentle");

  try {
    const [localStore, goalsConfig] = await Promise.all([
      chrome.storage.local.get([
        "goalStatus",
        "scoreboard",
        "dailySummary",
        "kpmLog",
        "kpmLive",
        "privacyMode",
        "categorizationRules"
      ]),
      loadGoals()
    ]);

    const today = todayKey();
    const summary = localStore.dailySummary?.[today] || {};
    const goalStatus = localStore.goalStatus || null;
    const scoreboard = localStore.scoreboard || null;
    const goals = goalsConfig.daily;

    renderProgress(goalStatus, goals);
    renderStats(goalStatus, goals, summary, localStore, scoreboard);
    renderDistractors(summary.topHosts || [], localStore.categorizationRules || {});
  } catch (error) {
    console.warn("Momentum board render failed", error);
  }
});

resumeBtn?.addEventListener("click", () => {
  window.close();
});

openOptionsBtn?.addEventListener("click", () => {
  if (chrome?.runtime?.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    window.open(chrome.runtime.getURL("options.html"), "_blank", "noopener");
  }
});

function applyMode(mode) {
  const config = MODE_CONFIG[mode] || MODE_CONFIG.gentle;
  document.body.dataset.mode = mode;
  if (progressFillEl) progressFillEl.dataset.mode = mode;
  if (modeBadgeEl) modeBadgeEl.textContent = config.badge;
  if (modeTitleEl) modeTitleEl.textContent = config.title;
  if (modeMessageEl) modeMessageEl.textContent = config.message;
  if (coachingTipEl) coachingTipEl.textContent = config.tip;
}

function renderProgress(goalStatus, goals) {
  const targetSec = Math.max(0, Number(goals.productiveSecTarget) || 0);
  const pct = goalStatus?.pctProductive
    ? Math.round(Math.min(1, Math.max(0, goalStatus.pctProductive)) * 100)
    : 0;
  const remainingSec =
    targetSec > 0 ? Math.max(0, goalStatus?.productiveRemainingSec ?? targetSec) : 0;
  const primary = targetSec > 0 ? `${pct}% complete` : "No target set";
  const secondary =
    targetSec > 0
      ? remainingSec > 0
        ? `${formatMinutes(remainingSec)} left`
        : `Target met · ${formatMinutes(targetSec)}`
      : "Set a daily goal to unlock progress tracking.";

  if (progressFillEl) progressFillEl.style.width = targetSec > 0 ? `${pct}%` : "0%";
  if (progressPrimaryEl) progressPrimaryEl.textContent = primary;
  if (progressSecondaryEl) progressSecondaryEl.textContent = secondary;
}

function renderStats(goalStatus, goals, summary, localStore, scoreboard) {
  const targetSec = Math.max(0, Number(goals.productiveSecTarget) || 0);
  const remainingSec =
    targetSec > 0 ? Math.max(0, goalStatus?.productiveRemainingSec ?? targetSec) : 0;
  const capSec = Math.max(0, Number(goals.distractingSecCap) || 0);
  const distractOver = Math.max(0, goalStatus?.distractingOverSec || 0);
  const productiveRemaining = remainingSec > 0 ? formatMinutes(remainingSec) : "Met";
  const capLabel =
    capSec > 0
      ? distractOver > 0
        ? `+${formatMinutes(distractOver)} over`
        : `${formatMinutes(summary.classes?.Distracting || 0)} / ${formatMinutes(capSec)}`
      : "No cap set";
  const streak = scoreboard?.streaks?.daysMetTarget || 0;
  const flowTarget = Math.max(0, Number(goals.flowWindowsTarget) || 0);
  const flowDone = goalStatus?.flowDone ?? scoreboard?.today?.flowCount ?? 0;
  const flowText = flowTarget > 0 ? `Flow windows: ${flowDone}/${flowTarget}` : `Flow windows: ${flowDone}`;
  const flowMet = flowTarget > 0 && flowDone >= flowTarget;
  const kpm = computeRecentKpm(localStore.kpmLog, localStore.kpmLive, localStore.privacyMode);

  if (remainingStatEl) remainingStatEl.textContent = targetSec > 0 ? productiveRemaining : "—";
  if (distractStatEl) distractStatEl.textContent = capLabel;
  if (kpmStatEl) kpmStatEl.textContent = `${kpm} kpm`;
  if (streakStatEl) streakStatEl.textContent = `${streak} day${streak === 1 ? "" : "s"}`;
  if (flowStatusEl) {
    flowStatusEl.textContent = flowText;
    flowStatusEl.dataset.state = flowMet ? "met" : "open";
  }
}

function renderDistractors(hosts, rules) {
  if (!distractingListEl) return;
  if (!Array.isArray(hosts) || hosts.length === 0) {
    distractingListEl.innerHTML = `<li class="muted">No distractions logged yet.</li>`;
    return;
  }
  const ruleCache = buildRuleCache(rules);
  const distractors = hosts
    .map((entry) => ({
      host: entry.host,
      seconds: Math.max(0, Math.round(entry.seconds || 0)),
      category: classifyBase(entry.host, ruleCache)
    }))
    .filter((entry) => entry.category === "Distracting")
    .slice(0, 4);

  if (distractors.length === 0) {
    distractingListEl.innerHTML = `<li class="muted">No distraction patterns detected — nice!</li>`;
    return;
  }

  distractingListEl.innerHTML = distractors
    .map(
      (entry) =>
        `<li><span>${sanitize(entry.host)}</span><span>${formatMinutes(entry.seconds)}</span></li>`
    )
    .join("");
}

function computeRecentKpm(kpmLog = {}, kpmLive = {}, privacyEnabled = false) {
  if (privacyEnabled) return 0;
  const today = todayKey();
  const minutes = { ...(kpmLog?.[today]?.minutes || {}) };
  const liveTs = typeof kpmLive?.minuteTs === "number" ? kpmLive.minuteTs : null;
  const liveCount = Math.max(0, Math.round(kpmLive?.pending || 0));
  if (liveTs) {
    const dayFromLive = new Date(liveTs).toISOString().split("T")[0];
    if (dayFromLive === today) {
      minutes[liveTs] = (minutes[liveTs] || 0) + liveCount;
    }
  }
  const now = Date.now();
  const floorNow = now - (now % (60 * 1000));
  let total = 0;
  let buckets = 0;
  for (let i = 0; i < 5; i += 1) {
    const ts = floorNow - i * 60 * 1000;
    if (minutes[ts]) {
      total += Number(minutes[ts]) || 0;
      buckets += 1;
    }
  }
  return buckets ? Math.round(total / buckets) : 0;
}

function todayKey() {
  return new Date().toISOString().split("T")[0];
}

function formatMinutes(seconds = 0) {
  return `${Math.max(0, Math.round(seconds / 60))}m`;
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
        // ignore invalid regex rule
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

function sanitize(value = "") {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}
