// AI Mystery Shopper — server.js
//
// Dunne Express-laag rond de agent-logica in lib/agent.js. De agent doorloopt
// met Playwright (headless Chromium) een website als gesimuleerde klant en
// laat Claude bij elke stap de volgende actie kiezen (klikken/invullen/stoppen).
//
// Veiligheidsregel: de agent rondt nooit een echte aankoop, bestelling of
// accountaanmaak af (zie lib/agent.js).

const express = require("express");
const path = require("path");
const { PERSONAS, MAX_STEPS_LIMIT, validateUrl, runMysteryShopper } = require("./lib/agent");

const PORT = process.env.PORT || 10000;

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/personas", (req, res) => {
  res.json({ personas: PERSONAS });
});

app.post("/api/run-test", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Serverconfiguratie ontbreekt (ANTHROPIC_API_KEY)." });
    return;
  }

  const { url, personaKey, goal, maxSteps, consent } = req.body || {};

  if (!consent) {
    res.status(400).json({ error: "Bevestig eerst dat je toestemming hebt om deze site te testen." });
    return;
  }
  const persona = PERSONAS[personaKey];
  if (!persona) {
    res.status(400).json({ error: "Onbekende persona." });
    return;
  }
  if (!goal || typeof goal !== "string" || !goal.trim()) {
    res.status(400).json({ error: "Vul een doel voor deze klant in." });
    return;
  }
  const check = validateUrl(url || "");
  if (!check.ok) {
    res.status(400).json({ error: check.error });
    return;
  }
  const steps = Math.min(Math.max(parseInt(maxSteps, 10) || 5, 3), MAX_STEPS_LIMIT);

  try {
    const result = await runMysteryShopper({
      url: check.url,
      persona,
      goal: goal.trim().slice(0, 300),
      maxSteps: steps,
      apiKey,
    });
    res.json({ persona: persona.label, goal: goal.trim(), url: check.url, ...result });
  } catch (err) {
    console.error("Mystery shopper run failed:", err && err.message, err && err.stack);
    res.status(500).json({ error: "Er ging iets mis tijdens de test. Probeer het opnieuw." });
  }
});

app.listen(PORT, () => {
  console.log(`AI Mystery Shopper draait op poort ${PORT}`);
  console.log(`ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? "gevonden ✔" : "ONTBREEKT ✘"}`);
});
