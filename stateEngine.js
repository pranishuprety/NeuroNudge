// stateEngine.js
// Centralized focus-state heuristics: normalizes stored activity summaries,
// keeps domain-switch history tidy, and exposes helpers to classify the current
// state (steady / drift / overload) for the background service worker.

const SUMMARY_KEY = "activitySummary";
const TEN_MINUTES_MS = 10 * 60 * 1000;
const DRIFT_IDLE_THRESHOLD_MS = 5 * 60 * 1000;
const OVERLOAD_THRESHOLD_MS = 45 * 60 * 1000;
const IDLE_RESET_MS = 2 * 60 * 1000;

const getTodayKey = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};

export { SUMMARY_KEY, TEN_MINUTES_MS, DRIFT_IDLE_THRESHOLD_MS, OVERLOAD_THRESHOLD_MS, IDLE_RESET_MS };

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

export function determineState(summary) {
  const now = Date.now();
  const switchCount = summary.domainSwitches.length;
  const idleElapsed = summary.lastState === "idle" ? now - summary.lastIdleAt : 0;
  const effectiveFocusStreak =
    summary.focusStreakMs + (summary.lastState === "active" ? now - summary.lastActiveAt : 0);
  const hasDrifted = switchCount > 4 || idleElapsed >= DRIFT_IDLE_THRESHOLD_MS;
  const hasOverloaded = effectiveFocusStreak >= OVERLOAD_THRESHOLD_MS && summary.lastIdleDurationMs < IDLE_RESET_MS;
  if (hasOverloaded) return "overload";
  if (hasDrifted) return "drift";
  return "steady";
}

export async function getCurrentState() {
  const summary = await getNormalizedSummary();
  const state = determineState(summary);
  await chrome.storage.local.set({
    [SUMMARY_KEY]: summary,
    focusState: state,
    lastStateComputedAt: Date.now()
  });
  return state;
}
