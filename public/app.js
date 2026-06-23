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
  notice: document.querySelector("#notice"),
  startBtn: document.querySelector("#startBtn"),
  loginBtn: document.querySelector("#loginBtn"),
  logoutBtn: document.querySelector("#logoutBtn"),
  stopBtn: document.querySelector("#stopBtn"),
  refreshBtn: document.querySelector("#refreshBtn"),
  loginModal: document.querySelector("#loginModal"),
  modalBackdrop: document.querySelector("#modalBackdrop"),
  closeModalBtn: document.querySelector("#closeModalBtn"),
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
  if (!status?.dockerInstalled) return ["error", "Docker 未就绪"];
  if (!status.container?.running) return ["warn", "容器未运行"];
  if (!status.agentReachable) return ["warn", "服务启动中"];
  if (status.wechat?.status === "logged_in") return ["ok", "微信已登录"];
  if (status.wechat?.status === "logged_out") return ["warn", "等待扫码"];
  return ["warn", "等待微信"];
}

function render(status) {
  state.last = status;

  const [tone, text] = heartbeatTone(status);
  els.heartbeat.className = `heartbeat ${tone}`;
  els.heartbeatText.textContent = text;

  els.dockerStatus.textContent = status.dockerInstalled ? "ready" : "missing";
  els.containerStatus.textContent = status.container?.status || "-";
  els.wechatStatus.textContent = status.wechat?.status || (status.agentReachable ? "unknown" : "-");
  els.accountStatus.textContent = status.wechat?.loggedInUser || "-";
  els.statusJson.textContent = JSON.stringify(status, null, 2);

  if (!status.dockerInstalled) {
    showNotice("未检测到 Docker，请先启动 Docker Desktop。", "error");
  } else if (status.lastError && status.container?.running) {
    showNotice(status.lastError, "error");
  } else if (status.wechat?.status === "logged_in") {
    showNotice("微信已连接。", "ok");
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

function closeLoginModal() {
  els.loginModal.hidden = true;
  els.vncFrame.src = "about:blank";
}

els.startBtn.addEventListener("click", async () => {
  const status = await runAction(
    () => api("/api/start", { method: "POST" }),
    "Docker 容器已启动。",
  );
  if (status?.agentReachable && status?.wechat?.status !== "logged_in") {
    openLoginModal();
  }
});

els.loginBtn.addEventListener("click", openLoginModal);

els.logoutBtn.addEventListener("click", () => {
  void runAction(() => api("/api/logout", { method: "POST" }), "已请求退出微信。");
});

els.stopBtn.addEventListener("click", () => {
  void runAction(() => api("/api/stop", { method: "POST" }), "容器已停止。");
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
