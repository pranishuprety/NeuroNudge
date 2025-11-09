// parentMode.js
// Encapsulates Parent Mode configuration, rule indexing, usage tracking, and storage plumbing.

export const PARENT_MODE_CONFIG_KEY = "parentModeConfig";
export const PARENT_MODE_SESSION_KEY = "parentModeSession";

const DEFAULT_CONFIG = {
  enabled: false,
  blocked: [],
  limits: [],
  notify: false,
  contactNumber: ""
};

const SESSION_RESET_MS = 30 * 60 * 1000;

function cloneDefaultConfig() {
  return {
    enabled: DEFAULT_CONFIG.enabled,
    blocked: [...DEFAULT_CONFIG.blocked],
    limits: [...DEFAULT_CONFIG.limits]
  };
}

export class ParentModeManager {
  constructor() {
    this.config = cloneDefaultConfig();
    this.blockedSet = new Set();
    this.limitIndex = new Map();
    this.sessionUsage = new Map();
    this.sessionPersistTimer = null;
    this.dailyCache = { dayKey: null, totals: new Map() };
  }

  normalizePhone(raw) {
    if (!raw || typeof raw !== "string") return "";
    const trimmed = raw.trim();
    if (!trimmed) return "";
    const digits = trimmed.replace(/[^\d]/g, "");
    if (!digits) return "";
    return `+${digits}`;
  }

  normalizeHostKey(raw) {
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

  sanitizeConfig(raw) {
    const payload = raw && typeof raw === "object" ? raw : {};
    const enabled = Boolean(payload.enabled);
    const notify = Boolean(payload.notify);
    const contactNumber = this.normalizePhone(payload.contactNumber || payload.phone || payload.contact);

    const blockedList = Array.isArray(payload.blocked) ? payload.blocked : [];
    const blocked = Array.from(
      new Set(
        blockedList
          .map((entry) => this.normalizeHostKey(entry))
          .filter((entry) => typeof entry === "string" && entry)
      )
    );

    const limitsList = Array.isArray(payload.limits) ? payload.limits : [];
    const limits = [];
    limitsList.forEach((entry) => {
      if (!entry || typeof entry !== "object") return;
      const host = this.normalizeHostKey(entry.host || entry.site || "");
      const type = entry.type === "session" ? "session" : "daily";
      const minutes = Number(entry.minutes);
      if (!host || !Number.isFinite(minutes) || minutes <= 0) return;
      limits.push({
        host,
        type,
        minutes: Math.round(minutes)
      });
    });

    return {
      enabled,
      blocked,
      limits,
      notify,
      contactNumber
    };
  }

  sanitizeSession(raw) {
    const payload = raw && typeof raw === "object" ? raw : {};
    const result = {};
    Object.entries(payload).forEach(([host, entry]) => {
      const normalized = this.normalizeHostKey(host);
      const seconds = Number(entry?.seconds);
      const lastActiveAt = Number(entry?.lastActiveAt);
      if (!normalized || !Number.isFinite(seconds) || seconds < 0) return;
      result[normalized] = {
        seconds,
        lastActiveAt: Number.isFinite(lastActiveAt) && lastActiveAt > 0 ? lastActiveAt : 0
      };
    });
    return result;
  }

  applyConfig(raw) {
    this.config = this.sanitizeConfig(raw);
    this.blockedSet = new Set(this.config.blocked);
    this.rebuildLimitIndex();
    this.pruneSessionUsage();
  }

  applySession(raw) {
    const sanitized = this.sanitizeSession(raw);
    this.sessionUsage = new Map(Object.entries(sanitized));
  }

  rebuildLimitIndex() {
    const index = new Map();
    this.config.limits.forEach((entry) => {
      const existing = index.get(entry.host) || {};
      existing[entry.type] = {
        host: entry.host,
        type: entry.type,
        minutes: entry.minutes,
        seconds: entry.minutes * 60
      };
      index.set(entry.host, existing);
    });
    this.limitIndex = index;
  }

  pruneSessionUsage() {
    let removed = false;
    for (const key of Array.from(this.sessionUsage.keys())) {
      const rules = this.limitIndex.get(key);
      if (!rules || !rules.session) {
        this.sessionUsage.delete(key);
        removed = true;
      }
    }
    if (removed) {
      void this.persistSessionUsage();
    }
  }

  async load() {
    const [configWrap, sessionWrap] = await Promise.all([
      chrome.storage.local.get(PARENT_MODE_CONFIG_KEY),
      chrome.storage.local.get(PARENT_MODE_SESSION_KEY)
    ]);
    this.applyConfig(configWrap[PARENT_MODE_CONFIG_KEY]);
    this.applySession(sessionWrap[PARENT_MODE_SESSION_KEY]);
  }

  async persistConfig() {
    await chrome.storage.local.set({
      [PARENT_MODE_CONFIG_KEY]: {
        ...this.config,
        blocked: [...this.config.blocked],
        limits: [...this.config.limits]
      }
    });
  }

  async persistSessionUsage() {
    if (this.sessionPersistTimer) {
      clearTimeout(this.sessionPersistTimer);
      this.sessionPersistTimer = null;
    }
    const payload = {};
    for (const [host, entry] of this.sessionUsage.entries()) {
      payload[host] = {
        seconds: Math.max(0, Math.round(entry.seconds || 0)),
        lastActiveAt: Number(entry.lastActiveAt) || 0
      };
    }
    await chrome.storage.local.set({ [PARENT_MODE_SESSION_KEY]: payload });
  }

  scheduleSessionPersist() {
    if (this.sessionPersistTimer) return;
    this.sessionPersistTimer = setTimeout(() => {
      void this.persistSessionUsage().catch((error) => console.warn("Parent session persist failed", error));
    }, 750);
  }

  isEnabled() {
    return Boolean(this.config.enabled);
  }

  async setEnabled(enabled) {
    const next = Boolean(enabled);
    if (next === this.config.enabled) return;
    this.config.enabled = next;
    await this.persistConfig();
  }

  async addBlockedHost(host) {
    const normalized = this.normalizeHostKey(host);
    if (!normalized) {
      throw new Error("Enter a valid site");
    }
    if (!this.config.blocked.includes(normalized)) {
      this.config.blocked.push(normalized);
      this.blockedSet.add(normalized);
      await this.persistConfig();
    }
  }

  async removeBlockedHost(host) {
    const normalized = this.normalizeHostKey(host);
    if (!normalized) return;
    const next = this.config.blocked.filter((entry) => entry !== normalized);
    if (next.length !== this.config.blocked.length) {
      this.config.blocked = next;
      this.blockedSet = new Set(next);
      await this.persistConfig();
    }
  }

  async addLimit({ host, minutes, type }) {
    const normalized = this.normalizeHostKey(host);
    const mkMinutes = Math.max(1, Math.round(Number(minutes) || 0));
    const limitType = type === "session" ? "session" : "daily";
    if (!normalized) {
      throw new Error("Enter a valid site");
    }
    if (!Number.isFinite(mkMinutes) || mkMinutes <= 0) {
      throw new Error("Enter minutes greater than 0");
    }
    let updated = false;
    this.config.limits = this.config.limits.map((entry) => {
      if (entry.host === normalized && entry.type === limitType) {
        updated = true;
        return { host: normalized, minutes: mkMinutes, type: limitType };
      }
      return entry;
    });
    if (!updated) {
      this.config.limits.push({ host: normalized, minutes: mkMinutes, type: limitType });
    }
    this.rebuildLimitIndex();
    await this.persistConfig();
  }

  async removeLimit({ host, type }) {
    const normalized = this.normalizeHostKey(host);
    const limitType = type === "session" ? "session" : "daily";
    if (!normalized) return;
    const next = this.config.limits.filter(
      (entry) => !(entry.host === normalized && entry.type === limitType)
    );
    if (next.length !== this.config.limits.length) {
      this.config.limits = next;
      this.rebuildLimitIndex();
      await this.persistConfig();
    }
  }

  invalidateDailyCache() {
    this.dailyCache = { dayKey: null, totals: new Map() };
  }

  resetDailyCacheForDay(dayKey) {
    this.dailyCache = { dayKey, totals: new Map() };
  }

  async ensureDailyCache(dayKey) {
    if (this.dailyCache.dayKey === dayKey) return;
    const { dailyTimeLog = {} } = await chrome.storage.local.get("dailyTimeLog");
    const dayLog = dailyTimeLog?.[dayKey] || {};
    const totals = new Map();
    Object.entries(dayLog).forEach(([host, payload]) => {
      const normalized = this.normalizeHostKey(host);
      const seconds = Math.max(0, Math.round(payload?.seconds || 0));
      if (!normalized || seconds <= 0) return;
      totals.set(normalized, (totals.get(normalized) || 0) + seconds);
    });
    this.dailyCache = { dayKey, totals };
  }

  registerDailyIncrement(dayKey, host, deltaSeconds) {
    if (!this.dailyCache.dayKey || this.dailyCache.dayKey !== dayKey) return;
    const normalized = this.normalizeHostKey(host);
    if (!normalized) return;
    this.dailyCache.totals.set(normalized, (this.dailyCache.totals.get(normalized) || 0) + deltaSeconds);
  }

  handleDayRollover(newDayKey) {
    this.resetDailyCacheForDay(newDayKey);
    this.clearCompletedSessions();
  }

  clearCompletedSessions() {
    if (this.sessionUsage.size === 0) return;
    this.sessionUsage.clear();
    void this.persistSessionUsage();
  }

  matchBlocked(normalizedHost) {
    if (!normalizedHost) return null;
    if (this.blockedSet.has(normalizedHost)) return normalizedHost;
    let longest = null;
    for (const entry of this.blockedSet) {
      if (normalizedHost === entry || normalizedHost.endsWith(`.${entry}`)) {
        if (!longest || entry.length > longest.length) {
          longest = entry;
        }
      }
    }
    return longest;
  }

  matchLimits(normalizedHost) {
    if (!normalizedHost || this.limitIndex.size === 0) return null;
    if (this.limitIndex.has(normalizedHost)) {
      return { key: normalizedHost, rules: this.limitIndex.get(normalizedHost) };
    }
    let matchKey = null;
    for (const [key] of this.limitIndex.entries()) {
      if (normalizedHost === key || normalizedHost.endsWith(`.${key}`)) {
        if (!matchKey || key.length > matchKey.length) {
          matchKey = key;
        }
      }
    }
    if (!matchKey) return null;
    return { key: matchKey, rules: this.limitIndex.get(matchKey) };
  }

  pruneStaleSessions(now = Date.now()) {
    let removed = false;
    for (const [key, entry] of this.sessionUsage.entries()) {
      const lastActive = Number(entry.lastActiveAt) || 0;
      if (!lastActive) continue;
      if (now - lastActive > SESSION_RESET_MS) {
        this.sessionUsage.delete(key);
        removed = true;
      }
    }
    if (removed) {
      void this.persistSessionUsage();
    }
  }

  touchSessionUsage(host, deltaSeconds, now = Date.now()) {
    if (!this.isEnabled() || deltaSeconds <= 0) return;
    const normalized = this.normalizeHostKey(host);
    if (!normalized) return;
    const match = this.matchLimits(normalized);
    if (!match || !match.rules.session) return;
    const key = match.key;
    const entry = this.sessionUsage.get(key) || { seconds: 0, lastActiveAt: 0 };
    entry.seconds = Math.max(0, Number(entry.seconds) || 0) + deltaSeconds;
    entry.lastActiveAt = now;
    this.sessionUsage.set(key, entry);
    this.scheduleSessionPersist();
  }

  getSessionSnapshot(key, now = Date.now()) {
    if (!key) return null;
    const entry = this.sessionUsage.get(key);
    if (!entry) return null;
    const lastActive = Number(entry.lastActiveAt) || 0;
    if (lastActive && now - lastActive > SESSION_RESET_MS) {
      this.sessionUsage.delete(key);
      this.scheduleSessionPersist();
      return null;
    }
    return {
      seconds: Math.max(0, Number(entry.seconds) || 0),
      lastActiveAt
    };
  }

  async evaluateHostAccess(host, dayKey, now = Date.now()) {
    if (!this.isEnabled()) return { enforced: false };
    const normalized = this.normalizeHostKey(host);
    if (!normalized) return { enforced: false };

    const blockedKey = this.matchBlocked(normalized);
    if (blockedKey) {
      return {
        enforced: true,
        action: "block",
        reason: "blocked",
        ruleHost: blockedKey
      };
    }

    const match = this.matchLimits(normalized);
    if (!match) return { enforced: false };

    const { key, rules } = match;
    await this.ensureDailyCache(dayKey);

    if (rules.daily) {
      const used = this.computeDailyUsageForRule(key);
      if (used >= rules.daily.seconds) {
        return {
          enforced: true,
          action: "limit",
          reason: "daily",
          ruleHost: key,
          limit: rules.daily,
          usedSeconds: used
        };
      }
    }

    if (rules.session) {
      const snapshot = this.getSessionSnapshot(key, now);
      const used = snapshot?.seconds || 0;
      if (used >= rules.session.seconds) {
        return {
          enforced: true,
          action: "limit",
          reason: "session",
          ruleHost: key,
          limit: rules.session,
          usedSeconds: used
        };
      }
    }

    return {
      enforced: false,
      ruleHost: key,
      rules
    };
  }

  computeDailyUsageForRule(ruleKey) {
    if (!ruleKey || !this.dailyCache.totals) return 0;
    let total = 0;
    for (const [hostKey, seconds] of this.dailyCache.totals.entries()) {
      if (hostKey === ruleKey || hostKey.endsWith(`.${ruleKey}`) || ruleKey.endsWith(`.${hostKey}`)) {
        total += seconds;
      }
    }
    return Math.max(0, Math.round(total));
  }

  async buildSnapshot(dayKey, now = Date.now()) {
    await this.ensureDailyCache(dayKey);
    this.pruneStaleSessions(now);

    const blocked = this.config.blocked.map((host) => ({
      host,
      active: this.isEnabled()
    }));

    const limits = this.config.limits.map((entry) => {
      const key = entry.host;
      const ruleBag = this.limitIndex.get(key) || {};
      let usedSeconds = 0;
      if (entry.type === "daily") {
        usedSeconds = this.computeDailyUsageForRule(key);
      } else if (entry.type === "session") {
        const snapshot = this.getSessionSnapshot(key, now);
        usedSeconds = snapshot?.seconds || 0;
      }
      const limitSeconds = entry.minutes * 60;
      const remainingSeconds = Math.max(0, limitSeconds - usedSeconds);
      const exhausted = usedSeconds >= limitSeconds;
      return {
        host: entry.host,
        type: entry.type,
        minutes: entry.minutes,
        usedSeconds,
        remainingSeconds,
        exhausted,
        hasDaily: Boolean(ruleBag.daily),
        hasSession: Boolean(ruleBag.session)
      };
    });

    return {
      enabled: this.isEnabled(),
      blocked,
      limits,
      notify: Boolean(this.config.notify),
      contactNumber: this.config.contactNumber || ""
    };
  }

  getNotificationSettings() {
    return {
      notify: Boolean(this.config.notify),
      contactNumber: this.config.contactNumber || ""
    };
  }

  async setNotificationSettings({ notify, contactNumber }) {
    const nextNotify = Boolean(notify);
    const nextContact = this.normalizePhone(contactNumber || "");
    if (this.config.notify === nextNotify && this.config.contactNumber === nextContact) return;
    this.config.notify = nextNotify;
    this.config.contactNumber = nextContact;
    await this.persistConfig();
  }
}
