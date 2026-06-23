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
  logoutBtn: document.querySelector("#logoutBtn"),
  stopBtn: document.querySelector("#stopBtn"),
  resetBtn: document.querySelector("#resetBtn"),
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
  els.startBtn.disabled = busy;
  els.loginBtn.disabled = busy || !state.last?.agentReachable;
  els.logoutBtn.disabled = busy || state.last?.wechat?.status !== "logged_in";
  els.stopBtn.disabled = busy || !state.last?.container?.exists;
  els.resetBtn.disabled = busy;
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

  const [tone, text] = heartbeatTone(status);
  els.heartbeat.className = `heartbeat ${tone}`;
  els.heartbeatText.textContent = text;
  els.startBtn.innerHTML = running
    ? '<span class="button-icon">⏻</span>Shutdown Docker'
    : '<span class="button-icon">▶</span>启动 Docker';
  els.startBtn.classList.toggle("danger-primary", running);

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
  void startLoginAndOpenModal(true);
});

els.continueLoginBtn.addEventListener("click", () => {
  void startLoginAndOpenModal(true);
});

els.logoutBtn.addEventListener("click", () => {
  void runAction(() => api("/api/logout", { method: "POST" }), "已请求退出微信。");
});

els.stopBtn.addEventListener("click", () => {
  void runAction(() => api("/api/stop", { method: "POST" }), "容器已停止。");
});

els.resetBtn.addEventListener("click", () => {
  void runAction(() => api("/api/reset", { method: "POST" }), "容器已重建。");
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
