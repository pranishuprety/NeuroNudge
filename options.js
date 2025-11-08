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

const DEFAULT_RULES = {
  breakInterval: 45,
  driftSensitivity: "medium",
  maxDailyHours: 8,
  voice: true,
  distractingLimitMinutes: 60
};

const initPromise = init();

async function init() {
  const { rules } = await chrome.storage.local.get("rules");
  const current = { ...DEFAULT_RULES, ...(rules || {}) };
  breakInput.value = current.breakInterval;
  driftSelect.value = current.driftSensitivity;
  maxDailyInput.value = current.maxDailyHours;
  voiceCheckbox.checked = Boolean(current.voice);
  if (distractingLimitInput) distractingLimitInput.value = current.distractingLimitMinutes;
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
  await chrome.storage.local.set({ rules: payload });
  toastEl.textContent = "Rules saved!";
  // Clear the status message quickly so it does not linger.
  setTimeout(() => (toastEl.textContent = ""), 2000);
});

// ---- Domain classification (Step 3) ----
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
