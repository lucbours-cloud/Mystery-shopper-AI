// AI Mystery Shopper — server.js
//
// Dunne Express-laag rond de agent-logica in lib/agent.js. Omdat een vergelijking
// met meerdere persona's een paar minuten kan duren, draait dat op de achtergrond
// als "job" (in-memory) terwijl de frontend de voortgang uitpolt — zo blijft geen
// enkel HTTP-verzoek lang genoeg open om door een proxy-timeout geraakt te worden.

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { PERSONAS, MAX_STEPS_LIMIT, MAX_PERSONAS_PER_RUN, validateUrl, runComparison } = require("./lib/agent");

const PORT = process.env.PORT || 10000;
const JOB_TTL_MS = 30 * 60 * 1000; // opruimen na 30 min

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const jobs = new Map();

function cleanupOldJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) jobs.delete(id);
  }
}

function friendlyErrorFor(err) {
  const msg = (err && err.message) || "";
  if (msg.includes("Timeout") && msg.includes("goto")) {
    return "Kon de website niet op tijd laden. Controleer of de URL klopt en de site bereikbaar is.";
  }
  if (msg.toLowerCase().includes("net::")) {
    return "Kon geen verbinding maken met deze website. Controleer of de URL klopt.";
  }
  if (msg.includes("Anthropic API-fout")) {
    return "De AI kon geen beslissing nemen (probleem bij Claude). Probeer het opnieuw.";
  }
  return "Er ging iets mis tijdens de test. Probeer het opnieuw.";
}

app.get("/api/personas", (req, res) => {
  res.json({ personas: PERSONAS, maxPersonas: MAX_PERSONAS_PER_RUN });
});

app.post("/api/start-test", (req, res) => {
  cleanupOldJobs();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Serverconfiguratie ontbreekt (ANTHROPIC_API_KEY)." });
    return;
  }

  const { url, personaKeys, goal, maxSteps, consent } = req.body || {};

  if (!consent) {
    res.status(400).json({ error: "Bevestig eerst dat je toestemming hebt om deze site te testen." });
    return;
  }
  const keys = Array.isArray(personaKeys) ? personaKeys.filter((k) => PERSONAS[k]) : [];
  if (keys.length === 0) {
    res.status(400).json({ error: "Kies minstens één klant-persona." });
    return;
  }
  if (keys.length > MAX_PERSONAS_PER_RUN) {
    res.status(400).json({ error: `Kies maximaal ${MAX_PERSONAS_PER_RUN} persona's per vergelijking.` });
    return;
  }
  if (!goal || typeof goal !== "string" || !goal.trim()) {
    res.status(400).json({ error: "Vul een doel voor deze klant(en) in." });
    return;
  }
  const check = validateUrl(url || "");
  if (!check.ok) {
    res.status(400).json({ error: check.error });
    return;
  }
  const steps = Math.min(Math.max(parseInt(maxSteps, 10) || 5, 3), MAX_STEPS_LIMIT);

  const jobId = crypto.randomBytes(12).toString("hex");
  const job = {
    id: jobId,
    status: "running", // running | done | error
    createdAt: Date.now(),
    progress: { phase: "starting", personaIndex: 0, personaTotal: keys.length, personaLabel: null },
    result: null,
    error: null,
  };
  jobs.set(jobId, job);

  // Fire-and-forget: de HTTP-response komt meteen terug, het werk loopt door.
  (async () => {
    try {
      const result = await runComparison({
        url: check.url,
        personaKeys: keys,
        goal: goal.trim().slice(0, 300),
        maxSteps: steps,
        apiKey,
        onProgress: (p) => {
          job.progress = { ...job.progress, ...p };
        },
      });
      job.result = { url: check.url, goal: goal.trim(), ...result };
      job.status = "done";
    } catch (err) {
      console.error("Mystery shopper comparison failed:", err && err.message, err && err.stack);
      job.error = friendlyErrorFor(err);
      job.status = "error";
    }
  })();

  res.status(202).json({ jobId });
});

app.get("/api/test-status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "Onbekende of verlopen testsessie." });
    return;
  }
  res.json({
    status: job.status,
    progress: job.progress,
    result: job.status === "done" ? job.result : null,
    error: job.status === "error" ? job.error : null,
  });
});

app.listen(PORT, () => {
  console.log(`AI Mystery Shopper draait op poort ${PORT}`);
  console.log(`ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? "gevonden ✔" : "ONTBREEKT ✘"}`);
});
