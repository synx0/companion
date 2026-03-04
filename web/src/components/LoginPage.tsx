/**
 * LoginPage.tsx — Passkey-based login gate.
 * Replaces the legacy token-based login form.
 */

import { useEffect } from "react";
import { PasskeyLogin } from "./PasskeyLogin.js";

interface LoginPageProps {
  onAuthenticated?: () => void;
}

export function LoginPage({ onAuthenticated = () => window.location.reload() }: LoginPageProps = {}) {
  // Check if URL indicates a registration flow
  useEffect(() => {
    if (window.location.pathname === "/register") {
      // Registration is handled in App.tsx routing — nothing to do here
    }
  }, []);

  return <PasskeyLogin onAuthenticated={onAuthenticated} showRegisterLink />;
}
