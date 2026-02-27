import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { registerDeepgramRoutes } from "./deepgram-routes.js";

// Mock settings-manager to control deepgramApiKey
let mockSettings = { deepgramApiKey: "" };

vi.mock("../settings-manager.js", () => ({
  getSettings: () => ({ ...mockSettings }),
}));

// Mock global fetch to simulate Deepgram API responses
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function createApp() {
  const app = new Hono();
  registerDeepgramRoutes(app);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSettings = { deepgramApiKey: "" };
});

describe("POST /deepgram/transcribe", () => {
  it("returns 400 when no API key is configured", async () => {
    const app = createApp();
    const formData = new FormData();
    formData.append("audio", new Blob(["fake"], { type: "audio/webm" }), "test.webm");

    const res = await app.request("/deepgram/transcribe", {
      method: "POST",
      body: formData,
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Deepgram API key is not configured");
  });

  it("returns 400 when no audio file is provided", async () => {
    mockSettings.deepgramApiKey = "dg_test_key";
    const app = createApp();
    const formData = new FormData();

    const res = await app.request("/deepgram/transcribe", {
      method: "POST",
      body: formData,
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("No audio file provided");
  });

  it("returns transcript on successful transcription", async () => {
    mockSettings.deepgramApiKey = "dg_test_key";
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          results: {
            channels: [
              {
                alternatives: [
                  { transcript: "Hello world" },
                ],
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );

    const app = createApp();
    const formData = new FormData();
    formData.append("audio", new Blob(["fake-audio-data"], { type: "audio/webm" }), "test.webm");

    const res = await app.request("/deepgram/transcribe", {
      method: "POST",
      body: formData,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.text).toBe("Hello world");

    // Verify the fetch was called with the correct Deepgram URL and auth header
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("https://api.deepgram.com/v1/listen");
    expect(opts.headers.Authorization).toBe("Token dg_test_key");
  });

  it("returns 502 on Deepgram API error", async () => {
    mockSettings.deepgramApiKey = "dg_test_key";
    mockFetch.mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 }),
    );

    const app = createApp();
    const formData = new FormData();
    formData.append("audio", new Blob(["fake-audio-data"], { type: "audio/webm" }), "test.webm");

    const res = await app.request("/deepgram/transcribe", {
      method: "POST",
      body: formData,
    });

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain("Deepgram error: 500");
  });

  it("returns 401 when Deepgram returns 401", async () => {
    mockSettings.deepgramApiKey = "dg_invalid_key";
    mockFetch.mockResolvedValueOnce(
      new Response("Unauthorized", { status: 401 }),
    );

    const app = createApp();
    const formData = new FormData();
    formData.append("audio", new Blob(["fake-audio-data"], { type: "audio/webm" }), "test.webm");

    const res = await app.request("/deepgram/transcribe", {
      method: "POST",
      body: formData,
    });

    expect(res.status).toBe(401);
  });

  it("passes keywords to Deepgram query params", async () => {
    mockSettings.deepgramApiKey = "dg_test_key";
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          results: { channels: [{ alternatives: [{ transcript: "test" }] }] },
        }),
        { status: 200 },
      ),
    );

    const app = createApp();
    const formData = new FormData();
    formData.append("audio", new Blob(["fake"], { type: "audio/webm" }), "test.webm");

    const res = await app.request("/deepgram/transcribe?keywords=react,typescript", {
      method: "POST",
      body: formData,
    });

    expect(res.status).toBe(200);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("keywords=react");
    expect(url).toContain("keywords=typescript");
  });
});

describe("POST /deepgram/verify", () => {
  it("returns connected false when no API key configured", async () => {
    const app = createApp();

    const res = await app.request("/deepgram/verify", { method: "POST" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connected).toBe(false);
    expect(body.error).toBe("No API key configured");
  });

  it("returns connected true with project name on valid key", async () => {
    mockSettings.deepgramApiKey = "dg_valid_key";
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          projects: [{ name: "My DG Project" }],
        }),
        { status: 200 },
      ),
    );

    const app = createApp();
    const res = await app.request("/deepgram/verify", { method: "POST" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connected).toBe(true);
    expect(body.projectName).toBe("My DG Project");
  });

  it("returns connected false on invalid key", async () => {
    mockSettings.deepgramApiKey = "dg_invalid_key";
    mockFetch.mockResolvedValueOnce(
      new Response("Unauthorized", { status: 401 }),
    );

    const app = createApp();
    const res = await app.request("/deepgram/verify", { method: "POST" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connected).toBe(false);
    expect(body.error).toContain("401");
  });

  it("returns connected false on network error", async () => {
    mockSettings.deepgramApiKey = "dg_test_key";
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const app = createApp();
    const res = await app.request("/deepgram/verify", { method: "POST" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connected).toBe(false);
    expect(body.error).toBe("Network error");
  });
});
