# Docker WeChat Login Demo

Minimal Node.js TypeScript service and UI for running `agent-wechat` locally.

## Start

```bash
pnpm start
```

Open:

```text
http://localhost:3017
```

## What It Does

- Creates a local auth token under `runtime/auth-token`
- Starts Docker container `agent-wechat-demo`
- Opens the noVNC login page in an iframe modal
- Polls WeChat login status every few seconds
- Shows logout and disconnected reminders

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3017` | Demo UI/service port |
| `AGENT_WECHAT_IMAGE` | `ghcr.io/thisnick/agent-wechat:latest` | Docker image |
| `AGENT_WECHAT_CONTAINER` | `agent-wechat-demo` | Container name |
| `AGENT_WECHAT_URL` | `http://127.0.0.1:6174` | Server-side API URL |
| `PUBLIC_AGENT_WECHAT_URL` | `http://localhost:6174` | Browser iframe URL |
| `AGENT_WECHAT_PROXY` | empty | Optional proxy passed to the container |

## Notes

This demo expects Docker to be running. The container needs `SYS_PTRACE` and
`seccomp=unconfined`, matching the upstream agent-wechat requirements.
