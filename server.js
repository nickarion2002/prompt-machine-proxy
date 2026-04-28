const express = require("express");
const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// ─── Model ID remapping ───────────────────────────────────────────────────────
// OpenRouter periodically deprecates model IDs. We remap old IDs to current
// valid ones so the iOS app keeps working without forcing every user to update.
const MODEL_REMAP = {
  "google/gemini-flash-1.5":      "google/gemini-2.5-flash",
  "google/gemini-1.5-flash":      "google/gemini-2.5-flash",
  "mistralai/mistral-small-3.1":  "mistralai/mistral-small-3.2-24b-instruct-2506",
  "deepseek/deepseek-chat":       "deepseek/deepseek-chat-v3.1",
};

function remapModel(modelId) {
  return MODEL_REMAP[modelId] || modelId;
}

// Health check
app.get("/", (req, res) => {
  res.json({ status: "Prompt Maschine proxy is running." });
});

// Proxy endpoint - iOS app calls this instead of OpenRouter directly
app.post("/api/generate", async (req, res) => {
  if (!OPENROUTER_API_KEY) {
    return res.status(500).json({ error: "Server misconfiguration: missing API key." });
  }

  // Remap deprecated model IDs to current valid ones
  const remappedBody = { ...req.body };
  if (remappedBody.model) {
    const remapped = remapModel(remappedBody.model);
    if (remapped !== remappedBody.model) {
      console.log(`[generate] Remapped ${remappedBody.model} -> ${remapped}`);
      remappedBody.model = remapped;
    }
  }

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(remappedBody),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    return res.json(data);
  } catch (err) {
    console.error("Proxy error:", err);
    return res.status(500).json({ error: "Proxy request failed." });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
});
