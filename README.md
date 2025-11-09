# 🧠 NeuroNudge  
### Your mindful focus companion for the modern web  

Smart productivity and wellbeing extension built at **Hack Princeton Fall 2025**. NeuroNudge learns from your digital rhythm — your typing pace, tab focus, and browsing patterns — to help you stay in flow without forcing it. When distraction creeps in, it senses the drift and gently guides you back, acting like a real-time mental energy thermostat.  

---

## 🌐 Overview  
NeuroNudge is a **Chromium-based browser extension** that brings awareness, balance, and intelligent focus to your online life. It helps professionals prevent burnout, students maintain flow, and parents encourage healthier screen habits for their kids.  

Whether you are coding, studying, or exploring, NeuroNudge adapts to your rhythm — not the other way around.  

---

## ✨ Features  

### 🕹️ Real-Time Focus Engine  
- Detects focus drift from **tab switches, idle streaks, and typing rhythm**.  
- Calculates context-switch costs and identifies when your attention starts to fade.  

### 🧭 Adaptive Nudges  
- Provides **gentle, personalized prompts** when you lose focus.  
- Offers motivation or short resets instead of harsh interruptions.  

### 📊 Dynamic Dashboard  
- Tracks **time spent per site** and classifies activity as productive, distracting, or neutral.  
- Displays a **daily scorecard** with focus streaks, recovery time, and typing pace.  

### 🧒 Digital Wellbeing for Families  
- Adds **parental guardrails** for students and families on school-managed Chromebooks.  
- Allows setting time limits, blocking certain sites, or defining custom “focus hours.”  

### 🔮 Predictive Focus Modeling  
- Uses **agent-based learning** inspired by Amazon Nova ACT to forecast drift before it happens.  
- Suggests preemptive micro-breaks and focus rituals to prevent burnout.  

### 🔐 Privacy by Design  
- No cloud sync. No external databases.  
- All focus data is processed and stored **locally** on the user’s device.  

---

## 🧩 Architecture  

**Core Components:**  
- `background.js` → runs the **state engine** and monitors attention signals.  
- `content.js` → detects typing rhythm and activity state.  
- `popup.html / popup.js` → visualizes real-time stats and nudges.  
- `dashboard.html` → shows extended daily summaries, site classifications, and streak data.  
- `options.html` → manages **custom rules**, **parental settings**, and **time limits**.  

Built with:  
- **Manifest V3**  
- **JavaScript / HTML / CSS**  
- **chrome.storage API** for local persistence  
- **lightweight analytics layer** for focus-state inference  

---

## 🚀 Getting Started  

### 1. Clone the repository  
```bash
git clone https://github.com/pranishuprety/NeuroNudge.git
cd NeuroNudge
