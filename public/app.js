// Ask Adam — frontend logic (v2): auth gate + server-backed data.
(function () {
  "use strict";

  // Only onboarding "seen" flag stays local; everything else is server-side.
  const ONBOARD_KEY = "askadam.seenOnboarding.v2";
  let me = null; // current user
  let freeLimit = 5;

  // ---------- Router ----------
  const screens = document.querySelectorAll(".screen");
  function show(name) {
    screens.forEach((s) => s.classList.toggle("active", s.dataset.screen === name));
    window.scrollTo(0, 0);
    if (name === "home") renderHome();
    if (name === "growth") renderGrowth();
    if (name === "wisdom") renderWisdom();
    if (name === "situations") renderSituations();
    if (name === "chat") loadChat();
    if (name === "cycle") loadCycle();
    if (name === "settings") renderSettings();
  }

  document.body.addEventListener("click", (e) => {
    const el = e.target.closest("[data-goto]");
    if (el) show(el.dataset.goto);
  });

  async function api(path, opts) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      ...opts,
    });
    return res;
  }

  // ---------- Boot ----------
  boot();
  async function boot() {
    // Fetch which login options are available.
    try {
      const cfg = await (await api("/api/config")).json();
      freeLimit = cfg.freeLimit || 5;
      const p = cfg.providers || {};
      document.getElementById("btnGoogle").classList.toggle("hidden", !p.google);
      document.getElementById("btnFacebook").classList.toggle("hidden", !p.facebook);
      document.getElementById("devLogin").classList.toggle("hidden", !p.devLogin);
    } catch {}

    // Surface OAuth failures passed back as ?authError=
    const params = new URLSearchParams(location.search);
    if (params.get("authError")) {
      const box = document.getElementById("authError");
      box.textContent = "That login didn't complete. Please try again.";
      box.classList.remove("hidden");
      history.replaceState({}, "", location.pathname);
    }

    // Check session.
    const r = await api("/api/me");
    if (r.ok) {
      const data = await r.json();
      me = data.user;
      freeLimit = data.freeLimit || freeLimit;
      afterLogin();
    } else {
      setTimeout(() => {
        if (localStorage.getItem(ONBOARD_KEY)) show("login");
        else show("onboarding");
      }, 1600);
    }
  }

  function afterLogin() {
    if (!localStorage.getItem(ONBOARD_KEY)) {
      show("onboarding");
    } else {
      setTimeout(() => show("home"), 900);
    }
  }

  // ---------- Onboarding ----------
  let slide = 0;
  const nextBtn = document.getElementById("onboardNext");
  if (nextBtn) {
    nextBtn.addEventListener("click", () => {
      const slides = document.querySelectorAll(".onboard-slide");
      const dots = document.querySelectorAll(".onboard .dot");
      slide++;
      if (slide >= slides.length) {
        localStorage.setItem(ONBOARD_KEY, "1");
        slide = 0;
        slides.forEach((s, i) => s.classList.toggle("hidden", i !== 0));
        dots.forEach((d, i) => d.classList.toggle("active", i === 0));
        nextBtn.textContent = "Next";
        show(me ? "home" : "login");
        return;
      }
      slides.forEach((s, i) => s.classList.toggle("hidden", i !== slide));
      dots.forEach((d, i) => d.classList.toggle("active", i === slide));
      nextBtn.textContent = slide === slides.length - 1 ? "Enter Ask Adam" : "Next";
    });
  }

  // ---------- Dev login ----------
  const devBtn = document.getElementById("devLoginBtn");
  if (devBtn) {
    devBtn.addEventListener("click", async () => {
      const email = document.getElementById("devEmail").value.trim();
      const box = document.getElementById("authError");
      const r = await api("/auth/dev", { method: "POST", body: JSON.stringify({ email }) });
      if (r.ok) {
        location.reload();
      } else {
        const d = await r.json().catch(() => ({}));
        box.textContent = d.error || "Login failed.";
        box.classList.remove("hidden");
      }
    });
  }

  // ---------- Home ----------
  function greetingText() {
    const h = new Date().getHours();
    const part = h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
    const name = me?.name ? `, ${me.name.split(" ")[0]}` : "";
    return `Good ${part}${name}`;
  }
  function renderHome() {
    document.getElementById("greeting").textContent = greetingText();
  }

  // ---------- Chat ----------
  const chatLog = document.getElementById("chatLog");
  const chatForm = document.getElementById("chatForm");
  const chatText = document.getElementById("chatText");
  const usagePill = document.getElementById("usagePill");
  let chatLoaded = false;

  function addBubble(text, cls) {
    const div = document.createElement("div");
    div.className = "bubble " + cls;
    div.textContent = text;
    chatLog.appendChild(div);
    chatLog.scrollTop = chatLog.scrollHeight;
    return div;
  }
  function addTyping() {
    const div = document.createElement("div");
    div.className = "bubble adam";
    div.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
    chatLog.appendChild(div);
    chatLog.scrollTop = chatLog.scrollHeight;
    return div;
  }
  function setUsage(remaining) {
    if (remaining === null || remaining === undefined) usagePill.textContent = "Premium";
    else usagePill.textContent = `${remaining}/${freeLimit} free`;
  }

  async function loadChat() {
    if (chatLoaded) return;
    chatLoaded = true;
    chatLog.innerHTML = "";
    try {
      const d = await (await api("/api/history")).json();
      if (d.messages?.length) {
        d.messages.forEach((m) => addBubble(m.content, m.role === "user" ? "user" : "adam"));
      } else {
        addBubble("Hey, I'm Adam. Ask me anything about relationships, communication, emotions, or intimacy. What's on your mind?", "adam");
      }
    } catch {
      addBubble("Hey, I'm Adam. What's on your mind?", "adam");
    }
    try {
      const me2 = await (await api("/api/me")).json();
      setUsage(me2.remaining);
    } catch {}
  }

  chatForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = chatText.value.trim();
    if (!text) return;
    chatText.value = "";
    addBubble(text, "user");
    const typing = addTyping();
    try {
      const r = await api("/api/chat", { method: "POST", body: JSON.stringify({ message: text }) });
      const d = await r.json();
      typing.remove();
      if (r.status === 429 || d.limitReached) {
        addBubble(d.message || "You've reached today's free limit.", "error");
        const up = addBubble("Tap to see Premium →", "error");
        up.style.cursor = "pointer";
        up.addEventListener("click", () => show("subscription"));
        setUsage(0);
        return;
      }
      if (d.error) { addBubble(d.error, "error"); return; }
      addBubble(d.reply, "adam");
      setUsage(d.remaining);
    } catch {
      typing.remove();
      addBubble("Couldn't reach Adam. Check your connection and try again.", "error");
    }
  });

  // ---------- Cycle Guide ----------
  const PHASES = {};
  api("/api/cycle-advice").then((r) => r.json()).then((d) => Object.assign(PHASES, d.phases || {})).catch(() => {});
  let cycleLoaded = false;

  async function loadCycle() {
    if (cycleLoaded) return;
    cycleLoaded = true;
    try {
      const d = await (await api("/api/cycle")).json();
      if (d.cycle) {
        if (d.cycle.lastPeriod) document.getElementById("lastPeriod").value = d.cycle.lastPeriod;
        if (d.cycle.cycleLength) document.getElementById("cycleLen").value = d.cycle.cycleLength;
        computeAndRender(); // show saved result immediately
      }
    } catch {}
  }

  document.getElementById("calcCycle").addEventListener("click", async () => {
    const dateVal = document.getElementById("lastPeriod").value;
    const len = parseInt(document.getElementById("cycleLen").value, 10) || 28;
    if (!dateVal) {
      const box = document.getElementById("cycleResult");
      box.classList.remove("hidden");
      box.innerHTML = '<p class="fineprint">Please choose the last period start date.</p>';
      return;
    }
    computeAndRender();
    // Persist settings (also counts as advice read).
    api("/api/cycle", { method: "POST", body: JSON.stringify({ lastPeriod: dateVal, cycleLength: len }) }).catch(() => {});
  });

  function computeAndRender() {
    const dateVal = document.getElementById("lastPeriod").value;
    const len = parseInt(document.getElementById("cycleLen").value, 10) || 28;
    const box = document.getElementById("cycleResult");
    const res = computePhase(dateVal, len);
    if (!res) {
      box.classList.remove("hidden");
      box.innerHTML = '<p class="fineprint">That date looks like it\'s in the future. Please check it.</p>';
      return;
    }
    const info = PHASES[res.phase] || { range: "", summary: "", advice: [] };
    box.classList.remove("hidden");
    box.innerHTML =
      `<div class="phase-card">
        <div class="phase-name">${res.phase} Phase</div>
        <div class="phase-meta">Cycle day ${res.dayOfCycle} of ${res.cycleLength} · ${info.range}</div>
        <p>${info.summary}</p>
        <div class="advice-title">How to support her</div>
        <ul class="bullets">${(info.advice || []).map((a) => `<li>${a}</li>`).join("")}</ul>
      </div>`;
  }

  function computePhase(lastPeriodISO, cycleLength) {
    const MS = 86400000;
    const last = new Date(lastPeriodISO); last.setHours(0, 0, 0, 0);
    const now = new Date(); now.setHours(0, 0, 0, 0);
    const len = Math.max(20, Math.min(45, cycleLength || 28));
    const diff = Math.floor((now - last) / MS);
    if (isNaN(diff) || diff < 0) return null;
    const dayOfCycle = (diff % len) + 1;
    const ov = len - 14;
    let phase;
    if (dayOfCycle <= 5) phase = "Menstrual";
    else if (dayOfCycle >= ov && dayOfCycle <= ov + 1) phase = "Ovulation";
    else if (dayOfCycle < ov) phase = "Follicular";
    else phase = "Luteal";
    return { dayOfCycle, phase, cycleLength: len };
  }

  // ---------- Real Situations ----------
  let situations = [];
  function renderSituations() {
    const list = document.getElementById("situationList");
    const adviceBox = document.getElementById("situationAdvice");
    adviceBox.classList.add("hidden");
    if (situations.length) return;
    api("/api/situations").then((r) => r.json()).then((d) => {
      situations = d.items || [];
      list.innerHTML = "";
      situations.forEach((s) => {
        const b = document.createElement("button");
        b.className = "situation-btn";
        b.textContent = s.title;
        b.addEventListener("click", () => {
          adviceBox.classList.remove("hidden");
          adviceBox.innerHTML = `<div class="advice-card"><h3>${s.title}</h3><p>${s.advice}</p></div>`;
          adviceBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
          api("/api/track-advice", { method: "POST" }).catch(() => {});
        });
        list.appendChild(b);
      });
    }).catch(() => { list.innerHTML = '<p class="fineprint">Couldn\'t load situations.</p>'; });
  }

  // ---------- Daily Wisdom ----------
  let wisdom = [];
  let wisdomIdx = 0;
  let savedWisdom = [];
  const wisdomCard = document.getElementById("wisdomCard");

  async function renderWisdom() {
    if (!wisdom.length) {
      try {
        const d = await (await api("/api/wisdom")).json();
        wisdom = d.items || [];
        const dayNum = Math.floor(Date.now() / 86400000);
        wisdomIdx = wisdom.length ? dayNum % wisdom.length : 0;
      } catch { wisdomCard.textContent = "Couldn't load wisdom."; }
    }
    paintWisdom();
    await loadSaved();
  }
  function paintWisdom() {
    wisdomCard.textContent = wisdom.length ? "“" + wisdom[wisdomIdx] + "”" : "…";
  }
  document.getElementById("nextWisdom").addEventListener("click", () => {
    if (!wisdom.length) return;
    wisdomIdx = (wisdomIdx + 1) % wisdom.length;
    paintWisdom();
    api("/api/track-advice", { method: "POST" }).catch(() => {});
  });
  document.getElementById("saveWisdom").addEventListener("click", async () => {
    const w = wisdom[wisdomIdx];
    if (!w) return;
    await api("/api/saved-wisdom", { method: "POST", body: JSON.stringify({ text: w }) });
    await loadSaved();
  });
  async function loadSaved() {
    try {
      const d = await (await api("/api/saved-wisdom")).json();
      savedWisdom = d.items || [];
    } catch { savedWisdom = []; }
    renderSaved();
  }
  function renderSaved() {
    const box = document.getElementById("savedWisdom");
    box.innerHTML = savedWisdom.map((w) => `<div class="saved-item">“${w}”</div>`).join("");
  }

  // ---------- Growth ----------
  async function renderGrowth() {
    let s = { questionsAsked: 0, adviceRead: 0, daysActive: 0 };
    try { s = await (await api("/api/stats")).json(); } catch {}
    document.getElementById("statQuestions").textContent = s.questionsAsked;
    document.getElementById("statAdvice").textContent = s.adviceRead;
    document.getElementById("statDays").textContent = s.daysActive;
    const score = Math.min(100, s.questionsAsked * 3 + s.adviceRead * 2 + s.daysActive * 4);
    document.getElementById("awarenessFill").style.width = score + "%";
    document.getElementById("awarenessPct").textContent = score + "%";
  }

  // ---------- Settings ----------
  let nameSaveTimer = null;
  function renderSettings() {
    document.getElementById("userName").value = me?.name || "";
  }
  document.getElementById("userName").addEventListener("input", (e) => {
    const name = e.target.value.trim();
    if (me) me.name = name;
    clearTimeout(nameSaveTimer);
    nameSaveTimer = setTimeout(() => {
      api("/api/me", { method: "PATCH", body: JSON.stringify({ name }) }).catch(() => {});
    }, 500);
  });
  document.getElementById("logoutBtn").addEventListener("click", async () => {
    await api("/auth/logout", { method: "POST" });
    location.reload();
  });
  document.getElementById("deleteBtn").addEventListener("click", async () => {
    if (!confirm("Permanently delete your account and all your data? This cannot be undone.")) return;
    await api("/api/me", { method: "DELETE" });
    location.reload();
  });
  const upgrade = document.getElementById("upgradeBtn");
  if (upgrade) upgrade.addEventListener("click", () => alert("Payments aren't enabled yet in this version."));
})();
