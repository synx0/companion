import { useState, useEffect } from "react";
import { authClient } from "./lib/auth-client";
import { Dashboard } from "./pages/Dashboard";
import { Landing } from "./pages/Landing";

/**
 * Root application component for Companion Cloud.
 *
 * Auth-aware routing using Better Auth's useSession hook:
 * - Unauthenticated → Landing page (login/signup + pricing)
 * - Authenticated   → Dashboard (instance management)
 */
export default function App() {
  const [hash, setHash] = useState(window.location.hash);
  const session = authClient.useSession();

  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Styled loading state while checking session.
  // If there's an error (e.g. auth server not configured), treat as unauthenticated.
  if (session.isPending && !session.error) {
    return (
      <div className="h-screen bg-cc-bg flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-2 h-2 rounded-full bg-cc-primary animate-pulse-dot" />
          <span className="font-[family-name:var(--font-display)] text-xs text-cc-muted-fg">
            companion<span className="text-cc-primary">.</span>cloud
          </span>
        </div>
      </div>
    );
  }

  // Unauthenticated or auth error → landing page
  if (!session.data) {
    return <Landing />;
  }

  // Authenticated → dashboard
  return <Dashboard />;
}
