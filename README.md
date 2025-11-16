# Remote Command Center

A dual-application platform for orchestrating secure remote command execution:

- **Server App (`server-app/`)** – a macOS-native Tauri application with a React UI and Rust backend. It manages command definitions, executes jobs securely, and exposes authenticated HTTP/WebSocket APIs for remote control.
- **Client App (`client-app/`)** – a progressive web application optimised for mobile devices that connects to the server over HTTPS/WebSockets to trigger commands and monitor activity in real time.

## Repository layout

```
/home/engine/project
├── server-app            # Tauri desktop application (React + Tailwind + Rust)
│   ├── package.json
│   ├── index.html
│   ├── src/              # Front-end UI
│   └── src-tauri/        # Rust backend + Tauri configuration
└── client-app            # Mobile-first PWA (React + Tailwind)
    ├── package.json
    ├── public/           # Manifest and icons
    └── src/              # PWA source
```

## Prerequisites

- **Node.js 18+** with npm or yarn (both apps use Vite + React + Tailwind).
- **Rust toolchain** (`rustup`, latest stable) for compiling the Tauri backend.
- **Tauri prerequisites for macOS** – Xcode Command Line Tools and a recent version of `cargo`. See the [Tauri documentation](https://tauri.app/v1/guides/getting-started/prerequisites) for detailed setup steps.

## Server app (macOS Tauri)

```bash
cd server-app
npm install
npm run tauri:dev        # launches the Tauri shell with live reload
npm run tauri:build      # produces a signed macOS bundle in src-tauri/target
```

The Rust backend (`src-tauri/src`) exposes an HTTP + WebSocket API (`:6280` by default) for remote clients. Command definitions, execution history, session management, and secure password hashing are handled within `state.rs`. The React UI in `src/` lets administrators manage commands and monitor activity from the native shell.

Key features:
- Command catalogue CRUD with live updates via Tauri events.
- Secure execution pipeline using `tokio::process::Command` with rich logging.
- Authentication + session management (`argon2` hashing, token-based sessions).
- Embedded Axum web server for remote clients (REST + WebSocket streaming).
- System tray integration for quick access/visibility toggle on macOS.

## Client app (PWA)

```bash
cd client-app
npm install
npm run dev         # local development on http://localhost:4173
npm run build       # static production build in dist/
```

The client is a mobile-first React application that:
- Stores server profiles locally and authenticates via the REST API.
- Streams live command updates over WebSockets.
- Allows parameterised command execution (with server-side enforcement).
- Provides an installable PWA experience with offline caching via `vite-plugin-pwa`.

Ensure the server app is running and publicly reachable (or tunneled) before attempting to connect from a mobile device.

## Environment configuration

The server listens on port **6280** by default. Override with the `REMOTE_COMMAND_CENTER_PORT` environment variable before starting the Tauri app if you need to expose a different port.

## Security notes

- Default admin credentials are `admin` / `admin123`. Change them immediately using the "Set password" Tauri command or extend the UI to surface this action.
- All remote communication is expected to occur over TLS (run the server behind a reverse proxy such as nginx or Caddy, or extend the Rust layer to load certificates directly).
- Commands execute on the host system—review and sandbox executable definitions according to your security policy.

## Next steps

- Wire additional persistence (SQLite/encrypted file store) for commands and history.
- Integrate multi-user roles and fine-grained permissions.
- Add push notifications for failed commands or server health changes.

Feel free to extend either application as needed; both projects follow standard Vite + React conventions for rapid iteration.
