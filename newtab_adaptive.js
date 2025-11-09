const DEFAULT_GOALS = {
  daily: {
    productiveSecTarget: 3 * 3600,
    distractingSecCap: 45 * 60,
    flowWindowsTarget: 2
  }
};

const MODE_COPY = {
  gentle: {
    badge: "Gentle Nudge",
    title: "Ease back into focus",
    message: "Give yourself a mindful beat. Clear the noise, breathe, and choose one meaningful next action."
  },
  push: {
    badge: "Momentum Push",
    title: "You're close — lock in the win",
    message: "The finish line is minutes away. Seal the sprint, note the win, and ride the streak."
  },
  interrupt: {
    badge: "Pattern Interrupt",
    title: "Let's break the distraction loop",
    message: "Deep inhale, tab audit, and a short reset. Keep only the tab that supports your next focused move."
  },
  reset: {
    badge: "Cascade Reset",
    title: "Take a restoring micro-reset",
    message: "Follow the breathing cadence below. When the timer ends, resume flow feeling clearer."
  }
};

const MICRO_PRESETS = [
  {
    id: "box-breath",
    text: "Box-breath for two minutes: inhale 4s • hold 4s • exhale 4s • hold 4s. Repeat the square six times.",
    modes: ["gentle", "reset", "interrupt"]
  },
  {
    id: "eye-break",
    text: "Eye refresh: close eyes for 5s, then focus on something 20 feet away for 20s. Repeat five rounds.",
    modes: ["push", "interrupt", "reset"]
  },
  {
    id: "shoulder-roll",
    text: "Shoulder reset: roll shoulders forward 8x, backward 8x, then reach arms overhead and exhale slowly.",
    modes: ["gentle", "push", "reset"]
  },
  {
    id: "body-scan",
    text: "Quick body scan: starting at toes, notice & release tension up through legs, hips, shoulders, jaw.",
    modes: ["gentle", "reset"]
  },
  {
    id: "intent-note",
    text: "Intent reset: jot one sentence—“When the timer ends I will begin with…”—and breathe while you wait.",
    modes: ["push", "interrupt"]
  }
];

const modeBadgeEl = document.getElementById("modeBadge");
const modeTitleEl = document.getElementById("modeTitle");
const modeMessageEl = document.getElementById("modeMessage");
const whyChipEl = document.getElementById("whyChip");
const statTargetEl = document.getElementById("statTarget");
const statDistractingEl = document.getElementById("statDistracting");
const statKpmEl = document.getElementById("statKpm");
const statFlowEl = document.getElementById("statFlow");
const statRiskEl = document.getElementById("statRisk");
const statRiskCardEl = document.getElementById("statRiskCard");
const microTextEl = document.getElementById("microText");
const resetCardEl = document.getElementById("resetCard");
const resetTimerEl = document.getElementById("resetTimer");
const resumeBtn = document.getElementById("resumeBtn");
const closeBtn = document.getElementById("closeBtn");

document.addEventListener("DOMContentLoaded", async () => {
  const params = new URLSearchParams(window.location.search);
  const mode = (params.get("mode") || "gentle").toLowerCase();
  applyMode(mode);

  try {
    const [store, goalsConfig] = await Promise.all([
      chrome.storage.local.get([
        "goalStatus",
        "dailySummary",
        "riskEngineStatus",
        "riskEngineMeta",
        "flowLog",
        "kpmLog",
        "kpmLive",
        "privacyMode"
      ]),
      loadGoals()
    ]);

    const today = todayKey();
    const summary = store.dailySummary?.[today] || {};
    const goalStatus = store.goalStatus || null;
    const riskStatus = store.riskEngineStatus || {};
    const riskMeta = store.riskEngineMeta || {};
    const goals = goalsConfig.daily;

    renderWhyChip(params, riskStatus, goalStatus);
    renderStats(goalStatus, goals, summary, store, riskStatus);
    renderMicroReset(mode);
    setupTimer(mode, riskMeta);
  } catch (error) {
    console.warn("Adaptive new-tab render failed", error);
  }
});

resumeBtn?.addEventListener("click", async () => {
  try {
    await chrome.runtime.sendMessage({ type: "risk:resumeFlow", source: "adaptive_page" });
  } catch (error) {
    console.warn("Resume flow request failed", error);
  } finally {
    window.close();
  }
});

closeBtn?.addEventListener("click", () => {
  window.close();
});

function applyMode(mode) {
  const normalized = MODE_COPY[mode] ? mode : "gentle";
  document.body.dataset.mode = normalized;
  const copy = MODE_COPY[normalized];
  if (modeBadgeEl) modeBadgeEl.textContent = copy.badge;
  if (modeTitleEl) modeTitleEl.textContent = copy.title;
  if (modeMessageEl) modeMessageEl.textContent = copy.message;
}

function renderWhyChip(params, riskStatus, goalStatus) {
  const directReason = params.get("reason");
  const riskExplain = (riskStatus?.latestExplain || "").trim();
  let message = directReason || riskExplain;
  if (!message && goalStatus?.state) {
    message =
      goalStatus.state === "FAILING"
        ? "Nudged because you’re over the cap — let’s reset."
        : "Nudged because you’re nearing your target. Take a mindful pause.";
  }
  if (!message) {
    message = "Nudged because: focus check-in.";
  }
  if (whyChipEl) {
    whyChipEl.textContent = message;
  }
}

function renderStats(goalStatus, goals, summary, store, riskStatus) {
  const targetSec = Math.max(0, Number(goals.productiveSecTarget) || 0);
  const hasGoalStatus = Boolean(goalStatus);
  const remainingSec =
    targetSec > 0 && hasGoalStatus
      ? Math.max(0, goalStatus?.productiveRemainingSec ?? targetSec)
      : 0;
  const remainingLabel = hasGoalStatus
    ? targetSec > 0
      ? remainingSec > 0
        ? formatMinutes(remainingSec)
        : "Met"
      : "—"
    : "—";

  const capSec = Math.max(0, Number(goals.distractingSecCap) || 0);
  const distractSeconds = Math.max(0, Math.round(summary?.classes?.Distracting || 0));
  const distractOver = Math.max(0, goalStatus?.distractingOverSec || 0);
  let distractLabel = "—";
  if (hasGoalStatus && capSec > 0) {
    distractLabel =
      distractOver > 0
        ? `+${formatMinutes(distractOver)} over`
        : `${formatMinutes(distractSeconds)} / ${formatMinutes(capSec)}`;
  } else if (distractSeconds > 0) {
    distractLabel = `${formatMinutes(distractSeconds)} logged`;
  }

  const kpm = computeRecentKpm(store.kpmLog, store.kpmLive, store.privacyMode);
  const flowLabel = computeFlowLabel(store.flowLog, summary);

  const riskScore =
    typeof riskStatus?.latestScore === "number"
      ? `${Math.round(Math.max(0, Math.min(1, riskStatus.latestScore)) * 100)}%`
      : "—";

  if (statTargetEl) statTargetEl.textContent = remainingLabel;
  if (statDistractingEl) statDistractingEl.textContent = distractLabel;
  if (statKpmEl) statKpmEl.textContent = `${kpm} kpm`;
  if (statFlowEl) statFlowEl.textContent = flowLabel;
  if (statRiskEl) statRiskEl.textContent = riskScore;
  if (statRiskCardEl) {
    statRiskCardEl.hidden = typeof riskStatus?.latestScore !== "number";
  }
}

function renderMicroReset(mode) {
  if (!microTextEl) return;
  const candidates = MICRO_PRESETS.filter((entry) => entry.modes.includes(mode));
  const pool = candidates.length ? candidates : MICRO_PRESETS;
  const index = Math.floor((Date.now() / (60 * 1000)) % pool.length);
  microTextEl.textContent = pool[index].text;
}

function setupTimer(mode, meta) {
  if (!resetCardEl || !resetTimerEl) return;
  const resetUntil = Number(meta?.resetActiveUntil) || 0;
  const remainingMs = resetUntil - Date.now();
  if (mode !== "reset" && remainingMs <= 0) {
    resetCardEl.hidden = true;
    return;
  }
  resetCardEl.hidden = false;
  updateTimer(resetUntil);
  const interval = setInterval(() => {
    const stillRemaining = updateTimer(resetUntil);
    if (stillRemaining <= 0) {
      clearInterval(interval);
    }
  }, 1000);
}

function updateTimer(resetUntil) {
  if (!resetTimerEl) return 0;
  const diff = Math.max(0, resetUntil - Date.now());
  const seconds = Math.ceil(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  resetTimerEl.textContent = `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  return diff;
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

function computeFlowLabel(flowLog = [], summary = {}) {
  if (Array.isArray(flowLog)) {
    const recentEnd = flowLog.find((entry) => entry?.type === "end");
    if (recentEnd && typeof recentEnd.durationMs === "number") {
      return `${formatMinutesFromMs(recentEnd.durationMs)} session`;
    }
  }
  const focusStreakMs = Math.max(0, Number(summary.focusStreakMs) || 0);
  if (focusStreakMs > 0) {
    return `${formatMinutesFromMs(focusStreakMs)} active`;
  }
  return "No flow yet";
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

function formatMinutesFromMs(ms = 0) {
  const totalMinutes = Math.max(0, Math.round(ms / (60 * 1000)));
  return `${totalMinutes}m`;
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
