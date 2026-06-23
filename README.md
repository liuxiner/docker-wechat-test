# Docker WeChat Login Demo

Minimal Node.js TypeScript service and UI for running `agent-wechat` locally.

## Start

```bash
nvm use
pnpm install
pnpm start
```

This project uses Node 22 because `@agent-wechat/cli` relies on the native
`WebSocket` global for `wx auth login`.

Open:

```text
http://localhost:3017
```

## What It Does

- Uses the project-local `@agent-wechat/cli` dependency when available
- Falls back to global `wx` during development
- Starts the upstream `agent-wechat` container through `wx up`
- Reads status through `wx status` and `wx auth status`
- Reads the noVNC token through `wx auth token`
- Starts QR login through `wx auth login --new`
- Opens the noVNC login page in an iframe modal
- Polls WeChat login status every few seconds
- Shows logout and disconnected reminders
- Switches the Docker button between start and shutdown
- Switches the WeChat button between login, logging in, and logout
- Provides a small send-message test panel via `wx chats list --json`, `wx messages send --text`, and `wx messages send --image`
- Provides exact group/user name search backed by `wx chats find` and `wx contacts find --json`

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3017` | Demo UI/service port |
| `AGENT_WECHAT_URL` | `http://localhost:6174` | CLI/API URL |
| `PUBLIC_AGENT_WECHAT_URL` | `http://localhost:6174` | Browser iframe URL |
| `AGENT_WECHAT_PROXY` | empty | Optional proxy passed to `wx up --proxy` |
| `AGENT_WECHAT_LOGIN_TIMEOUT` | `300` | Seconds passed to `wx auth login --timeout` |
| `WX_BIN` | empty | Optional custom `wx` executable path |

## Notes

This demo intentionally does not reimplement agent-wechat Docker launch logic.
The upstream CLI owns container creation, auth token generation, health checks,
login, logout, and shutdown.

The upstream container name is `agent-wechat`, and its token lives in the
location managed by `wx` (`~/.config/agent-wechat/token`).

The embedded noVNC window is view-only in the upstream container. It is for
watching QR codes and UI state, not manually clicking WeChat popups. Use the
demo's login button to let `agent-wechat` dismiss popups and enter the QR page.

`agent-wechat` has search commands (`wx chats find <name>` and
`wx contacts find <name> --json`), but the CLI does not expose an exact-match
flag. This demo service filters the returned candidates with strict string
matching before showing them in the UI.
