// ─── LINOIR CHAT WIDGET ───────────────────────────────────────────────────────
// Drop this script into any page and it creates the chat bubble automatically.
// <script src="./widget.js"></script>

(function () {
  const API_URL = "http://localhost:3001/api/chat";
  let history = [];
  let isOpen = false;

  // ── Inject Styles ────────────────────────────────────────────────────────────
  const style = document.createElement("style");
  style.textContent = `
    #linoir-chat-bubble {
      position: fixed;
      bottom: 28px; right: 28px;
      width: 52px; height: 52px;
      background: #1a1a1a;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer;
      z-index: 9000;
      box-shadow: 0 4px 20px rgba(0,0,0,0.2);
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }
    #linoir-chat-bubble:hover {
      transform: scale(1.08);
      box-shadow: 0 6px 24px rgba(0,0,0,0.25);
    }
    #linoir-chat-bubble svg { color: #fff; }

    #linoir-chat-window {
      position: fixed;
      bottom: 92px; right: 28px;
      width: 360px;
      max-height: 520px;
      background: #fff;
      border-radius: 16px;
      box-shadow: 0 12px 48px rgba(0,0,0,0.14);
      display: flex; flex-direction: column;
      z-index: 9000;
      overflow: hidden;
      opacity: 0; visibility: hidden;
      transform: translateY(12px);
      transition: all 0.25s ease;
    }
    #linoir-chat-window.open {
      opacity: 1; visibility: visible;
      transform: translateY(0);
    }

    #linoir-chat-header {
      padding: 16px 20px;
      background: #1a1a1a;
      color: #fff;
      display: flex; align-items: center; gap: 12px;
    }
    .linoir-avatar {
      width: 36px; height: 36px;
      background: #c8a96e;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 14px; font-weight: 600; color: #fff;
      flex-shrink: 0;
    }
    .linoir-header-info { flex: 1; }
    .linoir-header-info strong { display: block; font-size: 14px; font-weight: 500; }
    .linoir-header-info span { font-size: 11px; color: rgba(255,255,255,0.5); }
    #linoir-chat-close {
      background: none; border: none; cursor: pointer;
      color: rgba(255,255,255,0.6); padding: 4px;
      transition: color 0.2s;
    }
    #linoir-chat-close:hover { color: #fff; }

    #linoir-chat-messages {
      flex: 1; overflow-y: auto;
      padding: 16px;
      display: flex; flex-direction: column; gap: 12px;
      scroll-behavior: smooth;
    }

    .linoir-msg {
      max-width: 80%;
      padding: 10px 14px;
      border-radius: 14px;
      font-size: 13px;
      line-height: 1.5;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    .linoir-msg.agent {
      background: #f2f2f0;
      color: #2a2a24;
      align-self: flex-start;
      border-bottom-left-radius: 4px;
    }
    .linoir-msg.user {
      background: #1a1a1a;
      color: #fff;
      align-self: flex-end;
      border-bottom-right-radius: 4px;
    }
    .linoir-msg.typing {
      background: #f2f2f0;
      align-self: flex-start;
      color: #9a9a94;
      font-style: italic;
    }

    #linoir-chat-input-area {
      padding: 12px 16px;
      border-top: 1px solid #e8e8e4;
      display: flex; gap: 8px; align-items: center;
    }
    #linoir-chat-input {
      flex: 1;
      padding: 10px 14px;
      border: 1px solid #e8e8e4;
      border-radius: 24px;
      font-size: 13px;
      outline: none;
      font-family: inherit;
      transition: border-color 0.2s;
    }
    #linoir-chat-input:focus { border-color: #1a1a1a; }
    #linoir-chat-send {
      width: 36px; height: 36px;
      background: #1a1a1a;
      border: none; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; flex-shrink: 0;
      transition: background 0.2s;
    }
    #linoir-chat-send:hover { background: #3a3a34; }
    #linoir-chat-send svg { color: #fff; }

    @media (max-width: 480px) {
      #linoir-chat-window {
        bottom: 0; right: 0; left: 0;
        width: 100%; border-radius: 16px 16px 0 0;
        max-height: 75vh;
      }
      #linoir-chat-bubble { bottom: 20px; right: 20px; }
    }
  `;
  document.head.appendChild(style);

  // ── Inject HTML ──────────────────────────────────────────────────────────────
  document.body.insertAdjacentHTML("beforeend", `
    <button id="linoir-chat-bubble" aria-label="Chat with Aria">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
      </svg>
    </button>

    <div id="linoir-chat-window">
      <div id="linoir-chat-header">
        <div class="linoir-avatar">A</div>
        <div class="linoir-header-info">
          <strong>Aria</strong>
          <span>Linoir Support · Online</span>
        </div>
        <button id="linoir-chat-close">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div id="linoir-chat-messages"></div>
      <div id="linoir-chat-input-area">
        <input id="linoir-chat-input" type="text" placeholder="Ask about products, orders..." maxlength="300">
        <button id="linoir-chat-send">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
        </button>
      </div>
    </div>
  `);

  // ── Elements ─────────────────────────────────────────────────────────────────
  const bubble = document.getElementById("linoir-chat-bubble");
  const window_ = document.getElementById("linoir-chat-window");
  const closeBtn = document.getElementById("linoir-chat-close");
  const messages = document.getElementById("linoir-chat-messages");
  const input = document.getElementById("linoir-chat-input");
  const sendBtn = document.getElementById("linoir-chat-send");

  // ── Open / Close ─────────────────────────────────────────────────────────────
  function openChat() {
    isOpen = true;
    window_.classList.add("open");
    input.focus();
    if (messages.children.length === 0) {
      addMessage("agent", "Hi! I'm Aria, Linoir's support assistant. 👋\n\nI can help you with products, orders, sizing, returns, and more. What can I help you with today?");
    }
  }

  function closeChat() {
    isOpen = false;
    window_.classList.remove("open");
  }

  bubble.addEventListener("click", () => isOpen ? closeChat() : openChat());
  closeBtn.addEventListener("click", closeChat);

  // ── Add Message ───────────────────────────────────────────────────────────────
  function addMessage(role, text) {
    const div = document.createElement("div");
    div.className = `linoir-msg ${role}`;
    div.textContent = text;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    return div;
  }

  function showTyping() {
    const div = addMessage("typing", "Aria is typing...");
    div.id = "linoir-typing";
    return div;
  }

  function removeTyping() {
    document.getElementById("linoir-typing")?.remove();
  }

  // ── Send Message ──────────────────────────────────────────────────────────────
  async function sendMessage() {
    const text = input.value.trim();
    if (!text) return;

    input.value = "";
    input.disabled = true;
    sendBtn.disabled = true;

    addMessage("user", text);
    history.push({ role: "user", content: text });

    const typing = showTyping();

    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, history: history.slice(-8) })
      });

      const data = await res.json();
      removeTyping();

      const reply = data.reply || "Sorry, I couldn't get a response. Please try again.";
      addMessage("agent", reply);
      history.push({ role: "assistant", content: reply });

    } catch {
      removeTyping();
      addMessage("agent", "I'm having trouble connecting right now. Please try again in a moment.");
    }

    input.disabled = false;
    sendBtn.disabled = false;
    input.focus();
  }

  sendBtn.addEventListener("click", sendMessage);
  input.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) sendMessage();
  });

  // ── Save order to backend after checkout ──────────────────────────────────────
  // Call this from order-confirmation.html after order is placed
  window.linoirSaveOrder = function(order) {
    fetch("http://localhost:3001/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(order)
    }).catch(() => {}); // silent fail
  };

})();
