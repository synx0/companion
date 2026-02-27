// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

interface MockStoreState {
  currentSessionId: string | null;
}

let mockState: MockStoreState;

const mockApi = {
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  verifyDeepgramConnection: vi.fn(),
};

vi.mock("../api.js", () => ({
  api: {
    getSettings: (...args: unknown[]) => mockApi.getSettings(...args),
    updateSettings: (...args: unknown[]) => mockApi.updateSettings(...args),
    verifyDeepgramConnection: (...args: unknown[]) => mockApi.verifyDeepgramConnection(...args),
  },
}));

vi.mock("../store.js", () => {
  const useStoreFn = (selector: (state: MockStoreState) => unknown) => selector(mockState);
  useStoreFn.getState = () => mockState;
  return { useStore: useStoreFn };
});

import { DeepgramSettingsPage } from "./DeepgramSettingsPage.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockState = { currentSessionId: null };
  mockApi.getSettings.mockResolvedValue({
    openrouterApiKeyConfigured: false,
    openrouterModel: "openrouter/free",
    linearApiKeyConfigured: false,
    deepgramApiKeyConfigured: true,
  });
  mockApi.updateSettings.mockResolvedValue({
    openrouterApiKeyConfigured: false,
    openrouterModel: "openrouter/free",
    linearApiKeyConfigured: false,
    deepgramApiKeyConfigured: true,
  });
  mockApi.verifyDeepgramConnection.mockResolvedValue({
    connected: true,
    projectName: "My Project",
  });
});

describe("DeepgramSettingsPage", () => {
  it("loads Deepgram configuration status", async () => {
    render(<DeepgramSettingsPage />);
    expect(mockApi.getSettings).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Deepgram key configured")).toBeInTheDocument();
  });

  it("saves trimmed Deepgram API key", async () => {
    render(<DeepgramSettingsPage />);
    await screen.findByText("Deepgram key configured");

    fireEvent.change(screen.getByLabelText("Deepgram API Key"), {
      target: { value: "  dg_api_123  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({ deepgramApiKey: "dg_api_123" });
    });
    expect(mockApi.verifyDeepgramConnection).toHaveBeenCalled();
    expect(await screen.findByText("Integration saved.")).toBeInTheDocument();
  });

  it("shows an error when saving empty key", async () => {
    render(<DeepgramSettingsPage />);
    await screen.findByText("Deepgram key configured");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Please enter a Deepgram API key.")).toBeInTheDocument();
    expect(mockApi.updateSettings).not.toHaveBeenCalled();
  });

  it("verifies connection when Verify is clicked", async () => {
    render(<DeepgramSettingsPage />);
    await screen.findByText("Deepgram key configured");

    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() => {
      expect(mockApi.verifyDeepgramConnection).toHaveBeenCalled();
    });
    expect(await screen.findByText("Deepgram connection verified.")).toBeInTheDocument();
  });

  it("disconnects Deepgram integration", async () => {
    mockApi.updateSettings.mockResolvedValueOnce({
      openrouterApiKeyConfigured: false,
      openrouterModel: "openrouter/free",
      linearApiKeyConfigured: false,
      deepgramApiKeyConfigured: false,
    });

    render(<DeepgramSettingsPage />);
    await screen.findByText("Deepgram key configured");

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({ deepgramApiKey: "" });
    });
    expect(await screen.findByText("Deepgram disconnected.")).toBeInTheDocument();
  });

  it("shows connected status with project name", async () => {
    render(<DeepgramSettingsPage />);

    // Wait for the connection check to complete
    await waitFor(() => {
      expect(mockApi.verifyDeepgramConnection).toHaveBeenCalled();
    });

    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(await screen.findByText("My Project")).toBeInTheDocument();
  });
});
