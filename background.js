// background.js
// MV3 service worker orchestrating NeuroNudge: records privacy-preserving
// activity summaries, asks the state engine for focus state, calls the AI
// nudge helper, shows notifications, and plays gentle voice cues.

import { SUMMARY_KEY, IDLE_RESET_MS, getCurrentState, getNormalizedSummary } from "./stateEngine.js";
import { getAINudge } from "./aiNudge.js";

const NUDGE_INTERVAL_MINUTES = 10;
const IDLE_DETECTION_INTERVAL_SECONDS = 60;
const TRACKING_ALARM = "neuro-time-engine";
const RULES_REFRESH_ALARM = "neuro-rules-refresh";
const MAX_TRACKING_DELTA_SECONDS = 120;
const RETAIN_DAYS = 30;
const RULES_REFRESH_MINUTES = 10;
const KPM_MINUTE_MS = 60 * 1000;
const KPM_MAX_BATCH = 1200;
const SUMMARY_PRUNE_DAYS = 30;
const DEFAULT_GOALS = {
  daily: {
    productiveSecTarget: 3 * 3600,
    distractingSecCap: 45 * 60,
    flowWindowsTarget: 2
  }
};
const GOAL_STATUS_STATES = {
  PASSING: "PASSING",
  AT_RISK: "AT_RISK",
  FAILING: "FAILING"
};
let ruleCache = { exact: new Map(), domains: new Map(), contains: [], regex: [] };
const BLOCKED_HOSTS_KEY = "blockedDistractingHosts";


let flowState = { active: false, startAt: 0 };
let lastBreakNudgeAt = 0;
const BREAK_COOLDOWN_MS = 20 * 60 * 1000;
const DEFAULT_RULES = {
  breakInterval: 45,
  driftSensitivity: "medium",
  maxDailyHours: 8,
  voice: true,
  distractingLimitMinutes: 60
};
const STATE_MESSAGES = {
  drift: "Seems your focus drifted, ready to sprint?",
  overload: "You’ve worked hard — time for a short break.",
  steady: "Good rhythm, keep it up!"
};

let privacyMode = false;
let currentIdleState = "active";
let lastActiveStart = Date.now();
let lastIdleStart = Date.now();
let lastFocusState = null;
let lastTickTs = Date.now();
let lastActiveTab = null;
let lastTrackedHost = null;
let rulesConfig = { ...DEFAULT_RULES };
let kpmMinuteBucket = 0;
let kpmMinuteTs = null;
let blockedDistractingHosts = new Set();
let siteLimits = new Map();

chrome.runtime.onInstalled.addListener(() => {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "NeuroNudge",
    message: "NeuroNudge is ready to keep you balanced."
  });
  seedTimeLogStorage().catch((error) => console.warn("Seed storage failed", error));
});

chrome.runtime.onStartup.addListener(() => {
  ensureTrackingAlarm().catch((error) => console.warn("Ensure alarm failed", error));
  hydrateTimeEngine().catch((error) => console.warn("Hydrate engine failed", error));
});

bootstrap();

async function bootstrap() {
  chrome.idle.setDetectionInterval(IDLE_DETECTION_INTERVAL_SECONDS);

  const [
    {
      privacyMode: storedPrivacy = false,
      [BLOCKED_HOSTS_KEY]: storedBlockedHosts = []
    },
    summaryStore,
    storedState
  ] = await Promise.all([
    chrome.storage.local.get(["privacyMode", BLOCKED_HOSTS_KEY]),
    getNormalizedSummary(),
    chrome.storage.local.get("focusState")
  ]);

  privacyMode = storedPrivacy;
  if (Array.isArray(storedBlockedHosts)) {
    blockedDistractingHosts = new Set(
      storedBlockedHosts.filter((entry) => typeof entry === "string" && entry)
    );
  }
  lastFocusState = storedState.focusState || null;
  await chrome.storage.local.set({ [SUMMARY_KEY]: summaryStore });
  await seedTimeLogStorage();
  await ensureTrackingAlarm();
  await hydrateTimeEngine();
  await loadRules();
  await loadRulesCache();
  await loadSiteLimits();
  await updateLiveKpm(kpmMinuteTs, kpmMinuteBucket);

  const initialIdleState = await chrome.idle.queryState(IDLE_DETECTION_INTERVAL_SECONDS);
  currentIdleState = normalizeIdleState(initialIdleState);
  const now = Date.now();
  lastActiveStart = now;
  lastIdleStart = now;
  await updateSummary((summary) => {
    summary.lastState = currentIdleState;
    if (currentIdleState === "active") {
      summary.lastActiveAt = now;
    } else {
      summary.lastIdleAt = now;
    }
  });

  chrome.tabs.onActivated.addListener(() => {
    handleTick("tab switch", { refreshActive: false })
      .catch((error) => console.warn("Tick on tab switch failed", error))
      .finally(() => refreshActiveTab().catch((error) => console.warn("Tab focus error", error)));
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tab?.active && changeInfo.url) {
      handleTick("tab update", { refreshActive: false })
        .catch((error) => console.warn("Tick on tab update failed", error))
        .finally(() => refreshActiveTab().catch((error) => console.warn("Tab update error", error)));
    }
  });

  chrome.tabs.onCreated.addListener((tab) => {
    handleNewTab(tab).catch((error) => console.warn("Adaptive tab error", error));
  });

  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    refreshActiveTab().catch((error) => console.warn("Window focus error", error));
  });

  chrome.idle.onStateChanged.addListener((state) => {
    handleIdleChange(state).catch((error) => console.warn("Idle state error", error));
    if (state === "idle") {
      handleTick("idle", { refreshActive: false, forceLog: true }).catch((error) => console.warn("Tick on idle failed", error));
    } else if (state === "active") {
      lastTickTs = Date.now();
      refreshActiveTab().catch((error) => console.warn("Idle resume refresh failed", error));
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;

    if (changes.privacyMode) {
      const nextPrivacy = Boolean(changes.privacyMode.newValue);
      if (nextPrivacy !== privacyMode) {
        privacyMode = nextPrivacy;
        if (privacyMode) {
          lastActiveTab = null;
          lastTrackedHost = null;
          kpmMinuteBucket = 0;
          kpmMinuteTs = null;
          updateLiveKpm(null, 0).catch((error) => console.warn("KPM live reset failed", error));
        } else {
          refreshActiveTab().catch((error) => console.warn("Privacy resume capture error", error));
        }
      }
    }

    if (changes.categorizationRules) {
      loadRulesCache().catch((error) => console.warn("Rule cache refresh failed", error));
    }
    if (changes.rules) {
      loadRules().catch((error) => console.warn("Rules refresh failed", error));
      const prevLimit = Number(changes.rules.oldValue?.distractingLimitMinutes);
      const nextLimit = Number(changes.rules.newValue?.distractingLimitMinutes);
      if (Number.isFinite(prevLimit) && Number.isFinite(nextLimit) && prevLimit !== nextLimit) {
        clearBlockedHosts().catch((error) => console.warn("Blocked hosts reset failed", error));
      }
    }
    if (changes.distractingSiteLimits) {
      loadSiteLimits().catch((error) => console.warn("Site limit cache refresh failed", error));
      clearBlockedHosts().catch((error) => console.warn("Blocked hosts reset failed", error));
    }
  });

  chrome.alarms.create("neuro-nudge-eval", {
    periodInMinutes: NUDGE_INTERVAL_MINUTES,
    delayInMinutes: 1
  });
  chrome.alarms.create(RULES_REFRESH_ALARM, {
    periodInMinutes: RULES_REFRESH_MINUTES,
    delayInMinutes: 0.5
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "neuro-nudge-eval") {
      evaluateStateAndNudge("schedule").catch((error) => console.error("Nudge eval failed", error));
    }
    if (alarm.name === TRACKING_ALARM) {
      handleTick("alarm").catch((error) => console.warn("Engine alarm tick failed", error));
    }
    if (alarm.name === RULES_REFRESH_ALARM) {
      loadRules().catch((error) => console.warn("Rules refresh failed", error));
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "kpm:batch") {
      handleKpmBatch(message, sender).catch((error) => console.warn("KPM batch intake failed", error));
      return false;
    }
    if (message?.type === "nudges:trigger") {
      evaluateStateAndNudge("manual", { force: true })
        .then((state) => sendResponse({ state }))
        .catch((error) => sendResponse({ error: error.message }));
      return true;
    }
    if (message?.type === "activity:summary") {
      getNormalizedSummary()
        .then((summary) => sendResponse({ summary }))
        .catch((error) => sendResponse({ error: error.message }));
      return true;
    }
    if (message?.type === "extension:reset") {
      blockedDistractingHosts.clear();
      persistBlockedHosts().catch((error) => console.warn("Blocked host reset failed", error));
      return false;
    }
    return false;
  });

  await refreshActiveTab();
  try {
    const { dailySummary = {} } = await chrome.storage.local.get("dailySummary");
    await syncGoalEngine(dailySummary[todayKey()]);
  } catch (error) {
    console.warn("Initial goal sync failed", error);
  }
}

function normalizeIdleState(state) {
  return state === "active" ? "active" : "idle";
}

async function handleIdleChange(state) {
  const normalized = normalizeIdleState(state);
  if (normalized === currentIdleState) return;
  const now = Date.now();

  if (normalized === "idle") {
    const activeDuration = now - lastActiveStart;
    await updateSummary((summary) => {
      if (activeDuration > 0) {
        summary.totalFocusMs += activeDuration;
        summary.lastActiveDurationMs = activeDuration;
        summary.focusStreakMs += activeDuration;
      }
      summary.lastState = "idle";
      summary.lastIdleAt = now;
    });
    lastIdleStart = now;
  } else {
    const idleDuration = now - lastIdleStart;
    await updateSummary((summary) => {
      if (idleDuration > 0) {
        summary.totalIdleMs += idleDuration;
        summary.lastIdleDurationMs = idleDuration;
      }
      if (idleDuration >= IDLE_RESET_MS) {
        summary.focusStreakMs = 0;
      }
      summary.lastState = "active";
      summary.lastActiveAt = now;
    });
    lastActiveStart = now;
  }

  currentIdleState = normalized;
}

async function refreshActiveTab() {
  if (privacyMode) {
    lastActiveTab = null;
    lastTrackedHost = null;
    return;
  }
  const active = await getActiveTab();
  if (!active) {
    lastActiveTab = null;
    lastTrackedHost = null;
    return;
  }
  if (active.host && lastTrackedHost && lastTrackedHost !== active.host) {
    await updateSummary((summary) => {
      summary.domainSwitches.push({ timestamp: Date.now() });
      summary.domainSwitches = summary.domainSwitches.slice(-20);
    });
  }
  lastTrackedHost = active.host || null;
  lastActiveTab = active;
  if (lastActiveTab.host && blockedDistractingHosts.has(lastActiveTab.host)) {
    await enforceBlockedHost(lastActiveTab, "blocked");
    return;
  }
  try {
    await maybeEnforceDistractingLimit(active);
  } catch (error) {
    console.warn("Distracting limit enforcement failed", error);
  }
}

async function ensureTrackingAlarm() {
  const alarms = await chrome.alarms.getAll();
  const alreadyExists = alarms.some((alarm) => alarm.name === TRACKING_ALARM);
  if (!alreadyExists) {
    chrome.alarms.create(TRACKING_ALARM, { periodInMinutes: 1 });
  }
}

async function hydrateTimeEngine() {
  const { lastTickTs: storedTick } = await chrome.storage.local.get("lastTickTs");
  if (typeof storedTick === "number") {
    lastTickTs = storedTick;
  } else {
    lastTickTs = Date.now();
    await chrome.storage.local.set({ lastTickTs });
  }
  await refreshActiveTab();
}

async function loadRulesCache() {
  const { categorizationRules = {} } = await chrome.storage.local.get("categorizationRules");
  const exact = new Map();
  const domains = new Map();
  const contains = [];
  const regex = [];

  for (const key of Object.keys(categorizationRules)) {
    const focusClass = categorizationRules[key];
    if (typeof focusClass !== "string") continue;
    const parsed = parseRuleKey(key);
    if (!parsed) continue;
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
  }

  ruleCache = { exact, domains, contains, regex };
}

async function loadRules() {
  const { rules } = await chrome.storage.local.get("rules");
  rulesConfig = { ...DEFAULT_RULES, ...(rules || {}) };
}

async function loadSiteLimits() {
  const { distractingSiteLimits = {} } = await chrome.storage.local.get("distractingSiteLimits");
  const map = new Map();
  for (const [key, value] of Object.entries(distractingSiteLimits)) {
    const normalized = normalizeHostKey(key);
    const seconds = Number(value);
    if (!normalized || !Number.isFinite(seconds) || seconds <= 0) continue;
    map.set(normalized, seconds);
  }
  siteLimits = map;
}

async function persistBlockedHosts() {
  await chrome.storage.local.set({
    [BLOCKED_HOSTS_KEY]: Array.from(blockedDistractingHosts)
  });
}

async function clearBlockedHosts() {
  if (blockedDistractingHosts.size === 0) return;
  blockedDistractingHosts.clear();
  await persistBlockedHosts();
}

function parseRuleKey(rawKey) {
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

function classifyHost(host) {
  if (!host) return "Neutral";
  const normalized = host.toLowerCase();

  if (ruleCache.exact?.has(normalized)) {
    return ruleCache.exact.get(normalized);
  }

  if (ruleCache.domains) {
    for (const [domain, value] of ruleCache.domains.entries()) {
      if (normalized === domain || normalized.endsWith(`.${domain}`)) {
        return value;
      }
    }
  }

  if (ruleCache.contains) {
    for (const [fragment, value] of ruleCache.contains) {
      if (normalized.includes(fragment)) {
        return value;
      }
    }
  }

  if (ruleCache.regex) {
    for (const [rx, value] of ruleCache.regex) {
      try {
        if (rx.test(normalized)) return value;
      } catch {
        // ignore bad regex
      }
    }
  }
  return "Neutral";
}

function isDistractingHost(host) {
  return classifyHost(host).startsWith("Distracting");
}

function normalizeHostKey(raw) {
  if (!raw || typeof raw !== "string") return "";
  let base = raw.trim();
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
  base = base.trim().toLowerCase();
  return base;
}

function getSiteLimitSeconds(host) {
  if (!host) return null;
  const normalized = normalizeHostKey(host);
  if (!normalized) return null;
  if (siteLimits.has(normalized)) return siteLimits.get(normalized);
  for (const [limitHost, seconds] of siteLimits.entries()) {
    if (normalized === limitHost || normalized.endsWith(`.${limitHost}`)) {
      return seconds;
    }
  }
  return null;
}

async function handleTick(reason = "alarm", { refreshActive: shouldRefresh = true, forceLog = false } = {}) {
  const now = Date.now();
  const deltaSeconds = (now - lastTickTs) / 1000;
  if (deltaSeconds < 1) {
    lastTickTs = now;
    return;
  }

  if (
    !lastActiveTab ||
    !lastActiveTab.host ||
    privacyMode
  ) {
    lastTickTs = now;
    await chrome.storage.local.set({ lastTickTs: now });
    if (shouldRefresh) {
      await refreshActiveTab();
    }
    return;
  }

  const elapsedSeconds = Math.min(deltaSeconds, MAX_TRACKING_DELTA_SECONDS);
  const loggedHost = lastActiveTab.host;
  const idleState = await chrome.idle.queryState(IDLE_DETECTION_INTERVAL_SECONDS);
  if (idleState === "active" || forceLog) {
    await logTimeForHost(loggedHost, elapsedSeconds);
  }

  try {
    await flushPendingKpm(now);
  } catch (error) {
    console.warn("KPM flush on tick failed", error);
  }

  try {
    await updateDailySummary();
    await maybeRunBreakCoach();
    await updateFlowWindow();
    await maybeEnforceDistractingLimit(lastActiveTab);
  } catch (error) {
    console.warn("Post-tick enrichments failed", error);
  }

  lastTickTs = now;
  await chrome.storage.local.set({ lastTickTs: now });

  if (shouldRefresh) {
    await refreshActiveTab();
  }
  console.log(
    `[Engine] Tick (${reason}) Δ=${Math.round(elapsedSeconds)}s host=${loggedHost || "none"}`
  );
}

async function updateDailySummary() {
  const today = todayKey();
  const [{ dailyTimeLog = {} }, { kpmLog = {} }] = await Promise.all([
    chrome.storage.local.get("dailyTimeLog"),
    chrome.storage.local.get("kpmLog")
  ]);

  const dayMap = dailyTimeLog[today] || {};
  const classes = { Productive: 0, Distracting: 0, Neutral: 0 };

  for (const [host, payload] of Object.entries(dayMap)) {
    const seconds = Math.max(0, Math.round(payload?.seconds || 0));
    const bucket = classifyHost(host).split(":")[0] || "Neutral";
    classes[bucket] = (classes[bucket] || 0) + seconds;
  }

  const topHosts = Object.entries(dayMap)
    .map(([host, payload]) => ({
      host,
      seconds: Math.max(0, Math.round(payload?.seconds || 0))
    }))
    .filter((entry) => entry.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, 10);

  const minutes = kpmLog[today]?.minutes || {};
  const now = Date.now();
  const floorNow = now - (now % KPM_MINUTE_MS);
  let total = 0;
  let buckets = 0;
  for (let i = 0; i < 5; i += 1) {
    const ts = floorNow - i * KPM_MINUTE_MS;
    if (minutes[ts]) {
      total += minutes[ts];
      buckets += 1;
    }
  }
  const minuteAvg5 = buckets ? total / buckets : 0;

  const { dailySummary = {} } = await chrome.storage.local.get("dailySummary");
  dailySummary[today] = {
    classes,
    topHosts,
    kpm: { minuteAvg5 },
    computedAt: Date.now()
  };
  await chrome.storage.local.set({ dailySummary });
  try {
    await syncGoalEngine(dailySummary[today]);
  } catch (error) {
    console.warn("Goal engine sync failed", error);
  }
}

async function maybeRunBreakCoach() {
  const { rules = {}, dailySummary = {} } = await chrome.storage.local.get(["rules", "dailySummary"]);
  const today = todayKey();
  const summary = dailySummary[today];
  if (!summary) return;

  // future tuning: tie to break interval
  const breakMinutes = Math.max(10, Number(rules.breakInterval) || DEFAULT_RULES.breakInterval);
  const recentAvg = summary.kpm?.minuteAvg5 || 0;
  const HIGH_KPM = recentAvg >= 120; // placeholder threshold
  if (!HIGH_KPM) return;

  const now = Date.now();
  const streakLikely = now - lastTickTs <= 2 * 60 * 1000;
  if (!streakLikely) return;
  if (now - lastBreakNudgeAt < BREAK_COOLDOWN_MS) return;

  lastBreakNudgeAt = now;
  const msg = "Typing hard for a while. Try a 2-min reset?";
  await appendNudge({ message: msg, state: "overload", meta: { breakMinutes } });
  try {
    if (chrome.notifications) {
      chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "Break Coach",
        message: msg,
        priority: 1
      });
    }
  } catch (error) {
    console.warn("Break coach notification failed", error);
  }
}

async function appendNudge(entry) {
  const day = todayKey();
  const { nudgeLog = [] } = await chrome.storage.local.get("nudgeLog");
  const payload = [{ day, at: Date.now(), ...entry }, ...nudgeLog].slice(0, 50);
  await chrome.storage.local.set({ nudgeLog: payload });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "nudges:trigger") {
    appendNudge({ message: "Manual nudge sent.", state: "manual" }).catch((error) =>
      console.warn("Manual append failed", error)
    );
  }
  return false;
});

async function updateFlowWindow() {
  const { dailySummary = {} } = await chrome.storage.local.get("dailySummary");
  const summary = dailySummary[todayKey()];
  if (!summary) return;

  const recentAvg = summary.kpm?.minuteAvg5 || 0;
  const host = lastActiveTab?.host || "";
  const productive = classifyHost(host).startsWith("Productive");
  const FLOW_KPM = recentAvg >= 80;

  if (productive && FLOW_KPM) {
    if (!flowState.active) {
      flowState = { active: true, startAt: Date.now() };
      await markFlow("start", flowState.startAt);
    }
  } else if (flowState.active) {
    const endAt = Date.now();
    await markFlow("end", endAt, flowState.startAt);
    flowState = { active: false, startAt: 0 };
  }
}

async function markFlow(kind, timestamp, startAt = 0) {
  const { flowLog = [] } = await chrome.storage.local.get("flowLog");
  if (kind === "start") {
    const updated = [{ type: "start", at: timestamp }, ...flowLog].slice(0, 40);
    await chrome.storage.local.set({ flowLog: updated });
    return;
  }
  const durationMs = Math.max(0, timestamp - startAt);
  const updated = [{ type: "end", at: timestamp, durationMs }, ...flowLog].slice(0, 40);
  await chrome.storage.local.set({ flowLog: updated });
}

async function maybeEnforceDistractingLimit(tab) {
  if (!tab || privacyMode) return;
  const targetUrl = chrome.runtime.getURL("motivator.html");
  const tabUrl = tab.url || "";
  if (tabUrl.startsWith(targetUrl) || tabUrl.startsWith("chrome-extension://")) return;
  const host = tab.host || normalizeHost(tabUrl);
  if (!host) return;

  const limits = [];
  const hostIsDistracting = isDistractingHost(host);
  const globalLimitMinutes = Number(rulesConfig.distractingLimitMinutes);
  if (hostIsDistracting && Number.isFinite(globalLimitMinutes) && globalLimitMinutes > 0) {
    limits.push({ seconds: globalLimitMinutes * 60, reason: "global" });
  }
  const siteLimitSeconds = getSiteLimitSeconds(host);
  if (Number.isFinite(siteLimitSeconds) && siteLimitSeconds > 0) {
    limits.push({ seconds: siteLimitSeconds, reason: "site" });
  }
  if (!limits.length) return;

  const today = todayKey();
  const { dailyTimeLog = {} } = await chrome.storage.local.get("dailyTimeLog");
  if (!dailyTimeLog[today]) dailyTimeLog[today] = {};
  const entry = dailyTimeLog[today][host] || { seconds: 0, alert: null, limitHit: null };
  if (typeof entry.limitHit === "undefined") entry.limitHit = null;
  const hostSeconds = Math.max(0, Math.round(entry.seconds || 0));

  const sortedLimits = limits
    .map((limit) => ({ ...limit, remaining: limit.seconds - hostSeconds }))
    .sort((a, b) => a.seconds - b.seconds);

  const triggered = sortedLimits.find((limit) => limit.remaining <= 0);
  if (triggered) {
    const hitKey = `limit-hit-${triggered.reason}`;
    const alreadyHit = entry.alert === hitKey;
    entry.alert = hitKey;
    entry.limitHit = triggered.reason;
    dailyTimeLog[today][host] = entry;
    await chrome.storage.local.set({ dailyTimeLog });

    if (!blockedDistractingHosts.has(host)) {
      blockedDistractingHosts.add(host);
      await persistBlockedHosts();
    }

    if (!alreadyHit) {
      const limitMinutes = Math.round(triggered.seconds / 60);
      const message =
        triggered.reason === "site"
          ? `Focus reset: ${host} reached its ${limitMinutes}m limit.`
          : `Focus reset: time on ${host} hit your limit.`;
      await appendNudge({
        message,
        state: "limit",
        meta: { host, limitMinutes, reason: triggered.reason }
      });
      try {
        await chrome.notifications.create(`limit-hit-${triggered.reason}-${host}`, {
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: "Distracting limit reached",
          message,
          priority: 2
        });
      } catch (error) {
        console.warn("Limit hit notification failed", error);
      }
    }

    await enforceBlockedHost(tab);
    return;
  }

  if (blockedDistractingHosts.has(host)) {
    blockedDistractingHosts.delete(host);
    await persistBlockedHosts();
  }

  const warning = sortedLimits
    .filter((limit) => limit.remaining > 0 && limit.remaining <= 30)
    .sort((a, b) => a.remaining - b.remaining)[0];

  if (warning) {
    const warnKey = `limit-warning-${warning.reason}`;
    if (entry.alert !== warnKey) {
      entry.alert = warnKey;
      entry.limitHit = null;
      dailyTimeLog[today][host] = entry;
      await chrome.storage.local.set({ dailyTimeLog });
      const secondsRemaining = Math.ceil(warning.remaining);
      const message =
        warning.reason === "site"
          ? `${secondsRemaining}s left before ${host}'s limit.`
          : `Only ${secondsRemaining}s left on ${host}.`;
      await appendNudge({
        message,
        state: "limit_warning",
        meta: { host, remaining: secondsRemaining, reason: warning.reason }
      });
      try {
        await chrome.notifications.create(`limit-warning-${warning.reason}-${host}`, {
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: "Almost at your distracting limit",
          message,
          priority: 1
        });
      } catch (error) {
        console.warn("Limit warning notification failed", error);
      }
    }
  } else if (entry.alert && entry.alert.startsWith("limit-warning")) {
    entry.alert = null;
    entry.limitHit = null;
    dailyTimeLog[today][host] = entry;
    await chrome.storage.local.set({ dailyTimeLog });
  }
}

async function logTimeForHost(host, addSeconds) {
  if (!host || !Number.isFinite(addSeconds) || addSeconds <= 0) return;
  const day = todayKey();
  const { dailyTimeLog = {}, engineMeta = {} } = await chrome.storage.local.get(["dailyTimeLog", "engineMeta"]);
  if (day !== engineMeta.lastPersistedDay) {
    pruneOldDays(dailyTimeLog, day);
    await rolloverKpmLogs(day);
    const { dailySummary = {} } = await chrome.storage.local.get("dailySummary");
    const todayDate = new Date(day);
    for (const key of Object.keys(dailySummary)) {
      const diffDays = (todayDate - new Date(key)) / (1000 * 60 * 60 * 24);
      if (diffDays > SUMMARY_PRUNE_DAYS) {
        delete dailySummary[key];
      }
    }
    await chrome.storage.local.set({ dailySummary });
    engineMeta.lastPersistedDay = day;
    await clearBlockedHosts().catch((error) => console.warn("Blocked hosts day reset failed", error));
  }
  if (!dailyTimeLog[day]) dailyTimeLog[day] = {};
  const entry = dailyTimeLog[day][host] || { seconds: 0, alert: null, limitHit: null };
  if (typeof entry.limitHit === "undefined") entry.limitHit = null;
  entry.seconds += Math.max(1, Math.round(addSeconds));
  dailyTimeLog[day][host] = entry;
  await chrome.storage.local.set({ dailyTimeLog, engineMeta });
  await updateSummary((summary) => {
    summary.domainStats[host] = (summary.domainStats[host] || 0) + Math.max(1, Math.round(addSeconds));
  });
}

async function enforceBlockedHost(tab) {
  const tabId = typeof tab.tabId === "number" ? tab.tabId : tab.id;
  if (!tabId) return;
  const host = tab.host || normalizeHost(tab.url || "");
  if (!host || !blockedDistractingHosts.has(host)) return;
  const targetUrl = chrome.runtime.getURL("motivator.html");
  try {
    await chrome.tabs.update(tabId, { url: targetUrl });
  } catch (error) {
    console.warn("Blocked host redirect failed", error);
  }
}

function pruneOldDays(log, currentDayStr) {
  const today = new Date(currentDayStr);
  let removed = 0;
  for (const key of Object.keys(log)) {
    const diffDays = (today - new Date(key)) / (1000 * 60 * 60 * 24);
    if (diffDays > RETAIN_DAYS) {
      delete log[key];
      removed += 1;
    }
  }
  if (removed) {
    console.log(`[Engine] Pruned ${removed} old day(s)`);
  }
}

async function handleKpmBatch(message, sender) {
  if (!sender?.tab?.active) return;
  if (!sender?.tab?.url || !/^https?:/.test(sender.tab.url)) return;
  if (privacyMode) return;

  const { privacyMode: storedPrivacy } = await chrome.storage.local.get("privacyMode");
  if (storedPrivacy) return;

  const idle = await chrome.idle.queryState(IDLE_DETECTION_INTERVAL_SECONDS);
  if (idle !== "active") return;

  const now = Date.now();
  const minute = floorToMinute(now);

  if (kpmMinuteTs !== null && minute !== kpmMinuteTs && kpmMinuteBucket > 0) {
    try {
      await flushKpmMinute(kpmMinuteTs, kpmMinuteBucket);
    } catch (error) {
      console.warn("KPM flush on minute rollover failed", error);
    }
    kpmMinuteBucket = 0;
  }

  kpmMinuteTs = minute;

  const add = Math.max(0, Math.min(KPM_MAX_BATCH, Number(message.count) || 0));
  if (add <= 0) return;
  kpmMinuteBucket = Math.min(kpmMinuteBucket + add, KPM_MAX_BATCH);
  console.log(`[KPM] batch +${add} keys`, {
    tab: sender.tab?.url,
    origin: message.origin,
    minuteTs: kpmMinuteTs,
    pending: kpmMinuteBucket
  });
  await updateLiveKpm(kpmMinuteTs, kpmMinuteBucket);
}

async function flushPendingKpm(now) {
  if (!kpmMinuteTs || kpmMinuteBucket <= 0) return;
  await flushKpmMinute(kpmMinuteTs, kpmMinuteBucket);
  kpmMinuteBucket = 0;
  kpmMinuteTs = floorToMinute(now);
  await updateLiveKpm(kpmMinuteTs, kpmMinuteBucket);
}

async function flushKpmMinute(minuteTs, count) {
  if (!minuteTs || !count) return;
  const day = todayKey();
  const { kpmLog = {} } = await chrome.storage.local.get("kpmLog");
  if (!kpmLog[day]) kpmLog[day] = { minutes: {}, rollup: { totalKeys: 0 } };
  const dayObj = kpmLog[day];
  dayObj.minutes[minuteTs] = (dayObj.minutes[minuteTs] || 0) + count;
  dayObj.rollup.totalKeys = (dayObj.rollup.totalKeys || 0) + count;
  await chrome.storage.local.set({ kpmLog });
}

async function rolloverKpmLogs(currentDay) {
  const { kpmLog = {} } = await chrome.storage.local.get("kpmLog");
  pruneOldKpm(kpmLog, currentDay);
  await chrome.storage.local.set({ kpmLog });
  await updateLiveKpm(kpmMinuteTs, kpmMinuteBucket);
}

function pruneOldKpm(kpmLog, currentDayStr) {
  const today = new Date(currentDayStr);
  for (const key of Object.keys(kpmLog)) {
    const diffDays = (today - new Date(key)) / (1000 * 60 * 60 * 24);
    if (diffDays > RETAIN_DAYS) {
      delete kpmLog[key];
    }
  }
}

function floorToMinute(timestamp) {
  return timestamp - (timestamp % KPM_MINUTE_MS);
}

async function updateLiveKpm(minuteTs, pending) {
  const normalizedPending = Math.max(0, Math.round(pending || 0));
  await chrome.storage.local.set({
    kpmLive: {
      minuteTs: typeof minuteTs === "number" && normalizedPending > 0 ? minuteTs : null,
      pending: normalizedPending
    }
  });
}

async function seedTimeLogStorage() {
  const { dailyTimeLog, engineMeta, lastTickTs: storedTick } = await chrome.storage.local.get([
    "dailyTimeLog",
    "engineMeta",
    "lastTickTs"
  ]);
  const initPayload = {};
  if (!dailyTimeLog) initPayload.dailyTimeLog = {};
  if (!engineMeta) initPayload.engineMeta = { lastPersistedDay: todayKey() };
  if (typeof storedTick !== "number") initPayload.lastTickTs = Date.now();
  if (Object.keys(initPayload).length > 0) {
    await chrome.storage.local.set(initPayload);
  }
}

async function getActiveTab() {
  try {
    const win = await chrome.windows.getLastFocused({ populate: true, windowTypes: ["normal"] });
    const activeTab = win.tabs?.find((tab) => tab.active && tab.url);
    if (activeTab?.url) {
      const host = normalizeHost(activeTab.url);
      return host ? { tabId: activeTab.id, host, url: activeTab.url } : null;
    }
  } catch (error) {
    console.warn("getActiveTab via windows failed", error);
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, windowType: "normal" });
    if (!tab?.url) return null;
    const host = normalizeHost(tab.url);
    return host ? { tabId: tab.id, host, url: tab.url } : null;
  } catch (error) {
    console.error("getActiveTab fallback error", error);
    return null;
  }
}

function normalizeHost(url) {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    return parsed.hostname.replace(/^www\./i, "");
  } catch {
    return null;
  }
}

function todayKey() {
  return new Date().toISOString().split("T")[0];
}

async function evaluateStateAndNudge(triggerSource = "schedule", { force = false } = {}) {
  const state = await getCurrentState(rulesConfig);
  const hasChanged = state !== lastFocusState;
  const shouldNudge = force || hasChanged;
  if (!shouldNudge) return state;
  await deliverNudge(state, triggerSource);
  lastFocusState = state;
  await chrome.storage.local.set({ focusState: state, currentState: state });
  return state;
}

async function deliverNudge(state, triggerSource) {
  const { userMood = "neutral", nudgeCount = 0, nudgeHistory = [], nudgeLog = [] } = await chrome.storage.local.get([
    "userMood",
    "nudgeCount",
    "nudgeHistory",
    "nudgeLog"
  ]);

  const aiResult = await getAINudge(state, userMood).catch((error) => {
    console.warn("AI helper failed", error);
    return null;
  });
  const fallback = STATE_MESSAGES[state] || STATE_MESSAGES.steady;
  const message = aiResult?.message?.trim() || fallback;
  const notificationId = `neuro-nudge-${Date.now()}`;

  await chrome.notifications.create(notificationId, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "NeuroNudge",
    message,
    priority: 0
  });

  if (rulesConfig.voice) {
    speakMessage(message);
  }

  const timestamp = Date.now();
  const updatedHistory = [{ message, state, mood: userMood, at: timestamp, source: aiResult?.source || "local", trigger: triggerSource }, ...nudgeHistory].slice(0, 10);
  const newLogEntry = {
    message,
    state,
    time: formatClock(timestamp),
    day: todayKey(),
    at: timestamp
  };
  const updatedLog = [newLogEntry, ...nudgeLog].slice(0, 20);
  await chrome.storage.local.set({
    nudgeCount: nudgeCount + 1,
    nudgeHistory: updatedHistory,
    nudgeLog: updatedLog,
    lastNudgeMessage: message,
    lastNudgeAt: timestamp
  });
}

function speakMessage(message) {
  if (!chrome.tts) return;
  chrome.tts.speak(message, {
    lang: "en-US",
    enqueue: false,
    rate: 1,
    voiceName: undefined
  });
}

function formatClock(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

async function syncGoalEngine(summary) {
  const day = todayKey();
  const goalStatus = await computeGoalStatus(summary, { day });
  await updateScoreboard(summary, goalStatus, day);
}

async function computeGoalStatus(summary, { day = todayKey(), skipPersist = false, flowLog: flowLogOverride } = {}) {
  const safeSummary = summary || {};
  const classes = safeSummary.classes || {};
  const productiveSec = Math.max(0, Math.round(classes.Productive || 0));
  const distractingSec = Math.max(0, Math.round(classes.Distracting || 0));
  const { dailyTimeLog = {} } = await chrome.storage.local.get("dailyTimeLog");
  const dayLog = dailyTimeLog[day] || {};
  const siteLimitBreached = Object.values(dayLog).some((entry) => entry?.limitHit);

  const goals = await getGoals();
  const dailyGoals = goals.daily || {};
  const productiveTarget = Number(dailyGoals.productiveSecTarget) || 0;
  const distractingCap = Number(dailyGoals.distractingSecCap) || 0;
  const flowTarget = Number(dailyGoals.flowWindowsTarget) || 0;

  const flowLogSource = Array.isArray(flowLogOverride) ? flowLogOverride : (await chrome.storage.local.get("flowLog")).flowLog;
  const normalizedFlowLog = Array.isArray(flowLogSource) ? flowLogSource : [];
  const flowDone = countFlowsForDay(normalizedFlowLog, day);

  const pctProductive = productiveTarget > 0 ? Math.min(1, productiveSec / productiveTarget) : 1;
  const productiveRemainingSec = productiveTarget > 0 ? Math.max(0, productiveTarget - productiveSec) : 0;
  const distractingOverSec = distractingCap > 0 ? Math.max(0, distractingSec - distractingCap) : 0;

  let state = resolveGoalState({
    productiveTarget,
    distractingCap,
    pctProductive,
    productiveRemainingSec,
    distractingSec,
    day
  });

  if (siteLimitBreached) {
    state = GOAL_STATUS_STATES.FAILING;
  }

  if (state !== GOAL_STATUS_STATES.PASSING && flowTarget > 0 && flowDone >= flowTarget && pctProductive >= 0.75) {
    state = GOAL_STATUS_STATES.AT_RISK;
  }

  const goalStatus = {
    state,
    pctProductive,
    productiveRemainingSec,
    distractingOverSec,
    flowDone,
    updatedAt: Date.now()
  };

  if (!skipPersist) {
    await chrome.storage.local.set({ goalStatus });
  }

  return goalStatus;
}

function resolveGoalState({ productiveTarget, distractingCap, pctProductive, productiveRemainingSec, distractingSec, day }) {
  let state = GOAL_STATUS_STATES.PASSING;
  if (productiveTarget > 0) {
    if (pctProductive >= 1) {
      state = GOAL_STATUS_STATES.PASSING;
    } else {
      const dayStart = new Date(`${day}T00:00:00`).getTime();
      const hoursIntoDay = Math.max(0, (Date.now() - dayStart) / (60 * 60 * 1000));
      const expectedPct = Math.min(1, Math.max(0, (hoursIntoDay - 1) / 9));
      if (expectedPct <= 0.05) {
        state = GOAL_STATUS_STATES.AT_RISK;
      } else if (pctProductive >= expectedPct * 0.8) {
        state = GOAL_STATUS_STATES.AT_RISK;
      } else {
        state = GOAL_STATUS_STATES.FAILING;
      }
    }
  }

  if (distractingCap > 0) {
    const usageRatio = distractingSec / distractingCap;
    if (usageRatio >= 1) {
      state = GOAL_STATUS_STATES.FAILING;
    } else if (usageRatio >= 0.8 && state === GOAL_STATUS_STATES.PASSING) {
      state = GOAL_STATUS_STATES.AT_RISK;
    }
  }

  if (productiveTarget > 0 && productiveRemainingSec <= productiveTarget * 0.1 && state === GOAL_STATUS_STATES.FAILING) {
    return GOAL_STATUS_STATES.AT_RISK;
  }

  return state;
}

async function updateScoreboard(summary, goalStatus, day) {
  const storage = await chrome.storage.local.get(["scoreboard", "scoreboardMeta", "dailySummary", "flowLog"]);
  const storedScoreboard = storage.scoreboard || null;
  const meta = storage.scoreboardMeta || {};
  const dailySummary = storage.dailySummary || {};
  const flowLog = Array.isArray(storage.flowLog) ? storage.flowLog : [];

  const productiveSec = Math.max(0, Math.round(summary?.classes?.Productive || 0));
  const distractingSec = Math.max(0, Math.round(summary?.classes?.Distracting || 0));
  const flowCount = countFlowsForDay(flowLog, day);

  const history7d = Array.isArray(storedScoreboard?.history7d) ? [...storedScoreboard.history7d] : [];
  let streakCount = storedScoreboard?.streaks?.daysMetTarget || 0;
  let lastEvaluatedDay = meta.lastEvaluatedDay || null;
  const prevDay = meta.day;

  if (prevDay && prevDay !== day && lastEvaluatedDay !== prevDay) {
    const prevSummary = dailySummary[prevDay];
    if (prevSummary) {
      const prevStatus = await computeGoalStatus(prevSummary, {
        day: prevDay,
        skipPersist: true,
        flowLog
      });
      const met = prevStatus.state === GOAL_STATUS_STATES.PASSING;
      if (!history7d.some((entry) => entry?.day === prevDay)) {
        history7d.unshift({
          day: prevDay,
          productiveSec: Math.max(0, Math.round(prevSummary?.classes?.Productive || 0)),
          met
        });
        if (history7d.length > 7) history7d.length = 7;
      }
      streakCount = met ? streakCount + 1 : 0;
    }
    lastEvaluatedDay = prevDay;
  }

  const todayMet = goalStatus?.state === GOAL_STATUS_STATES.PASSING;

  const scoreboardPayload = {
    today: { productiveSec, distractingSec, flowCount, met: todayMet },
    streaks: { daysMetTarget: streakCount },
    history7d
  };

  const metaPayload = {
    day,
    lastEvaluatedDay
  };

  await chrome.storage.local.set({ scoreboard: scoreboardPayload, scoreboardMeta: metaPayload });
}

function countFlowsForDay(flowLog, day) {
  if (!Array.isArray(flowLog)) return 0;
  return flowLog.reduce((count, entry) => {
    if (!entry || entry.type !== "end") return count;
    const entryDay = new Date(entry.at).toISOString().split("T")[0];
    return entryDay === day ? count + 1 : count;
  }, 0);
}

async function getGoals() {
  try {
    if (!chrome?.storage?.sync) {
      return { daily: { ...DEFAULT_GOALS.daily } };
    }
    const { goals } = await chrome.storage.sync.get("goals");
    const input = goals && typeof goals === "object" ? goals : {};
    const daily = {
      ...DEFAULT_GOALS.daily,
      ...(input.daily || {})
    };
    return { daily };
  } catch (error) {
    console.warn("Goals fetch failed", error);
    return { daily: { ...DEFAULT_GOALS.daily } };
  }
}

function pickInterventionMode(goalStatus, summary) {
  if (!goalStatus) return null;
  const state = goalStatus.state;
  if (state === GOAL_STATUS_STATES.PASSING) return null;
  const remaining = goalStatus.productiveRemainingSec || 0;
  const minuteAvg5 = summary?.kpm?.minuteAvg5 || 0;
  const distractingSec = Math.max(0, Math.round(summary?.classes?.Distracting || 0));
  const productiveSec = Math.max(0, Math.round(summary?.classes?.Productive || 0));

  if (state === GOAL_STATUS_STATES.FAILING) {
    if (remaining > 0 && remaining <= 15 * 60) return "push";
    if (distractingSec > productiveSec * 0.8 || minuteAvg5 < 20) return "interrupt";
    return "interrupt";
  }

  if (state === GOAL_STATUS_STATES.AT_RISK) {
    if (remaining > 0 && remaining <= 30 * 60) return "push";
    if (minuteAvg5 < 30) return "gentle";
    return "gentle";
  }

  return null;
}

async function handleNewTab(tab) {
  const newTabUrl = tab?.pendingUrl || tab?.url || "";
  if (!newTabUrl) return;
  if (!newTabUrl.startsWith("chrome://newtab")) return;
  if (tab?.url && tab.url.startsWith("chrome-extension://")) return;

  try {
    const storage = await chrome.storage.local.get(["goalStatus", "dailySummary"]);
    const today = todayKey();
    const summary = storage.dailySummary?.[today] || null;
    if (!summary) return;
    let status = storage.goalStatus || null;

    const stale = !status || typeof status.updatedAt !== "number" || Date.now() - status.updatedAt > 2 * 60 * 1000;
    if (stale) {
      status = await computeGoalStatus(summary);
    }

    if (!status || status.state === GOAL_STATUS_STATES.PASSING) return;

    const mode = pickInterventionMode(status, summary);
    if (!mode) return;

    const destination = `${chrome.runtime.getURL("inspiration.html")}?mode=${encodeURIComponent(mode)}`;
    if (typeof tab.id === "number") {
      await chrome.tabs.update(tab.id, { url: destination });
    }
  } catch (error) {
    console.warn("Adaptive new tab failed", error);
  }
}

async function updateSummary(mutator) {
  const summary = await getNormalizedSummary();
  await Promise.resolve(mutator(summary));
  await chrome.storage.local.set({ [SUMMARY_KEY]: summary });
  return summary;
}
