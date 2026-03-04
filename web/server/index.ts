process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";

// Enrich process PATH at startup so binary resolution and `which` calls can find
// binaries installed via version managers (nvm, volta, fnm, etc.).
// Critical when running as a launchd/systemd service with a restricted PATH.
import { getEnrichedPath } from "./path-resolver.js";
process.env.PATH = getEnrichedPath();

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { cacheControlMiddleware } from "./cache-headers.js";
import { createRoutes } from "./routes.js";
import { CliLauncher } from "./cli-launcher.js";
import { WsBridge } from "./ws-bridge.js";
import { SessionStore } from "./session-store.js";
import { WorktreeTracker } from "./worktree-tracker.js";
import { containerManager } from "./container-manager.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { TerminalManager } from "./terminal-manager.js";
import { generateSessionTitle } from "./auto-namer.js";
import * as sessionNames from "./session-names.js";
import { getSettings } from "./settings-manager.js";
import { PRPoller } from "./pr-poller.js";
import { RecorderManager } from "./recorder.js";
import { CronScheduler } from "./cron-scheduler.js";
import { AgentExecutor } from "./agent-executor.js";
import { migrateCronJobsToAgents } from "./agent-cron-migrator.js";

import { startPeriodicCheck, setServiceMode } from "./update-checker.js";
import { imagePullManager } from "./image-pull-manager.js";
import { isRunningAsService } from "./service.js";
import { verifySession, getSessionFromCookieHeader, verifyCliSecret, revokeCliSecret } from "./passkey-manager.js";
import { registerPasskeyRoutes } from "./routes/passkey-routes.js";
import { getCookie } from "hono/cookie";
import type { SocketData } from "./ws-bridge.js";
import type { ServerWebSocket } from "bun";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = process.env.__COMPANION_PACKAGE_ROOT || resolve(__dirname, "..");

import { DEFAULT_PORT_DEV, DEFAULT_PORT_PROD } from "./constants.js";

const defaultPort = process.env.NODE_ENV === "production" ? DEFAULT_PORT_PROD : DEFAULT_PORT_DEV;
const port = Number(process.env.PORT) || defaultPort;
const idleTimeoutSeconds = Number(process.env.COMPANION_IDLE_TIMEOUT_SECONDS || "120");
const sessionStore = new SessionStore(process.env.COMPANION_SESSION_DIR);
const wsBridge = new WsBridge();
const launcher = new CliLauncher(port);
const worktreeTracker = new WorktreeTracker();
const CONTAINER_STATE_PATH = join(homedir(), ".companion", "containers.json");
const terminalManager = new TerminalManager();
const prPoller = new PRPoller(wsBridge);
const recorder = new RecorderManager();
const cronScheduler = new CronScheduler(launcher, wsBridge);
const agentExecutor = new AgentExecutor(launcher, wsBridge);

// ── Restore persisted sessions from disk ────────────────────────────────────
wsBridge.setStore(sessionStore);
wsBridge.setRecorder(recorder);
launcher.setStore(sessionStore);
launcher.setRecorder(recorder);
launcher.restoreFromDisk();
wsBridge.restoreFromDisk();
containerManager.restoreState(CONTAINER_STATE_PATH);

// When the CLI reports its internal session_id, store it for --resume on relaunch
wsBridge.onCLISessionIdReceived((sessionId, cliSessionId) => {
  launcher.setCLISessionId(sessionId, cliSessionId);
});

// When a Codex adapter is created, attach it to the WsBridge
launcher.onCodexAdapterCreated((sessionId, adapter) => {
  wsBridge.attachCodexAdapter(sessionId, adapter);
});

// Start watching PRs when git info is resolved for a session
wsBridge.onSessionGitInfoReadyCallback((sessionId, cwd, branch) => {
  prPoller.watch(sessionId, cwd, branch);
});

// Auto-relaunch CLI when a browser connects to a session with no CLI
const relaunchingSet = new Set<string>();
wsBridge.onCLIRelaunchNeededCallback(async (sessionId) => {
  if (relaunchingSet.has(sessionId)) return;
  const info = launcher.getSession(sessionId);
  if (info?.archived) return;
  if (info && info.state !== "starting") {
    relaunchingSet.add(sessionId);
    console.log(`[server] Auto-relaunching CLI for session ${sessionId}`);
    try {
      const result = await launcher.relaunch(sessionId);
      if (!result.ok && result.error) {
        wsBridge.broadcastToSession(sessionId, { type: "error", message: result.error });
      }
    } finally {
      setTimeout(() => relaunchingSet.delete(sessionId), 5000);
    }
  }
});

// Auto-generate session title after first turn completes
wsBridge.onFirstTurnCompletedCallback(async (sessionId, firstUserMessage) => {
  // Don't overwrite a name that was already set (manual rename or prior auto-name)
  if (sessionNames.getName(sessionId)) return;
  if (!getSettings().anthropicApiKey.trim()) return;
  const info = launcher.getSession(sessionId);
  const model = info?.model || "claude-sonnet-4-6";
  console.log(`[server] Auto-naming session ${sessionId} via Anthropic with model ${model}...`);
  const title = await generateSessionTitle(firstUserMessage, model);
  // Re-check: a manual rename may have occurred while we were generating
  if (title && !sessionNames.getName(sessionId)) {
    console.log(`[server] Auto-named session ${sessionId}: "${title}"`);
    sessionNames.setName(sessionId, title);
    wsBridge.broadcastNameUpdate(sessionId, title);
  }
});

console.log(`[server] Session persistence: ${sessionStore.directory}`);
if (recorder.isGloballyEnabled()) {
  console.log(`[server] Recording enabled (dir: ${recorder.getRecordingsDir()}, max: ${recorder.getMaxLines()} lines)`);
}

const app = new Hono();

const COMPANION_DOMAIN = process.env.COMPANION_DOMAIN?.trim();

// Allow localhost (dev/tunnel) and COMPANION_DOMAIN (production) origins.
app.use("/api/*", cors({
  origin: (origin) => {
    // Reject requests with no Origin header — non-browser clients don't need CORS
    if (!origin) return null;
    try {
      const { hostname, origin: o } = new URL(origin);
      if (hostname === "localhost" || hostname === "127.0.0.1") return origin;
      if (COMPANION_DOMAIN && (hostname === COMPANION_DOMAIN || o === `https://${COMPANION_DOMAIN}`)) return origin;
    } catch { /* ignore malformed */ }
    return null;
  },
  credentials: true,
}));

// Security headers — defense-in-depth for internet-facing Cloudflare Tunnel deployments.
// Applied after CORS so CORS headers are already set before we add security headers.
app.use("/*", async (c, next) => {
  await next();
  // CSP: allow same-origin resources; PostHog analytics (opt-in, CDN may load recorder script)
  c.header(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' https://us-assets.i.posthog.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "connect-src 'self' https://us.i.posthog.com https://us-assets.i.posthog.com",
      "font-src 'self' data:",
      "worker-src 'self' blob:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  );
  c.header("X-Frame-Options", "DENY");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // HSTS only when served over HTTPS (i.e., exposed via Cloudflare Tunnel with COMPANION_DOMAIN)
  if (COMPANION_DOMAIN) {
    c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
});

// Public passkey auth routes — no session required
const publicApi = new Hono();
registerPasskeyRoutes(publicApi);
app.route("/api", publicApi);

// All other /api routes require a valid session
app.route("/api", createRoutes(launcher, wsBridge, sessionStore, worktreeTracker, terminalManager, prPoller, recorder, cronScheduler, agentExecutor));

// Dynamic manifest — session cookie handles PWA auth automatically.
app.get("/manifest.json", (c) => {
  const manifest = {
    name: "The Companion",
    short_name: "Companion",
    description: "Web UI for Claude Code and Codex",
    start_url: "/",
    scope: "/",
    display: "standalone" as const,
    background_color: "#262624",
    theme_color: "#d97757",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };
  c.header("Content-Type", "application/manifest+json");
  return c.json(manifest);
});

// In production, serve built frontend using absolute path (works when installed as npm package)
if (process.env.NODE_ENV === "production") {
  const distDir = resolve(packageRoot, "dist");
  app.use("/*", cacheControlMiddleware());
  app.use("/*", serveStatic({ root: distDir }));
  app.get("/*", (c) => new Response(Bun.file(resolve(distDir, "index.html"))));
}

const server = Bun.serve<SocketData>({
  port,
  // Bind to loopback only — defense in depth alongside iptables rules.
  // This ensures the process itself never accepts external connections
  // regardless of firewall state.
  hostname: "127.0.0.1",
  idleTimeout: idleTimeoutSeconds,
  async fetch(req, server) {
    const url = new URL(req.url);

    // Helper: check if request is from localhost (same machine)
    const reqIp = server.requestIP(req);
    const reqAddr = reqIp?.address ?? "";
    const isLocalhost = reqAddr === "127.0.0.1" || reqAddr === "::1" || reqAddr === "::ffff:127.0.0.1";

    // ── CLI WebSocket — Claude Code CLI connects here via --sdk-url ────
    // Requires: (1) localhost origin, (2) per-session cliSecret query param.
    const cliMatch = url.pathname.match(/^\/ws\/cli\/([a-f0-9-]+)$/);
    if (cliMatch) {
      const sessionId = cliMatch[1];
      const cliSecret = url.searchParams.get("cliSecret");
      if (!isLocalhost) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (!verifyCliSecret(sessionId, cliSecret)) {
        return new Response("Unauthorized", { status: 401 });
      }
      // Secret is single-use: the CLI holds the URL for the session lifetime,
      // so we keep the secret in memory until the session ends.
      const upgraded = server.upgrade(req, {
        data: { kind: "cli" as const, sessionId },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // ── Browser WebSocket — connects to a specific session ─────────────
    const browserMatch = url.pathname.match(/^\/ws\/browser\/([a-f0-9-]+)$/);
    if (browserMatch) {
      const cookieHeader = req.headers.get("cookie") ?? "";
      const sessionToken = getSessionFromCookieHeader(cookieHeader);
      if (!verifySession(sessionToken)) {
        return new Response("Unauthorized", { status: 401 });
      }
      const sessionId = browserMatch[1];
      const upgraded = server.upgrade(req, {
        data: { kind: "browser" as const, sessionId },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // ── Terminal WebSocket — embedded terminal PTY connection ─────────
    const termMatch = url.pathname.match(/^\/ws\/terminal\/([a-f0-9-]+)$/);
    if (termMatch) {
      const cookieHeader = req.headers.get("cookie") ?? "";
      const sessionToken = getSessionFromCookieHeader(cookieHeader);
      if (!verifySession(sessionToken)) {
        return new Response("Unauthorized", { status: 401 });
      }
      const terminalId = termMatch[1];
      const upgraded = server.upgrade(req, {
        data: { kind: "terminal" as const, terminalId },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Hono handles the rest
    return app.fetch(req, server);
  },
  websocket: {
    open(ws: ServerWebSocket<SocketData>) {
      const data = ws.data;
      if (data.kind === "cli") {
        wsBridge.handleCLIOpen(ws, data.sessionId);
        launcher.markConnected(data.sessionId);
      } else if (data.kind === "browser") {
        wsBridge.handleBrowserOpen(ws, data.sessionId);
      } else if (data.kind === "terminal") {
        terminalManager.addBrowserSocket(ws);
      }
    },
    message(ws: ServerWebSocket<SocketData>, msg: string | Buffer) {
      const data = ws.data;
      if (data.kind === "cli") {
        wsBridge.handleCLIMessage(ws, msg);
      } else if (data.kind === "browser") {
        wsBridge.handleBrowserMessage(ws, msg);
      } else if (data.kind === "terminal") {
        terminalManager.handleBrowserMessage(ws, msg);
      }
    },
    close(ws: ServerWebSocket<SocketData>) {
      const data = ws.data;
      if (data.kind === "cli") {
        wsBridge.handleCLIClose(ws);
        revokeCliSecret(data.sessionId); // clean up per-session secret
      } else if (data.kind === "browser") {
        wsBridge.handleBrowserClose(ws);
      } else if (data.kind === "terminal") {
        terminalManager.removeBrowserSocket(ws);
      }
    },
  },
});

console.log(`Server running on http://localhost:${server.port}`);
console.log(`  Auth: WebAuthn passkey (Face ID / Touch ID)`);
console.log(`  Run 'companion-admin create-invite' to generate a registration link`);
console.log();
console.log(`  CLI WebSocket:     ws://localhost:${server.port}/ws/cli/:sessionId`);
console.log(`  Browser WebSocket: ws://localhost:${server.port}/ws/browser/:sessionId`);

if (process.env.NODE_ENV !== "production") {
  console.log("Dev mode: frontend at http://localhost:5174");
}

// ── Cron scheduler ──────────────────────────────────────────────────────────
cronScheduler.startAll();

// ── Agent system ────────────────────────────────────────────────────────────
migrateCronJobsToAgents();
agentExecutor.startAll();

// ── Image pull manager — pre-pull missing Docker images for environments ────
imagePullManager.initFromEnvironments();

// ── Update checker ──────────────────────────────────────────────────────────
startPeriodicCheck();
if (isRunningAsService()) {
  setServiceMode(true);
  console.log("[server] Running as background service (auto-update available)");
}

// ── Graceful shutdown — persist container state ──────────────────────────────
function gracefulShutdown() {
  console.log("[server] Persisting container state before shutdown...");
  containerManager.persistState(CONTAINER_STATE_PATH);
  process.exit(0);
}
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

// ── Reconnection watchdog ────────────────────────────────────────────────────
// After a server restart, restored CLI processes may not reconnect their
// WebSocket. Give them a grace period, then kill + relaunch any that are
// still in "starting" state (alive but no WS connection).
const RECONNECT_GRACE_MS = Number(process.env.COMPANION_RECONNECT_GRACE_MS || "30000");
const starting = launcher.getStartingSessions();
if (starting.length > 0) {
  console.log(`[server] Waiting ${RECONNECT_GRACE_MS / 1000}s for ${starting.length} CLI process(es) to reconnect...`);
  setTimeout(async () => {
    const stale = launcher.getStartingSessions();
    for (const info of stale) {
      if (info.archived) continue;
      console.log(`[server] CLI for session ${info.sessionId} did not reconnect, relaunching...`);
      await launcher.relaunch(info.sessionId);
    }
  }, RECONNECT_GRACE_MS);
}
