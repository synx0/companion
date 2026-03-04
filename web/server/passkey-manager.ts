/**
 * passkey-manager.ts
 *
 * WebAuthn / Passkey authentication layer.
 * Replaces the token-based auth-manager.
 *
 * Storage (all under ~/.companion/):
 *   passkeys.json     – registered credential objects
 *   passkey-sessions.json – active session tokens (set as HTTP-only cookies)
 *   invites.json      – one-time registration tokens
 *
 * Challenges are kept in-memory (5-minute TTL).
 */

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type VerifiedRegistrationResponse,
  type VerifiedAuthenticationResponse,
} from "@simplewebauthn/server";
// Types are re-exported from @simplewebauthn/server in v13
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Paths ─────────────────────────────────────────────────────────────────────

const COMPANION_DIR = join(homedir(), ".companion");
const PASSKEYS_FILE = join(COMPANION_DIR, "passkeys.json");
const SESSIONS_FILE = join(COMPANION_DIR, "passkey-sessions.json");
const INVITES_FILE = join(COMPANION_DIR, "invites.json");

function ensureDir() {
  mkdirSync(COMPANION_DIR, { recursive: true });
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StoredCredential {
  id: string;                  // base64url credential ID
  publicKey: string;           // base64 encoded COSE public key
  counter: number;
  transports: string[];
  createdAt: number;
  deviceName?: string;
}

interface PasskeyStore {
  credentials: StoredCredential[];
  /** Opaque user handle (single user — no username). Fixed once created. */
  userHandle: string;
}

interface SessionStore {
  sessions: Record<string, { credentialId: string; createdAt: number; expiresAt: number }>;
}

interface InviteStore {
  invites: Record<string, { createdAt: number; expiresAt: number; used: boolean }>;
}

// ── Singleton state ───────────────────────────────────────────────────────────

/** In-memory challenge map: challengeId → { challenge, expiresAt } */
const challenges = new Map<string, { challenge: string; expiresAt: number }>();

const CHALLENGE_TTL_MS = 5 * 60 * 1000;   // 5 minutes
const SESSION_TTL_MS   = 30 * 24 * 60 * 60 * 1000; // 30 days
const INVITE_TTL_MS    = 24 * 60 * 60 * 1000;       // 24 hours

// ── Persistence helpers ───────────────────────────────────────────────────────

function loadPasskeyStore(): PasskeyStore {
  try {
    if (existsSync(PASSKEYS_FILE)) {
      return JSON.parse(readFileSync(PASSKEYS_FILE, "utf-8")) as PasskeyStore;
    }
  } catch { /* corrupt — start fresh */ }
  return { credentials: [], userHandle: randomBytes(32).toString("base64url") };
}

function savePasskeyStore(store: PasskeyStore): void {
  ensureDir();
  writeFileSync(PASSKEYS_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

function loadSessionStore(): SessionStore {
  try {
    if (existsSync(SESSIONS_FILE)) {
      return JSON.parse(readFileSync(SESSIONS_FILE, "utf-8")) as SessionStore;
    }
  } catch { /* corrupt */ }
  return { sessions: {} };
}

function saveSessionStore(store: SessionStore): void {
  ensureDir();
  writeFileSync(SESSIONS_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

function loadInviteStore(): InviteStore {
  try {
    if (existsSync(INVITES_FILE)) {
      return JSON.parse(readFileSync(INVITES_FILE, "utf-8")) as InviteStore;
    }
  } catch { /* corrupt */ }
  return { invites: {} };
}

function saveInviteStore(store: InviteStore): void {
  ensureDir();
  writeFileSync(INVITES_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

// ── Challenge management ──────────────────────────────────────────────────────

function pruneExpiredChallenges() {
  const now = Date.now();
  for (const [id, entry] of challenges) {
    if (entry.expiresAt < now) challenges.delete(id);
  }
}

function storeChallenge(challenge: string): string {
  pruneExpiredChallenges();
  const challengeId = randomBytes(16).toString("hex");
  challenges.set(challengeId, { challenge, expiresAt: Date.now() + CHALLENGE_TTL_MS });
  return challengeId;
}

function consumeChallenge(challengeId: string): string | null {
  const entry = challenges.get(challengeId);
  if (!entry || entry.expiresAt < Date.now()) return null;
  challenges.delete(challengeId);
  return entry.challenge;
}

// ── Registration ──────────────────────────────────────────────────────────────

export interface RegistrationOptionsResult {
  options: PublicKeyCredentialCreationOptionsJSON;
  challengeId: string;
}

/**
 * Generate WebAuthn registration options.
 * Restricts to platform authenticators only (Face ID, Touch ID, Windows Hello).
 * No username — single-user model.
 */
export async function generatePasskeyRegistrationOptions(
  rpID: string,
  rpName: string,
): Promise<RegistrationOptionsResult> {
  const store = loadPasskeyStore();
  const existingCredentials = store.credentials.map((c) => ({
    id: c.id,
    transports: c.transports as AuthenticatorTransport[],
  }));

  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userID: new TextEncoder().encode(store.userHandle),
    userName: "companion-user",
    userDisplayName: "Companion User",
    attestationType: "none",
    excludeCredentials: existingCredentials,
    authenticatorSelection: {
      authenticatorAttachment: "platform",   // Face ID / Touch ID only
      requireResidentKey: true,              // enables passkey behaviour
      residentKey: "required",
      userVerification: "required",          // biometric required
    },
    timeout: 60000,
  });

  const challengeId = storeChallenge(options.challenge);
  return { options, challengeId };
}

export interface RegistrationVerifyResult {
  ok: boolean;
  error?: string;
  credentialId?: string;
}

export async function verifyPasskeyRegistration(
  response: RegistrationResponseJSON,
  challengeId: string,
  rpID: string,
  origin: string,
  deviceName?: string,
): Promise<RegistrationVerifyResult> {
  const expectedChallenge = consumeChallenge(challengeId);
  if (!expectedChallenge) {
    return { ok: false, error: "Challenge expired or not found" };
  }

  let verification: VerifiedRegistrationResponse;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
  } catch (err) {
    return { ok: false, error: String(err) };
  }

  if (!verification.verified || !verification.registrationInfo) {
    return { ok: false, error: "Verification failed" };
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

  const stored: StoredCredential = {
    id: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString("base64"),
    counter: credential.counter,
    transports: (credential.transports ?? []) as string[],
    createdAt: Date.now(),
    deviceName,
  };

  const store = loadPasskeyStore();
  store.credentials.push(stored);
  savePasskeyStore(store);

  console.log(
    `[passkey] Registered credential ${credential.id} (device: ${deviceName ?? "unknown"}, type: ${credentialDeviceType}, backed up: ${credentialBackedUp})`,
  );

  return { ok: true, credentialId: credential.id };
}

// ── Authentication ────────────────────────────────────────────────────────────

export interface AuthOptionsResult {
  options: PublicKeyCredentialRequestOptionsJSON;
  challengeId: string;
}

/**
 * Generate WebAuthn authentication options.
 * allowCredentials is empty → any registered passkey works.
 */
export async function generatePasskeyAuthOptions(
  rpID: string,
): Promise<AuthOptionsResult> {
  const store = loadPasskeyStore();
  const allowCredentials = store.credentials.map((c) => ({
    id: c.id,
    transports: c.transports as AuthenticatorTransport[],
  }));

  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials,
    userVerification: "required",
    timeout: 60000,
  });

  const challengeId = storeChallenge(options.challenge);
  return { options, challengeId };
}

export interface AuthVerifyResult {
  ok: boolean;
  sessionToken?: string;
  error?: string;
}

export async function verifyPasskeyAuth(
  response: AuthenticationResponseJSON,
  challengeId: string,
  rpID: string,
  origin: string,
): Promise<AuthVerifyResult> {
  const expectedChallenge = consumeChallenge(challengeId);
  if (!expectedChallenge) {
    return { ok: false, error: "Challenge expired or not found" };
  }

  const store = loadPasskeyStore();
  const credential = store.credentials.find((c) => c.id === response.id);
  if (!credential) {
    return { ok: false, error: "Unknown credential" };
  }

  let verification: VerifiedAuthenticationResponse;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey, "base64"),
        counter: credential.counter,
        transports: credential.transports as AuthenticatorTransport[],
      },
      requireUserVerification: true,
    });
  } catch (err) {
    return { ok: false, error: String(err) };
  }

  if (!verification.verified) {
    return { ok: false, error: "Authentication failed" };
  }

  // Update signature counter to prevent replay attacks
  credential.counter = verification.authenticationInfo.newCounter;
  savePasskeyStore(store);

  // Create session
  const sessionToken = createSession(credential.id);
  return { ok: true, sessionToken };
}

// ── Session management ────────────────────────────────────────────────────────

function createSession(credentialId: string): string {
  const token = randomBytes(32).toString("base64url");
  const store = loadSessionStore();

  // Prune expired sessions
  const now = Date.now();
  for (const [k, v] of Object.entries(store.sessions)) {
    if (v.expiresAt < now) delete store.sessions[k];
  }

  store.sessions[token] = {
    credentialId,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
  saveSessionStore(store);
  return token;
}

export function verifySession(token: string | null | undefined): boolean {
  if (!token) return false;
  const store = loadSessionStore();
  const session = store.sessions[token];
  if (!session) return false;
  if (session.expiresAt < Date.now()) {
    // Expired — clean up lazily
    delete store.sessions[token];
    saveSessionStore(store);
    return false;
  }
  return true;
}

export function revokeSession(token: string): void {
  const store = loadSessionStore();
  delete store.sessions[token];
  saveSessionStore(store);
}

export function revokeAllSessions(): void {
  saveSessionStore({ sessions: {} });
}

// ── Invite management ─────────────────────────────────────────────────────────

export function createInvite(): string {
  const token = randomBytes(24).toString("base64url");
  const store = loadInviteStore();
  store.invites[token] = {
    createdAt: Date.now(),
    expiresAt: Date.now() + INVITE_TTL_MS,
    used: false,
  };
  saveInviteStore(store);
  return token;
}

export function validateInvite(token: string): { valid: boolean; reason?: string } {
  const store = loadInviteStore();
  const invite = store.invites[token];
  if (!invite) return { valid: false, reason: "not found" };
  if (invite.used) return { valid: false, reason: "already used" };
  if (invite.expiresAt < Date.now()) return { valid: false, reason: "expired" };
  return { valid: true };
}

/**
 * Atomically validate and consume an invite in a single file load/save cycle.
 * Prevents TOCTOU race conditions where two concurrent requests could both
 * pass validateInvite() and both proceed to register.
 */
export function consumeInvite(token: string): { ok: boolean; reason?: string } {
  const store = loadInviteStore();
  const invite = store.invites[token];
  if (!invite) return { ok: false, reason: "not found" };
  if (invite.used) return { ok: false, reason: "already used" };
  if (invite.expiresAt < Date.now()) return { ok: false, reason: "expired" };
  // Mark used and persist in the same operation
  store.invites[token].used = true;
  saveInviteStore(store);
  return { ok: true };
}

// ── Status ────────────────────────────────────────────────────────────────────

export function hasRegisteredCredentials(): boolean {
  const store = loadPasskeyStore();
  return store.credentials.length > 0;
}

export function listCredentials(): Array<Pick<StoredCredential, "id" | "deviceName" | "createdAt">> {
  return loadPasskeyStore().credentials.map(({ id, deviceName, createdAt }) => ({
    id,
    deviceName,
    createdAt,
  }));
}

export function revokeCredential(id: string): boolean {
  const store = loadPasskeyStore();
  const idx = store.credentials.findIndex((c) => c.id === id);
  if (idx === -1) return false;
  store.credentials.splice(idx, 1);
  savePasskeyStore(store);
  return true;
}

// ── CLI WebSocket secrets ─────────────────────────────────────────────────────
// Per-session one-time secrets embedded in the --sdk-url so the server can
// verify that the connecting WS is the Claude Code process it spawned,
// not an arbitrary local process that guessed the session ID from `ps aux`.

const cliSecrets = new Map<string, string>(); // sessionId → secret

export function generateCliSecret(sessionId: string): string {
  const secret = randomBytes(32).toString("hex");
  cliSecrets.set(sessionId, secret);
  return secret;
}

export function verifyCliSecret(sessionId: string, candidate: string | null | undefined): boolean {
  if (!candidate) return false;
  const expected = cliSecrets.get(sessionId);
  if (!expected) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function revokeCliSecret(sessionId: string): void {
  cliSecrets.delete(sessionId);
}

// ── Cookie helpers ────────────────────────────────────────────────────────────

export const SESSION_COOKIE_NAME = "companion_session";
export const SESSION_COOKIE_MAX_AGE = SESSION_TTL_MS / 1000; // seconds

/** Parse a raw Cookie header string into a key→value map. */
export function parseCookies(cookieHeader: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const raw = part.slice(eq + 1).trim();
    // Guard against malformed percent-encoding (e.g. "bad%value") which
    // would cause decodeURIComponent to throw, enabling a DoS via cookie header.
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      out[key] = raw; // use raw value; session lookup will simply fail to match
    }
  }
  return out;
}

/** Extract session token from request Cookie header. */
export function getSessionFromCookieHeader(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  return parseCookies(cookieHeader)[SESSION_COOKIE_NAME] ?? null;
}
