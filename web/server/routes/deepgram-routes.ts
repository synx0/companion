import type { Hono } from "hono";
import { getSettings } from "../settings-manager.js";

export function registerDeepgramRoutes(api: Hono): void {
  /**
   * POST /deepgram/transcribe
   * Accepts audio via multipart/form-data, proxies to Deepgram REST API,
   * returns transcribed text. Optional ?keywords= query param for enrichment.
   */
  api.post("/deepgram/transcribe", async (c) => {
    const settings = getSettings();
    const apiKey = settings.deepgramApiKey.trim();
    if (!apiKey) {
      return c.json({ error: "Deepgram API key is not configured" }, 400);
    }

    const formData = await c.req.formData().catch(() => null);
    if (!formData) {
      return c.json({ error: "Invalid form data" }, 400);
    }

    const audioFile = formData.get("audio") as File | null;
    if (!audioFile) {
      return c.json({ error: "No audio file provided" }, 400);
    }

    const audioBuffer = await audioFile.arrayBuffer();
    if (audioBuffer.byteLength === 0) {
      return c.json({ error: "Audio file is empty" }, 400);
    }

    // Optional keyword enrichment from query params
    const keywordsParam = c.req.query("keywords");

    const params = new URLSearchParams({
      model: "nova-3",
      smart_format: "true",
      punctuate: "true",
    });
    if (keywordsParam) {
      for (const kw of keywordsParam.split(",").map((k) => k.trim()).filter(Boolean)) {
        params.append("keywords", kw);
      }
    }

    let dgResponse: Response;
    try {
      dgResponse = await fetch(
        `https://api.deepgram.com/v1/listen?${params.toString()}`,
        {
          method: "POST",
          headers: {
            Authorization: `Token ${apiKey}`,
            "Content-Type": audioFile.type || "audio/webm",
          },
          body: audioBuffer,
        },
      );
    } catch (err) {
      return c.json(
        { error: `Failed to reach Deepgram: ${err instanceof Error ? err.message : String(err)}` },
        502,
      );
    }

    if (!dgResponse.ok) {
      const errBody = await dgResponse.text().catch(() => "");
      return c.json(
        { error: `Deepgram error: ${dgResponse.status} ${errBody}` },
        dgResponse.status === 401 ? 401 : 502,
      );
    }

    const result = await dgResponse.json();
    const transcript =
      result?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";

    return c.json({ text: transcript });
  });

  /**
   * POST /deepgram/verify
   * Validates the stored Deepgram API key by calling the projects endpoint.
   * Returns { connected, projectName?, error? }.
   */
  api.post("/deepgram/verify", async (c) => {
    const settings = getSettings();
    const apiKey = settings.deepgramApiKey.trim();
    if (!apiKey) {
      return c.json({ connected: false, error: "No API key configured" });
    }

    try {
      const res = await fetch("https://api.deepgram.com/v1/projects", {
        headers: { Authorization: `Token ${apiKey}` },
      });
      if (res.ok) {
        const data = await res.json();
        const projectName = data?.projects?.[0]?.name || "Deepgram";
        return c.json({ connected: true, projectName });
      }
      return c.json({ connected: false, error: `API returned ${res.status}` });
    } catch (err) {
      return c.json({
        connected: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
