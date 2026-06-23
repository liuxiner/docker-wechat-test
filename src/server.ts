import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

type CommandResult = {
  stdout: string;
  stderr: string;
  command?: string;
  source?: string;
};

type ContainerInfo = {
  exists: boolean;
  running: boolean;
  status: string;
  error?: string;
};

type AgentAuthStatus = {
  status: "logged_in" | "logged_out" | "app_not_running" | "unknown";
  loggedInUser?: string;
};

type DemoStatus = {
  ok: boolean;
  cliAvailable: boolean;
  container: ContainerInfo;
  agentReachable: boolean;
  wechat?: AgentAuthStatus;
  token?: string;
  apiUrl: string;
  vncUrl: string;
  wx?: {
    source?: string;
    statusOutput?: string;
    authStatusOutput?: string;
    loginJob?: LoginJobSnapshot;
  };
  lastError?: string;
};

type ChatSummary = {
  id?: string;
  username?: string;
  name?: string;
  remark?: string;
  unreadCount?: number;
  isGroup?: boolean;
};

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = join(rootDir, "public");

const PORT = Number(process.env.PORT ?? 3017);
const AGENT_URL = trimTrailingSlash(process.env.AGENT_WECHAT_URL ?? "http://localhost:6174");
const PUBLIC_AGENT_URL = trimTrailingSlash(
  process.env.PUBLIC_AGENT_WECHAT_URL ?? "http://localhost:6174",
);
const AGENT_PROXY = process.env.AGENT_WECHAT_PROXY?.trim();
const LOGIN_TIMEOUT_SECONDS = process.env.AGENT_WECHAT_LOGIN_TIMEOUT ?? "300";
const requireFromHere = createRequire(import.meta.url);

type WxInvocation = {
  command: string;
  prefixArgs: string[];
  shell: boolean;
  source: string;
};

type LoginJobSnapshot = {
  running: boolean;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  stdoutTail: string;
  stderrTail: string;
  error?: string;
};

type LoginJob = LoginJobSnapshot & {
  child?: ChildProcessWithoutNullStreams;
};

let cachedWxInvocation: WxInvocation | undefined;
let loginJob: LoginJob | undefined;

function trimTrailingSlash(input: string): string {
  return input.replace(/\/+$/, "");
}

async function resolveWxInvocation(): Promise<WxInvocation> {
  if (cachedWxInvocation) return cachedWxInvocation;

  if (process.env.WX_BIN) {
    cachedWxInvocation = {
      command: process.env.WX_BIN,
      prefixArgs: [],
      shell: process.platform === "win32",
      source: "WX_BIN",
    };
    return cachedWxInvocation;
  }

  try {
    const pkgPath = requireFromHere.resolve("@agent-wechat/cli/package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    const bin = typeof pkg.bin === "object" ? pkg.bin.wx : pkg.bin;
    if (typeof bin === "string") {
      cachedWxInvocation = {
        command: process.execPath,
        prefixArgs: [resolve(dirname(pkgPath), bin)],
        shell: false,
        source: "@agent-wechat/cli dependency",
      };
      return cachedWxInvocation;
    }
  } catch {
    // Dependency not installed yet; fall back to global wx for development.
  }

  cachedWxInvocation = {
    command: "wx",
    prefixArgs: [],
    shell: process.platform === "win32",
    source: "global wx",
  };
  return cachedWxInvocation;
}

async function runWx(args: string[], timeoutMs = 120_000): Promise<CommandResult> {
  const wx = await resolveWxInvocation();
  const fullArgs = [...wx.prefixArgs, ...args];
  return new Promise((resolvePromise, reject) => {
    execFile(
      wx.command,
      fullArgs,
      {
        timeout: timeoutMs,
        shell: wx.shell,
        cwd: rootDir,
        env: {
          ...process.env,
          AGENT_WECHAT_URL: AGENT_URL,
        },
      },
      (error, stdout, stderr) => {
      if (error) {
        const err = new Error(stderr?.toString().trim() || stdout?.toString().trim() || error.message);
        reject(err);
        return;
      }
      resolvePromise({
        stdout: stdout.toString().trim(),
        stderr: stderr.toString().trim(),
        command: `wx ${args.join(" ")}`.trim(),
        source: wx.source,
      });
      },
    );
  });
}

async function isCliAvailable(): Promise<boolean> {
  try {
    await runWx(["--version"], 20_000);
    return true;
  } catch {
    return false;
  }
}

async function getWxToken(): Promise<string | undefined> {
  try {
    const result = await runWx(["auth", "token"], 30_000);
    const match = result.stdout.match(/[a-f0-9]{64}/i);
    return match?.[0];
  } catch {
    return undefined;
  }
}

function parseWxStatus(output: string): {
  container: ContainerInfo;
  agentReachable: boolean;
  wechat?: AgentAuthStatus;
} {
  const lower = output.toLowerCase();
  const containerLine = output.match(/^Container:\s*(.+)$/im)?.[1]?.trim() ?? "unknown";
  const running = containerLine === "up";
  const exists = containerLine !== "down" && containerLine !== "unknown (Docker unavailable)";
  const serverLine = output.match(/^Server:\s*(.+)$/im)?.[1]?.trim();
  const loginLine = output.match(/^Login:\s*(.+)$/im)?.[1]?.trim();

  let wechat: AgentAuthStatus | undefined;
  if (loginLine) {
    if (loginLine.startsWith("logged in")) {
      wechat = {
        status: "logged_in",
        loggedInUser: loginLine.match(/^logged in as\s+(.+)$/i)?.[1],
      };
    } else if (loginLine.includes("logged out")) {
      wechat = { status: "logged_out" };
    } else if (loginLine.includes("app not running")) {
      wechat = { status: "app_not_running" };
    } else {
      wechat = { status: "unknown" };
    }
  }

  return {
    container: {
      exists,
      running,
      status: containerLine,
      error: output.match(/^Error:\s*(.+)$/im)?.[1]?.trim(),
    },
    agentReachable: serverLine === "reachable" || lower.includes("server: reachable"),
    wechat,
  };
}

function parseWxAuthStatus(output: string): AgentAuthStatus | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  const loggedIn = trimmed.match(/^Logged in(?: as (.+))?/i);
  if (loggedIn) {
    return {
      status: "logged_in",
      loggedInUser: loggedIn[1],
    };
  }
  const status = trimmed.match(/^Status:\s*(.+)$/i)?.[1]?.trim().replace(/\s+/g, "_");
  if (status === "logged_out" || status === "app_not_running" || status === "unknown") {
    return { status };
  }
  return { status: "unknown" };
}

async function getDemoStatus(lastError?: string): Promise<DemoStatus> {
  const token = await getWxToken();
  const cliAvailable = await isCliAvailable();
  let container: ContainerInfo = { exists: false, running: false, status: "unknown" };
  let agentReachable = false;
  let wechat: AgentAuthStatus | undefined;
  let observedError = lastError;
  let statusOutput: string | undefined;
  let authStatusOutput: string | undefined;
  let wxSource: string | undefined;

  if (cliAvailable) {
    try {
      const status = await runWx(["status"], 60_000);
      statusOutput = status.stdout;
      wxSource = status.source;
      const parsed = parseWxStatus(status.stdout);
      container = parsed.container;
      agentReachable = parsed.agentReachable;
      wechat = parsed.wechat;

      if (agentReachable) {
        const auth = await runWx(["auth", "status"], 30_000);
        authStatusOutput = auth.stdout;
        wechat = parseWxAuthStatus(auth.stdout) ?? wechat;
      }
      if (wechat?.status === "logged_in" && loginJob && !loginJob.running && loginJob.exitCode !== 0) {
        loginJob = undefined;
      }
    } catch (err) {
      observedError = err instanceof Error ? err.message : String(err);
    }
  } else {
    observedError = observedError ?? "wx CLI is not available. Run pnpm install or install @agent-wechat/cli.";
  }

  return {
    ok: cliAvailable && container.running && agentReachable,
    cliAvailable,
    container,
    agentReachable,
    wechat,
    token,
    apiUrl: AGENT_URL,
    vncUrl: `${PUBLIC_AGENT_URL}/vnc/?token=${encodeURIComponent(token ?? "")}&autoconnect=true`,
    wx: {
      source: wxSource ?? cachedWxInvocation?.source,
      statusOutput,
      authStatusOutput,
      loginJob: getLoginJobSnapshot(),
    },
    lastError: observedError,
  };
}

async function startContainer(): Promise<void> {
  const args = ["up"];
  if (AGENT_PROXY) {
    args.push("--proxy", AGENT_PROXY);
  }
  await runWx(args, 300_000);
}

async function stopContainer(): Promise<void> {
  await runWx(["down"], 120_000);
}

async function logoutWeChat(): Promise<unknown> {
  const result = await runWx(["auth", "logout"], 60_000);
  return result.stdout || result.stderr || "logout requested";
}

async function resetContainer(): Promise<void> {
  try {
    await stopContainer();
  } catch {
    // wx down is allowed to report "not found"; wx up below is the important step.
  }
  await startContainer();
}

function appendTail(existing: string, chunk: Buffer): string {
  const merged = `${existing}${chunk.toString()}`;
  return merged.length > 6000 ? merged.slice(-6000) : merged;
}

function getLoginJobSnapshot(): LoginJobSnapshot | undefined {
  if (!loginJob) return undefined;
  const { child: _child, ...snapshot } = loginJob;
  return snapshot;
}

async function startLoginJob(newAccount = false): Promise<LoginJobSnapshot> {
  if (loginJob?.running) {
    return getLoginJobSnapshot() as LoginJobSnapshot;
  }

  const wx = await resolveWxInvocation();
  const args = [
    ...wx.prefixArgs,
    "auth",
    "login",
    "--timeout",
    LOGIN_TIMEOUT_SECONDS,
    ...(newAccount ? ["--new"] : []),
  ];
  const child = spawn(wx.command, args, {
    cwd: rootDir,
    shell: wx.shell,
    env: {
      ...process.env,
      AGENT_WECHAT_URL: AGENT_URL,
    },
  });

  loginJob = {
    running: true,
    startedAt: new Date().toISOString(),
    stdoutTail: "",
    stderrTail: "",
    child,
  };

  child.stdout.on("data", (chunk) => {
    if (loginJob) loginJob.stdoutTail = appendTail(loginJob.stdoutTail, chunk);
  });

  child.stderr.on("data", (chunk) => {
    if (loginJob) loginJob.stderrTail = appendTail(loginJob.stderrTail, chunk);
  });

  child.on("error", (err) => {
    if (!loginJob) return;
    loginJob.running = false;
    loginJob.finishedAt = new Date().toISOString();
    loginJob.error = err.message;
  });

  child.on("exit", (code) => {
    if (!loginJob) return;
    loginJob.running = false;
    loginJob.finishedAt = new Date().toISOString();
    loginJob.exitCode = code;
  });

  return getLoginJobSnapshot() as LoginJobSnapshot;
}

async function listChats(limit = 50): Promise<ChatSummary[]> {
  const result = await runWx(["chats", "list", "--limit", String(limit), "--json"], 60_000);
  const parsed = JSON.parse(result.stdout);
  if (!Array.isArray(parsed)) {
    throw new Error("wx chats list did not return an array");
  }
  return parsed;
}

async function sendTextMessage(chatId: string, text: string): Promise<CommandResult> {
  return runWx(["messages", "send", chatId, "--text", text], 120_000);
}

async function readJsonBody<T>(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new Error("Request body too large");
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {} as T;
  return JSON.parse(raw) as T;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, text: string, contentType: string): void {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = resolve(publicDir, relativePath);

  if (!filePath.startsWith(publicDir)) {
    sendText(res, 403, "Forbidden", "text/plain; charset=utf-8");
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("Not a file");
    const bytes = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": contentTypeFor(filePath),
      "Content-Length": bytes.length,
      "Cache-Control": "no-store",
    });
    res.end(bytes);
  } catch {
    sendText(res, 404, "Not found", "text/plain; charset=utf-8");
  }
}

function contentTypeFor(path: string): string {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (!url.pathname.startsWith("/api/")) return false;

  try {
    if (req.method === "GET" && url.pathname === "/api/status") {
      sendJson(res, 200, await getDemoStatus());
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/start") {
      await startContainer();
      sendJson(res, 200, await getDemoStatus());
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/stop") {
      await stopContainer();
      sendJson(res, 200, await getDemoStatus());
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/reset") {
      await resetContainer();
      sendJson(res, 200, await getDemoStatus());
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/login/start") {
      const newAccount = url.searchParams.get("new") === "1";
      const login = await startLoginJob(newAccount);
      sendJson(res, 200, {
        login,
        status: await getDemoStatus(),
      });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/logout") {
      const logout = await logoutWeChat();
      sendJson(res, 200, {
        logout,
        status: await getDemoStatus(),
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/chats") {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50), 1), 200);
      sendJson(res, 200, {
        chats: await listChats(limit),
        status: await getDemoStatus(),
      });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/messages/send") {
      const body = await readJsonBody<{ chatId?: string; text?: string }>(req);
      const chatId = body.chatId?.trim();
      const text = body.text?.trim();
      if (!chatId || !text) {
        sendJson(res, 400, { error: "chatId and text are required" });
        return true;
      }
      const result = await sendTextMessage(chatId, text);
      sendJson(res, 200, {
        ok: true,
        output: result.stdout,
        status: await getDemoStatus(),
      });
      return true;
    }

    sendJson(res, 404, { error: "Unknown API route" });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, {
      error: message,
      status: await getDemoStatus(message).catch(() => undefined),
    });
    return true;
  }
}

const server = createServer((req, res) => {
  void (async () => {
    if (await handleApi(req, res)) return;
    if (req.method === "GET" || req.method === "HEAD") {
      await serveStatic(req, res);
      return;
    }
    sendText(res, 405, "Method not allowed", "text/plain; charset=utf-8");
  })().catch((err) => {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  });
});

server.listen(PORT, () => {
  console.log(`docker-wechat-test listening on http://localhost:${PORT}`);
});
