// Ask Adam — frontend logic (v2): auth gate + server-backed data.
(function () {
  "use strict";

  // ---------- Minimal, safe Markdown renderer (ChatGPT-style output) ----------
  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function inlineMd(s) {
    return s
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
      .replace(/\b(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  }
  function renderMarkdown(text) {
    const lines = escapeHtml(String(text || "")).split(/\r?\n/);
    let html = "";
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        const lvl = Math.min(h[1].length + 2, 5);
        html += `<h${lvl}>${inlineMd(h[2])}</h${lvl}>`;
        i++;
        continue;
      }
      if (/^\s*[-*]\s+/.test(line)) {
        html += "<ul>";
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          html += "<li>" + inlineMd(lines[i].replace(/^\s*[-*]\s+/, "")) + "</li>";
          i++;
        }
        html += "</ul>";
        continue;
      }
      if (/^\s*\d+\.\s+/.test(line)) {
        html += "<ol>";
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          html += "<li>" + inlineMd(lines[i].replace(/^\s*\d+\.\s+/, "")) + "</li>";
          i++;
        }
        html += "</ol>";
        continue;
      }
      if (/^\s*$/.test(line)) {
        i++;
        continue;
      }
      const para = [];
      while (
        i < lines.length &&
        !/^\s*$/.test(lines[i]) &&
        !/^\s*[-*]\s+/.test(lines[i]) &&
        !/^\s*\d+\.\s+/.test(lines[i]) &&
        !/^#{1,6}\s+/.test(lines[i])
      ) {
        para.push(inlineMd(lines[i]));
        i++;
      }
      html += "<p>" + para.join("<br>") + "</p>";
    }
    return html;
  }

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
    if (name === "subscription") renderSubscription();
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
    try {
      const cfg = await (await api("/api/config")).json();
      freeLimit = cfg.freeLimit || 5;
    } catch {}
    initBilling();

    // Check session (Auth0-backed).
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

  // ---------- Chat (conversations, voice, ChatGPT-style) ----------
  const chatLog = document.getElementById("chatLog");
  const chatForm = document.getElementById("chatForm");
  const chatText = document.getElementById("chatText");
  const usagePill = document.getElementById("usagePill");
  const chatTitleEl = document.getElementById("chatTitle");
  const convListEl = document.getElementById("convList");
  const drawer = document.getElementById("chatDrawer");
  const drawerOverlay = document.getElementById("drawerOverlay");
  const scrollBottomBtn = document.getElementById("scrollBottomBtn");
  let currentConversationId = null;
  let conversations = [];
  let chatWired = false;
  let chatBusy = false;

  function scrollToBottom() { chatLog.scrollTop = chatLog.scrollHeight; }

  function addBubble(text, cls) {
    const div = document.createElement("div");
    div.className = "bubble " + cls;
    if (cls.indexOf("adam") !== -1) div.innerHTML = renderMarkdown(text);
    else div.textContent = text;
    chatLog.appendChild(div);
    if (cls === "adam") addMsgActions(text);
    scrollToBottom();
    return div;
  }
  function addMsgActions(text) {
    const row = document.createElement("div");
    row.className = "msg-actions";
    const copy = document.createElement("button");
    copy.textContent = "Copy";
    copy.addEventListener("click", () => {
      navigator.clipboard?.writeText(text);
      copy.textContent = "Copied"; setTimeout(() => (copy.textContent = "Copy"), 1500);
    });
    const speak = document.createElement("button");
    speak.textContent = "🔊 Speak";
    speak.addEventListener("click", () => speakText(text, speak));
    row.appendChild(copy); row.appendChild(speak);
    chatLog.appendChild(row);
  }
  function addTyping() {
    const div = document.createElement("div");
    div.className = "bubble adam";
    div.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
    chatLog.appendChild(div);
    scrollToBottom();
    return div;
  }
  function setUsage(remaining) {
    if (remaining === null || remaining === undefined) usagePill.textContent = "Premium";
    else usagePill.textContent = `${remaining}/${freeLimit} free`;
  }

  // ----- Voice output (read aloud) -----
  let speaking = false;
  function speakText(text, btn) {
    if (!("speechSynthesis" in window)) { alert("Voice output isn't supported in this browser."); return; }
    if (speaking) { speechSynthesis.cancel(); speaking = false; if (btn) btn.textContent = "🔊 Speak"; return; }
    const clean = text.replace(/[#*`_>]/g, "").replace(/\n+/g, ". ");
    const u = new SpeechSynthesisUtterance(clean);
    u.rate = 1;
    u.onend = () => { speaking = false; if (btn) btn.textContent = "🔊 Speak"; };
    speaking = true; if (btn) btn.textContent = "⏹ Stop";
    speechSynthesis.speak(u);
  }

  // ----- Voice input (dictation) -----
  let recognizing = false;
  let recog = null;
  function setupMic() {
    const micBtn = document.getElementById("micBtn");
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { micBtn.style.display = "none"; return; }
    recog = new SR();
    recog.lang = "en-US"; recog.interimResults = true; recog.continuous = false;
    recog.onresult = (e) => {
      let t = "";
      for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
      chatText.value = t;
    };
    recog.onend = () => { recognizing = false; micBtn.classList.remove("recording"); };
    recog.onerror = () => { recognizing = false; micBtn.classList.remove("recording"); };
    micBtn.addEventListener("click", () => {
      if (recognizing) { recog.stop(); return; }
      try { recog.start(); recognizing = true; micBtn.classList.add("recording"); } catch {}
    });
  }

  // ----- Conversation drawer -----
  function openDrawer() { drawer.classList.remove("hidden"); drawerOverlay.classList.remove("hidden"); loadConversations(); }
  function closeDrawer() { drawer.classList.add("hidden"); drawerOverlay.classList.add("hidden"); }

  async function loadConversations() {
    try {
      const d = await (await api("/api/conversations")).json();
      conversations = d.conversations || [];
    } catch { conversations = []; }
    renderConvList();
  }
  function renderConvList() {
    convListEl.innerHTML = "";
    if (!conversations.length) {
      convListEl.innerHTML = '<p class="fineprint" style="padding:12px">No chats yet. Start one below.</p>';
      return;
    }
    conversations.forEach((c) => {
      const item = document.createElement("div");
      item.className = "conv-item" + (c.id === currentConversationId ? " active" : "");
      const name = document.createElement("span");
      name.className = "conv-name";
      name.textContent = c.title || "New chat";
      name.addEventListener("click", () => { openConversation(c.id); closeDrawer(); });
      const del = document.createElement("button");
      del.className = "conv-del";
      del.textContent = "🗑";
      del.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        if (!confirm("Delete this chat?")) return;
        await api("/api/conversations/" + c.id, { method: "DELETE" });
        if (c.id === currentConversationId) newChat();
        loadConversations();
      });
      item.appendChild(name); item.appendChild(del);
      convListEl.appendChild(item);
    });
  }

  function greetingBubble() {
    chatLog.innerHTML = "";
    addBubble("Hey, I'm Adam. Ask me anything about relationships, communication, emotions, or intimacy. What's on your mind?", "adam");
  }

  async function openConversation(id) {
    currentConversationId = id;
    chatLog.innerHTML = "";
    try {
      const d = await (await api("/api/conversations/" + id + "/messages")).json();
      if (d.messages?.length) d.messages.forEach((m) => addBubble(m.content, m.role === "user" ? "user" : "adam"));
      else greetingBubble();
    } catch { greetingBubble(); }
    const c = conversations.find((x) => x.id === id);
    chatTitleEl.textContent = c?.title || "Ask Adam";
    scrollToBottom();
  }

  function newChat() {
    currentConversationId = null;
    chatTitleEl.textContent = "Ask Adam";
    greetingBubble();
    closeDrawer();
    chatText.focus();
  }

  async function loadChat() {
    if (!chatWired) {
      chatWired = true;
      setupMic();
      document.getElementById("chatMenuBtn").addEventListener("click", openDrawer);
      document.getElementById("drawerClose").addEventListener("click", closeDrawer);
      drawerOverlay.addEventListener("click", closeDrawer);
      document.getElementById("newChatBtn").addEventListener("click", newChat);
      document.getElementById("drawerNewChat").addEventListener("click", newChat);
      scrollBottomBtn.addEventListener("click", scrollToBottom);
      chatLog.addEventListener("scroll", () => {
        const nearBottom = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 80;
        scrollBottomBtn.classList.toggle("hidden", nearBottom);
      });
    }
    await loadConversations();
    if (conversations.length) await openConversation(conversations[0].id);
    else newChat();
    try {
      const me2 = await (await api("/api/me")).json();
      setUsage(me2.remaining);
    } catch {}
  }

  chatForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = chatText.value.trim();
    if (!text || chatBusy) return;
    chatBusy = true;
    chatText.value = "";
    addBubble(text, "user");
    const typing = addTyping();
    try {
      const r = await api("/api/chat", { method: "POST", body: JSON.stringify({ message: text, conversationId: currentConversationId }) });
      const d = await r.json();
      typing.remove();
      if (r.status === 429 || d.limitReached) {
        addBubble(d.message || "You've reached today's free limit.", "error");
        const up = addBubble("Tap to see Premium →", "error");
        up.style.cursor = "pointer";
        up.addEventListener("click", () => show("subscription"));
        setUsage(0);
        if (d.conversationId) currentConversationId = d.conversationId;
        return;
      }
      if (d.error) { addBubble(d.error, "error"); return; }
      addBubble(d.reply, "adam");
      setUsage(d.remaining);
      const wasNew = !currentConversationId;
      if (d.conversationId) currentConversationId = d.conversationId;
      if (wasNew) {
        await loadConversations();
        const c = conversations.find((x) => x.id === currentConversationId);
        chatTitleEl.textContent = c?.title || "Ask Adam";
      }
    } catch {
      typing.remove();
      addBubble("Couldn't reach Adam. Check your connection and try again.", "error");
    } finally {
      chatBusy = false;
    }
  });

  // ---------- Cycle Guide ----------
  const PHASES = {};
  api("/api/cycle-advice").then((r) => r.json()).then((d) => Object.assign(PHASES, d.phases || {})).catch(() => {});
  let cycleLoaded = false;
  let partnerName = "";

  async function loadCycle() {
    if (cycleLoaded) return;
    cycleLoaded = true;
    try {
      const d = await (await api("/api/partner")).json();
      const p = d.partner;
      if (p) {
        if (p.displayName) {
          document.getElementById("partnerName").value = p.displayName;
          partnerName = p.displayName;
        }
        if (p.cycle?.lastPeriod) document.getElementById("lastPeriod").value = p.cycle.lastPeriod;
        if (p.cycle?.cycleLength) document.getElementById("cycleLen").value = p.cycle.cycleLength;
        if (p.cycle) computeAndRender(); // show saved result immediately
      }
    } catch {}
  }

  document.getElementById("calcCycle").addEventListener("click", async () => {
    const dateVal = document.getElementById("lastPeriod").value;
    const len = parseInt(document.getElementById("cycleLen").value, 10) || 28;
    partnerName = document.getElementById("partnerName").value.trim();
    if (!dateVal) {
      const box = document.getElementById("cycleResult");
      box.classList.remove("hidden");
      box.innerHTML = '<p class="fineprint">Please choose the last period start date.</p>';
      return;
    }
    computeAndRender();
    // Persist the partner name and cycle settings (also counts as advice read).
    api("/api/partner", { method: "POST", body: JSON.stringify({ displayName: partnerName }) }).catch(() => {});
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
        <div class="advice-title">How to support ${partnerName || "her"}</div>
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
          api("/api/event", { method: "POST", body: JSON.stringify({ type: "concern", summary: `Looked up: ${s.title}` }) }).catch(() => {});
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
    loadRelationship();
  }

  async function loadRelationship() {
    const status = document.getElementById("plStatus");
    const unlinkBtn = document.getElementById("plUnlink");
    try {
      const d = await (await api("/api/relationship")).json();
      if (d.relationship) {
        status.textContent = `Linked with ${d.relationship.partnerName || "your partner"}.`;
        unlinkBtn.classList.remove("hidden");
      } else {
        status.textContent = "Not linked with a partner.";
        unlinkBtn.classList.add("hidden");
      }
    } catch {}
  }

  document.getElementById("plInviteBtn").addEventListener("click", async () => {
    const out = document.getElementById("plInviteOut");
    try {
      const d = await (await api("/api/relationship/invite", { method: "POST" })).json();
      out.classList.remove("hidden");
      out.innerHTML = `Share this code with your partner (valid 7 days):<br><span class="code">${d.code}</span>`;
    } catch {
      out.classList.remove("hidden");
      out.textContent = "Couldn't create an invite. Try again.";
    }
  });

  document.getElementById("plAcceptBtn").addEventListener("click", async () => {
    const code = document.getElementById("plCode").value.trim();
    const msg = document.getElementById("plMsg");
    msg.classList.remove("hidden");
    if (!code) { msg.textContent = "Enter an invite code."; return; }
    const r = await api("/api/relationship/accept", { method: "POST", body: JSON.stringify({ code }) });
    const d = await r.json().catch(() => ({}));
    if (r.ok) {
      msg.textContent = "Linked!";
      document.getElementById("plCode").value = "";
      loadRelationship();
    } else {
      msg.textContent = d.error || "Couldn't link with that code.";
    }
  });

  document.getElementById("plUnlink").addEventListener("click", async () => {
    if (!confirm("Unlink from your partner?")) return;
    await api("/api/relationship/unlink", { method: "POST" });
    loadRelationship();
  });
  document.getElementById("userName").addEventListener("input", (e) => {
    const name = e.target.value.trim();
    if (me) me.name = name;
    clearTimeout(nameSaveTimer);
    nameSaveTimer = setTimeout(() => {
      api("/api/me", { method: "PATCH", body: JSON.stringify({ name }) }).catch(() => {});
    }, 500);
  });
  document.getElementById("logoutBtn").addEventListener("click", () => {
    window.location.href = "/logout";
  });
  document.getElementById("deleteBtn").addEventListener("click", async () => {
    if (!confirm("Permanently delete your account and all your data? This cannot be undone.")) return;
    await api("/api/me", { method: "DELETE" });
    window.location.href = "/logout"; // ends the Auth0 session after deletion
  });
  // ---------- Billing (Paddle) ----------
  let billing = null;
  async function initBilling() {
    try {
      billing = await (await api("/api/billing/config")).json();
      const note = document.getElementById("billingNote");
      if (!billing.enabled) {
        if (note) note.textContent = "Payments aren't configured yet.";
        return;
      }
      if (window.Paddle) {
        if (billing.environment === "sandbox") Paddle.Environment.set("sandbox");
        Paddle.Initialize({
          token: billing.clientToken,
          eventCallback: (e) => {
            if (!e) return;
            if (e.name === "checkout.completed") {
              // The webhook flips entitlement server-side; refresh shortly after.
              setTimeout(refreshMe, 2500);
            }
            if (e.name === "checkout.error" || e.name === "checkout.warning") {
              console.error("Paddle checkout event:", e);
              const note = document.getElementById("billingNote");
              const reason = e.error?.detail || e.error?.message || e.detail || (e.data && JSON.stringify(e.data)) || "unknown";
              if (note) note.textContent = "Checkout error: " + reason;
            }
          },
        });
      }
    } catch {}
  }

  function openCheckout(priceId) {
    if (!billing || !billing.enabled || !window.Paddle || !priceId) {
      alert("Payments aren't available right now.");
      return;
    }
    Paddle.Checkout.open({
      items: [{ priceId, quantity: 1 }],
      customer: me?.email ? { email: me.email } : undefined,
      customData: { user_id: String(me?.id || "") },
      settings: { displayMode: "overlay", theme: "dark" },
    });
  }

  async function refreshMe() {
    try {
      const d = await (await api("/api/me")).json();
      if (d.user) me = d.user;
      if (me?.isPremium) {
        setUsage(null);
        alert("You're Premium now — enjoy unlimited access to Adam.");
        show("home");
      }
    } catch {}
  }

  const buyM = document.getElementById("buyMonthly");
  const buyA = document.getElementById("buyAnnual");
  if (buyM) buyM.addEventListener("click", () => openCheckout(billing?.monthlyPriceId));
  if (buyA) buyA.addEventListener("click", () => openCheckout(billing?.annualPriceId));

  async function renderSubscription() {
    const statusCard = document.getElementById("subStatusCard");
    const upsell = document.getElementById("subUpsell");
    try {
      const d = await (await api("/api/billing/status")).json();
      if (d.premium && d.status && d.status !== "inactive") {
        statusCard.classList.remove("hidden");
        upsell.classList.add("hidden");
        const badge = document.getElementById("subBadge");
        badge.textContent = d.status === "trialing" ? "Trial" : d.status.charAt(0).toUpperCase() + d.status.slice(1);
        document.getElementById("subPlan").textContent =
          "Ask Adam Premium" + (d.plan ? ` — ${d.plan.charAt(0).toUpperCase() + d.plan.slice(1)}` : "");
        const renew = document.getElementById("subRenew");
        if (d.currentPeriodEnd) {
          const nice = new Date(d.currentPeriodEnd).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
          const label = d.status === "trialing" ? "Trial ends " : d.status === "canceled" ? "Access until " : "Renews on ";
          renew.textContent = label + nice;
        } else {
          renew.textContent = "";
        }
      } else {
        statusCard.classList.add("hidden");
        upsell.classList.remove("hidden");
      }
    } catch {
      statusCard.classList.add("hidden");
      upsell.classList.remove("hidden");
    }
  }

  const manageBtn = document.getElementById("manageSub");
  if (manageBtn) {
    manageBtn.addEventListener("click", async () => {
      const r = await api("/api/billing/portal", { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.url) window.open(d.url, "_blank");
      else alert(d.error || "Couldn't open subscription management.");
    });
  }
})();
