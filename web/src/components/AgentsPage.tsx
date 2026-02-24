import { useState, useEffect, useCallback, useRef } from "react";
import { api, type AgentInfo, type AgentExport, type AgentExecution, type McpServerConfigAgent, type CompanionEnv } from "../api.js";
import { getModelsForBackend, getDefaultModel, getModesForBackend, getDefaultMode } from "../utils/backends.js";
import { FolderPicker } from "./FolderPicker.js";
import { timeAgo } from "../utils/time-ago.js";
import type { Route } from "../utils/routing.js";

// ─── Types ──────────────────────────────────────────────────────────────────

interface Props {
  route: Route;
}

interface McpServerFormEntry {
  type: "stdio" | "sse" | "http";
  command: string;
  args: string;
  url: string;
  env: string;
}

interface AgentFormData {
  name: string;
  description: string;
  icon: string;
  backendType: "claude" | "codex";
  model: string;
  permissionMode: string;
  cwd: string;
  useTempDir: boolean;
  prompt: string;
  envSlug: string;
  // Environment variables (key-value pairs)
  env: { key: string; value: string }[];
  // Codex internet access
  codexInternetAccess: boolean;
  // Git
  branch: string;
  createBranch: boolean;
  useWorktree: boolean;
  // MCP Servers
  mcpServers: Record<string, McpServerConfigAgent>;
  // Skills
  skills: string[];
  // Docker/Container
  containerImage: string;
  containerPorts: string;
  containerVolumes: string;
  containerInitScript: string;
  // Allowed tools
  allowedTools: string[];
  // Triggers
  webhookEnabled: boolean;
  scheduleEnabled: boolean;
  scheduleExpression: string;
  scheduleRecurring: boolean;
}

const EMPTY_FORM: AgentFormData = {
  name: "",
  description: "",
  icon: "",
  backendType: "claude",
  model: getDefaultModel("claude"),
  permissionMode: getDefaultMode("claude"),
  cwd: "",
  useTempDir: false,
  prompt: "",
  envSlug: "",
  env: [],
  codexInternetAccess: false,
  branch: "",
  createBranch: false,
  useWorktree: false,
  mcpServers: {},
  skills: [],
  containerImage: "",
  containerPorts: "",
  containerVolumes: "",
  containerInitScript: "",
  allowedTools: [],
  webhookEnabled: false,
  scheduleEnabled: false,
  scheduleExpression: "0 8 * * *",
  scheduleRecurring: true,
};

const CRON_PRESETS: { label: string; value: string }[] = [
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every day at 8am", value: "0 8 * * *" },
  { label: "Every day at noon", value: "0 12 * * *" },
  { label: "Weekdays at 9am", value: "0 9 * * 1-5" },
  { label: "Every Monday at 8am", value: "0 8 * * 1" },
  { label: "Every 30 minutes", value: "*/30 * * * *" },
];

const ICON_OPTIONS = ["", "🤖", "📝", "🔍", "🛡️", "📊", "🧪", "🚀", "🔧", "📋", "💡"];

// ─── Helpers ────────────────────────────────────────────────────────────────

function humanizeSchedule(expression: string, recurring: boolean): string {
  if (!recurring) return "One-time";
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return expression;
  const [minute, hour, , , dayOfWeek] = parts;
  if (expression === "* * * * *") return "Every minute";
  if (hour === "*" && minute.startsWith("*/")) {
    const n = parseInt(minute.slice(2), 10);
    return n === 1 ? "Every minute" : `Every ${n} minutes`;
  }
  if (minute === "0" && hour === "*") return "Every hour";
  if (minute === "0" && hour.startsWith("*/")) {
    const n = parseInt(hour.slice(2), 10);
    return n === 1 ? "Every hour" : `Every ${n} hours`;
  }
  if (minute !== "*" && hour !== "*" && !hour.includes("/") && !hour.includes(",")) {
    const h = parseInt(hour, 10);
    const m = parseInt(minute, 10);
    if (!isNaN(h) && !isNaN(m)) {
      const period = h >= 12 ? "PM" : "AM";
      const displayHour = h === 0 ? 12 : h > 12 ? h - 12 : h;
      const displayMin = m.toString().padStart(2, "0");
      const timeStr = `${displayHour}:${displayMin} ${period}`;
      if (dayOfWeek === "*") return `Daily at ${timeStr}`;
      if (dayOfWeek === "1-5") return `Weekdays at ${timeStr}`;
    }
  }
  return expression;
}

function getWebhookUrl(agent: AgentInfo): string {
  const base = window.location.origin;
  return `${base}/api/agents/${encodeURIComponent(agent.id)}/webhook/${agent.triggers?.webhook?.secret || ""}`;
}

/** Count how many advanced features are configured */
function countAdvancedFeatures(form: AgentFormData): number {
  let count = 0;
  if (Object.keys(form.mcpServers).length > 0) count++;
  if (form.skills.length > 0) count++;
  if (form.containerImage) count++;
  if (form.allowedTools.length > 0) count++;
  return count;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function AgentsPage({ route }: Props) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"list" | "edit">("list");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<AgentFormData>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [runInputAgent, setRunInputAgent] = useState<AgentInfo | null>(null);
  const [runInput, setRunInput] = useState("");
  const [copiedWebhook, setCopiedWebhook] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load agents
  const loadAgents = useCallback(async () => {
    try {
      const list = await api.listAgents();
      setAgents(list);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  // Handle route-based navigation to agent detail
  useEffect(() => {
    if (route.page === "agent-detail" && "agentId" in route) {
      const agent = agents.find((a) => a.id === route.agentId);
      if (agent) {
        startEdit(agent);
      }
    }
  }, [route, agents]);

  // ── Form helpers ──

  function startCreate() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setError("");
    setView("edit");
  }

  function startEdit(agent: AgentInfo) {
    setEditingId(agent.id);
    setForm({
      name: agent.name,
      description: agent.description,
      icon: agent.icon || "",
      backendType: agent.backendType,
      model: agent.model,
      permissionMode: agent.permissionMode,
      cwd: agent.cwd === "temp" ? "" : agent.cwd,
      useTempDir: agent.cwd === "temp" || !agent.cwd,
      prompt: agent.prompt,
      envSlug: agent.envSlug || "",
      env: agent.env
        ? Object.entries(agent.env).map(([key, value]) => ({ key, value }))
        : [],
      codexInternetAccess: agent.codexInternetAccess ?? false,
      branch: agent.branch || "",
      createBranch: agent.createBranch ?? false,
      useWorktree: agent.useWorktree ?? false,
      mcpServers: agent.mcpServers || {},
      skills: agent.skills || [],
      containerImage: agent.container?.image || "",
      containerPorts: (agent.container?.ports || []).join(", "),
      containerVolumes: (agent.container?.volumes || []).join("\n"),
      containerInitScript: agent.container?.initScript || "",
      allowedTools: agent.allowedTools || [],
      webhookEnabled: agent.triggers?.webhook?.enabled ?? false,
      scheduleEnabled: agent.triggers?.schedule?.enabled ?? false,
      scheduleExpression: agent.triggers?.schedule?.expression || "0 8 * * *",
      scheduleRecurring: agent.triggers?.schedule?.recurring ?? true,
    });
    setError("");
    setView("edit");
  }

  function cancelEdit() {
    setView("list");
    setEditingId(null);
    setError("");
    window.location.hash = "#/agents";
  }

  async function handleSave() {
    setSaving(true);
    setError("");
    try {
      // Build env record from key-value pairs, omitting empty keys
      const envRecord: Record<string, string> = {};
      for (const { key, value } of form.env) {
        if (key.trim()) envRecord[key.trim()] = value;
      }

      // Build container config, only include if image is set
      const container = form.containerImage
        ? {
            image: form.containerImage,
            ports: form.containerPorts
              ? form.containerPorts.split(",").map((p) => parseInt(p.trim(), 10)).filter((n) => !isNaN(n))
              : undefined,
            volumes: form.containerVolumes
              ? form.containerVolumes.split("\n").map((v) => v.trim()).filter(Boolean)
              : undefined,
            initScript: form.containerInitScript || undefined,
          }
        : undefined;

      const data: Partial<AgentInfo> = {
        version: 1,
        name: form.name,
        description: form.description,
        icon: form.icon || undefined,
        backendType: form.backendType,
        model: form.model,
        permissionMode: form.permissionMode,
        cwd: form.useTempDir ? "temp" : form.cwd,
        prompt: form.prompt,
        envSlug: form.envSlug || undefined,
        env: Object.keys(envRecord).length > 0 ? envRecord : undefined,
        codexInternetAccess: form.backendType === "codex" ? form.codexInternetAccess : undefined,
        branch: form.branch || undefined,
        createBranch: form.branch ? form.createBranch : undefined,
        useWorktree: form.branch ? form.useWorktree : undefined,
        mcpServers: Object.keys(form.mcpServers).length > 0 ? form.mcpServers : undefined,
        skills: form.skills.length > 0 ? form.skills : undefined,
        container,
        allowedTools: form.allowedTools.length > 0 ? form.allowedTools : undefined,
        enabled: true,
        triggers: {
          webhook: { enabled: form.webhookEnabled, secret: "" },
          schedule: {
            enabled: form.scheduleEnabled,
            expression: form.scheduleExpression,
            recurring: form.scheduleRecurring,
          },
        },
      };

      if (editingId) {
        await api.updateAgent(editingId, data);
      } else {
        await api.createAgent(data);
      }

      await loadAgents();
      setView("list");
      setEditingId(null);
      window.location.hash = "#/agents";
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this agent?")) return;
    try {
      await api.deleteAgent(id);
      await loadAgents();
    } catch {
      // ignore
    }
  }

  async function handleToggle(id: string) {
    try {
      await api.toggleAgent(id);
      await loadAgents();
    } catch {
      // ignore
    }
  }

  async function handleRun(agent: AgentInfo, input?: string) {
    try {
      await api.runAgent(agent.id, input);
      setRunInputAgent(null);
      setRunInput("");
      await loadAgents();
    } catch {
      // ignore
    }
  }

  function handleRunClick(agent: AgentInfo) {
    if (agent.prompt.includes("{{input}}")) {
      setRunInputAgent(agent);
      setRunInput("");
    } else {
      handleRun(agent);
    }
  }

  async function handleExport(agent: AgentInfo) {
    try {
      const exported = await api.exportAgent(agent.id);
      const blob = new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${agent.id}.agent.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text) as AgentExport;
      await api.importAgent(data);
      await loadAgents();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to import agent");
    }
    // Reset file input
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function copyWebhookUrl(agent: AgentInfo) {
    const url = getWebhookUrl(agent);
    navigator.clipboard.writeText(url).then(() => {
      setCopiedWebhook(agent.id);
      setTimeout(() => setCopiedWebhook(null), 2000);
    });
  }

  async function handleRegenerateSecret(id: string) {
    if (!confirm("Regenerate webhook secret? The old URL will stop working.")) return;
    try {
      await api.regenerateAgentWebhookSecret(id);
      await loadAgents();
    } catch {
      // ignore
    }
  }

  // ── Render ──

  if (view === "edit") {
    return <AgentEditor
      form={form}
      setForm={setForm}
      editingId={editingId}
      error={error}
      saving={saving}
      onSave={handleSave}
      onCancel={cancelEdit}
    />;
  }

  return (
    <div className="h-full overflow-y-auto bg-cc-bg">
      <div className="max-w-4xl mx-auto p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-lg font-semibold text-cc-fg">Agents</h1>
            <p className="text-xs text-cc-muted mt-0.5">Reusable autonomous session configs. Run manually, via webhook, or on a schedule.</p>
          </div>
          <div className="flex gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              onChange={handleImport}
              className="hidden"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="px-3 py-1.5 text-xs rounded-lg border border-cc-border text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
            >
              Import
            </button>
            <button
              onClick={startCreate}
              className="px-3 py-1.5 text-xs rounded-lg bg-cc-primary text-white hover:bg-cc-primary-hover transition-colors cursor-pointer"
            >
              + New Agent
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/30 text-cc-error text-xs">
            {error}
          </div>
        )}

        {/* Agent Cards */}
        {loading ? (
          <div className="text-sm text-cc-muted">Loading...</div>
        ) : agents.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-3xl mb-3">🤖</div>
            <p className="text-sm text-cc-muted">No agents yet</p>
            <p className="text-xs text-cc-muted mt-1">Create an agent to get started, or import a shared JSON config.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {agents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                onEdit={() => startEdit(agent)}
                onDelete={() => handleDelete(agent.id)}
                onToggle={() => handleToggle(agent.id)}
                onRun={() => handleRunClick(agent)}
                onExport={() => handleExport(agent)}
                onCopyWebhook={() => copyWebhookUrl(agent)}
                onRegenerateSecret={() => handleRegenerateSecret(agent.id)}
                copiedWebhook={copiedWebhook === agent.id}
              />
            ))}
          </div>
        )}
      </div>

      {/* Run Input Modal */}
      {runInputAgent && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setRunInputAgent(null)}
        >
          <div
            className="bg-cc-card rounded-[14px] shadow-2xl p-6 w-full max-w-lg border border-cc-border"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-medium text-cc-fg mb-1">Run {runInputAgent.name}</h3>
            <p className="text-xs text-cc-muted mb-3">This agent's prompt uses {"{{input}}"} — provide the input below.</p>
            <textarea
              value={runInput}
              onChange={(e) => setRunInput(e.target.value)}
              placeholder="Enter input for the agent..."
              className="w-full px-3 py-2 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-sm resize-none h-24 focus:outline-none focus:ring-1 focus:ring-cc-primary"
              autoFocus
            />
            <div className="flex justify-end gap-2 mt-3">
              <button
                onClick={() => setRunInputAgent(null)}
                className="px-3 py-1.5 text-xs rounded-lg border border-cc-border text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => handleRun(runInputAgent, runInput)}
                className="px-3 py-1.5 text-xs rounded-lg bg-cc-primary text-white hover:bg-cc-primary-hover transition-colors cursor-pointer"
              >
                Run
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Agent Card ─────────────────────────────────────────────────────────────

function AgentCard({
  agent,
  onEdit,
  onDelete,
  onToggle,
  onRun,
  onExport,
  onCopyWebhook,
  onRegenerateSecret,
  copiedWebhook,
}: {
  agent: AgentInfo;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
  onRun: () => void;
  onExport: () => void;
  onCopyWebhook: () => void;
  onRegenerateSecret: () => void;
  copiedWebhook: boolean;
}) {
  const triggers: string[] = ["Manual"];
  if (agent.triggers?.webhook?.enabled) triggers.push("Webhook");
  if (agent.triggers?.schedule?.enabled) {
    triggers.push(humanizeSchedule(
      agent.triggers.schedule.expression,
      agent.triggers.schedule.recurring,
    ));
  }

  return (
    <div className="rounded-xl border border-cc-border bg-cc-card p-4 hover:border-cc-primary/30 transition-colors">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <div className="text-xl flex-shrink-0">{agent.icon || "🤖"}</div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium text-cc-fg truncate">{agent.name}</h3>
              <span className={`px-1.5 py-0.5 text-[10px] rounded-full font-medium ${agent.enabled ? "bg-cc-success/15 text-cc-success" : "bg-cc-muted/15 text-cc-muted"}`}>
                {agent.enabled ? "Enabled" : "Disabled"}
              </span>
              <span className="px-1.5 py-0.5 text-[10px] rounded-full bg-cc-hover text-cc-muted">
                {agent.backendType === "codex" ? "Codex" : "Claude"}
              </span>
            </div>
            {agent.description && (
              <p className="text-xs text-cc-muted mt-0.5 truncate">{agent.description}</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0 ml-3">
          <button
            onClick={onRun}
            className="px-2.5 py-1 text-xs rounded-lg bg-cc-primary text-white hover:bg-cc-primary-hover transition-colors cursor-pointer"
            title="Run agent"
          >
            Run
          </button>
          <button
            onClick={onEdit}
            className="p-1.5 rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
            title="Edit"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
              <path d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61z" />
            </svg>
          </button>
          <button
            onClick={onExport}
            className="p-1.5 rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
            title="Export JSON"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
              <path d="M3.5 13a.5.5 0 01-.5-.5V11h1v1h8v-1h1v1.5a.5.5 0 01-.5.5h-9zM8 2a.5.5 0 01.5.5v6.793l2.146-2.147a.5.5 0 01.708.708l-3 3a.5.5 0 01-.708 0l-3-3a.5.5 0 01.708-.708L7.5 9.293V2.5A.5.5 0 018 2z" />
            </svg>
          </button>
          <button
            onClick={onToggle}
            className="p-1.5 rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
            title={agent.enabled ? "Disable" : "Enable"}
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
              {agent.enabled ? (
                <path d="M5 3a5 5 0 000 10h6a5 5 0 000-10H5zm6 3a2 2 0 110 4 2 2 0 010-4z" />
              ) : (
                <path d="M11 3a5 5 0 010 10H5A5 5 0 015 3h6zM5 6a2 2 0 100 4 2 2 0 000-4z" />
              )}
            </svg>
          </button>
          <button
            onClick={onDelete}
            className="p-1.5 rounded-lg text-cc-muted hover:text-cc-error hover:bg-cc-error/10 transition-colors cursor-pointer"
            title="Delete"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
              <path d="M5.5 5.5a.5.5 0 01.5.5v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm5 0a.5.5 0 01.5.5v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm-7-3A1.5 1.5 0 015 1h6a1.5 1.5 0 011.5 1.5H14a.5.5 0 010 1h-.554L12.2 14.118A1.5 1.5 0 0110.706 15H5.294a1.5 1.5 0 01-1.494-.882L2.554 3.5H2a.5.5 0 010-1h1.5z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Trigger badges + stats */}
      <div className="flex items-center justify-between mt-3 pt-3 border-t border-cc-border/50">
        <div className="flex items-center gap-1.5 flex-wrap">
          {triggers.map((t, i) => (
            <span key={i} className="px-2 py-0.5 text-[10px] rounded-full bg-cc-hover text-cc-muted">
              {t}
            </span>
          ))}
          {agent.triggers?.webhook?.enabled && (
            <button
              onClick={onCopyWebhook}
              className="px-2 py-0.5 text-[10px] rounded-full bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 transition-colors cursor-pointer"
              title="Copy webhook URL"
            >
              {copiedWebhook ? "Copied!" : "Copy URL"}
            </button>
          )}
        </div>
        <div className="flex items-center gap-3 text-[10px] text-cc-muted">
          {agent.totalRuns > 0 && <span>{agent.totalRuns} run{agent.totalRuns !== 1 ? "s" : ""}</span>}
          {agent.lastRunAt && <span>Last: {timeAgo(agent.lastRunAt)}</span>}
          {agent.nextRunAt && <span>Next: {timeAgo(agent.nextRunAt)}</span>}
        </div>
      </div>
    </div>
  );
}

// ─── Agent Editor ───────────────────────────────────────────────────────────

function AgentEditor({
  form,
  setForm,
  editingId,
  error,
  saving,
  onSave,
  onCancel,
}: {
  form: AgentFormData;
  setForm: (f: AgentFormData | ((prev: AgentFormData) => AgentFormData)) => void;
  editingId: string | null;
  error: string;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const models = getModelsForBackend(form.backendType);
  const modes = getModesForBackend(form.backendType);
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(() => countAdvancedFeatures(form) > 0);
  const [showMcpForm, setShowMcpForm] = useState(false);
  const [mcpFormName, setMcpFormName] = useState("");
  const [mcpFormData, setMcpFormData] = useState<McpServerFormEntry>({
    type: "stdio",
    command: "",
    args: "",
    url: "",
    env: "",
  });
  const [availableSkills, setAvailableSkills] = useState<{ slug: string; name: string; description: string }[]>([]);
  const [envProfiles, setEnvProfiles] = useState<CompanionEnv[]>([]);
  const [allowedToolInput, setAllowedToolInput] = useState("");

  // Fetch skills and env profiles on mount
  useEffect(() => {
    api.listSkills().then(setAvailableSkills).catch(() => {});
    api.listEnvs().then(setEnvProfiles).catch(() => {});
  }, []);

  function updateField<K extends keyof AgentFormData>(key: K, value: AgentFormData[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function handleBackendChange(backend: "claude" | "codex") {
    setForm((prev) => ({
      ...prev,
      backendType: backend,
      model: getDefaultModel(backend),
      permissionMode: getDefaultMode(backend),
    }));
  }

  // ── Env vars helpers ──
  function addEnvVar() {
    setForm((prev) => ({ ...prev, env: [...prev.env, { key: "", value: "" }] }));
  }
  function updateEnvVar(index: number, field: "key" | "value", val: string) {
    setForm((prev) => {
      const updated = [...prev.env];
      updated[index] = { ...updated[index], [field]: val };
      return { ...prev, env: updated };
    });
  }
  function removeEnvVar(index: number) {
    setForm((prev) => ({ ...prev, env: prev.env.filter((_, i) => i !== index) }));
  }

  // ── MCP server helpers ──
  function addMcpServer() {
    if (!mcpFormName.trim()) return;
    const entry: McpServerConfigAgent = { type: mcpFormData.type };
    if (mcpFormData.type === "stdio") {
      entry.command = mcpFormData.command;
      entry.args = mcpFormData.args ? mcpFormData.args.split(" ").filter(Boolean) : undefined;
    } else {
      entry.url = mcpFormData.url;
    }
    if (mcpFormData.env.trim()) {
      try {
        entry.env = JSON.parse(mcpFormData.env);
      } catch { /* ignore parse errors */ }
    }
    setForm((prev) => ({
      ...prev,
      mcpServers: { ...prev.mcpServers, [mcpFormName.trim()]: entry },
    }));
    setMcpFormName("");
    setMcpFormData({ type: "stdio", command: "", args: "", url: "", env: "" });
    setShowMcpForm(false);
  }
  function removeMcpServer(name: string) {
    setForm((prev) => {
      const updated = { ...prev.mcpServers };
      delete updated[name];
      return { ...prev, mcpServers: updated };
    });
  }

  // ── Skills toggle ──
  function toggleSkill(slug: string) {
    setForm((prev) => ({
      ...prev,
      skills: prev.skills.includes(slug)
        ? prev.skills.filter((s) => s !== slug)
        : [...prev.skills, slug],
    }));
  }

  // ── Allowed tools helpers ──
  function addAllowedTool(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && allowedToolInput.trim()) {
      e.preventDefault();
      const tool = allowedToolInput.trim();
      if (!form.allowedTools.includes(tool)) {
        updateField("allowedTools", [...form.allowedTools, tool]);
      }
      setAllowedToolInput("");
    }
  }
  function removeAllowedTool(tool: string) {
    updateField("allowedTools", form.allowedTools.filter((t) => t !== tool));
  }

  return (
    <div className="h-full overflow-y-auto bg-cc-bg">
      <div className="max-w-3xl mx-auto p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <button
              onClick={onCancel}
              className="p-1.5 rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                <path d="M11 2L5 8l6 6" stroke="currentColor" strokeWidth="2" fill="none" />
              </svg>
            </button>
            <h1 className="text-lg font-semibold text-cc-fg">
              {editingId ? "Edit Agent" : "New Agent"}
            </h1>
          </div>
          <div className="flex gap-2">
            <button
              onClick={onCancel}
              className="px-3 py-1.5 text-xs rounded-lg border border-cc-border text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={onSave}
              disabled={saving || !form.name.trim() || !form.prompt.trim()}
              className="px-3 py-1.5 text-xs rounded-lg bg-cc-primary text-white hover:bg-cc-primary-hover transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
            >
              {saving ? "Saving..." : editingId ? "Save" : "Create"}
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/30 text-cc-error text-xs">
            {error}
          </div>
        )}

        <div className="space-y-6">
          {/* ── Basics ── */}
          <section>
            <h2 className="text-xs font-medium text-cc-muted uppercase tracking-wider mb-3">Basics</h2>
            <div className="space-y-3">
              <div className="flex gap-3">
                <div className="flex-shrink-0">
                  <label className="block text-xs text-cc-muted mb-1">Icon</label>
                  <select
                    value={form.icon}
                    onChange={(e) => updateField("icon", e.target.value)}
                    className="w-14 h-9 px-1 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-center text-lg focus:outline-none focus:ring-1 focus:ring-cc-primary"
                  >
                    {ICON_OPTIONS.map((ic) => (
                      <option key={ic} value={ic}>{ic || "—"}</option>
                    ))}
                  </select>
                </div>
                <div className="flex-1">
                  <label className="block text-xs text-cc-muted mb-1">Name *</label>
                  <input
                    value={form.name}
                    onChange={(e) => updateField("name", e.target.value)}
                    placeholder="e.g., Docs Writer"
                    className="w-full px-3 py-2 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-sm focus:outline-none focus:ring-1 focus:ring-cc-primary"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs text-cc-muted mb-1">Description</label>
                <input
                  value={form.description}
                  onChange={(e) => updateField("description", e.target.value)}
                  placeholder="What does this agent do?"
                  className="w-full px-3 py-2 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-sm focus:outline-none focus:ring-1 focus:ring-cc-primary"
                />
              </div>
            </div>
          </section>

          {/* ── Prompt ── */}
          <section>
            <h2 className="text-xs font-medium text-cc-muted uppercase tracking-wider mb-3">Prompt *</h2>
            <textarea
              value={form.prompt}
              onChange={(e) => updateField("prompt", e.target.value)}
              placeholder={"Write the agent's instructions here.\nUse {{input}} as a placeholder for trigger-provided input."}
              className="w-full px-3 py-2 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-sm resize-none h-40 font-mono-code focus:outline-none focus:ring-1 focus:ring-cc-primary"
            />
            <p className="text-[10px] text-cc-muted mt-1">
              Use <code className="px-1 py-0.5 rounded bg-cc-hover">{"{{input}}"}</code> where trigger input should be inserted.
            </p>
          </section>

          {/* ── Backend & Model ── */}
          <section>
            <h2 className="text-xs font-medium text-cc-muted uppercase tracking-wider mb-3">Backend</h2>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-cc-muted mb-1">Provider</label>
                <div className="flex rounded-lg border border-cc-border overflow-hidden">
                  <button
                    onClick={() => handleBackendChange("claude")}
                    className={`flex-1 px-3 py-1.5 text-xs transition-colors cursor-pointer ${form.backendType === "claude" ? "bg-cc-primary text-white" : "bg-cc-input-bg text-cc-muted hover:text-cc-fg"}`}
                  >
                    Claude
                  </button>
                  <button
                    onClick={() => handleBackendChange("codex")}
                    className={`flex-1 px-3 py-1.5 text-xs transition-colors cursor-pointer ${form.backendType === "codex" ? "bg-cc-primary text-white" : "bg-cc-input-bg text-cc-muted hover:text-cc-fg"}`}
                  >
                    Codex
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-xs text-cc-muted mb-1">Model</label>
                <select
                  value={form.model}
                  onChange={(e) => updateField("model", e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-sm focus:outline-none focus:ring-1 focus:ring-cc-primary"
                >
                  {models.map((m) => (
                    <option key={m.value} value={m.value}>{m.icon} {m.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-cc-muted mb-1">Mode</label>
                <select
                  value={form.permissionMode}
                  onChange={(e) => updateField("permissionMode", e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-sm focus:outline-none focus:ring-1 focus:ring-cc-primary"
                >
                  {modes.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </div>
            </div>
            {/* Codex internet access toggle */}
            {form.backendType === "codex" && (
              <label className="flex items-center gap-2 text-sm text-cc-fg cursor-pointer mt-3">
                <input
                  type="checkbox"
                  checked={form.codexInternetAccess}
                  onChange={(e) => updateField("codexInternetAccess", e.target.checked)}
                  className="rounded"
                />
                Allow internet access
              </label>
            )}
          </section>

          {/* ── Working Directory ── */}
          <section>
            <h2 className="text-xs font-medium text-cc-muted uppercase tracking-wider mb-3">Working Directory</h2>
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm text-cc-fg cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.useTempDir}
                  onChange={(e) => updateField("useTempDir", e.target.checked)}
                  className="rounded"
                />
                Use temporary directory
              </label>
              {!form.useTempDir && (
                <div className="flex gap-2">
                  <input
                    value={form.cwd}
                    onChange={(e) => updateField("cwd", e.target.value)}
                    placeholder="/path/to/project"
                    className="flex-1 px-3 py-2 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-sm focus:outline-none focus:ring-1 focus:ring-cc-primary"
                  />
                  <button
                    onClick={() => setShowFolderPicker(true)}
                    className="px-3 py-2 rounded-lg border border-cc-border text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors text-xs cursor-pointer"
                  >
                    Browse
                  </button>
                </div>
              )}
            </div>
            {showFolderPicker && (
              <FolderPicker
                initialPath={form.cwd || ""}
                onSelect={(path) => {
                  updateField("cwd", path);
                  setShowFolderPicker(false);
                }}
                onClose={() => setShowFolderPicker(false)}
              />
            )}
          </section>

          {/* ── Environment ── */}
          <section>
            <h2 className="text-xs font-medium text-cc-muted uppercase tracking-wider mb-3">Environment</h2>
            <div className="space-y-3">
              {/* Env profile dropdown */}
              <div>
                <label className="block text-xs text-cc-muted mb-1">Environment Profile</label>
                <select
                  value={form.envSlug}
                  onChange={(e) => updateField("envSlug", e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-sm focus:outline-none focus:ring-1 focus:ring-cc-primary"
                >
                  <option value="">None</option>
                  {envProfiles.map((env) => (
                    <option key={env.slug} value={env.slug}>{env.name}</option>
                  ))}
                </select>
                <p className="text-[10px] text-cc-muted mt-1">
                  Select a shared environment profile, or add variables below.
                </p>
              </div>
              {/* Inline key-value editor */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs text-cc-muted">Extra Variables</label>
                  <button
                    onClick={addEnvVar}
                    className="text-[10px] text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
                  >
                    + Add Variable
                  </button>
                </div>
                {form.env.length === 0 ? (
                  <p className="text-[10px] text-cc-muted">No extra variables set.</p>
                ) : (
                  <div className="space-y-1.5">
                    {form.env.map((entry, i) => (
                      <div key={i} className="flex gap-2 items-center">
                        <input
                          value={entry.key}
                          onChange={(e) => updateEnvVar(i, "key", e.target.value)}
                          placeholder="KEY"
                          className="w-1/3 px-2 py-1.5 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-xs font-mono-code focus:outline-none focus:ring-1 focus:ring-cc-primary"
                        />
                        <input
                          value={entry.value}
                          onChange={(e) => updateEnvVar(i, "value", e.target.value)}
                          placeholder="value"
                          className="flex-1 px-2 py-1.5 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-xs font-mono-code focus:outline-none focus:ring-1 focus:ring-cc-primary"
                        />
                        <button
                          onClick={() => removeEnvVar(i)}
                          className="text-cc-muted hover:text-cc-error transition-colors cursor-pointer p-1"
                          title="Remove variable"
                        >
                          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                            <path d="M4.646 4.646a.5.5 0 01.708 0L8 7.293l2.646-2.647a.5.5 0 01.708.708L8.707 8l2.647 2.646a.5.5 0 01-.708.708L8 8.707l-2.646 2.647a.5.5 0 01-.708-.708L7.293 8 4.646 5.354a.5.5 0 010-.708z" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* ── Git (only when cwd is set and not using temp dir) ── */}
          {!form.useTempDir && form.cwd && (
            <section data-testid="git-section">
              <h2 className="text-xs font-medium text-cc-muted uppercase tracking-wider mb-3">Git</h2>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-cc-muted mb-1">Branch</label>
                  <input
                    value={form.branch}
                    onChange={(e) => updateField("branch", e.target.value)}
                    placeholder="e.g., feature/my-branch"
                    className="w-full px-3 py-2 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-sm font-mono-code focus:outline-none focus:ring-1 focus:ring-cc-primary"
                  />
                </div>
                {form.branch && (
                  <div className="flex items-center gap-4">
                    <label className="flex items-center gap-2 text-sm text-cc-fg cursor-pointer">
                      <input
                        type="checkbox"
                        checked={form.createBranch}
                        onChange={(e) => updateField("createBranch", e.target.checked)}
                        className="rounded"
                      />
                      Create branch if missing
                    </label>
                    <label className="flex items-center gap-2 text-sm text-cc-fg cursor-pointer">
                      <input
                        type="checkbox"
                        checked={form.useWorktree}
                        onChange={(e) => updateField("useWorktree", e.target.checked)}
                        className="rounded"
                      />
                      Use worktree
                    </label>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* ── Advanced (collapsible) ── */}
          <section>
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-2 text-xs font-medium text-cc-muted uppercase tracking-wider cursor-pointer hover:text-cc-fg transition-colors w-full"
            >
              <svg
                viewBox="0 0 16 16"
                fill="currentColor"
                className={`w-3 h-3 transition-transform ${showAdvanced ? "rotate-90" : ""}`}
              >
                <path d="M6 3l5 5-5 5V3z" />
              </svg>
              Advanced
              {countAdvancedFeatures(form) > 0 && (
                <span className="px-1.5 py-0.5 text-[10px] rounded-full bg-cc-primary/15 text-cc-primary font-normal">
                  {countAdvancedFeatures(form)}
                </span>
              )}
            </button>

            {showAdvanced && (
              <div className="mt-4 space-y-6 pl-5 border-l-2 border-cc-border/30">
                {/* ── MCP Servers ── */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-xs font-medium text-cc-muted">MCP Servers</h3>
                    <button
                      onClick={() => setShowMcpForm(!showMcpForm)}
                      className="text-[10px] text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
                    >
                      {showMcpForm ? "Cancel" : "+ Add Server"}
                    </button>
                  </div>

                  {/* Existing servers list */}
                  {Object.keys(form.mcpServers).length === 0 && !showMcpForm && (
                    <p className="text-[10px] text-cc-muted">No MCP servers configured.</p>
                  )}
                  {Object.entries(form.mcpServers).map(([name, config]) => (
                    <div key={name} className="flex items-center justify-between py-1.5 px-2 rounded-lg bg-cc-hover/50 mb-1.5">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-cc-fg font-mono-code">{name}</span>
                        <span className="px-1.5 py-0.5 text-[10px] rounded bg-cc-border text-cc-muted">{config.type}</span>
                      </div>
                      <button
                        onClick={() => removeMcpServer(name)}
                        className="text-cc-muted hover:text-cc-error transition-colors cursor-pointer p-0.5"
                        title="Remove server"
                      >
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                          <path d="M4.646 4.646a.5.5 0 01.708 0L8 7.293l2.646-2.647a.5.5 0 01.708.708L8.707 8l2.647 2.646a.5.5 0 01-.708.708L8 8.707l-2.646 2.647a.5.5 0 01-.708-.708L7.293 8 4.646 5.354a.5.5 0 010-.708z" />
                        </svg>
                      </button>
                    </div>
                  ))}

                  {/* Add server form */}
                  {showMcpForm && (
                    <div className="rounded-lg border border-cc-border p-3 mt-2 space-y-2">
                      <div>
                        <label className="block text-[10px] text-cc-muted mb-0.5">Server Name</label>
                        <input
                          value={mcpFormName}
                          onChange={(e) => setMcpFormName(e.target.value)}
                          placeholder="e.g., my-server"
                          className="w-full px-2 py-1.5 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-xs font-mono-code focus:outline-none focus:ring-1 focus:ring-cc-primary"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] text-cc-muted mb-0.5">Type</label>
                        <div className="flex rounded-lg border border-cc-border overflow-hidden">
                          {(["stdio", "sse", "http"] as const).map((t) => (
                            <button
                              key={t}
                              onClick={() => setMcpFormData((prev) => ({ ...prev, type: t }))}
                              className={`flex-1 px-2 py-1 text-[10px] transition-colors cursor-pointer ${mcpFormData.type === t ? "bg-cc-primary text-white" : "bg-cc-input-bg text-cc-muted hover:text-cc-fg"}`}
                            >
                              {t}
                            </button>
                          ))}
                        </div>
                      </div>
                      {mcpFormData.type === "stdio" ? (
                        <>
                          <div>
                            <label className="block text-[10px] text-cc-muted mb-0.5">Command</label>
                            <input
                              value={mcpFormData.command}
                              onChange={(e) => setMcpFormData((prev) => ({ ...prev, command: e.target.value }))}
                              placeholder="e.g., npx -y @some/mcp-server"
                              className="w-full px-2 py-1.5 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-xs font-mono-code focus:outline-none focus:ring-1 focus:ring-cc-primary"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] text-cc-muted mb-0.5">Args (space-separated)</label>
                            <input
                              value={mcpFormData.args}
                              onChange={(e) => setMcpFormData((prev) => ({ ...prev, args: e.target.value }))}
                              placeholder="--port 3000"
                              className="w-full px-2 py-1.5 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-xs font-mono-code focus:outline-none focus:ring-1 focus:ring-cc-primary"
                            />
                          </div>
                        </>
                      ) : (
                        <div>
                          <label className="block text-[10px] text-cc-muted mb-0.5">URL</label>
                          <input
                            value={mcpFormData.url}
                            onChange={(e) => setMcpFormData((prev) => ({ ...prev, url: e.target.value }))}
                            placeholder="https://example.com/mcp"
                            className="w-full px-2 py-1.5 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-xs font-mono-code focus:outline-none focus:ring-1 focus:ring-cc-primary"
                          />
                        </div>
                      )}
                      <button
                        onClick={addMcpServer}
                        disabled={!mcpFormName.trim()}
                        className="px-3 py-1.5 text-xs rounded-lg bg-cc-primary text-white hover:bg-cc-primary-hover transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                      >
                        Add Server
                      </button>
                    </div>
                  )}
                </div>

                {/* ── Skills ── */}
                <div>
                  <h3 className="text-xs font-medium text-cc-muted mb-2">Skills</h3>
                  {availableSkills.length === 0 ? (
                    <p className="text-[10px] text-cc-muted">No skills found in ~/.claude/skills/</p>
                  ) : (
                    <div className="space-y-1.5">
                      {availableSkills.map((skill) => (
                        <label
                          key={skill.slug}
                          className="flex items-start gap-2 text-sm text-cc-fg cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={form.skills.includes(skill.slug)}
                            onChange={() => toggleSkill(skill.slug)}
                            className="rounded mt-0.5"
                          />
                          <div>
                            <span className="text-xs">{skill.name}</span>
                            {skill.description && (
                              <p className="text-[10px] text-cc-muted">{skill.description}</p>
                            )}
                          </div>
                        </label>
                      ))}
                    </div>
                  )}
                </div>

                {/* ── Docker Container ── */}
                <div>
                  <h3 className="text-xs font-medium text-cc-muted mb-2">Docker Container</h3>
                  <div className="space-y-2">
                    <div>
                      <label className="block text-[10px] text-cc-muted mb-0.5">Image</label>
                      <input
                        value={form.containerImage}
                        onChange={(e) => updateField("containerImage", e.target.value)}
                        placeholder="e.g., the-companion:latest"
                        className="w-full px-2 py-1.5 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-xs font-mono-code focus:outline-none focus:ring-1 focus:ring-cc-primary"
                      />
                    </div>
                    {form.containerImage && (
                      <>
                        <div>
                          <label className="block text-[10px] text-cc-muted mb-0.5">Ports (comma-separated)</label>
                          <input
                            value={form.containerPorts}
                            onChange={(e) => updateField("containerPorts", e.target.value)}
                            placeholder="3000, 8080"
                            className="w-full px-2 py-1.5 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-xs font-mono-code focus:outline-none focus:ring-1 focus:ring-cc-primary"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] text-cc-muted mb-0.5">Volumes (one per line)</label>
                          <textarea
                            value={form.containerVolumes}
                            onChange={(e) => updateField("containerVolumes", e.target.value)}
                            placeholder="/host/path:/container/path"
                            className="w-full px-2 py-1.5 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-xs font-mono-code resize-none h-16 focus:outline-none focus:ring-1 focus:ring-cc-primary"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] text-cc-muted mb-0.5">Init Script</label>
                          <textarea
                            value={form.containerInitScript}
                            onChange={(e) => updateField("containerInitScript", e.target.value)}
                            placeholder="#!/bin/bash\napt-get update && ..."
                            className="w-full px-2 py-1.5 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-xs font-mono-code resize-none h-20 focus:outline-none focus:ring-1 focus:ring-cc-primary"
                          />
                        </div>
                      </>
                    )}
                  </div>
                </div>

                {/* ── Allowed Tools ── */}
                <div>
                  <h3 className="text-xs font-medium text-cc-muted mb-2">Allowed Tools</h3>
                  <div className="space-y-2">
                    {form.allowedTools.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {form.allowedTools.map((tool) => (
                          <span key={tool} className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-mono-code rounded-lg bg-cc-hover text-cc-fg">
                            {tool}
                            <button
                              onClick={() => removeAllowedTool(tool)}
                              className="text-cc-muted hover:text-cc-error transition-colors cursor-pointer"
                            >
                              <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5">
                                <path d="M4.646 4.646a.5.5 0 01.708 0L8 7.293l2.646-2.647a.5.5 0 01.708.708L8.707 8l2.647 2.646a.5.5 0 01-.708.708L8 8.707l-2.646 2.647a.5.5 0 01-.708-.708L7.293 8 4.646 5.354a.5.5 0 010-.708z" />
                              </svg>
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                    <input
                      value={allowedToolInput}
                      onChange={(e) => setAllowedToolInput(e.target.value)}
                      onKeyDown={addAllowedTool}
                      placeholder="Type tool name and press Enter"
                      className="w-full px-2 py-1.5 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-xs font-mono-code focus:outline-none focus:ring-1 focus:ring-cc-primary"
                    />
                    <p className="text-[10px] text-cc-muted">Leave empty to allow all tools.</p>
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* ── Triggers ── */}
          <section>
            <h2 className="text-xs font-medium text-cc-muted uppercase tracking-wider mb-3">Triggers</h2>
            <div className="space-y-4">
              {/* Manual — always available */}
              <div className="flex items-center gap-2 text-sm text-cc-muted">
                <span className="text-cc-success">●</span> Manual trigger is always available via the Run button.
              </div>

              {/* Webhook */}
              <div className="rounded-lg border border-cc-border p-3">
                <label className="flex items-center gap-2 text-sm text-cc-fg cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.webhookEnabled}
                    onChange={(e) => updateField("webhookEnabled", e.target.checked)}
                    className="rounded"
                  />
                  Webhook
                </label>
                {form.webhookEnabled && (
                  <p className="text-[10px] text-cc-muted mt-2">
                    A unique URL with a secret token will be generated after saving. You can POST to it with <code className="px-1 py-0.5 rounded bg-cc-hover">{`{"input": "..."}`}</code> to trigger the agent.
                  </p>
                )}
              </div>

              {/* Schedule */}
              <div className="rounded-lg border border-cc-border p-3">
                <label className="flex items-center gap-2 text-sm text-cc-fg cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.scheduleEnabled}
                    onChange={(e) => updateField("scheduleEnabled", e.target.checked)}
                    className="rounded"
                  />
                  Schedule
                </label>
                {form.scheduleEnabled && (
                  <div className="mt-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <label className="flex items-center gap-1.5 text-xs text-cc-muted cursor-pointer">
                        <input
                          type="radio"
                          checked={form.scheduleRecurring}
                          onChange={() => updateField("scheduleRecurring", true)}
                        />
                        Recurring
                      </label>
                      <label className="flex items-center gap-1.5 text-xs text-cc-muted cursor-pointer">
                        <input
                          type="radio"
                          checked={!form.scheduleRecurring}
                          onChange={() => updateField("scheduleRecurring", false)}
                        />
                        One-time
                      </label>
                    </div>
                    {form.scheduleRecurring ? (
                      <div className="space-y-2">
                        <div className="flex flex-wrap gap-1">
                          {CRON_PRESETS.map((p) => (
                            <button
                              key={p.value}
                              onClick={() => updateField("scheduleExpression", p.value)}
                              className={`px-2 py-1 text-[10px] rounded-lg border transition-colors cursor-pointer ${form.scheduleExpression === p.value ? "border-cc-primary text-cc-primary" : "border-cc-border text-cc-muted hover:text-cc-fg"}`}
                            >
                              {p.label}
                            </button>
                          ))}
                        </div>
                        <input
                          value={form.scheduleExpression}
                          onChange={(e) => updateField("scheduleExpression", e.target.value)}
                          placeholder="Cron expression (e.g. 0 8 * * *)"
                          className="w-full px-3 py-2 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-sm font-mono-code focus:outline-none focus:ring-1 focus:ring-cc-primary"
                        />
                      </div>
                    ) : (
                      <input
                        type="datetime-local"
                        value={form.scheduleExpression}
                        onChange={(e) => updateField("scheduleExpression", e.target.value)}
                        className="w-full px-3 py-2 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-sm focus:outline-none focus:ring-1 focus:ring-cc-primary"
                      />
                    )}
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
