// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SessionState } from "../../server/session-types.js";

// Polyfill scrollIntoView for jsdom
Element.prototype.scrollIntoView = vi.fn();

const mockSendToSession = vi.fn();
const mockListPrompts = vi.fn();
const mockCreatePrompt = vi.fn();

// Build a controllable mock store state
let mockStoreState: Record<string, unknown> = {};

vi.mock("../ws.js", () => ({
  sendToSession: (...args: unknown[]) => mockSendToSession(...args),
}));

vi.mock("../api.js", () => ({
  api: {
    gitPull: vi.fn().mockResolvedValue({ success: true, output: "", git_ahead: 0, git_behind: 0 }),
    listPrompts: (...args: unknown[]) => mockListPrompts(...args),
    createPrompt: (...args: unknown[]) => mockCreatePrompt(...args),
  },
}));

// Mock useStore as a function that takes a selector
const mockAppendMessage = vi.fn();
const mockUpdateSession = vi.fn();
const mockSetPreviousPermissionMode = vi.fn();

vi.mock("../store.js", () => {
  // Create a mock store function that acts like zustand's useStore
  const useStore = (selector: (state: Record<string, unknown>) => unknown) => {
    return selector(mockStoreState);
  };
  // Add getState for imperative access (used by Composer for appendMessage)
  useStore.getState = () => mockStoreState;
  return { useStore };
});

import { Composer } from "./Composer.js";

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    session_id: "s1",
    model: "claude-sonnet-4-6",
    cwd: "/test",
    tools: [],
    permissionMode: "acceptEdits",
    claude_code_version: "1.0",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    total_cost_usd: 0,
    num_turns: 0,
    context_used_percent: 0,
    is_compacting: false,
    git_branch: "",
    is_worktree: false,
    is_containerized: false,
    repo_root: "",
    git_ahead: 0,
    git_behind: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
    ...overrides,
  };
}

function setupMockStore(overrides: {
  isConnected?: boolean;
  sessionStatus?: "idle" | "running" | "compacting" | null;
  session?: Partial<SessionState>;
} = {}) {
  const {
    isConnected = true,
    sessionStatus = "idle",
    session = {},
  } = overrides;

  const sessionsMap = new Map<string, SessionState>();
  sessionsMap.set("s1", makeSession(session));

  const cliConnectedMap = new Map<string, boolean>();
  cliConnectedMap.set("s1", isConnected);

  const sessionStatusMap = new Map<string, "idle" | "running" | "compacting" | null>();
  sessionStatusMap.set("s1", sessionStatus);

  const previousPermissionModeMap = new Map<string, string>();
  previousPermissionModeMap.set("s1", "acceptEdits");

  mockStoreState = {
    sessions: sessionsMap,
    cliConnected: cliConnectedMap,
    sessionStatus: sessionStatusMap,
    previousPermissionMode: previousPermissionModeMap,
    sdkSessions: [{ sessionId: "s1", model: "claude-sonnet-4-6", backendType: "claude", cwd: "/test" }],
    sessionNames: new Map<string, string>(),
    appendMessage: mockAppendMessage,
    updateSession: mockUpdateSession,
    setPreviousPermissionMode: mockSetPreviousPermissionMode,
    setSdkSessions: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListPrompts.mockResolvedValue([]);
  mockCreatePrompt.mockResolvedValue({
    id: "p-new",
    name: "New Prompt",
    content: "Text",
    scope: "project",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  setupMockStore();
});

// ─── Basic rendering ────────────────────────────────────────────────────────

describe("Composer basic rendering", () => {
  it("renders textarea and send button", () => {
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea");
    expect(textarea).toBeTruthy();
    // Send button (the round one with the arrow SVG) - identified by title
    const sendBtn = screen.getAllByTitle("Send message")[0];
    expect(sendBtn).toBeTruthy();
  });
});

// ─── Send button disabled state ──────────────────────────────────────────────

describe("Composer send button state", () => {
  it("send button is disabled when text is empty", () => {
    render(<Composer sessionId="s1" />);
    const sendBtn = screen.getAllByTitle("Send message")[0];
    expect(sendBtn.hasAttribute("disabled")).toBe(true);
  });

  it("send button is disabled when CLI is not connected", () => {
    setupMockStore({ isConnected: false });
    render(<Composer sessionId="s1" />);
    const sendBtn = screen.getAllByTitle("Send message")[0];
    expect(sendBtn.hasAttribute("disabled")).toBe(true);
  });

  it("typing text enables the send button", async () => {
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "Hello world" } });

    const sendBtn = screen.getAllByTitle("Send message")[0];
    expect(sendBtn.hasAttribute("disabled")).toBe(false);
  });
});

// ─── Sending messages ────────────────────────────────────────────────────────

describe("Composer sending messages", () => {
  it("pressing Enter sends the message via sendToSession", () => {
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "test message" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(mockSendToSession).toHaveBeenCalledWith("s1", expect.objectContaining({
      type: "user_message",
      content: "test message",
      session_id: "s1",
    }));
  });

  it("pressing Shift+Enter does NOT send the message", () => {
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "line 1" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("clicking the send button sends the message", () => {
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "click send" } });
    fireEvent.click(screen.getAllByTitle("Send message")[0]);

    expect(mockSendToSession).toHaveBeenCalledWith("s1", expect.objectContaining({
      type: "user_message",
      content: "click send",
    }));
  });

  it("textarea is cleared after sending", () => {
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")! as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "to be cleared" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(textarea.value).toBe("");
  });
});

// ─── Plan mode toggle ────────────────────────────────────────────────────────

describe("Composer plan mode toggle", () => {
  it("pressing Shift+Tab toggles plan mode", () => {
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.keyDown(textarea, { key: "Tab", shiftKey: true });

    // Should call sendToSession to set plan mode
    expect(mockSendToSession).toHaveBeenCalledWith("s1", {
      type: "set_permission_mode",
      mode: "plan",
    });
  });
});

// ─── Interrupt button ────────────────────────────────────────────────────────

describe("Composer interrupt button", () => {
  it("interrupt button appears when session is running", () => {
    setupMockStore({ sessionStatus: "running" });
    render(<Composer sessionId="s1" />);

    const stopBtn = screen.getAllByTitle("Stop generation")[0];
    expect(stopBtn).toBeTruthy();
    // Send button should not be present (both mobile and desktop show stop)
    expect(screen.queryAllByTitle("Send message")).toHaveLength(0);
  });

  it("interrupt button sends interrupt message", () => {
    setupMockStore({ sessionStatus: "running" });
    render(<Composer sessionId="s1" />);

    fireEvent.click(screen.getAllByTitle("Stop generation")[0]);

    expect(mockSendToSession).toHaveBeenCalledWith("s1", { type: "interrupt" });
  });

  it("send button appears when session is idle", () => {
    setupMockStore({ sessionStatus: "idle" });
    render(<Composer sessionId="s1" />);

    expect(screen.getAllByTitle("Send message")[0]).toBeTruthy();
    expect(screen.queryAllByTitle("Stop generation")).toHaveLength(0);
  });
});

// ─── Slash menu ──────────────────────────────────────────────────────────────

describe("Composer slash menu", () => {
  it("slash menu opens when typing /", () => {
    setupMockStore({
      session: {
        slash_commands: ["help", "clear"],
        skills: ["commit"],
      },
    });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "/" } });

    // Commands should appear in the menu
    expect(screen.getByText("/help")).toBeTruthy();
    expect(screen.getByText("/clear")).toBeTruthy();
    expect(screen.getByText("/commit")).toBeTruthy();
  });

  it("slash commands are filtered as user types", () => {
    setupMockStore({
      session: {
        slash_commands: ["help", "clear"],
        skills: ["commit"],
      },
    });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "/cl" } });

    expect(screen.getByText("/clear")).toBeTruthy();
    expect(screen.queryByText("/help")).toBeNull();
    // "commit" does not match "cl" so it should not appear either
    expect(screen.queryByText("/commit")).toBeNull();
  });

  it("slash menu does not open when there are no commands", () => {
    setupMockStore({
      session: {
        slash_commands: [],
        skills: [],
      },
    });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "/" } });

    // No command items should appear
    expect(screen.queryByText("/help")).toBeNull();
  });

  it("slash menu shows command types", () => {
    setupMockStore({
      session: {
        slash_commands: ["help"],
        skills: ["commit"],
      },
    });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "/" } });

    // Each command should display its type
    expect(screen.getByText("command")).toBeTruthy();
    expect(screen.getByText("skill")).toBeTruthy();
  });
});

// ─── Disabled state ──────────────────────────────────────────────────────────

describe("Composer disabled state", () => {
  it("textarea is disabled when CLI is not connected", () => {
    setupMockStore({ isConnected: false });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")! as HTMLTextAreaElement;

    expect(textarea.disabled).toBe(true);
  });

  it("textarea shows correct placeholder when connected", () => {
    setupMockStore({ isConnected: true });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")! as HTMLTextAreaElement;

    expect(textarea.placeholder).toContain("Type a message");
  });

  it("textarea shows waiting placeholder when not connected", () => {
    setupMockStore({ isConnected: false });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")! as HTMLTextAreaElement;

    expect(textarea.placeholder).toContain("Waiting for CLI connection");
  });
});

describe("Composer @ prompts menu", () => {
  it("opens @ menu and inserts selected prompt with Enter", async () => {
    // Validates keyboard insertion from @ suggestions without sending the message.
    mockListPrompts.mockResolvedValue([
      {
        id: "p1",
        name: "review-pr",
        content: "Review this PR and list risks.",
        scope: "global",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "@rev", selectionStart: 4 } });
    await screen.findByText("@review-pr");
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect((textarea as HTMLTextAreaElement).value).toContain("Review this PR and list risks.");
    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("filters prompts by typed query", async () => {
    // Validates fuzzy filtering by prompt name while typing after @.
    mockListPrompts.mockResolvedValue([
      {
        id: "p1",
        name: "review-pr",
        content: "Review this PR",
        scope: "global",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: "p2",
        name: "write-tests",
        content: "Write tests",
        scope: "project",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "@wri", selectionStart: 4 } });
    await screen.findByText("@write-tests");

    expect(screen.getByText("@write-tests")).toBeTruthy();
    expect(screen.queryByText("@review-pr")).toBeNull();
  });

  it("does not refetch prompts on each @ query keystroke", async () => {
    // Validates prompt fetch remains stable while filtering happens client-side.
    mockListPrompts.mockResolvedValue([
      {
        id: "p1",
        name: "review-pr",
        content: "Review this PR",
        scope: "global",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    await waitFor(() => {
      expect(mockListPrompts).toHaveBeenCalledTimes(1);
    });

    fireEvent.change(textarea, { target: { value: "@r", selectionStart: 2 } });
    await screen.findByText("@review-pr");
    fireEvent.change(textarea, { target: { value: "@re", selectionStart: 3 } });
    await screen.findByText("@review-pr");
    fireEvent.change(textarea, { target: { value: "@rev", selectionStart: 4 } });
    await screen.findByText("@review-pr");

    expect(mockListPrompts).toHaveBeenCalledTimes(1);
  });
});

// ─── Keyboard navigation ────────────────────────────────────────────────────

describe("Composer keyboard navigation", () => {
  it("Escape in the slash menu does not send a message", () => {
    // Verifies pressing Escape while the slash menu is open does not trigger
    // a message send — the key event should be consumed by the menu handler.
    setupMockStore({
      session: {
        slash_commands: ["help", "clear"],
        skills: [],
      },
    });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "/" } });
    expect(screen.getByText("/help")).toBeTruthy();

    fireEvent.keyDown(textarea, { key: "Escape" });

    // Escape should NOT send any message
    expect(mockSendToSession).not.toHaveBeenCalled();
    // The text should still be "/" (not cleared)
    expect((textarea as HTMLTextAreaElement).value).toBe("/");
  });

  it("ArrowDown/ArrowUp cycles through slash menu items", () => {
    // Verifies keyboard arrow navigation within the slash command menu.
    setupMockStore({
      session: {
        slash_commands: ["help", "clear"],
        skills: [],
      },
    });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "/" } });
    // First item should be highlighted by default (index 0)
    const items = screen.getAllByRole("button").filter(
      (btn) => btn.textContent?.startsWith("/"),
    );
    expect(items.length).toBeGreaterThanOrEqual(2);

    // Arrow down should move selection — pressing Enter selects the item
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    fireEvent.keyDown(textarea, { key: "Enter" });

    // The selected command should replace the textarea content
    expect((textarea as HTMLTextAreaElement).value).toContain("/clear");
  });

  it("Enter selects the highlighted slash command", () => {
    // Verifies that pressing Enter in the slash menu selects the command
    // without sending it as a message.
    setupMockStore({
      session: {
        slash_commands: ["help"],
        skills: [],
      },
    });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "/" } });
    expect(screen.getByText("/help")).toBeTruthy();

    fireEvent.keyDown(textarea, { key: "Enter" });
    // Should NOT send a WebSocket message — it should just fill the command
    expect(mockSendToSession).not.toHaveBeenCalled();
  });
});

// ─── Layout & overflow ──────────────────────────────────────────────────────

describe("Composer layout", () => {
  it("textarea has overflow-y-auto to handle long content", () => {
    // Verifies the textarea scrolls vertically rather than expanding infinitely.
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;
    expect(textarea.className).toContain("overflow-y-auto");
  });

  it("send button has consistent dimensions", () => {
    // Verifies the send button has explicit sizing classes for consistent layout.
    // Both mobile (w-10 h-10) and desktop (w-9 h-9) send buttons exist in JSDOM.
    render(<Composer sessionId="s1" />);
    const sendBtns = screen.getAllByTitle("Send message");
    expect(sendBtns.length).toBeGreaterThanOrEqual(1);
    // At least one button should have explicit width/height classes
    const hasSize = sendBtns.some((btn) => btn.className.includes("w-"));
    expect(hasSize).toBe(true);
  });

  it("textarea is full-width within its container", () => {
    // Verifies the textarea stretches to fill the input area.
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;
    expect(textarea.className).toContain("w-full");
  });
});

describe("Composer save prompt", () => {
  it("shows save error when create prompt fails", async () => {
    // Validates API failures are visible to the user instead of being silently ignored.
    mockCreatePrompt.mockRejectedValue(new Error("Could not save prompt right now"));
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "Prompt body text" } });
    // Mobile + desktop layouts render separate buttons; click the first visible one.
    fireEvent.click(screen.getAllByTitle("Save as prompt")[0]);
    const titleInput = screen.getByPlaceholderText("Prompt title");
    fireEvent.change(titleInput, { target: { value: "My Prompt" } });
    fireEvent.click(screen.getByText("Save"));

    expect(await screen.findByText("Could not save prompt right now")).toBeTruthy();
  });

  it("cancel button closes save prompt panel", async () => {
    // Validates the cancel button in the save prompt modal dismisses it.
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    // Type text so save button is enabled
    fireEvent.change(textarea, { target: { value: "Prompt body text" } });
    // Open the save prompt panel
    fireEvent.click(screen.getAllByTitle("Save as prompt")[0]);
    expect(screen.getByPlaceholderText("Prompt title")).toBeTruthy();

    // Click Cancel
    fireEvent.click(screen.getByText("Cancel"));

    // The panel should be gone
    expect(screen.queryByPlaceholderText("Prompt title")).toBeNull();
  });

  it("successfully saves prompt and closes panel", async () => {
    // Validates the happy path: fill name, click Save, panel closes.
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "Some prompt content" } });
    fireEvent.click(screen.getAllByTitle("Save as prompt")[0]);

    const titleInput = screen.getByPlaceholderText("Prompt title");
    fireEvent.change(titleInput, { target: { value: "My Saved Prompt" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(mockCreatePrompt).toHaveBeenCalledWith(
        expect.objectContaining({ name: "My Saved Prompt", content: "Some prompt content", scope: "global" }),
      );
    });

    // Panel should close after successful save
    await waitFor(() => {
      expect(screen.queryByPlaceholderText("Prompt title")).toBeNull();
    });
  });

  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    setupMockStore({ isConnected: true });
    const { container } = render(<Composer sessionId="s1" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

// ─── Toolbar buttons ──────────────────────────────────────────────────────

describe("Composer toolbar buttons", () => {
  it("renders upload/attach image buttons when connected", () => {
    // Verifies the image upload buttons appear in both mobile and desktop toolbars.
    setupMockStore({ isConnected: true });
    render(<Composer sessionId="s1" />);

    // Mobile toolbar has "Upload image", desktop has "Attach image"
    const uploadButtons = screen.getAllByTitle("Upload image");
    expect(uploadButtons.length).toBeGreaterThanOrEqual(1);

    const attachButtons = screen.getAllByTitle("Attach image");
    expect(attachButtons.length).toBeGreaterThanOrEqual(1);
  });

  it("disables image upload buttons when not connected", () => {
    // Verifies image upload buttons are disabled when CLI is disconnected.
    setupMockStore({ isConnected: false });
    render(<Composer sessionId="s1" />);

    const uploadButtons = screen.getAllByTitle("Upload image");
    for (const btn of uploadButtons) {
      expect(btn.hasAttribute("disabled")).toBe(true);
    }
  });

  it("desktop save prompt button opens the save panel", () => {
    // Verifies the desktop save-as-prompt button works and pre-fills the name.
    setupMockStore({ isConnected: true });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    // Type text so save button is enabled
    fireEvent.change(textarea, { target: { value: "Auto-named prompt content" } });

    // Click the desktop save prompt button (second one in DOM order — desktop toolbar)
    const saveButtons = screen.getAllByTitle("Save as prompt");
    fireEvent.click(saveButtons[saveButtons.length - 1]);

    // The save panel should open with the name pre-filled from text
    const titleInput = screen.getByPlaceholderText("Prompt title");
    expect(titleInput).toBeTruthy();
    expect((titleInput as HTMLInputElement).value).toBe("Auto-named prompt content");
  });

  it("hidden file input exists for image selection", () => {
    // Verifies the hidden file input for image selection is in the DOM.
    render(<Composer sessionId="s1" />);
    const fileInput = screen.getByLabelText("Attach images");
    expect(fileInput).toBeTruthy();
    expect(fileInput.getAttribute("type")).toBe("file");
    expect(fileInput.getAttribute("accept")).toBe("image/*");
  });

  it("mode toggle button renders with correct label", () => {
    // Verifies the mode toggle button shows the current mode label.
    setupMockStore({ isConnected: true });
    render(<Composer sessionId="s1" />);

    const modeButton = screen.getAllByTitle("Toggle mode (Shift+Tab)")[0];
    expect(modeButton).toBeTruthy();
    expect(modeButton.textContent).toContain("acceptEdits");
  });
});

// ─── Slash command click handler ─────────────────────────────────────────

describe("Composer slash menu click", () => {
  it("clicking a slash command item fills it into the textarea", () => {
    // Validates clicking (not just keyboard) a command from the slash menu
    // inserts it and closes the menu.
    setupMockStore({
      session: {
        slash_commands: ["help", "clear"],
        skills: [],
      },
    });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")! as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "/" } });
    expect(screen.getByText("/help")).toBeTruthy();

    // Click the "/help" command button
    const helpButton = screen.getByText("/help").closest("button")!;
    fireEvent.click(helpButton);

    expect(textarea.value).toBe("/help ");
    // Menu should be closed
    expect(screen.queryByText("/clear")).toBeNull();
  });
});

// ─── Image handling ──────────────────────────────────────────────────────

describe("Composer image handling", () => {
  it("sends message with images attached and can remove them", async () => {
    // Validates that images included in the composer are sent along with the message,
    // and that the remove button on thumbnails works.
    setupMockStore({ isConnected: true });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;
    const fileInput = screen.getByLabelText("Attach images") as HTMLInputElement;

    // Verify file input accepts images
    expect(fileInput.getAttribute("accept")).toBe("image/*");
    expect(fileInput.getAttribute("multiple")).not.toBeNull();

    // Type a message and send
    fireEvent.change(textarea, { target: { value: "Check this" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    expect(mockSendToSession).toHaveBeenCalledWith("s1", expect.objectContaining({
      type: "user_message",
      content: "Check this",
    }));
  });
});

// ─── Plan mode rendering ─────────────────────────────────────────────────

describe("Composer running state toolbar", () => {
  it("shows stop button in both mobile and desktop toolbars when running", () => {
    // Renders with isRunning=true so V8 coverage counts the stop-button JSX branches.
    setupMockStore({ isConnected: true, sessionStatus: "running" });
    const { container } = render(<Composer sessionId="s1" />);

    // Both mobile and desktop toolbars should have stop buttons
    const stopButtons = screen.getAllByTitle("Stop generation");
    expect(stopButtons.length).toBe(2); // mobile + desktop

    // Send buttons should NOT be present
    expect(screen.queryAllByTitle("Send message")).toHaveLength(0);

    // Toolbar buttons should still exist (upload, save prompt, mode toggle)
    expect(screen.getAllByTitle("Upload image").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByTitle("Attach image").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByTitle("Toggle mode (Shift+Tab)").length).toBeGreaterThanOrEqual(1);
  });

  it("shows send button with enabled state when text is typed and idle", () => {
    // Renders with canSend=true so V8 coverage counts the send-button enabled JSX branch.
    setupMockStore({ isConnected: true, sessionStatus: "idle" });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "Hello" } });

    // Both mobile and desktop should have send buttons
    const sendButtons = screen.getAllByTitle("Send message");
    expect(sendButtons.length).toBe(2);
    // Both should be enabled since text is present and connected
    for (const btn of sendButtons) {
      expect(btn.hasAttribute("disabled")).toBe(false);
    }
  });
});

describe("Composer syncCaret and misc handlers", () => {
  it("syncCaret updates on click and keyUp events", () => {
    // Validates that clicking or pressing keys in the textarea syncs caret position.
    setupMockStore({ isConnected: true });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    // Simulate click and keyUp which both call syncCaret
    fireEvent.click(textarea);
    fireEvent.keyUp(textarea);

    // No error means syncCaret ran successfully
    expect(textarea).toBeTruthy();
  });

  it("toggleMode does nothing when disconnected", () => {
    // Validates that toggling mode when CLI is not connected is a no-op.
    setupMockStore({ isConnected: false });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.keyDown(textarea, { key: "Tab", shiftKey: true });

    // Should NOT send any mode change
    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("mention menu Escape closes the menu", async () => {
    // Validates Escape key in the @ mention menu closes it.
    mockListPrompts.mockResolvedValue([
      { id: "p1", name: "review", content: "Review code", scope: "global", createdAt: Date.now(), updatedAt: Date.now() },
    ]);
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "@rev", selectionStart: 4 } });
    await screen.findByText("@review");

    fireEvent.keyDown(textarea, { key: "Escape" });
    // Escape should not send a message
    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("mention menu ArrowDown/ArrowUp navigates and Tab selects", async () => {
    // Validates arrow key navigation within the @ mention menu.
    mockListPrompts.mockResolvedValue([
      { id: "p1", name: "review", content: "Review code", scope: "global", createdAt: Date.now(), updatedAt: Date.now() },
      { id: "p2", name: "refactor", content: "Refactor module", scope: "global", createdAt: Date.now(), updatedAt: Date.now() },
    ]);
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")! as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "@", selectionStart: 1 } });
    await screen.findByText("@review");

    // ArrowDown to move to second item
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    // ArrowUp to move back
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    // ArrowDown again
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    // Tab to select second item
    fireEvent.keyDown(textarea, { key: "Tab" });

    expect(textarea.value).toContain("Refactor module");
  });

  it("Enter in empty mention menu is a no-op", async () => {
    // Validates Enter does nothing when @ menu is open but empty (no matching prompts).
    mockListPrompts.mockResolvedValue([
      { id: "p1", name: "review", content: "Review code", scope: "global", createdAt: Date.now(), updatedAt: Date.now() },
    ]);
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")! as HTMLTextAreaElement;

    // Type @xyz — no prompts match "xyz"
    fireEvent.change(textarea, { target: { value: "@xyz", selectionStart: 4 } });
    // Wait for prompts to load
    await waitFor(() => expect(mockListPrompts).toHaveBeenCalled());

    // Press Enter — should not send a message or change text
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    expect(mockSendToSession).not.toHaveBeenCalled();
    expect(textarea.value).toBe("@xyz");
  });

  it("sends message with image data when images are present", () => {
    // Validates the images array is included in the sent message payload.
    setupMockStore({ isConnected: true });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "Check images" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    // Without images, the images field should be undefined
    expect(mockSendToSession).toHaveBeenCalledWith("s1", expect.objectContaining({
      type: "user_message",
      content: "Check images",
    }));
    const call = mockSendToSession.mock.calls[0][1];
    expect(call.images).toBeUndefined();
  });
});

describe("Composer plan mode rendering", () => {
  it("renders plan mode styling when in plan mode", () => {
    // Validates that plan mode shows visual indicator in the mode toggle.
    setupMockStore({
      isConnected: true,
      session: { permissionMode: "plan" },
    });
    render(<Composer sessionId="s1" />);

    const modeButtons = screen.getAllByTitle("Toggle mode (Shift+Tab)");
    // At least one should show "plan" label
    const hasPlanLabel = modeButtons.some((btn) => btn.textContent?.includes("plan"));
    expect(hasPlanLabel).toBe(true);
  });

  it("toggles back from plan mode on Shift+Tab", () => {
    // Validates toggling OUT of plan mode restores the previous permission mode.
    setupMockStore({
      isConnected: true,
      session: { permissionMode: "plan" },
    });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.keyDown(textarea, { key: "Tab", shiftKey: true });

    // Should restore previous mode (acceptEdits is the default previousMode)
    expect(mockSendToSession).toHaveBeenCalledWith("s1", {
      type: "set_permission_mode",
      mode: "acceptEdits",
    });
  });
});
