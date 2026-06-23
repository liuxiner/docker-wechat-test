import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { access, chmod } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type CommandResult = {
  stdout: string;
  stderr: string;
};

type ContainerInfo = {
  exists: boolean;
  running: boolean;
  status: string;
  image?: string;
  startedAt?: string;
};

type AgentAuthStatus = {
  status: "logged_in" | "logged_out" | "app_not_running" | "unknown";
  loggedInUser?: string;
};

type DemoStatus = {
  ok: boolean;
  dockerInstalled: boolean;
  container: ContainerInfo;
  agentReachable: boolean;
  agentHealth?: unknown;
  wechat?: AgentAuthStatus;
  token: string;
  apiUrl: string;
  vncUrl: string;
  lastError?: string;
};

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = join(rootDir, "public");
const runtimeDir = join(rootDir, "runtime");
const agentDataDir = join(runtimeDir, "agent-data");
const agentHomeDir = join(runtimeDir, "agent-home");
const tokenPath = join(runtimeDir, "auth-token");

const PORT = Number(process.env.PORT ?? 3017);
const IMAGE = process.env.AGENT_WECHAT_IMAGE ?? "ghcr.io/thisnick/agent-wechat:latest";
const CONTAINER_NAME = process.env.AGENT_WECHAT_CONTAINER ?? "agent-wechat-demo";
const AGENT_URL = trimTrailingSlash(process.env.AGENT_WECHAT_URL ?? "http://127.0.0.1:6174");
const PUBLIC_AGENT_URL = trimTrailingSlash(
  process.env.PUBLIC_AGENT_WECHAT_URL ?? "http://localhost:6174",
);
const AGENT_PROXY = process.env.AGENT_WECHAT_PROXY?.trim();

function trimTrailingSlash(input: string): string {
  return input.replace(/\/+$/, "");
}

function execDocker(args: string[], timeoutMs = 60_000): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    execFile("docker", args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        const err = new Error(stderr?.trim() || error.message);
        reject(err);
        return;
      }
      resolvePromise({
        stdout: stdout.toString().trim(),
        stderr: stderr.toString().trim(),
      });
    });
  });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensureRuntime(): Promise<string> {
  await mkdir(agentDataDir, { recursive: true });
  await mkdir(agentHomeDir, { recursive: true });

  if (!(await fileExists(tokenPath))) {
    await writeFile(tokenPath, randomBytes(32).toString("hex"), { mode: 0o600 });
  }

  try {
    await chmod(tokenPath, 0o600);
  } catch {
    // Windows filesystems may not support POSIX chmod semantics.
  }

  return readFile(tokenPath, "utf8").then((buf) => buf.trim());
}

async function getContainerInfo(): Promise<ContainerInfo> {
  try {
    const result = await execDocker(["inspect", CONTAINER_NAME], 20_000);
    const parsed = JSON.parse(result.stdout)[0];
    const state = parsed?.State ?? {};
    return {
      exists: true,
      running: Boolean(state.Running),
      status: String(state.Status ?? "unknown"),
      image: parsed?.Config?.Image,
      startedAt: state.StartedAt,
    };
  } catch {
    return {
      exists: false,
      running: false,
      status: "missing",
    };
  }
}

async function isDockerInstalled(): Promise<boolean> {
  try {
    await execDocker(["--version"], 10_000);
    return true;
  } catch {
    return false;
  }
}

async function fetchAgent(path: string, token?: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  headers.set("Accept", "application/json");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(`${AGENT_URL}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok) {
      throw new Error(typeof body?.error === "string" ? body.error : `${res.status} ${res.statusText}`);
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForAgent(token: string, timeoutMs = 45_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await fetchAgent("/health", token);
      return true;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1200));
    }
  }
  return false;
}

async function getDemoStatus(lastError?: string): Promise<DemoStatus> {
  const token = await ensureRuntime();
  const dockerInstalled = await isDockerInstalled();
  const container = dockerInstalled
    ? await getContainerInfo()
    : { exists: false, running: false, status: "docker_missing" };

  let agentReachable = false;
  let agentHealth: unknown;
  let wechat: AgentAuthStatus | undefined;
  let observedError = lastError;

  if (dockerInstalled && container.running) {
    try {
      agentHealth = await fetchAgent("/health", token);
      agentReachable = true;
      wechat = (await fetchAgent("/api/status/auth", token)) as AgentAuthStatus;
    } catch (err) {
      observedError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    ok: dockerInstalled && container.running && agentReachable,
    dockerInstalled,
    container,
    agentReachable,
    agentHealth,
    wechat,
    token,
    apiUrl: AGENT_URL,
    vncUrl: `${PUBLIC_AGENT_URL}/vnc/?token=${encodeURIComponent(token)}&autoconnect=true`,
    lastError: observedError,
  };
}

async function startContainer(): Promise<void> {
  const token = await ensureRuntime();
  const info = await getContainerInfo();

  if (info.exists) {
    if (!info.running) {
      await execDocker(["start", CONTAINER_NAME], 60_000);
    }
    await waitForAgent(token);
    return;
  }

  const args = [
    "run",
    "-d",
    "--name",
    CONTAINER_NAME,
    "--security-opt",
    "seccomp=unconfined",
    "--cap-add",
    "SYS_PTRACE",
    "-p",
    "6174:6174",
    "-v",
    `${agentDataDir}:/data`,
    "-v",
    `${agentHomeDir}:/home/wechat`,
    "-v",
    `${tokenPath}:/data/auth-token:ro`,
    "--restart",
    "unless-stopped",
  ];

  if (AGENT_PROXY) {
    args.push("--cap-add", "NET_ADMIN", "-e", `PROXY=${AGENT_PROXY}`);
  }

  args.push(IMAGE);
  await execDocker(args, 300_000);
  await waitForAgent(token);
}

async function stopContainer(): Promise<void> {
  const info = await getContainerInfo();
  if (info.exists && info.running) {
    await execDocker(["stop", CONTAINER_NAME], 60_000);
  }
}

async function logoutWeChat(): Promise<unknown> {
  const token = await ensureRuntime();
  return fetchAgent("/api/status/logout", token, { method: "POST" });
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

    if (req.method === "POST" && url.pathname === "/api/logout") {
      const logout = await logoutWeChat();
      sendJson(res, 200, {
        logout,
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
