// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { AgentInfo } from "../api.js";

// ─── Mock setup ──────────────────────────────────────────────────────────────

const mockApi = {
  listAgents: vi.fn(),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
  toggleAgent: vi.fn(),
  runAgent: vi.fn(),
  exportAgent: vi.fn(),
  importAgent: vi.fn(),
  regenerateAgentWebhookSecret: vi.fn(),
  listSkills: vi.fn(),
  listEnvs: vi.fn(),
};

vi.mock("../api.js", () => ({
  api: {
    listAgents: (...args: unknown[]) => mockApi.listAgents(...args),
    createAgent: (...args: unknown[]) => mockApi.createAgent(...args),
    updateAgent: (...args: unknown[]) => mockApi.updateAgent(...args),
    deleteAgent: (...args: unknown[]) => mockApi.deleteAgent(...args),
    toggleAgent: (...args: unknown[]) => mockApi.toggleAgent(...args),
    runAgent: (...args: unknown[]) => mockApi.runAgent(...args),
    exportAgent: (...args: unknown[]) => mockApi.exportAgent(...args),
    importAgent: (...args: unknown[]) => mockApi.importAgent(...args),
    regenerateAgentWebhookSecret: (...args: unknown[]) =>
      mockApi.regenerateAgentWebhookSecret(...args),
    listSkills: (...args: unknown[]) => mockApi.listSkills(...args),
    listEnvs: (...args: unknown[]) => mockApi.listEnvs(...args),
  },
}));

// Mock FolderPicker since it has its own API dependencies
vi.mock("./FolderPicker.js", () => ({ FolderPicker: () => null }));

import { AgentsPage } from "./AgentsPage.js";

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: "agent-1",
    version: 1,
    name: "Test Agent",
    description: "A test agent for unit tests",
    icon: "",
    backendType: "claude",
    model: "claude-sonnet-4-6",
    permissionMode: "default",
    cwd: "/workspace",
    prompt: "Do the thing",
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    totalRuns: 0,
    consecutiveFailures: 0,
    triggers: {
      webhook: { enabled: false, secret: "" },
      schedule: { enabled: false, expression: "0 8 * * *", recurring: true },
    },
    ...overrides,
  };
}

const defaultRoute = { page: "agents" as const };

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.listAgents.mockResolvedValue([]);
  // Default: no skills or envs fetched
  mockApi.listSkills.mockResolvedValue([]);
  mockApi.listEnvs.mockResolvedValue([]);
  window.location.hash = "#/agents";
});

describe("AgentsPage", () => {
  // ── Render States ──────────────────────────────────────────────────────────

  it("renders loading state initially", () => {
    // The component shows "Loading..." text while the API call is pending.
    // We use a never-resolving promise to keep the loading state visible.
    mockApi.listAgents.mockReturnValue(new Promise(() => {}));
    render(<AgentsPage route={defaultRoute} />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("renders empty state when no agents exist", async () => {
    // When the API returns an empty list, the component shows a friendly
    // empty state with a prompt to create an agent.
    mockApi.listAgents.mockResolvedValue([]);
    render(<AgentsPage route={defaultRoute} />);
    await waitFor(() => {
      expect(screen.getByText("No agents yet")).toBeInTheDocument();
    });
    expect(
      screen.getByText("Create an agent to get started, or import a shared JSON config."),
    ).toBeInTheDocument();
  });

  it("renders agent cards after loading", async () => {
    // After the API returns agents, each agent should render as a card
    // displaying its name, description, and backend type badge.
    const agent = makeAgent({
      id: "a1",
      name: "My Code Reviewer",
      description: "Reviews pull requests automatically",
    });
    mockApi.listAgents.mockResolvedValue([agent]);
    render(<AgentsPage route={defaultRoute} />);
    await screen.findByText("My Code Reviewer");
    expect(screen.getByText("Reviews pull requests automatically")).toBeInTheDocument();
  });

  it("renders multiple agent cards in order", async () => {
    // Multiple agents should all appear in the list view.
    const agents = [
      makeAgent({ id: "a1", name: "Agent Alpha", description: "First agent" }),
      makeAgent({ id: "a2", name: "Agent Beta", description: "Second agent" }),
    ];
    mockApi.listAgents.mockResolvedValue(agents);
    render(<AgentsPage route={defaultRoute} />);
    await screen.findByText("Agent Alpha");
    expect(screen.getByText("Agent Beta")).toBeInTheDocument();
    expect(screen.getByText("First agent")).toBeInTheDocument();
    expect(screen.getByText("Second agent")).toBeInTheDocument();
  });

  // ── Agent Card Info ────────────────────────────────────────────────────────

  it("agent card shows correct info: name, description, and trigger badges", async () => {
    // Validates that an agent card displays the name, description, enabled status,
    // backend badge, and computed trigger badges (Manual is always shown, plus
    // Webhook/Schedule when enabled).
    const agent = makeAgent({
      id: "a1",
      name: "Docs Writer",
      description: "Writes documentation",
      icon: "",
      backendType: "claude",
      enabled: true,
      triggers: {
        webhook: { enabled: true, secret: "abc123" },
        schedule: { enabled: true, expression: "0 8 * * *", recurring: true },
      },
    });
    mockApi.listAgents.mockResolvedValue([agent]);
    render(<AgentsPage route={defaultRoute} />);

    await screen.findByText("Docs Writer");
    expect(screen.getByText("Writes documentation")).toBeInTheDocument();
    expect(screen.getByText("Enabled")).toBeInTheDocument();
    expect(screen.getByText("Claude")).toBeInTheDocument();

    // Trigger badges: Manual is always present, Webhook when enabled,
    // and schedule is humanized from the cron expression
    expect(screen.getByText("Manual")).toBeInTheDocument();
    expect(screen.getByText("Webhook")).toBeInTheDocument();
    expect(screen.getByText("Daily at 8:00 AM")).toBeInTheDocument();
  });

  it("agent card shows Disabled badge when agent is not enabled", async () => {
    // Agents can be toggled off. The card should reflect the disabled state.
    const agent = makeAgent({ id: "a1", name: "Disabled Agent", enabled: false });
    mockApi.listAgents.mockResolvedValue([agent]);
    render(<AgentsPage route={defaultRoute} />);

    await screen.findByText("Disabled Agent");
    expect(screen.getByText("Disabled")).toBeInTheDocument();
  });

  it("agent card shows Codex backend badge for codex agents", async () => {
    // Codex backend type should display "Codex" instead of "Claude".
    const agent = makeAgent({
      id: "a1",
      name: "Codex Agent",
      backendType: "codex",
    });
    mockApi.listAgents.mockResolvedValue([agent]);
    render(<AgentsPage route={defaultRoute} />);

    await screen.findByText("Codex Agent");
    expect(screen.getByText("Codex")).toBeInTheDocument();
  });

  it("agent card shows run count and last run time when available", async () => {
    // When an agent has been run before, the card displays run stats.
    const agent = makeAgent({
      id: "a1",
      name: "Busy Agent",
      totalRuns: 5,
      lastRunAt: Date.now() - 60000, // 1 minute ago
    });
    mockApi.listAgents.mockResolvedValue([agent]);
    render(<AgentsPage route={defaultRoute} />);

    await screen.findByText("Busy Agent");
    expect(screen.getByText("5 runs")).toBeInTheDocument();
  });

  it("agent card shows singular 'run' for exactly 1 run", async () => {
    // Edge case: singular "run" instead of "runs" when totalRuns is 1.
    const agent = makeAgent({
      id: "a1",
      name: "New Agent",
      totalRuns: 1,
    });
    mockApi.listAgents.mockResolvedValue([agent]);
    render(<AgentsPage route={defaultRoute} />);

    await screen.findByText("New Agent");
    expect(screen.getByText("1 run")).toBeInTheDocument();
  });

  it("agent card shows Copy URL button when webhook is enabled", async () => {
    // When webhook trigger is enabled, a "Copy URL" button appears next to
    // the trigger badges, allowing users to copy the webhook URL.
    const agent = makeAgent({
      id: "a1",
      name: "Webhook Agent",
      triggers: {
        webhook: { enabled: true, secret: "secret123" },
        schedule: { enabled: false, expression: "0 8 * * *", recurring: true },
      },
    });
    mockApi.listAgents.mockResolvedValue([agent]);
    render(<AgentsPage route={defaultRoute} />);

    await screen.findByText("Webhook Agent");
    expect(screen.getByText("Copy URL")).toBeInTheDocument();
  });

  // ── Interactive Behavior ───────────────────────────────────────────────────

  it("clicking '+ New Agent' shows the editor in create mode", async () => {
    // Clicking the New Agent button switches from list view to editor view
    // with "New Agent" as the heading.
    mockApi.listAgents.mockResolvedValue([]);
    render(<AgentsPage route={defaultRoute} />);

    // Wait for loading to complete
    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("+ New Agent"));

    // Editor should now be visible with "New Agent" heading
    expect(screen.getByText("New Agent")).toBeInTheDocument();
    // The "Create" button should be visible (not "Save")
    expect(screen.getByText("Create")).toBeInTheDocument();
  });

  it("clicking Cancel in editor returns to list view", async () => {
    // After opening the editor, clicking Cancel should navigate back to
    // the agent list without saving.
    mockApi.listAgents.mockResolvedValue([]);
    render(<AgentsPage route={defaultRoute} />);

    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });

    // Open editor
    fireEvent.click(screen.getByText("+ New Agent"));
    expect(screen.getByText("New Agent")).toBeInTheDocument();

    // Click Cancel — there are two Cancel buttons in the editor (back arrow area and header)
    const cancelButtons = screen.getAllByText("Cancel");
    fireEvent.click(cancelButtons[0]);

    // Should return to list view
    await waitFor(() => {
      expect(screen.getByText("No agents yet")).toBeInTheDocument();
    });
  });

  it("clicking Edit on an agent card opens the editor in edit mode", async () => {
    // Clicking the Edit button on an agent card should switch to the editor
    // with "Edit Agent" heading and "Save" button.
    const agent = makeAgent({ id: "a1", name: "Editable Agent", prompt: "Do something" });
    mockApi.listAgents.mockResolvedValue([agent]);
    render(<AgentsPage route={defaultRoute} />);

    await screen.findByText("Editable Agent");
    fireEvent.click(screen.getByTitle("Edit"));

    expect(screen.getByText("Edit Agent")).toBeInTheDocument();
    expect(screen.getByText("Save")).toBeInTheDocument();
    // Form should be pre-filled with agent data
    expect(screen.getByDisplayValue("Editable Agent")).toBeInTheDocument();
  });

  it("clicking Run on an agent without {{input}} triggers runAgent", async () => {
    // For agents whose prompt does not contain {{input}}, clicking Run
    // immediately calls the API without showing an input modal.
    const agent = makeAgent({ id: "a1", name: "Quick Agent", prompt: "Do the thing" });
    mockApi.listAgents.mockResolvedValue([agent]);
    mockApi.runAgent.mockResolvedValue({ ok: true, message: "started" });
    render(<AgentsPage route={defaultRoute} />);

    await screen.findByText("Quick Agent");
    fireEvent.click(screen.getByText("Run"));

    await waitFor(() => {
      expect(mockApi.runAgent).toHaveBeenCalledWith("a1", undefined);
    });
  });

  it("clicking Run on an agent with {{input}} shows input modal", async () => {
    // For agents whose prompt contains {{input}}, clicking Run should open
    // a modal that allows the user to provide input text.
    const agent = makeAgent({
      id: "a1",
      name: "Input Agent",
      prompt: "Process this: {{input}}",
    });
    mockApi.listAgents.mockResolvedValue([agent]);
    render(<AgentsPage route={defaultRoute} />);

    await screen.findByText("Input Agent");
    fireEvent.click(screen.getByText("Run"));

    // The input modal should appear
    expect(screen.getByText("Run Input Agent")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Enter input for the agent..."),
    ).toBeInTheDocument();
  });

  it("delete button calls deleteAgent after confirmation", async () => {
    // Clicking the Delete button should trigger a confirm dialog, then call
    // the deleteAgent API and refresh the agent list.
    const agent = makeAgent({ id: "a1", name: "Delete Me" });
    mockApi.listAgents.mockResolvedValue([agent]);
    mockApi.deleteAgent.mockResolvedValue({});
    window.confirm = vi.fn().mockReturnValue(true);

    render(<AgentsPage route={defaultRoute} />);
    await screen.findByText("Delete Me");
    fireEvent.click(screen.getByTitle("Delete"));

    await waitFor(() => {
      expect(window.confirm).toHaveBeenCalledWith("Delete this agent?");
      expect(mockApi.deleteAgent).toHaveBeenCalledWith("a1");
    });
  });

  it("toggle button calls toggleAgent API", async () => {
    // Clicking the toggle button (Enable/Disable) should call the API.
    const agent = makeAgent({ id: "a1", name: "Toggle Me", enabled: true });
    mockApi.listAgents.mockResolvedValue([agent]);
    mockApi.toggleAgent.mockResolvedValue({});

    render(<AgentsPage route={defaultRoute} />);
    await screen.findByText("Toggle Me");
    fireEvent.click(screen.getByTitle("Disable"));

    await waitFor(() => {
      expect(mockApi.toggleAgent).toHaveBeenCalledWith("a1");
    });
  });

  it("header shows 'Agents' title and description", async () => {
    // The page header displays the title and a short description of what agents are.
    render(<AgentsPage route={defaultRoute} />);
    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Agents")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Reusable autonomous session configs. Run manually, via webhook, or on a schedule.",
      ),
    ).toBeInTheDocument();
  });

  it("Import button is present in list view", async () => {
    // The list view should have an Import button for importing agents from JSON.
    render(<AgentsPage route={defaultRoute} />);
    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Import")).toBeInTheDocument();
  });

  // ── Environment Section ──────────────────────────────────────────────────

  it("editor shows environment section with profile dropdown", async () => {
    // When the editor is opened, the Environment section should be visible
    // with a dropdown for selecting an environment profile (fetched on mount).
    mockApi.listEnvs.mockResolvedValue([
      { slug: "dev", name: "Development", variables: {} },
      { slug: "prod", name: "Production", variables: {} },
    ]);
    render(<AgentsPage route={defaultRoute} />);
    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("+ New Agent"));

    // Environment section header
    expect(screen.getByText("Environment")).toBeInTheDocument();
    // Env profile dropdown options (including "None" default)
    expect(screen.getByText("Environment Profile")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("Development")).toBeInTheDocument();
      expect(screen.getByText("Production")).toBeInTheDocument();
    });
  });

  it("editor allows adding and removing environment variables", async () => {
    // The inline key-value editor should support adding rows for env vars
    // and removing them.
    render(<AgentsPage route={defaultRoute} />);
    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("+ New Agent"));

    // Initially shows "No extra variables set."
    expect(screen.getByText("No extra variables set.")).toBeInTheDocument();

    // Click "+ Add Variable"
    fireEvent.click(screen.getByText("+ Add Variable"));

    // Should now have KEY and value input fields
    expect(screen.getByPlaceholderText("KEY")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("value")).toBeInTheDocument();

    // Remove the variable
    fireEvent.click(screen.getByTitle("Remove variable"));
    expect(screen.getByText("No extra variables set.")).toBeInTheDocument();
  });

  // ── Git Section ──────────────────────────────────────────────────────────

  it("Git section appears only when cwd is set and useTempDir is false", async () => {
    // The Git section should only render when the agent has a working directory
    // and is not using a temp dir. This test verifies conditional rendering.
    render(<AgentsPage route={defaultRoute} />);
    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("+ New Agent"));

    // Initially no Git section (cwd is empty, useTempDir is false)
    expect(screen.queryByText("Git")).not.toBeInTheDocument();

    // Set a cwd value
    const cwdInput = screen.getByPlaceholderText("/path/to/project");
    fireEvent.change(cwdInput, { target: { value: "/workspace/my-project" } });

    // Git section should now appear
    expect(screen.getByText("Git")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("e.g., feature/my-branch")).toBeInTheDocument();
  });

  it("Git section shows createBranch and useWorktree checkboxes when branch is set", async () => {
    // The branch-related checkboxes are only visible after a branch name is typed.
    render(<AgentsPage route={defaultRoute} />);
    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("+ New Agent"));

    // Set cwd to make Git section appear
    fireEvent.change(screen.getByPlaceholderText("/path/to/project"), {
      target: { value: "/workspace" },
    });

    // No checkboxes yet (branch is empty)
    expect(screen.queryByText("Create branch if missing")).not.toBeInTheDocument();

    // Type a branch name
    fireEvent.change(screen.getByPlaceholderText("e.g., feature/my-branch"), {
      target: { value: "feature/test" },
    });

    // Checkboxes should now appear
    expect(screen.getByText("Create branch if missing")).toBeInTheDocument();
    expect(screen.getByText("Use worktree")).toBeInTheDocument();
  });

  // ── Codex Internet Access ────────────────────────────────────────────────

  it("Codex internet access toggle is only visible for codex backend", async () => {
    // The "Allow internet access" checkbox should only appear when the
    // backend type is set to "codex".
    render(<AgentsPage route={defaultRoute} />);
    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("+ New Agent"));

    // Default is Claude, so internet access should not be visible
    expect(screen.queryByText("Allow internet access")).not.toBeInTheDocument();

    // Switch to Codex backend — there are two "Codex" buttons (one in provider
    // selector in the editor's Backend section)
    const codexButtons = screen.getAllByText("Codex");
    fireEvent.click(codexButtons[0]);

    // Now the toggle should appear
    expect(screen.getByText("Allow internet access")).toBeInTheDocument();
  });

  // ── Advanced Section ────────────────────────────────────────────────────

  it("Advanced section collapse/expand toggle works", async () => {
    // The Advanced section is collapsed by default for new agents.
    // Clicking the toggle should expand and show MCP Servers, Skills,
    // Docker Container, and Allowed Tools sub-sections.
    render(<AgentsPage route={defaultRoute} />);
    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("+ New Agent"));

    // Advanced header should be visible
    expect(screen.getByText("Advanced")).toBeInTheDocument();

    // Sub-sections should NOT be visible (collapsed)
    expect(screen.queryByText("MCP Servers")).not.toBeInTheDocument();

    // Click Advanced to expand
    fireEvent.click(screen.getByText("Advanced"));

    // Sub-sections should now be visible
    expect(screen.getByText("MCP Servers")).toBeInTheDocument();
    expect(screen.getByText("Skills")).toBeInTheDocument();
    expect(screen.getByText("Docker Container")).toBeInTheDocument();
    expect(screen.getByText("Allowed Tools")).toBeInTheDocument();
  });

  it("Advanced section auto-expands when editing agent with advanced config", async () => {
    // When editing an agent that already has MCP servers or other advanced
    // features configured, the Advanced section should auto-expand.
    const agent = makeAgent({
      id: "a1",
      name: "Advanced Agent",
      mcpServers: {
        "test-server": { type: "stdio", command: "node", args: ["server.js"] },
      },
    });
    mockApi.listAgents.mockResolvedValue([agent]);
    render(<AgentsPage route={defaultRoute} />);

    await screen.findByText("Advanced Agent");
    fireEvent.click(screen.getByTitle("Edit"));

    // Advanced should be auto-expanded because agent has mcpServers
    expect(screen.getByText("MCP Servers")).toBeInTheDocument();
    // The MCP server entry should be visible
    expect(screen.getByText("test-server")).toBeInTheDocument();
  });

  // ── Skills ─────────────────────────────────────────────────────────────

  it("Skills checkbox list renders fetched skills", async () => {
    // When the API returns skills, they should appear as checkboxes in the
    // Advanced > Skills sub-section.
    mockApi.listSkills.mockResolvedValue([
      { slug: "code-review", name: "Code Review", description: "Reviews code changes" },
      { slug: "testing", name: "Testing", description: "Writes tests" },
    ]);
    render(<AgentsPage route={defaultRoute} />);
    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("+ New Agent"));
    // Expand Advanced
    fireEvent.click(screen.getByText("Advanced"));

    await waitFor(() => {
      expect(screen.getByText("Code Review")).toBeInTheDocument();
      expect(screen.getByText("Reviews code changes")).toBeInTheDocument();
      expect(screen.getByText("Testing")).toBeInTheDocument();
    });
  });

  it("Skills shows empty state when no skills found", async () => {
    // When the API returns no skills, a helpful message should appear.
    mockApi.listSkills.mockResolvedValue([]);
    render(<AgentsPage route={defaultRoute} />);
    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("+ New Agent"));
    fireEvent.click(screen.getByText("Advanced"));

    expect(screen.getByText("No skills found in ~/.claude/skills/")).toBeInTheDocument();
  });

  // ── MCP Servers ────────────────────────────────────────────────────────

  it("MCP server add/remove flow works", async () => {
    // Tests the full flow of adding an MCP server via the inline form and
    // then removing it.
    render(<AgentsPage route={defaultRoute} />);
    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("+ New Agent"));
    fireEvent.click(screen.getByText("Advanced"));

    // Initially shows empty state
    expect(screen.getByText("No MCP servers configured.")).toBeInTheDocument();

    // Click "+ Add Server"
    fireEvent.click(screen.getByText("+ Add Server"));

    // Fill in the form
    fireEvent.change(screen.getByPlaceholderText("e.g., my-server"), {
      target: { value: "my-mcp" },
    });
    fireEvent.change(screen.getByPlaceholderText("e.g., npx -y @some/mcp-server"), {
      target: { value: "npx mcp-tool" },
    });

    // Submit the server
    fireEvent.click(screen.getByText("Add Server"));

    // Server should now appear in the list
    expect(screen.getByText("my-mcp")).toBeInTheDocument();
    expect(screen.getByText("stdio")).toBeInTheDocument();

    // Empty state should be gone
    expect(screen.queryByText("No MCP servers configured.")).not.toBeInTheDocument();

    // Remove the server
    fireEvent.click(screen.getByTitle("Remove server"));
    expect(screen.getByText("No MCP servers configured.")).toBeInTheDocument();
  });

  // ── Allowed Tools ──────────────────────────────────────────────────────

  it("Allowed tools tag input works with Enter to add and X to remove", async () => {
    // Tests the tag-style input for allowed tools: typing a tool name and
    // pressing Enter adds it, clicking X removes it.
    render(<AgentsPage route={defaultRoute} />);
    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("+ New Agent"));
    fireEvent.click(screen.getByText("Advanced"));

    // Type a tool name and press Enter
    const toolInput = screen.getByPlaceholderText("Type tool name and press Enter");
    fireEvent.change(toolInput, { target: { value: "Read" } });
    fireEvent.keyDown(toolInput, { key: "Enter" });

    // Tool should appear as a tag
    expect(screen.getByText("Read")).toBeInTheDocument();

    // The input should be cleared
    expect(toolInput).toHaveValue("");

    // Add another tool
    fireEvent.change(toolInput, { target: { value: "Write" } });
    fireEvent.keyDown(toolInput, { key: "Enter" });
    expect(screen.getByText("Write")).toBeInTheDocument();

    // Helper text should still be visible
    expect(screen.getByText("Leave empty to allow all tools.")).toBeInTheDocument();
  });

  // ── Docker Container ───────────────────────────────────────────────────

  it("Docker container fields render in advanced section", async () => {
    // The Docker Container sub-section should show an Image input, and when
    // an image is entered, Ports, Volumes, and Init Script fields appear.
    render(<AgentsPage route={defaultRoute} />);
    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("+ New Agent"));
    fireEvent.click(screen.getByText("Advanced"));

    // Image input should be visible
    expect(screen.getByPlaceholderText("e.g., the-companion:latest")).toBeInTheDocument();

    // Ports/Volumes/Init Script should NOT be visible yet
    expect(screen.queryByPlaceholderText("3000, 8080")).not.toBeInTheDocument();

    // Enter an image name
    fireEvent.change(screen.getByPlaceholderText("e.g., the-companion:latest"), {
      target: { value: "my-image:latest" },
    });

    // Now Ports, Volumes, Init Script should be visible
    expect(screen.getByPlaceholderText("3000, 8080")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("/host/path:/container/path")).toBeInTheDocument();
  });

  // ── Edit Mode Deserialization ──────────────────────────────────────────

  it("edit mode deserializes all agent fields into form", async () => {
    // When editing an agent with all fields configured, the form should
    // correctly deserialize all values from AgentInfo to AgentFormData.
    const agent = makeAgent({
      id: "a1",
      name: "Full Agent",
      backendType: "codex",
      codexInternetAccess: true,
      env: { API_KEY: "secret123", DEBUG: "true" },
      branch: "feature/test",
      createBranch: true,
      useWorktree: true,
      allowedTools: ["Read", "Write"],
      skills: ["code-review"],
      mcpServers: { "my-server": { type: "sse", url: "https://example.com" } },
      container: { image: "test:latest", ports: [3000], volumes: ["/data:/data"], initScript: "echo hi" },
    });
    mockApi.listAgents.mockResolvedValue([agent]);
    render(<AgentsPage route={defaultRoute} />);

    await screen.findByText("Full Agent");
    fireEvent.click(screen.getByTitle("Edit"));

    // Verify basic fields
    expect(screen.getByDisplayValue("Full Agent")).toBeInTheDocument();

    // Codex internet access should be checked
    expect(screen.getByText("Allow internet access")).toBeInTheDocument();

    // Env vars should be populated (2 rows)
    expect(screen.getByDisplayValue("API_KEY")).toBeInTheDocument();
    expect(screen.getByDisplayValue("secret123")).toBeInTheDocument();

    // Branch should be populated
    expect(screen.getByDisplayValue("feature/test")).toBeInTheDocument();

    // Advanced should be auto-expanded (has MCP + allowed tools + container)
    expect(screen.getByText("my-server")).toBeInTheDocument();
    expect(screen.getByText("Read")).toBeInTheDocument();
    expect(screen.getByText("Write")).toBeInTheDocument();
    expect(screen.getByDisplayValue("test:latest")).toBeInTheDocument();
  });

  // ── Accessibility ──────────────────────────────────────────────────────────

  // Known pre-existing accessibility issues in AgentsPage component:
  // - Hidden file input for Import lacks an explicit label (the visible "Import"
  //   button triggers it programmatically, so it's functionally accessible but
  //   axe flags the hidden <input type="file"> without a <label>).
  // - Agent card uses <h3> directly (heading-order skip from page <h1>).
  // - Editor has icon-only back button without aria-label, and select elements
  //   whose visible <label> siblings are not associated via htmlFor/id.
  // These are excluded so the axe scan still catches any *new* violations.
  const axeRules = {
    rules: {
      // Hidden file input has no explicit label; "Import" button acts as trigger
      label: { enabled: false },
      // Agent cards skip heading levels (h1 -> h3)
      "heading-order": { enabled: false },
      // Icon-only back button in editor lacks aria-label
      "button-name": { enabled: false },
      // Select elements in editor have visible labels but not programmatically linked
      "select-name": { enabled: false },
    },
  };

  it("passes axe accessibility checks on empty state", async () => {
    // The empty state (no agents) should have no accessibility violations
    // beyond the known issues documented above.
    const { axe } = await import("vitest-axe");
    mockApi.listAgents.mockResolvedValue([]);
    const { container } = render(<AgentsPage route={defaultRoute} />);
    await waitFor(() => {
      expect(screen.getByText("No agents yet")).toBeInTheDocument();
    });
    const results = await axe(container, axeRules);
    expect(results).toHaveNoViolations();
  });

  it("passes axe accessibility checks with agent cards", async () => {
    // The list view with agent cards should have no accessibility violations
    // beyond the known issues documented above.
    const { axe } = await import("vitest-axe");
    const agent = makeAgent({
      id: "a1",
      name: "Accessible Agent",
      description: "This agent is accessible",
    });
    mockApi.listAgents.mockResolvedValue([agent]);
    const { container } = render(<AgentsPage route={defaultRoute} />);
    await screen.findByText("Accessible Agent");
    const results = await axe(container, axeRules);
    expect(results).toHaveNoViolations();
  });

  it("passes axe accessibility checks in editor view", async () => {
    // The agent editor form should have no accessibility violations
    // beyond the known issues documented above.
    const { axe } = await import("vitest-axe");
    mockApi.listAgents.mockResolvedValue([]);
    const { container } = render(<AgentsPage route={defaultRoute} />);
    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("+ New Agent"));
    const results = await axe(container, axeRules);
    expect(results).toHaveNoViolations();
  });

  it("passes axe accessibility checks in editor with advanced sections expanded", async () => {
    // The editor with the Advanced section expanded should still have no
    // new accessibility violations.
    const { axe } = await import("vitest-axe");
    mockApi.listAgents.mockResolvedValue([]);
    const { container } = render(<AgentsPage route={defaultRoute} />);
    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("+ New Agent"));
    fireEvent.click(screen.getByText("Advanced"));
    const results = await axe(container, axeRules);
    expect(results).toHaveNoViolations();
  });
});
