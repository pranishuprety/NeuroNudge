# 🧠 NeuroNudge  
### Your intelligent focus and digital wellbeing companion  

NeuroNudge is a browser extension built at **Hack Princeton Fall 2025** that helps people find their rhythm in a noisy digital world. It learns how you work, type, and browse, then helps you stay focused and balanced. Instead of forcing you to block or quit, it learns your patterns and gently guides you back when attention drifts.  

It is part focus tracker, part mental energy coach, and part wellbeing assistant.  
When you start overworking, it reminds you to pause. When you begin to scroll endlessly, it helps you reset. When you are in deep flow, it stays quiet and lets you stay there.  

---

## 🌍 Why NeuroNudge exists  

Every one of us has opened a “quick tab” that turned into 30 minutes. We all know what it feels like to lose hours on YouTube, Twitter, or Discord while a project sits waiting. We built NeuroNudge to make those moments visible and manageable.  

It is not a blocker or a productivity punishment tool. It is more like a mirror that reflects how your attention moves and helps you stay in control.  

---

## ✨ Key Features  

### 🕹️ Real-Time Awareness  
NeuroNudge observes your browsing rhythm in real time.  
It tracks your **tab switches**, **typing streaks**, and **idle moments** to map how focus shifts during your work session. When it detects drift, it sends a gentle reminder, like:  
> “You have been hopping tabs for a while. Want to return to your main task?”  

### 📊 Daily Flow Dashboard  
Every day, NeuroNudge builds a picture of your work rhythm:  
- Time spent on each site, grouped by focus type  
- Productive, neutral, and distracting minutes  
- Average typing speed and focus streaks  
- Time since your last proper break  

Example:  
> “3 hours on coding tasks, 45 minutes on social media, 1 hour of focused typing with a 15-minute break at ideal intervals.”  

### 🧭 Predictive Focus Model  
NeuroNudge learns from your behavior and begins to **predict drift** before it happens. Using agent-based modeling inspired by **Amazon Nova ACT**, it estimates when your focus energy is likely to drop and recommends a short reset to preserve flow.  

### 🧒 Family and Classroom Mode  
Built with education in mind, this feature lets parents or teachers set healthy screen boundaries.  
- Time limits for specific websites  
- Site categories like “Study,” “Entertainment,” or “Restricted”  
- Optional reports that show daily balance rather than punishment logs  

Example:  
> “Your child spent 2 hours studying and 45 minutes watching videos. Perfect balance achieved.”  

### 🧠 Mindful Nudges  
Instead of blocking access, NeuroNudge uses calm, mindful reminders to realign focus. Each nudge is short and personal, not robotic. Some examples:  
> “You’ve been working for a while. Maybe it’s time for a stretch.”  
> “You switched tabs 8 times in 3 minutes. Want to finish this one thing first?”  
> “Your typing pace slowed down. Maybe you need a small break or a sip of water.”  

### 💾 Local-Only Privacy  
Everything runs locally. No data is sent to servers, no analytics, no tracking.  
All information stays inside your browser storage so your digital habits remain private.  

### 🧩 Custom Rules and Settings  
- Add your own **productivity labels** for websites  
- Set **daily goals** or focus quotas  
- Create **break reminders** that adapt to your schedule  
- Toggle **family controls** for shared or school devices  

### 🧘 Built-in Wellbeing Tools  
NeuroNudge helps users not just work better but feel better.  
- Built-in breathing and micro-reset cues  
- Focus playlists and mindfulness quotes  
- Optional integration with break timers or AI routines through Amazon Nova  

---

## ⚙️ Architecture Overview  

NeuroNudge runs on a modular architecture built entirely with **Chrome Manifest V3**.  

**Core Components:**  
- **background.js** → runs the focus state engine, logs activity, predicts drift  
- **content.js** → listens to tab activity, typing rhythm, and idle signals  
- **popup.html / popup.js** → shows real-time stats and recent nudges  
- **dashboard.html** → displays analytics and trend summaries  
- **options.html** → parental controls, break timers, productivity categories  
- **storage.js** → handles local data management with privacy-first design  

All logic runs on-device using asynchronous state tracking through `chrome.storage`.  

---

## 🧱 Tech Stack  

| Component | Technology Used |
|------------|----------------|
| Frontend | HTML5, CSS3, JavaScript |
| Browser API | Chrome Manifest V3 |
| Storage | chrome.storage.local |
| Modeling | Agent-based behavioral learning (Nova ACT-inspired) |
| UI Library | Custom lightweight CSS components |
| Notifications | Chrome Alarms + Event-driven prompts |

---

## 🚀 How to Install  

1. Clone the repository  
```bash
git clone https://github.com/pranishuprety/NeuroNudge.git
cd NeuroNudge
