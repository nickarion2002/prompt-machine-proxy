const express = require("express");
const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// Health check
app.get("/", (req, res) => {
  res.json({ status: "Prompt Maschine proxy is running." });
});

// Proxy endpoint — iOS app calls this instead of OpenRouter directly
app.post("/api/generate", async (req, res) => {
  if (!OPENROUTER_API_KEY) {
    return res.status(500).json({ error: "Server misconfiguration: missing API key." });
  }

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(req.body),
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
