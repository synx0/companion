/**
 * passkey-routes.ts
 *
 * WebAuthn registration + authentication API endpoints.
 * These routes are PUBLIC (no session required) — they are the auth mechanism itself.
 *
 * Routes:
 *   POST /api/passkey/register/options   – generate registration options (invite-gated)
 *   POST /api/passkey/register/verify    – verify attestation, store credential
 *   POST /api/passkey/auth/options       – generate authentication challenge
 *   POST /api/passkey/auth/verify        – verify assertion, issue session cookie
 *   POST /api/passkey/logout             – revoke session cookie
 *   GET  /api/passkey/status             – whether any credentials are registered
 */

import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from "@simplewebauthn/server";
import {
  generatePasskeyRegistrationOptions,
  verifyPasskeyRegistration,
  generatePasskeyAuthOptions,
  verifyPasskeyAuth,
  validateInvite,
  consumeInvite,
  hasRegisteredCredentials,
  revokeSession,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_MAX_AGE,
  getSessionFromCookieHeader,
} from "../passkey-manager.js";

// ── Rate limiter ──────────────────────────────────────────────────────────────
// Simple in-memory sliding-window rate limiter per IP.
// Since the app is loopback-only this mainly guards against runaway scripts.
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 20;           // max attempts per window per IP

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const window = now - RATE_LIMIT_WINDOW_MS;
  const hits = (rateLimitMap.get(ip) ?? []).filter((t) => t > window);
  hits.push(now);
  rateLimitMap.set(ip, hits);
  return hits.length <= RATE_LIMIT_MAX;
}

function getClientIp(req: Request): string {
  // When a custom domain is configured a reverse proxy (e.g. cloudflared) sits in front.
  // In that case trust the X-Real-IP / X-Forwarded-For header the proxy sets so that
  // rate limiting is per actual client IP rather than a single shared bucket.
  if (CUSTOM_DOMAIN) {
    const realIp =
      req.headers.get("X-Real-IP") ??
      req.headers.get("X-Forwarded-For")?.split(",")[0]?.trim();
    if (realIp) return realIp;
  }
  // Pure loopback: every request comes from 127.0.0.1 — rate limit globally.
  return "127.0.0.1";
}

/** Allowed hostnames — localhost variants only (app is loopback-gated via iptables). */
const ALLOWED_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);
const CUSTOM_DOMAIN = process.env.COMPANION_DOMAIN?.trim();
if (CUSTOM_DOMAIN) ALLOWED_HOSTNAMES.add(CUSTOM_DOMAIN);

/**
 * Optional RP ID override — allows subdomains to share passkey credentials
 * with a parent domain. E.g. COMPANION_RP_ID=syx0.one lets dev.syx0.one
 * authenticate using passkeys registered on syx0.one.
 * WebAuthn permits this: the RP ID must be a registrable suffix of the hostname.
 */
const RP_ID_OVERRIDE = process.env.COMPANION_RP_ID?.trim();

/**
 * Derive RP ID and origin from the incoming request.
 * Validates against the allowlist to prevent Host-header spoofing attacks
 * where an attacker crafts "Host: attacker.com" to register credentials
 * under a foreign RP ID.
 */
function getRpInfo(req: Request): { rpID: string; origin: string } {
  const url = new URL(req.url);
  const hostname = url.hostname;
  if (!ALLOWED_HOSTNAMES.has(hostname)) {
    throw new Error(`Untrusted hostname: ${hostname}. Set COMPANION_DOMAIN env var to allow a custom domain.`);
  }
  // Use the RP ID override when set (for cross-subdomain passkey sharing),
  // otherwise fall back to the request hostname.
  const rpID = RP_ID_OVERRIDE || hostname;
  // When behind a reverse proxy (e.g. cloudflared), the server sees http:// but
  // the browser used https://. WebAuthn requires an exact origin match, so honour
  // the X-Forwarded-Proto header to reconstruct the real origin.
  const proto =
    CUSTOM_DOMAIN
      ? (req.headers.get("X-Forwarded-Proto") ?? "https")
      : url.protocol.replace(":", "");
  const origin = `${proto}://${hostname}`;
  return { rpID, origin };
}

export function registerPasskeyRoutes(app: Hono) {
  const passkey = new Hono();

  // ── Status ─────────────────────────────────────────────────────────────────

  passkey.get("/status", (c) => {
    // Return only whether credentials exist — device names and IDs are not
    // needed by the login page and shouldn't be exposed unauthenticated.
    return c.json({ hasCredentials: hasRegisteredCredentials() });
  });

  // ── Registration (invite-gated) ────────────────────────────────────────────

  passkey.post("/register/options", async (c) => {
    if (!checkRateLimit(getClientIp(c.req.raw))) {
      return c.json({ error: "Too many requests" }, 429);
    }
    const body = await c.req.json().catch(() => ({} as { inviteToken?: string; deviceName?: string }));
    const inviteToken = body.inviteToken ?? "";

    const check = validateInvite(inviteToken);
    if (!check.valid) {
      return c.json({ error: `Invalid invite: ${check.reason}` }, 403);
    }

    let rpID: string;
    try {
      ({ rpID } = getRpInfo(c.req.raw));
    } catch (e) {
      return c.json({ error: String(e) }, 400);
    }

    const { options, challengeId } = await generatePasskeyRegistrationOptions(rpID, "The Companion");
    return c.json({ options, challengeId });
  });

  passkey.post("/register/verify", async (c) => {
    const body = await c.req.json().catch(
      () => ({} as { inviteToken?: string; challengeId?: string; credential?: RegistrationResponseJSON; deviceName?: string }),
    );

    const { inviteToken, challengeId, credential, deviceName } = body;

    if (!inviteToken || !challengeId || !credential) {
      return c.json({ error: "Missing fields" }, 400);
    }

    let rpID: string, origin: string;
    try {
      ({ rpID, origin } = getRpInfo(c.req.raw));
    } catch (e) {
      return c.json({ error: String(e) }, 400);
    }
    const result = await verifyPasskeyRegistration(credential, challengeId, rpID, origin, deviceName);

    if (!result.ok) {
      return c.json({ error: result.error }, 400);
    }

    // Atomically consume invite — validates + marks used in one file write.
    // If two requests race, only the first to write wins; the second gets "already used".
    const consumed = consumeInvite(inviteToken);
    if (!consumed.ok) {
      return c.json({ error: `Invite ${consumed.reason}` }, 403);
    }

    console.log(`[passkey] New credential registered: ${result.credentialId}`);
    return c.json({ ok: true, credentialId: result.credentialId });
  });

  // ── Authentication ──────────────────────────────────────────────────────────

  passkey.post("/auth/options", async (c) => {
    if (!checkRateLimit(getClientIp(c.req.raw))) {
      return c.json({ error: "Too many requests" }, 429);
    }
    let rpID: string;
    try {
      ({ rpID } = getRpInfo(c.req.raw));
    } catch (e) {
      return c.json({ error: String(e) }, 400);
    }
    const { options, challengeId } = await generatePasskeyAuthOptions(rpID);
    return c.json({ options, challengeId });
  });

  passkey.post("/auth/verify", async (c) => {
    if (!checkRateLimit(getClientIp(c.req.raw))) {
      return c.json({ error: "Too many requests" }, 429);
    }
    const body = await c.req.json().catch(
      () => ({} as { challengeId?: string; credential?: AuthenticationResponseJSON }),
    );
    const { challengeId, credential } = body;
    if (!challengeId || !credential) {
      return c.json({ error: "Missing fields" }, 400);
    }

    let rpID: string, origin: string;
    try {
      ({ rpID, origin } = getRpInfo(c.req.raw));
    } catch (e) {
      return c.json({ error: String(e) }, 400);
    }
    const result = await verifyPasskeyAuth(credential, challengeId, rpID, origin);

    if (!result.ok || !result.sessionToken) {
      return c.json({ error: result.error ?? "Authentication failed" }, 401);
    }

    setCookie(c, SESSION_COOKIE_NAME, result.sessionToken, {
      path: "/",
      httpOnly: true,
      sameSite: "Strict",
      maxAge: SESSION_COOKIE_MAX_AGE,
      // Require HTTPS when serving via a custom domain/tunnel.
      // For pure loopback (http://localhost) the Secure attribute is intentionally
      // omitted because browsers don't require it for localhost origins.
      secure: !!CUSTOM_DOMAIN,
    });

    console.log("[passkey] Session created");
    return c.json({ ok: true });
  });

  // ── Logout ─────────────────────────────────────────────────────────────────

  passkey.post("/logout", (c) => {
    const cookieHeader = c.req.header("cookie") ?? "";
    const sessionToken = getSessionFromCookieHeader(cookieHeader);
    if (sessionToken) revokeSession(sessionToken);

    deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
    return c.json({ ok: true });
  });

  app.route("/passkey", passkey);
}
