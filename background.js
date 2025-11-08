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
const DEFAULT_RULES = {
  breakInterval: 45,
  driftSensitivity: "medium",
  maxDailyHours: 8,
  voice: true
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

  const [{ privacyMode: storedPrivacy = false }, summaryStore, storedState] = await Promise.all([
    chrome.storage.local.get("privacyMode"),
    getNormalizedSummary(),
    chrome.storage.local.get("focusState")
  ]);

  privacyMode = storedPrivacy;
  lastFocusState = storedState.focusState || null;
  await chrome.storage.local.set({ [SUMMARY_KEY]: summaryStore });
  await seedTimeLogStorage();
  await ensureTrackingAlarm();
  await hydrateTimeEngine();
  await loadRules();
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
    if (area === "local" && changes.privacyMode) {
      const nextPrivacy = Boolean(changes.privacyMode.newValue);
      if (nextPrivacy === privacyMode) return;
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
    return false;
  });

  await refreshActiveTab();
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

async function loadRules() {
  const { rules } = await chrome.storage.local.get("rules");
  rulesConfig = { ...DEFAULT_RULES, ...(rules || {}) };
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

  lastTickTs = now;
  await chrome.storage.local.set({ lastTickTs: now });

  if (shouldRefresh) {
    await refreshActiveTab();
  }
  console.log(
    `[Engine] Tick (${reason}) Δ=${Math.round(elapsedSeconds)}s host=${loggedHost || "none"}`
  );
}

async function logTimeForHost(host, addSeconds) {
  if (!host || !Number.isFinite(addSeconds) || addSeconds <= 0) return;
  const day = todayKey();
  const { dailyTimeLog = {}, engineMeta = {} } = await chrome.storage.local.get(["dailyTimeLog", "engineMeta"]);
  if (day !== engineMeta.lastPersistedDay) {
    pruneOldDays(dailyTimeLog, day);
    await rolloverKpmLogs(day);
    engineMeta.lastPersistedDay = day;
  }
  if (!dailyTimeLog[day]) dailyTimeLog[day] = {};
  const entry = dailyTimeLog[day][host] || { seconds: 0, alert: null };
  entry.seconds += Math.max(1, Math.round(addSeconds));
  dailyTimeLog[day][host] = entry;
  await chrome.storage.local.set({ dailyTimeLog, engineMeta });
  await updateSummary((summary) => {
    summary.domainStats[host] = (summary.domainStats[host] || 0) + Math.max(1, Math.round(addSeconds));
  });
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

async function updateSummary(mutator) {
  const summary = await getNormalizedSummary();
  await Promise.resolve(mutator(summary));
  await chrome.storage.local.set({ [SUMMARY_KEY]: summary });
  return summary;
}
