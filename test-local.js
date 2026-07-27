// Standalone test script — requires ONLY lib/agent.js (no express needed),
// so it can run with just the globally available "playwright" package.
// Usage: NODE_PATH=$(npm root -g) node test-local.js

const fs = require("fs");
const path = require("path");

// tiny .env loader
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, "utf8")
    .split("\n")
    .forEach((line) => {
      const t = line.trim();
      if (!t || t.startsWith("#")) return;
      const i = t.indexOf("=");
      if (i === -1) return;
      const k = t.slice(0, i).trim();
      const v = t.slice(i + 1).trim();
      if (!process.env[k]) process.env[k] = v;
    });
}

const { PERSONAS, validateUrl, runMysteryShopper } = require("./lib/agent");

(async () => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Geen ANTHROPIC_API_KEY gevonden in .env");
    process.exit(1);
  }

  const targetUrl = process.argv[2] || "http://localhost:4000/index.html";
  const check = validateUrl(targetUrl, { allowLocalForTesting: true });
  if (!check.ok) {
    console.error("URL check failed:", check.error);
    process.exit(1);
  }

  const persona = PERSONAS.prijsbewuste_twijfelaar;
  console.log("Start test tegen:", check.url);
  console.log("Persona:", persona.label);

  const result = await runMysteryShopper({
    url: check.url,
    persona,
    goal: "zich aanmelden voor een gratis proefperiode",
    maxSteps: 5,
    apiKey,
    onStep: (s) => {
      console.log(`\n[stap ${s.stepNumber}] actie=${s.action} emotie=${s.emotion} frictie=${s.friction}`);
      console.log("  gedachte:", s.thought);
      console.log("  note:", s.note);
    },
  });

  console.log("\n=== EINDRAPPORT ===");
  console.log(JSON.stringify(result.finalReport, null, 2));
  console.log(`\nTotaal stappen uitgevoerd: ${result.steps.length}`);
})().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
