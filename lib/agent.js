// Core Mystery Shopper agent logic — deliberately has NO dependency on Express,
// so it can be required and tested completely standalone (only needs "playwright").

const { chromium } = require("playwright");

const ANTHROPIC_VERSION = "2023-06-01";
const STEP_MODEL = "claude-sonnet-5"; // vision + navigatie-beslissingen
const REPORT_MODEL = "claude-haiku-4-5"; // eindrapport (tekst-only, goedkoper)
const MAX_STEPS_LIMIT = 8;
const MAX_PERSONAS_PER_RUN = 4;

const PERSONAS = {
  prijsbewuste_twijfelaar: {
    label: "Prijsbewuste twijfelaar",
    description:
      "Een klant die serieus geïnteresseerd is maar prijsgevoelig is en snel afhaakt bij onduidelijke kosten, verplichte accountaanmaak, of een proces dat te lang duurt.",
  },
  haastige_zakelijke_koper: {
    label: "Haastige zakelijke koper",
    description:
      "Een drukke professional die snel wil kunnen kopen/aanmelden, weinig geduld heeft voor lange formulieren, en afhaakt bij trage of verwarrende stappen.",
  },
  onzekere_eerste_bezoeker: {
    label: "Onzekere eerste bezoeker",
    description:
      "Iemand die het bedrijf nog niet kent, twijfelt of dit betrouwbaar is, en op zoek is naar duidelijkheid, sociale bewijskracht en geruststelling voordat hij verdergaat.",
  },
  loyale_terugkerende_klant: {
    label: "Loyale terugkerende klant",
    description:
      "Een bestaande klant die iets specifieks probeert te doen (bijv. opnieuw bestellen, account beheren) en gefrustreerd raakt als dat onnodig omslachtig is.",
  },
};

function isBlockedHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local")) return true;
  if (/^127\./.test(h) || h === "0.0.0.0" || h === "::1") return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  return false;
}

function validateUrl(rawUrl, { allowLocalForTesting = false } = {}) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: "Ongeldige URL." };
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { ok: false, error: "Alleen http/https URLs zijn toegestaan." };
  }
  if (!allowLocalForTesting && isBlockedHost(parsed.hostname)) {
    return { ok: false, error: "Deze host is niet toegestaan." };
  }
  return { ok: true, url: parsed.toString() };
}

async function extractInteractiveElements(page, limit = 25) {
  return await page.evaluate((limit) => {
    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return (
        rect.width > 2 &&
        rect.height > 2 &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        style.opacity !== "0"
      );
    }

    const selector = 'a, button, input, select, textarea, [role="button"], [onclick]';
    const nodes = Array.from(document.querySelectorAll(selector)).filter(isVisible);

    const elements = [];
    for (const el of nodes) {
      if (elements.length >= limit) break;
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute("type") || "";
      const rawText =
        el.innerText ||
        el.getAttribute("value") ||
        el.getAttribute("aria-label") ||
        el.getAttribute("placeholder") ||
        el.getAttribute("title") ||
        "";
      const text = rawText.trim().replace(/\s+/g, " ").slice(0, 80);
      const index = elements.length;
      el.setAttribute("data-ms-index", String(index));
      elements.push({
        index,
        tag,
        type: type || undefined,
        text: text || undefined,
        name: el.getAttribute("name") || undefined,
      });
    }
    return elements;
  }, limit);
}

// Best-effort: klik automatisch een cookiebanner/consent-overlay weg zodat die geen
// stappen "verspilt" of de pagina blokkeert. Faalt stil als er niets gevonden wordt.
async function tryDismissCookieBanner(page) {
  try {
    const clicked = await page.evaluate(() => {
      const patterns = [
        "accepteren",
        "accepteer alle",
        "alles accepteren",
        "akkoord",
        "toestaan",
        "sta alle toe",
        "accept all",
        "accept cookies",
        "i agree",
        "allow all",
        "got it",
      ];
      const candidates = Array.from(document.querySelectorAll("button, [role='button'], a"));
      for (const el of candidates) {
        const text = (el.innerText || "").trim().toLowerCase();
        if (!text || text.length > 40) continue;
        if (patterns.some((p) => text.includes(p))) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            el.click();
            return true;
          }
        }
      }
      return false;
    });
    if (clicked) {
      await page.waitForTimeout(400);
    }
  } catch {
    // Nooit de hele test laten stranden op het wegklikken van een banner.
  }
}

function formatElementsForPrompt(elements) {
  if (!elements.length) return "(geen klikbare elementen gevonden op deze pagina)";
  return elements
    .map((el) => {
      const bits = [`#${el.index}`, `<${el.tag}${el.type ? " type=" + el.type : ""}>`];
      if (el.text) bits.push(`"${el.text}"`);
      if (el.name) bits.push(`name=${el.name}`);
      return bits.join(" ");
    })
    .join("\n");
}

const BROWSER_ACTION_TOOL = {
  name: "browser_action",
  description: "Kies de eerstvolgende actie die deze klant op de pagina zou nemen.",
  input_schema: {
    type: "object",
    properties: {
      thought: {
        type: "string",
        description: "Korte interne gedachte van de klant op dit moment, in het Nederlands (1 zin).",
      },
      emotion: {
        type: "string",
        enum: ["enthousiast", "neutraal", "twijfelend", "gefrustreerd"],
        description: "Hoe de klant zich op dit moment voelt.",
      },
      friction: {
        type: "boolean",
        description: "True als de klant hier merkbare hinder, verwarring of twijfel ondervindt.",
      },
      note: {
        type: "string",
        description: "Korte, concrete beschrijving voor het rapport van wat hier gebeurt en waarom (1-2 zinnen, Nederlands).",
      },
      action: {
        type: "string",
        enum: ["click", "fill", "select", "finish_converted", "finish_abandoned"],
        description:
          "click/fill/select voeren een actie uit op een element. finish_converted = de klant zou hier het doel bereiken (bijv. vlak voor een definitieve bevestigingsknop). finish_abandoned = de klant haakt hier definitief af.",
      },
      element_index: {
        type: "integer",
        description: "Verplicht bij click/fill/select: het #index-nummer van het element uit de lijst.",
      },
      value: {
        type: "string",
        description:
          "Verplicht bij fill/select: een plausibele, verzonnen waarde (nooit echte persoonsgegevens) om in te vullen.",
      },
    },
    required: ["thought", "emotion", "friction", "note", "action"],
  },
};

const FINAL_REPORT_TOOL = {
  name: "provide_mystery_shopper_report",
  description: "Geef het eindrapport van deze mystery-shopper sessie.",
  input_schema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "2-3 zinnen samenvatting van hoe de sessie verliep en de belangrijkste bevinding.",
      },
      outcome: {
        type: "string",
        enum: ["converted", "abandoned", "incomplete"],
        description: "Wat er uiteindelijk gebeurde met deze klant.",
      },
      conversion_likelihood: {
        type: "string",
        enum: ["Hoog", "Gemiddeld", "Laag"],
        description: "Realistische inschatting hoe waarschijnlijk conversie is voor dit type klant op deze pagina.",
      },
      biggest_dropoff_risk: {
        type: "string",
        description: "De belangrijkste plek/reden waar deze (of vergelijkbare) klanten zouden afhaken.",
      },
      recommendations: {
        type: "array",
        minItems: 2,
        maxItems: 4,
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Korte titel (max 6 woorden)." },
            description: { type: "string", description: "1-2 zinnen concrete aanbeveling." },
            priority: { type: "string", enum: ["Hoog", "Gemiddeld", "Laag"] },
          },
          required: ["title", "description", "priority"],
        },
      },
    },
    required: ["summary", "outcome", "conversion_likelihood", "biggest_dropoff_risk", "recommendations"],
  },
};

async function callClaude({ model, system, messages, tool, apiKey }) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system,
      messages,
      tools: [tool],
      tool_choice: { type: "tool", name: tool.name },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API-fout (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const toolUse = (data.content || []).find((b) => b.type === "tool_use");
  if (!toolUse || !toolUse.input) {
    throw new Error("Onverwacht antwoord van het model (geen tool_use gevonden).");
  }
  return toolUse.input;
}

function stepSystemPrompt(persona, goal) {
  return `Je simuleert het gedrag van een echte (fictieve) klant die een website bezoekt.

Persona: ${persona.label} — ${persona.description}
Doel van deze klant op dit bezoek: ${goal}

Regels:
- Reageer zoals deze specifieke klant zou reageren, niet als een neutrale tester.
- Wees kritisch en realistisch: haak af bij verwarring, onduidelijke kosten, te veel stappen, of gebrek aan vertrouwen — precies zoals een echte klant van dit type zou doen.
- Wees eerlijk en ongezouten in "thought" en "note", ook als dat ongemakkelijk is voor de eigenaar van de site. Vermijd vage, diplomatieke of overdreven beleefde taal ("het zou fijn zijn als...") als er daadwerkelijk frictie is — benoem het probleem direct en concreet.
- Zet "friction" alleen op false als er ECHT niets op te merken viel; twijfel, wachten, of onduidelijkheid tellen als frictie, ook als de klant uiteindelijk wel doorgaat.
- BELANGRIJKE VEILIGHEIDSREGEL: als je bij een knop komt die een ECHTE bestelling, betaling of accountaanmaak zou afronden (bijv. "Plaats bestelling", "Betalen", "Account aanmaken", "Bevestigen en afrekenen"), klik deze dan NIET aan. Kies in plaats daarvan action "finish_converted" — de klant zou hier converteren, maar we voeren de daadwerkelijke afronding niet uit.
- Vul formuliervelden alleen met plausibele, volledig verzonnen gegevens (nooit echte namen, e-mails, adressen of betaalgegevens).
- Als er een cookiebanner, pop-up of overlay in beeld is die de pagina blokkeert, klik dan eerst op de meest logische "accepteren/sluiten"-knop daarvan voordat je verder gaat.
- Je antwoordt uitsluitend door de tool "browser_action" aan te roepen.`;
}

async function highlightAndScreenshot(page, index, color) {
  const selector = `[data-ms-index="${index}"]`;
  const found = await page.evaluate(
    ({ sel, color }) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      el.setAttribute("data-ms-prev-style", el.getAttribute("style") || "");
      el.style.outline = `4px solid ${color}`;
      el.style.outlineOffset = "2px";
      el.style.boxShadow = `0 0 0 6px ${color}55`;
      el.scrollIntoView({ block: "center", inline: "center" });
      return true;
    },
    { sel: selector, color }
  );

  if (!found) return null;

  await page.waitForTimeout(150); // scrollIntoView / re-render laten bezinken
  const buffer = await page.screenshot({ type: "jpeg", quality: 60, fullPage: false });

  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) {
      const prev = el.getAttribute("data-ms-prev-style") || "";
      el.setAttribute("style", prev);
      el.removeAttribute("data-ms-prev-style");
    }
  }, selector);

  return buffer.toString("base64");
}

function stepUserContent(stepNumber, maxSteps, elements, screenshotBase64) {
  return [
    {
      type: "text",
      text: `Stap ${stepNumber} van maximaal ${maxSteps}.

Klikbare/invulbare elementen op de huidige pagina:
${formatElementsForPrompt(elements)}

Bekijk de bijgevoegde screenshot en kies de volgende actie via de tool.`,
    },
    {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: screenshotBase64,
      },
    },
  ];
}

async function runMysteryShopper({ url, persona, goal, maxSteps, apiKey, onStep }) {
  const browser = await chromium.launch({ headless: true });
  const steps = [];

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    // Native browser dialogs (alert/confirm/prompt) blokkeren Playwright volledig als
    // ze niet worden afgehandeld — dit voorkomt dat een test daarop vastloopt.
    page.on("dialog", (dialog) => dialog.dismiss().catch(() => {}));

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await tryDismissCookieBanner(page);

    for (let stepNumber = 1; stepNumber <= maxSteps; stepNumber++) {
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      await tryDismissCookieBanner(page);

      const elements = await extractInteractiveElements(page);
      const screenshotBuffer = await page.screenshot({ type: "jpeg", quality: 55, fullPage: false });
      const screenshotBase64 = screenshotBuffer.toString("base64");

      let decision;
      try {
        decision = await callClaude({
          model: STEP_MODEL,
          system: stepSystemPrompt(persona, goal),
          messages: [{ role: "user", content: stepUserContent(stepNumber, maxSteps, elements, screenshotBase64) }],
          tool: BROWSER_ACTION_TOOL,
          apiKey,
        });
      } catch (err) {
        steps.push({
          stepNumber,
          screenshot: screenshotBase64,
          thought: "Kon geen beslissing genereren.",
          emotion: "neutraal",
          friction: true,
          note: `Technische fout tijdens deze stap: ${err.message}`,
          action: "finish_abandoned",
        });
        break;
      }

      let displayScreenshot = screenshotBase64;
      const targetsElement =
        ["click", "fill", "select"].includes(decision.action) && Number.isInteger(decision.element_index);
      if (targetsElement) {
        try {
          const highlightColor = decision.friction ? "#EF4444" : "#6D28D9";
          const annotated = await highlightAndScreenshot(page, decision.element_index, highlightColor);
          if (annotated) displayScreenshot = annotated;
        } catch {
          // Als annoteren om wat voor reden dan ook mislukt, gebruiken we gewoon de
          // originele screenshot — dit mag de test nooit laten stoppen.
        }
      }

      const stepRecord = {
        stepNumber,
        screenshot: displayScreenshot,
        thought: decision.thought,
        emotion: decision.emotion,
        friction: !!decision.friction,
        note: decision.note,
        action: decision.action,
      };
      steps.push(stepRecord);
      if (onStep) onStep(stepRecord);

      if (decision.action === "finish_converted" || decision.action === "finish_abandoned") {
        break;
      }

      try {
        const locator = page.locator(`[data-ms-index="${decision.element_index}"]`).first();
        if (decision.action === "click") {
          await locator.click({ timeout: 5000 });
        } else if (decision.action === "fill") {
          await locator.fill(decision.value || "test", { timeout: 5000 });
        } else if (decision.action === "select") {
          await locator.selectOption(decision.value || "", { timeout: 5000 });
        }
      } catch (err) {
        stepRecord.note += ` (Let op: de actie kon technisch niet worden uitgevoerd: ${err.message.slice(0, 150)})`;
        stepRecord.friction = true;
      }
    }

    const transcriptText = steps
      .map((s) => `Stap ${s.stepNumber}: actie=${s.action}, emotie=${s.emotion}, frictie=${s.friction}. ${s.note}`)
      .join("\n");

    const frictionCount = steps.filter((s) => s.friction).length;

    const finalReport = await callClaude({
      model: REPORT_MODEL,
      system: `Je bent een ervaren CX/UX-consultant die op basis van een mystery-shopper transcript een scherp, eerlijk eindrapport schrijft in het Nederlands.
Wees kritisch en direct — dit rapport is voor een bedrijf dat écht wil weten wat er beter kan, niet voor een geruststellend praatje. Als er frictiepunten waren (en die staan expliciet in het transcript gemarkeerd), moet dat duidelijk doorklinken in de samenvatting en de conversiekans-inschatting, ook als de klant uiteindelijk toch doorging. Vermijd generieke, af-en-toe-positieve taal die de werkelijke problemen verzacht.
Je antwoordt uitsluitend via de tool.`,
      messages: [
        {
          role: "user",
          content: `Persona: ${persona.label} — ${persona.description}\nDoel: ${goal}\nAantal stappen met frictie: ${frictionCount} van de ${steps.length}\n\nTranscript van de sessie:\n${transcriptText}\n\nSchrijf het eindrapport via de tool.`,
        },
      ],
      tool: FINAL_REPORT_TOOL,
      apiKey,
    });

    return { steps, finalReport };
  } finally {
    await browser.close().catch(() => {});
  }
}

const COMPARISON_TOOL = {
  name: "provide_comparison_report",
  description:
    "Vergelijk de resultaten van meerdere klant-persona's die dezelfde pagina met hetzelfde doel hebben doorlopen.",
  input_schema: {
    type: "object",
    properties: {
      cross_persona_summary: {
        type: "string",
        description:
          "2-4 zinnen: het belangrijkste patroon dat je ziet over alle persona's heen (Nederlands, direct en concreet, geen vage taal).",
      },
      common_dropoff_point: {
        type: "string",
        description:
          "Het punt of probleem waar meerdere persona's op vastliepen of twijfelden, indien van toepassing. Anders: leg uit waarom de persona's juist verschillend reageerden.",
      },
      prioritized_recommendations: {
        type: "array",
        minItems: 2,
        maxItems: 5,
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Korte titel (max 6 woorden)." },
            description: { type: "string", description: "1-2 zinnen concrete aanbeveling." },
            priority: { type: "string", enum: ["Hoog", "Gemiddeld", "Laag"] },
            affected_personas: {
              type: "array",
              items: { type: "string" },
              description: "Namen van de persona's die hierdoor geraakt werden.",
            },
          },
          required: ["title", "description", "priority", "affected_personas"],
        },
      },
    },
    required: ["cross_persona_summary", "prioritized_recommendations"],
  },
};

async function runComparison({ url, personaKeys, goal, maxSteps, apiKey, onProgress }) {
  const keys = personaKeys.slice(0, MAX_PERSONAS_PER_RUN);
  const personaResults = [];

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const persona = PERSONAS[key];
    if (!persona) continue;

    if (onProgress) {
      onProgress({ phase: "running_persona", personaIndex: i, personaTotal: keys.length, personaLabel: persona.label });
    }

    try {
      const { steps, finalReport } = await runMysteryShopper({ url, persona, goal, maxSteps, apiKey });
      personaResults.push({ personaKey: key, personaLabel: persona.label, steps, finalReport });
    } catch (err) {
      personaResults.push({
        personaKey: key,
        personaLabel: persona.label,
        steps: [],
        finalReport: null,
        error: err.message,
      });
    }
  }

  if (onProgress) {
    onProgress({ phase: "synthesizing" });
  }

  const successful = personaResults.filter((r) => r.finalReport);
  let comparison = null;

  if (successful.length > 0) {
    const summaryText = successful
      .map(
        (r) =>
          `Persona: ${r.personaLabel}\nUitkomst: ${r.finalReport.outcome}, conversiekans: ${r.finalReport.conversion_likelihood}\nSamenvatting: ${r.finalReport.summary}\nGrootste afhaakrisico: ${r.finalReport.biggest_dropoff_risk}`
      )
      .join("\n\n");

    comparison = await callClaude({
      model: REPORT_MODEL,
      system:
        "Je bent een ervaren CX/UX-consultant. Je krijgt de losse rapporten van meerdere gesimuleerde klant-persona's die dezelfde pagina hebben getest, en je destilleert daaruit het overkoepelende, prioriteitsgestuurde beeld. Wees kritisch en concreet, geen vage taal. Je antwoordt uitsluitend via de tool.",
      messages: [
        {
          role: "user",
          content: `Doel van het bezoek voor alle persona's: ${goal}\n\nResultaten per persona:\n\n${summaryText}\n\nSchrijf de vergelijkende analyse via de tool.`,
        },
      ],
      tool: COMPARISON_TOOL,
      apiKey,
    });
  }

  return { personaResults, comparison };
}

module.exports = {
  PERSONAS,
  MAX_STEPS_LIMIT,
  MAX_PERSONAS_PER_RUN,
  validateUrl,
  runMysteryShopper,
  runComparison,
};
