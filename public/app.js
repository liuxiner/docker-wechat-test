const state = {
  last: null,
  busy: false,
  wasLoggedIn: false,
  modalOpenedByUser: false,
};

const els = {
  heartbeat: document.querySelector("#heartbeat"),
  heartbeatText: document.querySelector("#heartbeatText"),
  dockerStatus: document.querySelector("#dockerStatus"),
  containerStatus: document.querySelector("#containerStatus"),
  wechatStatus: document.querySelector("#wechatStatus"),
  accountStatus: document.querySelector("#accountStatus"),
  statusJson: document.querySelector("#statusJson"),
  qrPanel: document.querySelector("#qrPanel"),
  terminalQr: document.querySelector("#terminalQr"),
  notice: document.querySelector("#notice"),
  startBtn: document.querySelector("#startBtn"),
  loginBtn: document.querySelector("#loginBtn"),
  resetBtn: document.querySelector("#resetBtn"),
  searchName: document.querySelector("#searchName"),
  searchType: document.querySelector("#searchType"),
  searchBtn: document.querySelector("#searchBtn"),
  searchResults: document.querySelector("#searchResults"),
  searchStatus: document.querySelector("#searchStatus"),
  loadChatsBtn: document.querySelector("#loadChatsBtn"),
  chatSelect: document.querySelector("#chatSelect"),
  messageText: document.querySelector("#messageText"),
  sendMessageBtn: document.querySelector("#sendMessageBtn"),
  testStatus: document.querySelector("#testStatus"),
  imageFile: document.querySelector("#imageFile"),
  sendImageBtn: document.querySelector("#sendImageBtn"),
  imageStatus: document.querySelector("#imageStatus"),
  refreshBtn: document.querySelector("#refreshBtn"),
  loginModal: document.querySelector("#loginModal"),
  modalBackdrop: document.querySelector("#modalBackdrop"),
  closeModalBtn: document.querySelector("#closeModalBtn"),
  continueLoginBtn: document.querySelector("#continueLoginBtn"),
  vncFrame: document.querySelector("#vncFrame"),
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { Accept: "application/json" },
    ...options,
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body.error || "Request failed");
  }
  return body;
}

function setBusy(busy) {
  state.busy = busy;
  const loggedIn = state.last?.wechat?.status === "logged_in";
  const loginRunning = Boolean(state.last?.wx?.loginJob?.running);

  els.startBtn.disabled = busy;
  els.loginBtn.disabled = busy || loginRunning || (!state.last?.agentReachable && !loggedIn);
  els.resetBtn.disabled = busy;
  els.searchName.disabled = busy || !loggedIn;
  els.searchType.disabled = busy || !loggedIn;
  els.searchBtn.disabled = busy || !loggedIn || !els.searchName.value.trim();
  els.loadChatsBtn.disabled = busy || !loggedIn;
  els.chatSelect.disabled = busy || !loggedIn;
  els.messageText.disabled = busy || !loggedIn;
  els.imageFile.disabled = busy || !loggedIn;
  els.sendMessageBtn.disabled = busy || !loggedIn || !els.chatSelect.value || !els.messageText.value.trim();
  els.sendImageBtn.disabled = busy || !loggedIn || !els.chatSelect.value || !els.imageFile.files?.[0];
}

function showNotice(message, tone = "warn") {
  els.notice.hidden = false;
  els.notice.textContent = message;
  els.notice.className = `notice ${tone}`;
}

function hideNotice() {
  els.notice.hidden = true;
  els.notice.textContent = "";
  els.notice.className = "notice";
}

function heartbeatTone(status) {
  if (!status?.cliAvailable) return ["error", "wx CLI 未就绪"];
  if (!status.container?.running) return ["warn", "容器未运行"];
  if (!status.agentReachable) return ["warn", "服务启动中"];
  if (status.wechat?.status === "logged_in") return ["ok", "微信已登录"];
  if (status.wechat?.status === "logged_out") return ["warn", "等待扫码"];
  return ["warn", "等待微信"];
}

function stripAnsi(text) {
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function extractTerminalQr(status) {
  const stdout = status?.wx?.loginJob?.stdoutTail || "";
  const text = stripAnsi(stdout).replace(/\r/g, "");
  const marker = "Scan this QR code with WeChat:";
  const start = text.lastIndexOf(marker);
  if (start < 0) return "";

  const afterMarker = text.slice(start + marker.length);
  const end = afterMarker.indexOf("Waiting for scan");
  const rawQr = end >= 0 ? afterMarker.slice(0, end) : afterMarker;
  return rawQr
    .replace(/^\n+/, "")
    .replace(/\n+$/, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
}

function summarizeStatus(status) {
  const copy = structuredClone(status);
  if (copy.token) {
    copy.token = `${copy.token.slice(0, 8)}...${copy.token.slice(-8)}`;
  }
  if (copy.vncUrl) {
    copy.vncUrl = copy.vncUrl.replace(/token=[^&]+/, "token=<hidden>");
  }
  const loginJob = copy.wx?.loginJob;
  if (loginJob) {
    if (loginJob.stdoutTail?.includes("Scan this QR code with WeChat:")) {
      loginJob.stdoutTail = "[QR code rendered above]";
    }
    if (loginJob.stderrTail && loginJob.stderrTail.length > 600) {
      loginJob.stderrTail = `${loginJob.stderrTail.slice(-600)}`;
    }
  }
  return copy;
}

function renderTerminalQr(status) {
  if (status?.wechat?.status === "logged_in") {
    els.qrPanel.hidden = true;
    els.terminalQr.textContent = "";
    return "";
  }

  const qr = extractTerminalQr(status);
  if (!qr) {
    els.qrPanel.hidden = true;
    els.terminalQr.textContent = "";
    return "";
  }

  els.qrPanel.hidden = false;
  els.terminalQr.textContent = qr;
  return qr;
}

function render(status) {
  state.last = status;
  const qr = renderTerminalQr(status);
  const running = Boolean(status.container?.running);
  const loggedIn = status.wechat?.status === "logged_in";
  const loginRunning = Boolean(status.wx?.loginJob?.running);

  const [tone, text] = heartbeatTone(status);
  els.heartbeat.className = `heartbeat ${tone}`;
  els.heartbeatText.textContent = text;
  els.startBtn.innerHTML = running
    ? '<span class="button-icon">⏻</span>Shutdown Docker'
    : '<span class="button-icon">▶</span>启动 Docker';
  els.startBtn.classList.toggle("danger-primary", running);
  els.loginBtn.innerHTML = loggedIn
    ? '<span class="button-icon">⏻</span>登出微信'
    : loginRunning
      ? '<span class="button-icon">…</span>登录中'
      : '<span class="button-icon">↗</span>登录微信';
  els.loginBtn.classList.toggle("danger", loggedIn);

  els.dockerStatus.textContent = status.cliAvailable ? "ready" : "missing";
  els.containerStatus.textContent = status.container?.status || "-";
  els.wechatStatus.textContent = status.wechat?.status || (status.agentReachable ? "unknown" : "-");
  els.accountStatus.textContent = status.wechat?.loggedInUser || "-";
  els.statusJson.textContent = JSON.stringify(summarizeStatus(status), null, 2);

  if (!status.cliAvailable) {
    showNotice("未检测到 wx CLI，请先 pnpm install 或安装 @agent-wechat/cli。", "error");
  } else if (status.lastError && status.container?.running) {
    showNotice(status.lastError, "error");
  } else if (status.container?.error) {
    showNotice(status.container.error, "error");
  } else if (status.wechat?.status === "logged_in") {
    showNotice("微信已连接。", "ok");
  } else if (qr) {
    showNotice("二维码已生成，请用微信扫码。", "ok");
  } else if (status.agentReachable) {
    showNotice("等待微信扫码确认。", "warn");
  } else {
    hideNotice();
  }

  if (state.wasLoggedIn && status.wechat?.status && status.wechat.status !== "logged_in") {
    showNotice("微信登录已失效，需要重新扫码。", "error");
  }
  state.wasLoggedIn = status.wechat?.status === "logged_in";

  if (status.wechat?.status === "logged_in" && !els.loginModal.hidden) {
    setTimeout(closeLoginModal, 900);
  }

  setBusy(state.busy);
}

async function refresh() {
  const status = await api("/api/status");
  render(status);
  return status;
}

async function runAction(action, success) {
  setBusy(true);
  try {
    const payload = await action();
    render(payload.status || payload);
    if (success) showNotice(success, "ok");
    return payload.status || payload;
  } catch (err) {
    showNotice(err.message || String(err), "error");
    await refresh().catch(() => undefined);
  } finally {
    setBusy(false);
  }
}

function setTestStatus(message, tone = "") {
  els.testStatus.textContent = message;
  els.testStatus.className = `inline-status ${tone}`;
}

function setImageStatus(message, tone = "") {
  els.imageStatus.textContent = message;
  els.imageStatus.className = `inline-status ${tone}`;
}

function setSearchStatus(message, tone = "") {
  els.searchStatus.textContent = message;
  els.searchStatus.className = `inline-status ${tone}`;
}

function openLoginModal() {
  if (!state.last?.vncUrl) return;
  state.modalOpenedByUser = true;
  els.vncFrame.src = state.last.vncUrl;
  els.loginModal.hidden = false;
}

async function startLoginAndOpenModal(newAccount = true) {
  const status = await runAction(
    () => api(`/api/login/start${newAccount ? "?new=1" : ""}`, { method: "POST" }),
    "已启动微信登录流程。",
  );
  if (status?.vncUrl) {
    openLoginModal();
  }
}

function chatLabel(chat) {
  const id = chat.username || chat.id || "";
  const name = chat.remark || chat.name || id;
  const group = chat.isGroup ? " [群]" : "";
  const unread = chat.unreadCount ? ` (${chat.unreadCount})` : "";
  return `${name}${group}${unread} - ${id}`;
}

function searchResultLabel(result) {
  const id = result.username || result.id || "";
  const name = result.remark || result.name || id;
  const marker = result.type === "group" ? "群" : result.type === "user" ? "用户" : "聊天";
  return `${name} [${marker}] - ${id}`;
}

function selectChatTarget(target) {
  const id = target.username || target.id;
  if (!id) return;

  let option = Array.from(els.chatSelect.options).find((item) => item.value === id);
  if (!option) {
    option = document.createElement("option");
    option.value = id;
    option.textContent = searchResultLabel(target);
    els.chatSelect.append(option);
  }
  els.chatSelect.value = id;
  setBusy(state.busy);
}

function renderSearchResults(results) {
  els.searchResults.replaceChildren();
  for (const result of results) {
    const button = document.createElement("button");
    button.className = "search-result";
    button.type = "button";
    button.textContent = searchResultLabel(result);
    button.addEventListener("click", () => selectChatTarget(result));
    els.searchResults.append(button);
  }
}

async function loadChats() {
  setBusy(true);
  setTestStatus("Loading...");
  try {
    const payload = await api("/api/chats?limit=100");
    render(payload.status);
    els.chatSelect.innerHTML = '<option value="">-</option>';
    for (const chat of payload.chats || []) {
      const id = chat.username || chat.id;
      if (!id) continue;
      const option = document.createElement("option");
      option.value = id;
      option.textContent = chatLabel(chat);
      els.chatSelect.append(option);
    }
    setTestStatus(`${els.chatSelect.options.length - 1} chats`);
  } catch (err) {
    setTestStatus(err.message || String(err), "error");
  } finally {
    setBusy(false);
  }
}

async function searchExactTarget() {
  const name = els.searchName.value.trim();
  const type = els.searchType.value;
  if (!name) return;

  setBusy(true);
  setSearchStatus("Searching...");
  try {
    const payload = await api(`/api/search/exact?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`);
    render(payload.status);
    const results = payload.results || [];
    renderSearchResults(results);
    if (results.length === 1) {
      selectChatTarget(results[0]);
    }
    setSearchStatus(`${results.length} exact match${results.length === 1 ? "" : "es"}`, results.length ? "ok" : "");
  } catch (err) {
    setSearchStatus(err.message || String(err), "error");
  } finally {
    setBusy(false);
  }
}

async function sendMessage() {
  const chatId = els.chatSelect.value;
  const text = els.messageText.value.trim();
  if (!chatId || !text) return;

  setBusy(true);
  setTestStatus("Sending...");
  try {
    const payload = await api("/api/messages/send", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ chatId, text }),
    });
    render(payload.status);
    setTestStatus("Sent", "ok");
  } catch (err) {
    setTestStatus(err.message || String(err), "error");
  } finally {
    setBusy(false);
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Failed to read image"));
    reader.readAsDataURL(file);
  });
}

async function sendImage() {
  const chatId = els.chatSelect.value;
  const file = els.imageFile.files?.[0];
  if (!chatId || !file) return;

  setBusy(true);
  setImageStatus("Uploading...");
  try {
    const dataUrl = await readFileAsDataUrl(file);
    const payload = await api("/api/messages/send-image", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chatId,
        filename: file.name,
        mimeType: file.type,
        dataUrl,
      }),
    });
    render(payload.status);
    setImageStatus("Image sent", "ok");
  } catch (err) {
    setImageStatus(err.message || String(err), "error");
  } finally {
    setBusy(false);
  }
}

function closeLoginModal() {
  els.loginModal.hidden = true;
  els.vncFrame.src = "about:blank";
}

els.startBtn.addEventListener("click", async () => {
  if (state.last?.container?.running) {
    await runAction(() => api("/api/stop", { method: "POST" }), "Docker 已关闭。");
    return;
  }

  const status = await runAction(
    () => api("/api/start", { method: "POST" }),
    "Docker 容器已启动。",
  );
  if (status?.agentReachable && status?.wechat?.status !== "logged_in") {
    await startLoginAndOpenModal(true);
  }
});

els.loginBtn.addEventListener("click", () => {
  if (state.last?.wechat?.status === "logged_in") {
    void runAction(() => api("/api/logout", { method: "POST" }), "已退出微信。");
    return;
  }
  void startLoginAndOpenModal(true);
});

els.continueLoginBtn.addEventListener("click", () => {
  void startLoginAndOpenModal(true);
});

els.resetBtn.addEventListener("click", () => {
  void runAction(() => api("/api/reset", { method: "POST" }), "容器已重建。");
});

els.searchName.addEventListener("input", () => setBusy(state.busy));
els.searchName.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void searchExactTarget();
  }
});
els.searchType.addEventListener("change", () => setBusy(state.busy));
els.searchBtn.addEventListener("click", () => {
  void searchExactTarget();
});

els.loadChatsBtn.addEventListener("click", () => {
  void loadChats();
});

els.chatSelect.addEventListener("change", () => setBusy(state.busy));
els.messageText.addEventListener("input", () => setBusy(state.busy));
els.imageFile.addEventListener("change", () => setBusy(state.busy));
els.sendMessageBtn.addEventListener("click", () => {
  void sendMessage();
});
els.sendImageBtn.addEventListener("click", () => {
  void sendImage();
});

els.refreshBtn.addEventListener("click", () => {
  void refresh().catch((err) => showNotice(err.message || String(err), "error"));
});

els.closeModalBtn.addEventListener("click", closeLoginModal);
els.modalBackdrop.addEventListener("click", closeLoginModal);

void refresh().catch((err) => showNotice(err.message || String(err), "error"));
setInterval(() => {
  if (!state.busy) {
    void refresh().catch((err) => showNotice(err.message || String(err), "error"));
  }
}, 3000);
