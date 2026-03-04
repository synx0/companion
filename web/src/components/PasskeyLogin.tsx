/**
 * PasskeyLogin.tsx
 *
 * WebAuthn authentication page.
 * Replaces the token-based LoginPage.
 * Uses Face ID / Touch ID / platform authenticator only.
 */

import { useState, useCallback, useEffect } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";

async function fetchAuthOptions(): Promise<{ options: PublicKeyCredentialRequestOptionsJSON; challengeId: string } | null> {
  try {
    const res = await fetch("/api/passkey/auth/options", { method: "POST" });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function verifyAuth(challengeId: string, credential: unknown): Promise<boolean> {
  const res = await fetch("/api/passkey/auth/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challengeId, credential }),
    credentials: "include",
  });
  return res.ok;
}

interface PasskeyLoginProps {
  onAuthenticated: () => void;
  /** If true, shows a link to go to the register page */
  showRegisterLink?: boolean;
}

export function PasskeyLogin({ onAuthenticated, showRegisterLink }: PasskeyLoginProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noCredentials, setNoCredentials] = useState(false);

  useEffect(() => {
    // Check if any passkeys are registered yet
    fetch("/api/passkey/status")
      .then((r) => r.json())
      .then((data: { hasCredentials: boolean }) => {
        if (!data.hasCredentials) setNoCredentials(true);
      })
      .catch(() => {});
  }, []);

  const handleLogin = useCallback(async () => {
    setLoading(true);
    setError(null);

    const result = await fetchAuthOptions();
    if (!result) {
      setError("Failed to get authentication options from server");
      setLoading(false);
      return;
    }

    let credential;
    try {
      credential = await startAuthentication({ optionsJSON: result.options });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("cancelled") || msg.includes("abort") || msg.includes("NotAllowed")) {
        setError("Authentication cancelled");
      } else {
        setError(`Passkey error: ${msg}`);
      }
      setLoading(false);
      return;
    }

    const ok = await verifyAuth(result.challengeId, credential);
    if (ok) {
      onAuthenticated();
    } else {
      setError("Authentication failed — try again");
    }
    setLoading(false);
  }, [onAuthenticated]);

  return (
    <div className="h-[100dvh] flex items-center justify-center bg-cc-bg text-cc-fg font-sans-ui antialiased">
      <div className="w-full max-w-sm px-6">
        <div className="text-center mb-10">
          <div className="text-4xl mb-4" aria-hidden>
            {/* Face ID icon */}
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="w-12 h-12 mx-auto text-cc-primary"
            >
              <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z" />
              <path d="M8 12s1 2 4 2 4-2 4-2" />
              <line x1="9" y1="9" x2="9.01" y2="9" />
              <line x1="15" y1="9" x2="15.01" y2="9" />
            </svg>
          </div>
          <h1 className="text-xl font-semibold text-cc-fg mb-1">Cook Land</h1>
          <p className="text-sm text-cc-muted">Sign in with your passkey</p>
        </div>

        {noCredentials && (
          <div className="mb-6 p-3 rounded-md bg-cc-hover border border-cc-border text-sm text-cc-muted text-center">
            No passkeys registered yet.{" "}
            {showRegisterLink && (
              <span>
                Use{" "}
                <code className="font-mono text-xs bg-cc-bg px-1 py-0.5 rounded">
                  companion-admin create-invite
                </code>{" "}
                to generate a registration link.
              </span>
            )}
          </div>
        )}

        {error && (
          <p className="mb-4 text-xs text-cc-error text-center" role="alert">
            {error}
          </p>
        )}

        <button
          onClick={handleLogin}
          disabled={loading || noCredentials}
          className="w-full py-3 px-4 text-sm font-medium bg-cc-primary text-white rounded-md hover:opacity-90 disabled:opacity-50 transition-opacity cursor-pointer disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {loading ? (
            <>
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
              </svg>
              Waiting for biometric…
            </>
          ) : (
            "Sign in with Face ID / Touch ID"
          )}
        </button>

        <p className="mt-6 text-[11px] text-cc-muted text-center leading-relaxed">
          Authentication uses your device's biometric sensor.
          No password or token is sent over the network.
        </p>
      </div>
    </div>
  );
}
