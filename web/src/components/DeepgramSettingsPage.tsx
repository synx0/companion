import { useEffect, useState } from "react";
import { api } from "../api.js";
import { navigateHome, navigateToSession } from "../utils/routing.js";
import { useStore } from "../store.js";
import { DeepgramLogo } from "./DeepgramLogo.js";

interface DeepgramSettingsPageProps {
  embedded?: boolean;
}

export function DeepgramSettingsPage({ embedded = false }: DeepgramSettingsPageProps) {
  const [deepgramApiKey, setDeepgramApiKey] = useState("");
  const [configured, setConfigured] = useState(false);
  const [connected, setConnected] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [checkingConnection, setCheckingConnection] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [connectionNote, setConnectionNote] = useState("");

  async function refreshConnectionStatus() {
    setCheckingConnection(true);
    setError("");
    setConnectionNote("");
    try {
      const info = await api.verifyDeepgramConnection();
      setConnected(info.connected);
      setProjectName(info.projectName || "");
      if (info.connected) {
        setConnectionNote("Deepgram connection verified.");
      } else if (info.error) {
        setError(info.error);
      }
    } catch (e: unknown) {
      setConnected(false);
      setProjectName("");
      setConnectionNote("");
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCheckingConnection(false);
    }
  }

  useEffect(() => {
    api.getSettings()
      .then((settings) => {
        setConfigured(settings.deepgramApiKeyConfigured);
        if (settings.deepgramApiKeyConfigured) {
          refreshConnectionStatus().catch(() => {});
        }
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = deepgramApiKey.trim();
    if (!trimmed) {
      setError("Please enter a Deepgram API key.");
      return;
    }

    setSaving(true);
    setError("");
    setSaved(false);
    setConnectionNote("");
    try {
      const settings = await api.updateSettings({ deepgramApiKey: trimmed });
      setConfigured(settings.deepgramApiKeyConfigured);
      setDeepgramApiKey("");
      setSaved(true);
      await refreshConnectionStatus();
      setTimeout(() => setSaved(false), 1800);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function onDisconnect() {
    setSaving(true);
    setError("");
    setSaved(false);
    setConnectionNote("");
    try {
      const settings = await api.updateSettings({ deepgramApiKey: "" });
      setConfigured(settings.deepgramApiKeyConfigured);
      setConnected(false);
      setProjectName("");
      setDeepgramApiKey("");
      setConnectionNote("Deepgram disconnected.");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={`${embedded ? "h-full" : "h-[100dvh]"} bg-cc-bg text-cc-fg font-sans-ui antialiased overflow-y-auto`}>
      <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 sm:py-10 pb-safe">
        <div className="flex items-start justify-between gap-3 mb-6">
          <div>
            <h1 className="text-xl font-semibold text-cc-fg">Deepgram Settings</h1>
            <p className="mt-1 text-sm text-cc-muted">
              Configure push-to-talk speech-to-text for dictation in the Composer.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                window.location.hash = "#/integrations";
              }}
              className="px-3 py-2.5 min-h-[44px] rounded-lg text-sm text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
            >
              Integrations
            </button>
            {!embedded && (
              <button
                onClick={() => {
                  const sessionId = useStore.getState().currentSessionId;
                  if (sessionId) {
                    navigateToSession(sessionId);
                  } else {
                    navigateHome();
                  }
                }}
                className="px-3 py-2.5 min-h-[44px] rounded-lg text-sm text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
              >
                Back
              </button>
            )}
          </div>
        </div>

        <section className="relative overflow-hidden bg-cc-card border border-cc-border rounded-xl p-4 sm:p-6 mb-4">
          <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_top_right,rgba(6,182,212,0.1),transparent_45%)]" />
          <div className="relative flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full border border-cc-border bg-cc-hover/60 text-xs text-cc-muted">
                <DeepgramLogo className="w-3.5 h-3.5 text-cc-fg" />
                <span>Deepgram Integration</span>
              </div>
              <h2 className="mt-3 text-lg sm:text-xl font-semibold text-cc-fg">
                Voice-to-text in your Composer
              </h2>
              <p className="mt-1.5 text-sm text-cc-muted max-w-2xl">
                Hold the microphone button to dictate. Audio is transcribed server-side via Deepgram — your API key never leaves the backend.
              </p>
              <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
                <span className="px-2 py-1 rounded-md bg-cc-hover text-cc-muted">Push-to-talk in Composer</span>
                <span className="px-2 py-1 rounded-md bg-cc-hover text-cc-muted">Server-side transcription</span>
                <span className="px-2 py-1 rounded-md bg-cc-hover text-cc-muted">No key exposure in browser</span>
              </div>
            </div>
            <div className="shrink-0 rounded-xl border border-cc-border bg-cc-bg px-3 py-2 text-right min-w-[170px]">
              <p className="text-[11px] text-cc-muted uppercase tracking-wide">Status</p>
              <p className={`mt-1 text-sm font-medium ${connected ? "text-cc-success" : configured ? "text-amber-500" : "text-cc-muted"}`}>
                {connected ? "Connected" : configured ? "Needs verification" : "Not connected"}
              </p>
              <p className="mt-0.5 text-[11px] text-cc-muted truncate">{projectName || "No project linked yet"}</p>
            </div>
          </div>
        </section>

        <form onSubmit={onSave} className="bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5 space-y-4">
          <h2 className="text-sm font-semibold text-cc-fg flex items-center gap-2">
            <DeepgramLogo className="w-4 h-4 text-cc-fg" />
            <span>Deepgram Credentials</span>
          </h2>
          <div>
            <label className="block text-sm font-medium mb-1.5" htmlFor="deepgram-key">
              Deepgram API Key
            </label>
            <input
              id="deepgram-key"
              type="password"
              value={deepgramApiKey}
              onChange={(e) => setDeepgramApiKey(e.target.value)}
              placeholder={configured ? "Configured. Enter a new key to replace." : "Enter your Deepgram API key"}
              className="w-full px-3 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/60"
            />
            <p className="mt-1.5 text-xs text-cc-muted">
              Used to transcribe audio from push-to-talk dictation. Get a key at{" "}
              <a href="https://console.deepgram.com" target="_blank" rel="noopener noreferrer" className="text-cc-primary hover:underline">
                console.deepgram.com
              </a>.
            </p>
          </div>

          {error && (
            <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
              {error}
            </div>
          )}

          {connectionNote && (
            <div className="px-3 py-2 rounded-lg bg-cc-success/10 border border-cc-success/20 text-xs text-cc-success">
              {connectionNote}
            </div>
          )}

          {saved && (
            <div className="px-3 py-2 rounded-lg bg-cc-success/10 border border-cc-success/20 text-xs text-cc-success">
              Integration saved.
            </div>
          )}

          <div className="flex items-center justify-between gap-3 flex-wrap">
            <span className="text-xs text-cc-muted">
              {loading ? "Loading..." : configured ? "Deepgram key configured" : "Deepgram key not configured"}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onDisconnect}
                disabled={saving || loading || !configured}
                className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  saving || loading || !configured
                    ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                    : "bg-cc-error/10 hover:bg-cc-error/20 text-cc-error cursor-pointer"
                }`}
              >
                Disconnect
              </button>
              <button
                type="button"
                onClick={() => {
                  refreshConnectionStatus().catch(() => {});
                }}
                disabled={checkingConnection || loading || !configured}
                className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  checkingConnection || loading || !configured
                    ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                    : "bg-cc-hover hover:bg-cc-active text-cc-fg cursor-pointer"
                }`}
              >
                {checkingConnection ? "Checking..." : "Verify"}
              </button>
              <button
                type="submit"
                disabled={saving || loading}
                className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  saving || loading
                    ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                    : "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
                }`}
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </form>

        <section className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="bg-cc-card border border-cc-border rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-wide text-cc-muted">1. Configure</p>
            <p className="mt-1 text-sm text-cc-fg">Add a Deepgram API key and verify the connection.</p>
          </div>
          <div className="bg-cc-card border border-cc-border rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-wide text-cc-muted">2. Hold</p>
            <p className="mt-1 text-sm text-cc-fg">Hold the microphone button in the Composer to record.</p>
          </div>
          <div className="bg-cc-card border border-cc-border rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-wide text-cc-muted">3. Release</p>
            <p className="mt-1 text-sm text-cc-fg">Release to transcribe — text appears in the message input.</p>
          </div>
        </section>
      </div>
    </div>
  );
}
