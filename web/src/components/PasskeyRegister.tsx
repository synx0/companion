/**
 * PasskeyRegister.tsx
 *
 * One-time passkey registration page.
 * Accessed via /register?invite=<token>
 * Uses Face ID / Touch ID / platform authenticator.
 */

import { useState, useCallback, useEffect } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";

interface RegOptions {
  options: PublicKeyCredentialCreationOptionsJSON;
  challengeId: string;
}

async function fetchRegOptions(inviteToken: string): Promise<RegOptions | { error: string }> {
  const res = await fetch("/api/passkey/register/options", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inviteToken }),
  });
  return res.json();
}

async function verifyRegistration(
  inviteToken: string,
  challengeId: string,
  credential: unknown,
  deviceName: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch("/api/passkey/register/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inviteToken, challengeId, credential, deviceName }),
    credentials: "include",
  });
  return res.json();
}

export function PasskeyRegister() {
  // Capture invite token at mount time from the URL, then immediately strip it
  // from the address bar so it doesn't persist in browser history or get copied.
  const [inviteToken] = useState<string>(
    () => new URLSearchParams(window.location.search).get("invite") ?? "",
  );
  const [deviceName, setDeviceName] = useState(navigator.userAgent.split("(")[0].trim() || "My Device");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [inviteValid, setInviteValid] = useState<boolean | null>(null);
  // Cache the options returned by the server pre-validation so that clicking
  // "Register" uses them immediately without a second round-trip.
  const [cachedOptions, setCachedOptions] = useState<RegOptions | null>(null);

  useEffect(() => {
    // Strip the invite token from the URL as soon as it has been captured in
    // state — this prevents it appearing in browser history, logs, or referer
    // headers on any subsequent navigation.
    const url = new URL(window.location.href);
    if (url.searchParams.has("invite")) {
      url.searchParams.delete("invite");
      window.history.replaceState({}, "", url.toString());
    }

    if (!inviteToken) {
      setInviteValid(false);
      return;
    }

    // Pre-validate the invite token against the server so we can show an
    // error immediately rather than only after the biometric prompt fires.
    fetchRegOptions(inviteToken)
      .then((result) => {
        if ("error" in result) {
          setInviteValid(false);
          setError(result.error);
        } else {
          setInviteValid(true);
          setCachedOptions(result);
        }
      })
      .catch(() => setInviteValid(false));
  }, [inviteToken]);

  const handleRegister = useCallback(async () => {
    if (!inviteToken) return;
    setLoading(true);
    setError(null);

    // Use pre-fetched options when available; re-fetch only if they've
    // expired (challenges have a 5-minute TTL on the server).
    let optResult = cachedOptions;
    if (!optResult) {
      const fetched = await fetchRegOptions(inviteToken);
      if ("error" in fetched) {
        setError(fetched.error);
        setLoading(false);
        return;
      }
      optResult = fetched;
    }

    let credential;
    try {
      credential = await startRegistration({ optionsJSON: optResult.options });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("cancelled") || msg.includes("NotAllowed")) {
        setError("Registration cancelled — please try again");
      } else {
        setError(`Passkey error: ${msg}`);
      }
      // Clear cached options so a re-click fetches a fresh challenge.
      setCachedOptions(null);
      setLoading(false);
      return;
    }

    const result = await verifyRegistration(inviteToken, optResult.challengeId, credential, deviceName);
    if (result.ok) {
      setSuccess(true);
    } else {
      setError(result.error ?? "Registration failed");
      setCachedOptions(null);
    }
    setLoading(false);
  }, [inviteToken, deviceName, cachedOptions]);

  if (inviteValid === false) {
    return (
      <div className="h-[100dvh] flex items-center justify-center bg-cc-bg text-cc-fg font-sans-ui antialiased">
        <div className="w-full max-w-sm px-6 text-center">
          <p className="text-cc-error text-sm">Invalid or missing invite token.</p>
          <p className="text-cc-muted text-xs mt-2">
            Run <code className="font-mono bg-cc-hover px-1 py-0.5 rounded">companion-admin create-invite</code> to generate a new link.
          </p>
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div className="h-[100dvh] flex items-center justify-center bg-cc-bg text-cc-fg font-sans-ui antialiased">
        <div className="w-full max-w-sm px-6 text-center">
          <div className="text-4xl mb-4">✓</div>
          <h2 className="text-lg font-semibold mb-2">Passkey registered</h2>
          <p className="text-sm text-cc-muted mb-6">
            Your device is now registered. The invite link has been consumed.
          </p>
          <a
            href="/"
            className="inline-block py-2 px-6 text-sm font-medium bg-cc-primary text-white rounded-md hover:opacity-90 transition-opacity"
          >
            Go to login
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="h-[100dvh] flex items-center justify-center bg-cc-bg text-cc-fg font-sans-ui antialiased">
      <div className="w-full max-w-sm px-6">
        <div className="text-center mb-8">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-12 h-12 mx-auto text-cc-primary mb-4"
          >
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <h1 className="text-xl font-semibold text-cc-fg mb-1">Register Passkey</h1>
          <p className="text-sm text-cc-muted">
            Create a Face ID / Touch ID passkey for this device.
            This invite link is single-use.
          </p>
        </div>

        <div className="mb-4">
          <label htmlFor="device-name" className="block text-xs text-cc-muted mb-1.5">
            Device name (optional)
          </label>
          <input
            id="device-name"
            type="text"
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            placeholder="My MacBook"
            className="w-full px-3 py-2 text-sm bg-cc-hover border border-cc-border rounded-md text-cc-fg placeholder:text-cc-muted/50 focus:outline-none focus:ring-1 focus:ring-cc-primary focus:border-cc-primary"
            disabled={loading}
          />
        </div>

        {error && (
          <p className="mb-4 text-xs text-cc-error" role="alert">{error}</p>
        )}

        <button
          onClick={handleRegister}
          disabled={loading}
          className="w-full py-3 px-4 text-sm font-medium bg-cc-primary text-white rounded-md hover:opacity-90 disabled:opacity-50 transition-opacity cursor-pointer disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {loading ? (
            <>
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
              </svg>
              Registering…
            </>
          ) : (
            "Register with Face ID / Touch ID"
          )}
        </button>

        <p className="mt-6 text-[11px] text-cc-muted text-center leading-relaxed">
          Your biometric data never leaves your device.
          WebAuthn is an open standard — nothing is sent to any server.
        </p>
      </div>
    </div>
  );
}
