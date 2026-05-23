const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-5";

async function callAnthropic(system, userMessage, maxTokens = 1000) {
  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userMessage }],
    }),
  });
  const data = await res.json();
  console.log("Anthropic status:", res.status, "response:", JSON.stringify(data).slice(0, 200));
  if (!res.ok) throw new Error(data.error?.message || "Anthropic API error");
  return data.content?.[0]?.text || "";
}

// ── Food search ──────────────────────────────────────────────────────────────
app.post("/api/food/search", async (req, res) => {
  const { query } = req.body;
  if (!query?.trim()) return res.status(400).json({ error: "No query" });
  try {
    const text = await callAnthropic(
      `You are a nutrition database. Return ONLY a valid JSON array, no markdown, no explanation.
Each item: {"name":"...","cal":number,"protein":number,"carbs":number,"fat":number}
Values are per 100g unless a serving size is more natural (e.g. 1 egg, 1 banana). Round to 1 decimal. Return 8-10 items.`,
      `Give me 8-10 foods matching "${query}" with accurate macros.`
    );
    const clean = text.replace(/```json|```/g, "").trim();
    res.json(JSON.parse(clean));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Barcode lookup ───────────────────────────────────────────────────────────
app.post("/api/food/barcode", async (req, res) => {
  const { barcode } = req.body;
  if (!barcode?.trim()) return res.status(400).json({ error: "No barcode" });
  try {
    const text = await callAnthropic(
      `You are a nutrition database. Return ONLY a valid JSON array, no markdown.
Each item: {"name":"...","cal":number,"protein":number,"carbs":number,"fat":number}
If you don't recognise the barcode return [].`,
      `Barcode ${barcode}. Return nutrition info if you know this product, otherwise [].`,
      500
    );
    const clean = text.replace(/```json|```/g, "").trim();
    res.json(JSON.parse(clean));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── AI Coaching nudge ─────────────────────────────────────────────────────────
app.post("/api/nudge", async (req, res) => {
  const { context } = req.body;
  if (!context?.trim()) return res.status(400).json({ error: "No context" });
  try {
    const text = await callAnthropic(
      `You are the AI coach inside Swayd — a fitness app built on one idea: "so what are you doing?" You speak like a sharp, direct PT who actually gives a damn. One specific, data-driven insight based on the user's stats. 2-3 sentences max. No generic advice, no fluff, no emojis. Be honest — even if it stings. Start with the most important observation. Sound like a person, not a bot. The brand voice is bold, minimal, a little edgy — like someone who trains hard and doesn't waste words.`,
      `My stats:\n${context}\n\nGive me one coaching insight.`,
      150
    );
    res.json({ text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "ok", app: "Swayd API" }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Swayd API running on port ${PORT}`));
