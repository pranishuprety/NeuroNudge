// aiNudge.js
// Provides optional AI-crafted nudges. Uses OpenAI or Gemini when configured,
// otherwise falls back to curated, privacy-safe local messages influenced by mood.

const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

const STATE_BASE_TEXT = {
  steady: "Good rhythm, keep it up!",
  drift: "Seems your focus drifted, ready to sprint?",
  overload: "You’ve worked hard — time for a short break."
};

const MOOD_TONE_PREFIX = {
  tired: "Gentle nudge: ",
  distracted: "Friendly reminder: ",
  focused: "Momentum check: "
};

const buildPrompt = (state, mood) =>
  `You are NeuroNudge, a supportive focus coach. The user currently feels "${mood}" and your sensor summary classified them as "${state}". Respond with ONE short empathetic sentence (<120 chars) encouraging healthy focus/break habits. Avoid emojis.`;

export async function getAINudge(state, mood = "neutral") {
  const { aiProvider, aiApiKey, aiModel } = await chrome.storage.local.get([
    "aiProvider",
    "aiApiKey",
    "aiModel"
  ]);

  if (!aiProvider || !aiApiKey) {
    return { message: getFallback(state, mood), source: "local" };
  }

  try {
    const prompt = buildPrompt(state, mood);
    const message =
      aiProvider === "gemini"
        ? await callGemini(aiApiKey, aiModel, prompt)
        : await callOpenAI(aiApiKey, aiModel, prompt);
    if (!message) throw new Error("Empty AI response");
    return { message: message.trim(), source: aiProvider };
  } catch (error) {
    console.warn("AI nudge failed, using fallback", error);
    return { message: getFallback(state, mood), source: "local-fallback" };
  }
}

function getFallback(state, mood) {
  const tonePrefix = MOOD_TONE_PREFIX[mood] || "";
  const base = STATE_BASE_TEXT[state] || STATE_BASE_TEXT.steady;
  return tonePrefix + base;
}

async function callOpenAI(apiKey, model = "gpt-4o-mini", prompt) {
  const response = await fetch(OPENAI_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "You are a concise, caring focus coach." },
        { role: "user", content: prompt }
      ],
      max_tokens: 60,
      temperature: 0.7
    })
  });
  if (!response.ok) throw new Error(`OpenAI error: ${response.status}`);
  const data = await response.json();
  return data.choices?.[0]?.message?.content;
}

async function callGemini(apiKey, model = "gemini-1.5-flash-latest", prompt) {
  const response = await fetch(`${GEMINI_ENDPOINT}/${model}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 60 }
    })
  });
  if (!response.ok) throw new Error(`Gemini error: ${response.status}`);
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text;
}
