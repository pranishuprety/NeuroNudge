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
  const breakingMinutes = Number(breakInput.value);
  const limitMinutes = Number(distractingLimitInput?.value);
  const payload = {
    breakInterval: Number.isFinite(breakingMinutes) && breakingMinutes > 0 ? breakingMinutes : DEFAULT_RULES.breakInterval,
    driftSensitivity: driftSelect.value,
    maxDailyHours: Number(maxDailyInput.value) || DEFAULT_RULES.maxDailyHours,
    voice: voiceCheckbox.checked,
    distractingLimitMinutes:
      Number.isFinite(limitMinutes) && limitMinutes >= 0 ? limitMinutes : DEFAULT_RULES.distractingLimitMinutes
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
const siteLimitHostInput = document.getElementById("siteLimitHost");
const siteLimitMinutesInput = document.getElementById("siteLimitMinutes");
const addSiteLimitBtn = document.getElementById("addSiteLimit");
const siteLimitListEl = document.getElementById("siteLimitList");
const bannedHostInput = document.getElementById("bannedHost");
const addBannedHostBtn = document.getElementById("addBannedHost");
const bannedListEl = document.getElementById("bannedList");
const parentModeToggle = document.getElementById("parentModeEnabled");
const parentStatusEl = document.getElementById("parentModeStatus");
const parentNotifyToggle = document.getElementById("parentNotifyToggle");
const parentContactInput = document.getElementById("parentContactNumber");
const parentBlockedHostInput = document.getElementById("parentBlockedHost");
const addParentBlockedBtn = document.getElementById("addParentBlocked");
const parentBlockedListEl = document.getElementById("parentBlockedList");
const parentLimitHostInput = document.getElementById("parentLimitHost");
const parentLimitMinutesInput = document.getElementById("parentLimitMinutes");
const parentLimitTypeSelect = document.getElementById("parentLimitType");
const addParentLimitBtn = document.getElementById("addParentLimit");
const parentLimitListEl = document.getElementById("parentLimitList");
const voiceApiKeyInput = document.getElementById("voiceApiKey");
const voiceIdInput = document.getElementById("voiceId");
const voiceSaveBtn = document.getElementById("voiceSave");
const voiceToastEl = document.getElementById("voiceToast");

const PARENT_MODE_CONFIG_KEY = "parentModeConfig";

addRuleBtn?.addEventListener("click", async () => {
  const key = (ruleKeyEl?.value || "").trim();
  const val = (ruleValueEl?.value || "Neutral").trim();
  const normalizedKey = sanitizeRuleKeyInput(key);
  if (!normalizedKey) return;
  const { categorizationRules = {} } = await chrome.storage.local.get("categorizationRules");
  categorizationRules[normalizedKey] = val;
  await chrome.storage.local.set({ categorizationRules });
  if (ruleKeyEl) ruleKeyEl.value = "";
  await renderRules();
});

async function renderRules() {
  if (!ruleListEl) return;
  const categorizationRules = await ensureNormalizedRules();
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

addSiteLimitBtn?.addEventListener("click", async () => {
  const host = sanitizeRuleKeyInput(siteLimitHostInput?.value || "");
  const minutes = Number(siteLimitMinutesInput?.value || 0);
  if (!host || !Number.isFinite(minutes) || minutes <= 0) return;
  const seconds = Math.round(minutes * 60);
  const limits = await ensureNormalizedSiteLimits();
  limits[host] = seconds;
  await chrome.storage.local.set({ distractingSiteLimits: limits });
  if (siteLimitHostInput) siteLimitHostInput.value = "";
  if (siteLimitMinutesInput) siteLimitMinutesInput.value = "";
  await renderSiteLimits();
});

addBannedHostBtn?.addEventListener("click", async () => {
  const host = sanitizeBannedHostInput(bannedHostInput?.value || "");
  if (!host) return;
  const hosts = await ensureNormalizedBannedHosts();
  if (!hosts.includes(host)) {
    hosts.push(host);
    await chrome.storage.local.set({ bannedHosts: hosts });
  }
  if (bannedHostInput) bannedHostInput.value = "";
  await renderBannedHosts();
});

async function renderSiteLimits() {
  if (!siteLimitListEl) return;
  const limits = await ensureNormalizedSiteLimits();
  const entries = Object.entries(limits);
  if (entries.length === 0) {
    siteLimitListEl.innerHTML = `<li><em class="muted">No per-site limits yet.</em></li>`;
    return;
  }
  siteLimitListEl.innerHTML = entries
    .map(
      ([host, seconds]) =>
        `<li><span>${sanitize(host)} · ${formatMinutesFromSeconds(seconds)}</span>
      <button type="button" data-host="${encodeURIComponent(host)}" class="secondary">Remove</button></li>`
    )
    .join("");
  siteLimitListEl.querySelectorAll("button[data-host]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const hostKey = decodeURIComponent(btn.getAttribute("data-host") || "");
      const limitsToUpdate = await ensureNormalizedSiteLimits();
      delete limitsToUpdate[hostKey];
      await chrome.storage.local.set({ distractingSiteLimits: limitsToUpdate });
      await renderSiteLimits();
    });
  });
}

async function renderBannedHosts() {
  if (!bannedListEl) return;
  const hosts = await ensureNormalizedBannedHosts();
  if (!hosts.length) {
    bannedListEl.innerHTML = `<li><em class="muted">No banned sites yet.</em></li>`;
    return;
  }
  const sorted = [...hosts].sort();
  bannedListEl.innerHTML = sorted
    .map(
      (host) =>
        `<li><span>${sanitize(host)}</span>
      <button type="button" data-host="${encodeURIComponent(host)}" class="secondary">Remove</button></li>`
    )
    .join("");
  bannedListEl.querySelectorAll("button[data-host]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const target = decodeURIComponent(btn.getAttribute("data-host") || "");
      const current = await ensureNormalizedBannedHosts();
      const next = current.filter((entry) => entry !== target);
      await chrome.storage.local.set({ bannedHosts: next });
      await renderBannedHosts();
    });
  });
}

function setParentStatus(message = "", state = "") {
  if (!parentStatusEl) return;
  parentStatusEl.textContent = message;
  if (state) {
    parentStatusEl.setAttribute("data-state", state);
  } else {
    parentStatusEl.removeAttribute("data-state");
  }
}

function parseParentHost(value = "") {
  if (!value || typeof value !== "string") return "";
  let cleaned = value.trim();
  if (!cleaned) return "";
  if (/^https?:\/\//i.test(cleaned)) {
    try {
      const parsed = new URL(cleaned);
      cleaned = parsed.hostname || cleaned;
    } catch {
      cleaned = cleaned.replace(/^https?:\/\//i, "");
    }
  }
  cleaned = cleaned.replace(/^www\./i, "");
  cleaned = cleaned.split("/")[0];
  cleaned = cleaned.trim().toLowerCase();
  return cleaned;
}

function parseParentPhone(value = "") {
  if (!value || typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const digits = trimmed.replace(/[^\d]/g, "");
  if (!digits) return "";
  return `+${digits}`;
}

function sanitizeParentConfig(raw) {
  const payload = raw && typeof raw === "object" ? raw : {};
  const enabled = Boolean(payload.enabled);
  const notify = Boolean(payload.notify);
  const contactNumber = parseParentPhone(payload.contactNumber || payload.phone || "");
  const blockedSet = new Set();
  if (Array.isArray(payload.blocked)) {
    payload.blocked
      .map((entry) => parseParentHost(entry))
      .filter((entry) => entry)
      .forEach((entry) => blockedSet.add(entry));
  }
  const limitMap = new Map();
  if (Array.isArray(payload.limits)) {
    payload.limits.forEach((entry) => {
      if (!entry || typeof entry !== "object") return;
      const host = parseParentHost(entry.host || entry.site || "");
      const type = entry.type === "session" ? "session" : "daily";
      const minutes = Math.max(1, Math.round(Number(entry.minutes) || 0));
      if (!host || !Number.isFinite(minutes) || minutes <= 0) return;
      limitMap.set(`${host}|${type}`, { host, type, minutes });
    });
  }
  return {
    enabled,
    blocked: Array.from(blockedSet),
    limits: Array.from(limitMap.values()),
    notify,
    contactNumber
  };
}

async function updateStoredParentConfig(mutator) {
  const stored = await chrome.storage.local.get(PARENT_MODE_CONFIG_KEY);
  const sanitized = sanitizeParentConfig(stored[PARENT_MODE_CONFIG_KEY]);
  const working = {
    enabled: sanitized.enabled,
    blocked: [...sanitized.blocked],
    limits: sanitized.limits.map((entry) => ({ ...entry })),
    notify: sanitized.notify,
    contactNumber: sanitized.contactNumber
  };
  const result = typeof mutator === "function" ? mutator(working) || working : working;
  const normalized = sanitizeParentConfig(result);
  await chrome.storage.local.set({ [PARENT_MODE_CONFIG_KEY]: normalized });
  return normalized;
}

function applyParentSnapshot(snapshot = {}) {
  const enabled = Boolean(snapshot.enabled);
  if (parentModeToggle) parentModeToggle.checked = enabled;
  if (parentNotifyToggle) parentNotifyToggle.checked = Boolean(snapshot.notify);
  if (parentContactInput) parentContactInput.value = snapshot.contactNumber || "";
  if (parentContactInput) parentContactInput.disabled = !Boolean(snapshot.notify);
  const blockedEntries = Array.isArray(snapshot.blocked) ? snapshot.blocked : [];
  const limitEntries = Array.isArray(snapshot.limits) ? snapshot.limits : [];
  renderParentBlockedList(blockedEntries, enabled);
  renderParentLimitList(limitEntries, enabled);
}

async function refreshParentMode(showErrors = false) {
  if (!parentModeToggle) return;
  try {
    const response = await chrome.runtime.sendMessage({ type: "parentMode:snapshot" });
    if (!response?.success) {
      throw new Error(response?.error || "Unable to load Parent Mode");
    }
    applyParentSnapshot(response.snapshot || {});
    return;
  } catch (error) {
    console.warn("Parent Mode snapshot failed", error);
    if (showErrors) {
      setParentStatus(error.message || "Parent Mode unavailable.", "error");
    }
  }
  const stored = await chrome.storage.local.get(PARENT_MODE_CONFIG_KEY);
  const fallback = sanitizeParentConfig(stored[PARENT_MODE_CONFIG_KEY]);
  if (parentModeToggle) parentModeToggle.checked = fallback.enabled;
  if (parentNotifyToggle) parentNotifyToggle.checked = fallback.notify;
  if (parentContactInput) {
    parentContactInput.value = fallback.contactNumber || "";
    parentContactInput.disabled = !fallback.notify;
  }
  const blockedFallback = fallback.blocked.map((host) => ({ host, active: fallback.enabled }));
  const limitsFallback = fallback.limits.map((entry) => ({
    ...entry,
    usedSeconds: 0,
    remainingSeconds: entry.minutes * 60,
    exhausted: false
  }));
  applyParentSnapshot({
    enabled: fallback.enabled,
    blocked: blockedFallback,
    limits: limitsFallback,
    notify: fallback.notify,
    contactNumber: fallback.contactNumber
  });
}

async function hydrateVoiceSettings() {
  if (!voiceApiKeyInput || !voiceIdInput) return;
  const { elevenLabsApiKey = "", elevenLabsVoiceId = "" } = await chrome.storage.local.get([
    "elevenLabsApiKey",
    "elevenLabsVoiceId"
  ]);
  voiceApiKeyInput.value = elevenLabsApiKey || "";
  voiceIdInput.value = elevenLabsVoiceId || "";
  if (voiceToastEl) voiceToastEl.textContent = "";
}

function renderParentBlockedList(entries = [], enabled = false) {
  if (!parentBlockedListEl) return;
  if (!Array.isArray(entries) || entries.length === 0) {
    parentBlockedListEl.innerHTML = `<li><em class="muted">No Parent Mode blocked sites yet.</em></li>`;
    return;
  }
  const markup = entries
    .slice()
    .map((entry) => (typeof entry === "string" ? { host: entry, active: enabled } : entry))
    .sort((a, b) => (a.host || "").localeCompare(b.host || ""))
    .map((entry) => {
      const host = entry.host || "";
      const hostLabel = sanitize(host);
      const active = entry.active ?? enabled;
      const detail = active ? "Active while Parent Mode is on" : "Saved — turn on Parent Mode to enforce";
      return `<li><div style="display:grid;gap:4px;"><span>${hostLabel}</span><span class="muted">${detail}</span></div><button type="button" class="secondary" data-parent-blocked="${encodeURIComponent(
        host
      )}">Remove</button></li>`;
    })
    .join("");
  parentBlockedListEl.innerHTML = markup;
}

function renderParentLimitList(entries = [], enabled = false) {
  if (!parentLimitListEl) return;
  if (!Array.isArray(entries) || entries.length === 0) {
    parentLimitListEl.innerHTML = `<li><em class="muted">No Parent Mode limits yet.</em></li>`;
    return;
  }
  const markup = entries
    .slice()
    .map((entry) => {
      if (typeof entry === "string") {
        return { host: entry, type: "daily", minutes: 0 };
      }
      return entry;
    })
    .sort((a, b) => {
      const hostCompare = (a.host || "").localeCompare(b.host || "");
      if (hostCompare !== 0) return hostCompare;
      return (a.type || "").localeCompare(b.type || "");
    })
    .map((entry) => {
      const host = entry.host || "";
      const hostLabel = sanitize(host);
      const typeLabel = entry.type === "session" ? "Session" : "Daily";
      const limitMinutes = Math.max(1, Math.round(Number(entry.minutes) || 0));
      const usedMinutes = Math.max(0, Math.round((Number(entry.usedSeconds) || 0) / 60));
      const remainingMinutes = Math.max(0, Math.round((Number(entry.remainingSeconds) || 0) / 60));
      let detail = `${limitMinutes}m limit`;
      if (!enabled) {
        detail += " · Saved";
      } else if (entry.exhausted) {
        detail += usedMinutes ? ` · Reached (${usedMinutes}m used)` : " · Reached";
      } else if (remainingMinutes > 0) {
        detail += ` · ${remainingMinutes}m left`;
      } else if (usedMinutes > 0) {
        detail += ` · ${usedMinutes}m logged`;
      }
      return `<li><div style="display:grid;gap:4px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="limit-tag">${typeLabel}</span>
          <span>${hostLabel}</span>
        </div>
        <span class="muted">${detail}</span>
      </div>
      <button type="button" class="secondary" data-parent-limit="${encodeURIComponent(host)}" data-parent-limit-type="${entry.type}">Remove</button></li>`;
    })
    .join("");
  parentLimitListEl.innerHTML = markup;
}

function formatMinutesFromSeconds(seconds = 0) {
  const total = Number(seconds) || 0;
  if (total <= 0) return "0m";
  const minutes = total / 60;
  if (minutes < 1) return "<1m";
  return `${Math.round(minutes)}m`;
}

function sanitizeRuleKeyInput(rawKey) {
  if (!rawKey || typeof rawKey !== "string") return "";
  let base = rawKey.trim();
  const colonIndex = base.indexOf(":");
  if (colonIndex !== -1) {
    base = base.slice(0, colonIndex).trim();
  }
  if (!base) return "";
  const regexSpecial = /[*^$+?()[\]{}|\\]/;
  if (regexSpecial.test(base)) {
    return base;
  }
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
  return base.toLowerCase();
}

function sanitizeBannedHostInput(rawKey) {
  const host = sanitizeRuleKeyInput(rawKey);
  if (!host) return "";
  const regexSpecial = /[*^$+?()[\]{}|\\]/;
  if (regexSpecial.test(host)) return "";
  return host;
}

function normalizeRuleDictionary(input = {}) {
  const normalized = {};
  let changed = false;
  Object.entries(input).forEach(([key, value]) => {
    if (typeof value !== "string") return;
    const normalizedKey = sanitizeRuleKeyInput(key);
    if (!normalizedKey) return;
    if (normalizedKey !== key) changed = true;
    normalized[normalizedKey] = value.trim();
  });
  return { normalized, changed };
}

async function ensureNormalizedRules() {
  const { categorizationRules = {} } = await chrome.storage.local.get("categorizationRules");
  const { normalized, changed } = normalizeRuleDictionary(categorizationRules);
  if (changed) {
    await chrome.storage.local.set({ categorizationRules: normalized });
  }
  return normalized;
}

initPromise.then(() => {
  renderRules();
  renderSiteLimits();
  renderBannedHosts();
  setParentStatus("");
  refreshParentMode(true);
  hydrateVoiceSettings();
});

function normalizeSiteLimitDictionary(input = {}) {
  const normalized = {};
  let changed = false;
  Object.entries(input).forEach(([key, value]) => {
    const host = sanitizeRuleKeyInput(key);
    const seconds = Number(value);
    if (!host || !Number.isFinite(seconds) || seconds <= 0) return;
    const rounded = Math.round(seconds);
    normalized[host] = rounded;
    if (host !== key || rounded !== seconds) changed = true;
  });
  return { normalized, changed };
}

async function ensureNormalizedSiteLimits() {
  const { distractingSiteLimits = {} } = await chrome.storage.local.get("distractingSiteLimits");
  const { normalized, changed } = normalizeSiteLimitDictionary(distractingSiteLimits);
  if (changed) {
    await chrome.storage.local.set({ distractingSiteLimits: normalized });
  }
  return normalized;
}

async function ensureNormalizedBannedHosts() {
  const { bannedHosts = [] } = await chrome.storage.local.get("bannedHosts");
  const normalized = [];
  const seen = new Set();
  let changed = !Array.isArray(bannedHosts);
  if (Array.isArray(bannedHosts)) {
    bannedHosts.forEach((entry) => {
      const host = sanitizeBannedHostInput(entry);
      if (!host || seen.has(host)) {
        if (host) changed = true;
        return;
      }
      if (host !== entry) changed = true;
      seen.add(host);
      normalized.push(host);
    });
  }
  if (changed) {
    await chrome.storage.local.set({ bannedHosts: normalized });
  }
  return normalized;
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

parentModeToggle?.addEventListener("change", async (event) => {
  const nextEnabled = Boolean(event?.target?.checked);
  parentModeToggle.disabled = true;
  try {
    await updateStoredParentConfig((config) => {
      config.enabled = nextEnabled;
      return config;
    });
    setParentStatus(nextEnabled ? "Parent Mode enabled." : "Parent Mode disabled.", "success");
  } catch (error) {
    console.error("Parent Mode toggle failed", error);
    setParentStatus(error.message || "Unable to update Parent Mode.", "error");
    parentModeToggle.checked = !nextEnabled;
  } finally {
    parentModeToggle.disabled = false;
    await refreshParentMode(false);
  }
});

addParentBlockedBtn?.addEventListener("click", async () => {
  const host = parseParentHost(parentBlockedHostInput?.value || "");
  if (!host) {
    setParentStatus("Enter a valid site to block.", "error");
    parentBlockedHostInput?.focus();
    return;
  }
  addParentBlockedBtn.disabled = true;
  try {
    await updateStoredParentConfig((config) => {
      if (!config.blocked.includes(host)) {
        config.blocked.push(host);
      }
      return config;
    });
    if (parentBlockedHostInput) parentBlockedHostInput.value = "";
    setParentStatus(`Blocked ${host}.`, "success");
  } catch (error) {
    console.error("Parent Mode add blocked failed", error);
    setParentStatus(error.message || "Couldn't block that site.", "error");
  } finally {
    addParentBlockedBtn.disabled = false;
    await refreshParentMode(false);
  }
});

parentBlockedListEl?.addEventListener("click", async (event) => {
  const btn = event.target instanceof HTMLElement ? event.target.closest("button[data-parent-blocked]") : null;
  if (!btn) return;
  const host = decodeURIComponent(btn.getAttribute("data-parent-blocked") || "");
  if (!host) return;
  btn.disabled = true;
  try {
    await updateStoredParentConfig((config) => {
      config.blocked = config.blocked.filter((entry) => entry !== host);
      return config;
    });
    setParentStatus(`Removed ${host}.`, "success");
  } catch (error) {
    console.error("Parent Mode remove blocked failed", error);
    setParentStatus(error.message || "Couldn't remove that site.", "error");
  } finally {
    btn.disabled = false;
    await refreshParentMode(false);
  }
});

addParentLimitBtn?.addEventListener("click", async () => {
  const host = parseParentHost(parentLimitHostInput?.value || "");
  const minutesRaw = Number(parentLimitMinutesInput?.value || 0);
  if (!host) {
    setParentStatus("Enter a site for the limit.", "error");
    parentLimitHostInput?.focus();
    return;
  }
  if (!Number.isFinite(minutesRaw) || minutesRaw <= 0) {
    setParentStatus("Minutes must be greater than 0.", "error");
    parentLimitMinutesInput?.focus();
    return;
  }
  const minutes = Math.max(1, Math.round(minutesRaw));
  const limitType = parentLimitTypeSelect?.value === "session" ? "session" : "daily";
  addParentLimitBtn.disabled = true;
  try {
    await updateStoredParentConfig((config) => {
      const filtered = config.limits.filter((entry) => !(entry.host === host && entry.type === limitType));
      filtered.push({ host, type: limitType, minutes });
      config.limits = filtered;
      return config;
    });
    if (parentLimitHostInput) parentLimitHostInput.value = "";
    if (parentLimitMinutesInput) parentLimitMinutesInput.value = "";
    setParentStatus(
      `${limitType === "session" ? "Session" : "Daily"} limit set for ${host}.`,
      "success"
    );
  } catch (error) {
    console.error("Parent Mode add limit failed", error);
    setParentStatus(error.message || "Couldn't add that limit.", "error");
  } finally {
    addParentLimitBtn.disabled = false;
    await refreshParentMode(false);
  }
});

parentLimitListEl?.addEventListener("click", async (event) => {
  const btn = event.target instanceof HTMLElement ? event.target.closest("button[data-parent-limit]") : null;
  if (!btn) return;
  const host = decodeURIComponent(btn.getAttribute("data-parent-limit") || "");
  const type = btn.getAttribute("data-parent-limit-type") === "session" ? "session" : "daily";
  if (!host) return;
  btn.disabled = true;
  try {
    await updateStoredParentConfig((config) => {
      config.limits = config.limits.filter((entry) => !(entry.host === host && entry.type === type));
      return config;
    });
    setParentStatus(`Removed ${type === "session" ? "session" : "daily"} limit for ${host}.`, "success");
  } catch (error) {
    console.error("Parent Mode remove limit failed", error);
    setParentStatus(error.message || "Couldn't remove that limit.", "error");
  } finally {
    btn.disabled = false;
    await refreshParentMode(false);
  }
});

parentBlockedHostInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addParentBlockedBtn?.click();
  }
});

[parentLimitHostInput, parentLimitMinutesInput].forEach((inputEl) => {
  if (!inputEl) return;
  inputEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addParentLimitBtn?.click();
    }
  });
});

voiceSaveBtn?.addEventListener("click", async () => {
  const apiKey = (voiceApiKeyInput?.value || "").trim();
  const voiceId = (voiceIdInput?.value || "").trim();
  voiceSaveBtn.disabled = true;
  try {
    await chrome.storage.local.set({
      elevenLabsApiKey: apiKey,
      elevenLabsVoiceId: voiceId,
      elevenLabsModelId: "eleven_monolingual_v1"
    });
    await chrome.runtime.sendMessage({ type: "elevenlabs:configUpdated" }).catch(() => {});
    if (voiceToastEl) {
      voiceToastEl.textContent = apiKey && voiceId ? "ElevenLabs voice saved." : "Voice settings cleared.";
    }
  } catch (error) {
    console.error("Voice settings save failed", error);
    if (voiceToastEl) voiceToastEl.textContent = error?.message || "Unable to save voice settings.";
  } finally {
    voiceSaveBtn.disabled = false;
    if (voiceToastEl) {
      setTimeout(() => {
        voiceToastEl.textContent = "";
      }, 3000);
    }
  }
});

parentNotifyToggle?.addEventListener("change", async (event) => {
  const nextNotify = Boolean(event?.target?.checked);
  if (parentContactInput) parentContactInput.disabled = !nextNotify;
  parentNotifyToggle.disabled = true;
  try {
    await updateStoredParentConfig((config) => {
      config.notify = nextNotify;
      return config;
    });
    if (nextNotify) {
      if (parentContactInput && !parseParentPhone(parentContactInput.value || "")) {
        setParentStatus("Enter a phone number to receive iMessage alerts.", "error");
        parentContactInput?.focus();
      } else {
        setParentStatus("iMessage alerts enabled.", "success");
      }
    } else {
      setParentStatus("iMessage alerts disabled.", "success");
    }
  } catch (error) {
    console.error("Parent Mode notify toggle failed", error);
    setParentStatus(error.message || "Unable to update iMessage alerts.", "error");
    parentNotifyToggle.checked = !nextNotify;
  } finally {
    parentNotifyToggle.disabled = false;
    await refreshParentMode(false);
  }
});

async function handleParentContactSave() {
  if (!parentContactInput) return;
  const normalized = parseParentPhone(parentContactInput.value || "");
  parentContactInput.value = normalized;
  try {
    await updateStoredParentConfig((config) => {
      config.contactNumber = normalized;
      return config;
    });
    if (normalized) {
      setParentStatus(`Alerts will go to ${normalized}.`, "success");
    } else {
      if (parentNotifyToggle?.checked) {
        setParentStatus("Add a phone number to receive iMessage alerts.", "error");
      } else {
        setParentStatus("Cleared iMessage contact.", "");
      }
    }
  } catch (error) {
    console.error("Parent Mode contact update failed", error);
    setParentStatus(error.message || "Unable to update contact number.", "error");
  } finally {
    await refreshParentMode(false);
  }
}

parentContactInput?.addEventListener("blur", () => {
  void handleParentContactSave();
});

parentContactInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    parentContactInput.blur();
  }
});
