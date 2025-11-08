// stateEngine.js
// Centralized focus-state heuristics: normalizes stored activity summaries,
// keeps domain-switch history tidy, and exposes helpers to classify the current
// state (steady / drift / overload) for the background service worker.

const SUMMARY_KEY = "activitySummary";
const TEN_MINUTES_MS = 10 * 60 * 1000;
const DEFAULT_DRIFT_IDLE_MS = 5 * 60 * 1000;
const DEFAULT_OVERLOAD_MS = 45 * 60 * 1000;
const IDLE_RESET_MS = 2 * 60 * 1000;
const DRIFT_SWITCH_THRESHOLDS = { low: 6, medium: 4, high: 3 };
const DRIFT_IDLE_THRESHOLDS = { low: 7, medium: 5, high: 3 };

const getTodayKey = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};

export { SUMMARY_KEY, TEN_MINUTES_MS, IDLE_RESET_MS };

export function createEmptySummary(date = getTodayKey()) {
  const now = Date.now();
  return {
    date,
    domainStats: {},
    domainSwitches: [],
    totalFocusMs: 0,
    totalIdleMs: 0,
    focusStreakMs: 0,
    lastIdleDurationMs: 0,
    lastActiveDurationMs: 0,
    lastIdleAt: now,
    lastActiveAt: now,
    lastState: "active"
  };
}

export function normalizeSummary(summary) {
  const today = getTodayKey();
  const base = summary && summary.date === today ? summary : createEmptySummary(today);
  if (!Array.isArray(base.domainSwitches)) base.domainSwitches = [];
  if (!base.domainStats || typeof base.domainStats !== "object") base.domainStats = {};
  base.domainSwitches = base.domainSwitches
    .filter((entry) => entry && typeof entry.timestamp === "number" && Date.now() - entry.timestamp <= TEN_MINUTES_MS)
    .slice(-20);
  if (typeof base.lastIdleAt !== "number") base.lastIdleAt = Date.now();
  if (typeof base.lastActiveAt !== "number") base.lastActiveAt = Date.now();
  if (typeof base.focusStreakMs !== "number") base.focusStreakMs = 0;
  if (typeof base.lastIdleDurationMs !== "number") base.lastIdleDurationMs = 0;
  if (typeof base.lastActiveDurationMs !== "number") base.lastActiveDurationMs = 0;
  if (base.lastState !== "idle" && base.lastState !== "active") base.lastState = "active";
  return base;
}

export async function getNormalizedSummary() {
  const stored = await chrome.storage.local.get(SUMMARY_KEY);
  return normalizeSummary(stored[SUMMARY_KEY]);
}

function resolveThresholds(rules = {}) {
  const sensitivity = rules.driftSensitivity || "medium";
  const switchThreshold = DRIFT_SWITCH_THRESHOLDS[sensitivity] ?? DRIFT_SWITCH_THRESHOLDS.medium;
  const idleThresholdMs = (DRIFT_IDLE_THRESHOLDS[sensitivity] ?? DRIFT_IDLE_THRESHOLDS.medium) * 60 * 1000;
  const breakMinutes = Math.max(15, Number(rules.breakInterval) || DEFAULT_OVERLOAD_MS / 60000);
  return {
    switchThreshold,
    idleThresholdMs: idleThresholdMs || DEFAULT_DRIFT_IDLE_MS,
    overloadThresholdMs: breakMinutes * 60 * 1000
  };
}

export function determineState(summary, rules = {}) {
  const now = Date.now();
  const switchCount = summary.domainSwitches.length;
  const idleElapsed = summary.lastState === "idle" ? now - summary.lastIdleAt : 0;
  const effectiveFocusStreak =
    summary.focusStreakMs + (summary.lastState === "active" ? now - summary.lastActiveAt : 0);
  const thresholds = resolveThresholds(rules);
  const hasDrifted = switchCount > thresholds.switchThreshold || idleElapsed >= thresholds.idleThresholdMs;
  const hasOverloaded =
    effectiveFocusStreak >= thresholds.overloadThresholdMs && summary.lastIdleDurationMs < IDLE_RESET_MS;
  if (hasOverloaded) return "overload";
  if (hasDrifted) return "drift";
  return "steady";
}

export async function getCurrentState(rules = {}) {
  const summary = await getNormalizedSummary();
  const state = determineState(summary, rules);
  await chrome.storage.local.set({
    [SUMMARY_KEY]: summary,
    focusState: state,
    currentState: state,
    lastStateComputedAt: Date.now()
  });
  return state;
}

export async function getRecentKpmAvg(minutesBack = 5) {
  const day = new Date().toISOString().split("T")[0];
  const { kpmLog = {} } = await chrome.storage.local.get("kpmLog");
  const minutes = kpmLog[day]?.minutes || {};
  const now = Date.now();
  const floorNow = now - (now % (60 * 1000));
  let total = 0;
  let buckets = 0;
  for (let i = 0; i < minutesBack; i += 1) {
    const ts = floorNow - i * 60 * 1000;
    if (minutes[ts]) {
      total += minutes[ts];
      buckets += 1;
    }
  }
  return buckets ? total / buckets : 0;
}
