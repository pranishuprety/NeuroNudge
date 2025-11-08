// options.js
// Loads and saves NeuroNudge rule preferences so the background worker can
// tailor state detection and nudging cadence.

const form = document.getElementById("rulesForm");
const breakInput = document.getElementById("breakInterval");
const driftSelect = document.getElementById("driftSensitivity");
const maxDailyInput = document.getElementById("maxDaily");
const voiceCheckbox = document.getElementById("voiceNudges");
const distractingLimitInput = document.getElementById("distractingLimit");
const toastEl = document.getElementById("toast");

const productiveTargetInput = document.getElementById("productiveTarget");
const distractingCapInput = document.getElementById("distractingCap");
const flowTargetInput = document.getElementById("flowTarget");

const DEFAULT_RULES = {
  breakInterval: 45,
  driftSensitivity: "medium",
  maxDailyHours: 8,
  voice: true,
  distractingLimitMinutes: 60
};

const DEFAULT_GOALS = {
  daily: {
    productiveSecTarget: 3 * 3600,
    distractingSecCap: 45 * 60,
    flowWindowsTarget: 2
  }
};

const initPromise = init();

async function init() {
  const [{ rules }, goalsConfig] = await Promise.all([chrome.storage.local.get("rules"), loadGoals()]);
  const current = { ...DEFAULT_RULES, ...(rules || {}) };
  breakInput.value = current.breakInterval;
  driftSelect.value = current.driftSensitivity;
  maxDailyInput.value = current.maxDailyHours;
  voiceCheckbox.checked = Boolean(current.voice);
  if (distractingLimitInput) distractingLimitInput.value = current.distractingLimitMinutes;

  const goalDaily = goalsConfig.daily;
  if (productiveTargetInput) {
    productiveTargetInput.value = Math.round(goalDaily.productiveSecTarget / 60);
  }
  if (distractingCapInput) {
    distractingCapInput.value = Math.round(goalDaily.distractingSecCap / 60);
  }
  if (flowTargetInput) {
    flowTargetInput.value = goalDaily.flowWindowsTarget;
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = {
    breakInterval: Number(breakInput.value) || DEFAULT_RULES.breakInterval,
    driftSensitivity: driftSelect.value,
    maxDailyHours: Number(maxDailyInput.value) || DEFAULT_RULES.maxDailyHours,
    voice: voiceCheckbox.checked,
    distractingLimitMinutes:
      Number(distractingLimitInput?.value) || DEFAULT_RULES.distractingLimitMinutes
  };
  const goalsPayload = normalizeGoals({
    daily: {
      productiveSecTarget: Math.max(0, Math.round(Number(productiveTargetInput?.value || 0) * 60)),
      distractingSecCap: Math.max(0, Math.round(Number(distractingCapInput?.value || 0) * 60)),
      flowWindowsTarget: Math.max(0, Math.round(Number(flowTargetInput?.value || 0)))
    }
  });

  await Promise.all([chrome.storage.local.set({ rules: payload }), saveGoals(goalsPayload)]);
  toastEl.textContent = "Preferences saved!";
  // Clear the status message quickly so it does not linger.
  setTimeout(() => (toastEl.textContent = ""), 2000);
});


const ruleKeyEl = document.getElementById("ruleKey");
const ruleValueEl = document.getElementById("ruleValue");
const addRuleBtn = document.getElementById("addRule");
const ruleListEl = document.getElementById("ruleList");

addRuleBtn?.addEventListener("click", async () => {
  const key = (ruleKeyEl?.value || "").trim();
  const val = (ruleValueEl?.value || "Neutral").trim();
  if (!key) return;
  const { categorizationRules = {} } = await chrome.storage.local.get("categorizationRules");
  categorizationRules[key] = val;
  await chrome.storage.local.set({ categorizationRules });
  if (ruleKeyEl) ruleKeyEl.value = "";
  await renderRules();
});

async function renderRules() {
  if (!ruleListEl) return;
  const { categorizationRules = {} } = await chrome.storage.local.get("categorizationRules");
  const entries = Object.entries(categorizationRules);
  if (entries.length === 0) {
    ruleListEl.innerHTML = `<li><em class="muted">No classification rules yet.</em></li>`;
    return;
  }
  ruleListEl.innerHTML = entries
    .map(
      ([key, value]) =>
        `<li><span>${sanitize(key)}</span><strong>${sanitize(value)}</strong>
      <button type="button" data-k="${encodeURIComponent(key)}" class="secondary remove-rule">Remove</button>
    </li>`
    )
    .join("");

  ruleListEl.querySelectorAll("button[data-k]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const storedKey = decodeURIComponent(btn.getAttribute("data-k") || "");
      const { categorizationRules = {} } = await chrome.storage.local.get("categorizationRules");
      delete categorizationRules[storedKey];
      await chrome.storage.local.set({ categorizationRules });
      await renderRules();
    });
  });
}

function sanitize(value = "") {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

initPromise.then(renderRules);

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

async function loadGoals() {
  try {
    if (chrome?.storage?.sync) {
      const { goals } = await chrome.storage.sync.get("goals");
      return normalizeGoals(goals);
    }
  } catch (error) {
    console.warn("Failed to load sync goals", error);
  }
  const { goals } = await chrome.storage.local.get("goals");
  return normalizeGoals(goals);
}

async function saveGoals(goals) {
  const payload = normalizeGoals(goals);
  try {
    if (chrome?.storage?.sync) {
      await chrome.storage.sync.set({ goals: payload });
      return;
    }
  } catch (error) {
    console.warn("Failed to save sync goals, falling back to local", error);
  }
  await chrome.storage.local.set({ goals: payload });
}
