const params = new URLSearchParams(window.location.search || "");
const reason = params.get("reason") === "banned" ? "banned" : "limit";
const host = params.get("host") || "";
const limitMinutesRaw = Number.parseInt(params.get("limitMinutes") || "", 10);
const limitMinutes = Number.isFinite(limitMinutesRaw) && limitMinutesRaw > 0 ? limitMinutesRaw : null;
const limitKind = params.get("limitKind") || null;

const headingEl = document.getElementById("heading");
const ledeEl = document.getElementById("lede");
const quoteTextEl = document.getElementById("quoteText");
const quoteSourceEl = document.getElementById("quoteSource");
const newQuoteBtn = document.getElementById("newQuote");
const settingsBtn = document.getElementById("openSettings");
const resumeBtn = document.getElementById("resumeWork");

const LOCAL_QUOTES = [
  { content: "The best time to start was yesterday. The next best time is now.", author: "Unknown" },
  { content: "Discipline is choosing what you want most over what you want now.", author: "Craig Groeschel" },
  { content: "Focus is a matter of deciding what things you're not going to do.", author: "John Carmack" },
  { content: "What you do every day matters more than what you do once in a while.", author: "Gretchen Rubin" },
  { content: "Small consistent steps beat occasional bursts of effort.", author: "Unknown" }
];

const AUTO_REFRESH_MS = 45000;
let autoRefreshTimer = null;

function formatHostLabel(input) {
  if (!input) return "";
  return input.replace(/^https?:\/\//i, "");
}

function describeLimit() {
  if (reason === "banned") {
    if (host) return `${formatHostLabel(host)} is on your banned list.`;
    return "This site is on your banned list.";
  }
  if (limitMinutes && limitKind === "site" && host) {
    return `${formatHostLabel(host)} has reached its ${limitMinutes} minute limit.`;
  }
  if (limitMinutes && host) {
    return `You spent ${limitMinutes} minutes on ${formatHostLabel(host)}. Limit reached.`;
  }
  if (limitMinutes) {
    return `You have reached your ${limitMinutes} minute distracting limit.`;
  }
  if (host) {
    return `Your focus limit for ${formatHostLabel(host)} just kicked in.`;
  }
  return "A focus limit just activated.";
}

function applyCopy() {
  if (reason === "banned") {
    headingEl.textContent = "Choose the Better Path";
    ledeEl.textContent = `${describeLimit()} Let this quote refocus your energy.`;
    settingsBtn.hidden = false;
  } else {
    headingEl.textContent = "Time's Up for This Detour";
    ledeEl.textContent = `${describeLimit()} Take a breath, soak in something uplifting, then jump back into your priorities.`;
    settingsBtn.hidden = false;
  }
}

function scheduleAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = window.setInterval(() => {
    void fetchQuote();
  }, AUTO_REFRESH_MS);
}

function pickLocalQuote() {
  if (!LOCAL_QUOTES.length) {
    return { content: "Take a mindful pause. Your focus is worth protecting.", author: "" };
  }
  return LOCAL_QUOTES[Math.floor(Math.random() * LOCAL_QUOTES.length)];
}

async function fetchQuote(userInitiated = false) {
  if (newQuoteBtn) newQuoteBtn.disabled = true;
  const fallback = pickLocalQuote();
  quoteTextEl.textContent = `“${fallback.content}”`;
  quoteSourceEl.textContent = fallback.author ? `— ${fallback.author}` : "";
  try {
    const result = await chrome.runtime.sendMessage({ type: "quotes:fetchRandom" });
    if (!result?.success) {
      throw new Error(result?.error || "Unknown error");
    }
    const payload = result.quote;
    console.debug("[FocusGuard] Quote payload", payload);
    const content =
      typeof payload?.content === "string" && payload.content.trim().length > 0
        ? payload.content.trim()
        : null;
    const author =
      typeof payload?.author === "string" && payload.author.trim().length > 0
        ? payload.author.trim()
        : null;
    if (!content) {
      throw new Error("No quote content returned");
    }
    quoteTextEl.textContent = `“${content}”`;
    quoteSourceEl.textContent = author ? `— ${author}` : "";
  } catch (error) {
    console.warn("Quote fetch failed", error);
    quoteSourceEl.textContent = `${fallback.author ? `— ${fallback.author} ` : ""}(offline quote)`;
  } finally {
    if (newQuoteBtn) newQuoteBtn.disabled = false;
    if (userInitiated) scheduleAutoRefresh();
  }
}

function initButtons() {
  if (newQuoteBtn) {
    newQuoteBtn.addEventListener("click", () => {
      if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
      }
      void fetchQuote(true);
    });
  }

  if (settingsBtn) {
    settingsBtn.addEventListener("click", () => {
      if (chrome?.runtime?.openOptionsPage) {
        chrome.runtime.openOptionsPage();
      } else {
        window.open(chrome.runtime.getURL("options.html"), "_blank", "noopener");
      }
    });
  }

  if (resumeBtn) {
    resumeBtn.addEventListener("click", () => {
      window.close();
    });
  }
}

applyCopy();
initButtons();
scheduleAutoRefresh();
void fetchQuote();
