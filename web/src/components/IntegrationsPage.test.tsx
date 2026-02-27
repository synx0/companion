// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

interface MockStoreState {
  currentSessionId: string | null;
}

let mockState: MockStoreState;

const mockApi = {
  getSettings: vi.fn(),
  getLinearConnection: vi.fn(),
  verifyDeepgramConnection: vi.fn(),
};

vi.mock("../api.js", () => ({
  api: {
    getSettings: (...args: unknown[]) => mockApi.getSettings(...args),
    getLinearConnection: (...args: unknown[]) => mockApi.getLinearConnection(...args),
    verifyDeepgramConnection: (...args: unknown[]) => mockApi.verifyDeepgramConnection(...args),
  },
}));

vi.mock("../store.js", () => {
  const useStoreFn = (selector: (state: MockStoreState) => unknown) => selector(mockState);
  useStoreFn.getState = () => mockState;
  return { useStore: useStoreFn };
});

import { IntegrationsPage } from "./IntegrationsPage.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockState = { currentSessionId: null };
  mockApi.getSettings.mockResolvedValue({
    openrouterApiKeyConfigured: false,
    openrouterModel: "openrouter/free",
    linearApiKeyConfigured: true,
    deepgramApiKeyConfigured: true,
  });
  mockApi.getLinearConnection.mockResolvedValue({
    connected: true,
    viewerName: "Ada",
    viewerEmail: "ada@example.com",
    teamName: "Engineering",
    teamKey: "ENG",
  });
  mockApi.verifyDeepgramConnection.mockResolvedValue({
    connected: true,
    projectName: "My Project",
  });
  window.location.hash = "#/integrations";
});

describe("IntegrationsPage", () => {
  it("shows Linear card with live status", async () => {
    render(<IntegrationsPage />);

    expect(mockApi.getSettings).toHaveBeenCalledTimes(1);
    await screen.findByText("Linear");
    // Both Linear and Deepgram cards may show "Connected" dots
    const dots = await screen.findAllByLabelText("Connected");
    expect(dots.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Ada \u2022 Engineering")).toBeInTheDocument();
  });

  it("opens dedicated Linear settings page from card", async () => {
    render(<IntegrationsPage />);

    await screen.findByRole("button", { name: "Open Linear settings" });
    fireEvent.click(screen.getByRole("button", { name: "Open Linear settings" }));

    await waitFor(() => {
      expect(window.location.hash).toBe("#/integrations/linear");
    });
  });

  it("shows Deepgram card with live status", async () => {
    render(<IntegrationsPage />);

    expect(mockApi.getSettings).toHaveBeenCalledTimes(1);
    await screen.findByText("Deepgram");
    // Both Linear and Deepgram should show connected dots
    const connectedDots = await screen.findAllByLabelText("Connected");
    expect(connectedDots.length).toBe(2);
    expect(screen.getByText("My Project")).toBeInTheDocument();
  });

  it("opens dedicated Deepgram settings page from card", async () => {
    render(<IntegrationsPage />);

    await screen.findByRole("button", { name: "Open Deepgram settings" });
    fireEvent.click(screen.getByRole("button", { name: "Open Deepgram settings" }));

    await waitFor(() => {
      expect(window.location.hash).toBe("#/integrations/deepgram");
    });
  });

  it("does not call verifyDeepgramConnection when not configured", async () => {
    mockApi.getSettings.mockResolvedValue({
      openrouterApiKeyConfigured: false,
      openrouterModel: "openrouter/free",
      linearApiKeyConfigured: false,
      deepgramApiKeyConfigured: false,
    });

    render(<IntegrationsPage />);

    await screen.findByText("Deepgram");
    expect(mockApi.verifyDeepgramConnection).not.toHaveBeenCalled();
  });
});
