// Core Mystery Shopper agent logic — deliberately has NO dependency on Express,
// so it can be required and tested completely standalone (only needs "playwright").

const { chromium } = require("playwright");

const ANTHROPIC_VERSION = "2023-06-01";

// Het "brein" van de klant-simulatie. Dit is de zwaarste en belangrijkste aanroep:
// per stap kijkt dit model naar een screenshot en beslist wat de klant zou doen.
// Opus 5 is hier merkbaar sterker in dan lichtere modellen (beter in het lezen van
// visuele context en het volhouden van consistent persona-gedrag over meerdere stappen).
// Via env-variabelen kun je per omgeving wisselen zonder de code aan te passen.
const STEP_MODEL = process.env.MYSTERY_SHOPPER_STEP_MODEL || "claude-opus-5";

// Rapportage is tekst-only (geen screenshots) en dus veel goedkoper per aanroep.
const REPORT_MODEL = process.env.MYSTERY_SHOPPER_REPORT_MODEL || "claude-sonnet-5";

// Welke breinmodellen een gebruiker per test mag kiezen (frontend-selector). De
// server valt terug op STEP_MODEL (hierboven, evt. via env-var ingesteld) als er
// niets of iets ongeldigs wordt meegestuurd — nooit een ongevalideerde string
// van de client rechtstreeks aan de Anthropic API doorgeven.
const STEP_MODELS = {
  "claude-opus-5": {
    label: "Opus 5",
    tagline: "Scherpste observaties",
    description:
      "Leest screenshots het nauwkeurigst en houdt een persona het meest consistent vol over meerdere stappen. Aanbevolen voor een rapport dat je aan een klant laat zien.",
    costHint: "~€0,19 per persona",
  },
  "claude-sonnet-5": {
    label: "Sonnet 5",
    tagline: "Sneller & goedkoper",
    description:
      "Ongeveer een derde goedkoper dan Opus per test, met iets minder scherpe observaties. Prima om snel en vaker te testen.",
    costHint: "~€0,13 per persona",
  },
};

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

// Doorzoekt niet alleen de hoofdpagina maar ook alle ingesloten iframes (bijv. een
// reserveringswidget van een externe partij die embedded staat op de pagina). Playwright
// kan via CDP scripts injecteren in de meeste iframes, ook cross-origin — als een frame
// dat blokkeert (zeldzaam) slaan we 'm gewoon over i.p.v. de hele stap te laten mislukken.
async function extractInteractiveElements(page, limit = 25) {
  const elements = [];
  let nextIndex = 0;
  const frames = page.frames();

  for (let frameIdx = 0; frameIdx < frames.length; frameIdx++) {
    if (elements.length >= limit) break;
    const frame = frames[frameIdx];
    if (frame.isDetached()) continue;

    let frameElements;
    try {
      frameElements = await frame.evaluate(
        ({ limit, startIndex }) => {
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

          const out = [];
          for (const el of nodes) {
            if (out.length >= limit) break;
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
            const index = startIndex + out.length;
            el.setAttribute("data-ms-index", String(index));
            out.push({
              index,
              tag,
              type: type || undefined,
              text: text || undefined,
              name: el.getAttribute("name") || undefined,
            });
          }
          return out;
        },
        { limit: limit - elements.length, startIndex: nextIndex }
      );
    } catch {
      // Cross-origin iframe dat scripting blokkeert, of een frame dat net is verdwenen —
      // overslaan, dit mag de rest van de pagina nooit blokkeren.
      continue;
    }

    for (const el of frameElements) {
      elements.push({ ...el, frameIndex: frameIdx, inIframe: frameIdx !== 0 });
      nextIndex = el.index + 1;
    }
  }

  return elements;
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
      if (el.inIframe) bits.push("[ingesloten widget op de pagina, bijv. een reserverings-/boekingsapp]");
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
      friction_severity: {
        type: "string",
        enum: ["geen", "licht", "matig", "ernstig"],
        description:
          "Hoe erg de hinder hier is. 'geen' = werkelijk niets op aan te merken. 'licht' = kleine twijfel of aarzeling. 'matig' = duidelijke verwarring die de klant vertraagt. 'ernstig' = dit is een reden om af te haken.",
      },
      note: {
        type: "string",
        description: "Korte, concrete beschrijving voor het rapport van wat hier gebeurt en waarom (1-2 zinnen, Nederlands).",
      },
      expectation_gap: {
        type: "string",
        description:
          "Alleen invullen als er een kloof is tussen wat de klant hier VERWACHTTE en wat hij daadwerkelijk AANTROF. Formuleer als: 'Verwachtte X, kreeg Y.' Laat leeg als er geen kloof is.",
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
    required: ["thought", "emotion", "friction_severity", "note", "action"],
  },
};

const FINAL_REPORT_TOOL = {
  name: "provide_mystery_shopper_report",
  description: "Geef het eindrapport van deze mystery-shopper sessie.",
  input_schema: {
    type: "object",
    properties: {
      headline: {
        type: "string",
        description:
          "Eén scherpe zin (max 90 tekens) die het oordeel samenvat, zoals een consultant het in een vergadering zou zeggen. Geen vage taal.",
      },
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
            effort: {
              type: "string",
              enum: ["Klein", "Middel", "Groot"],
              description: "Hoeveel werk het kost om dit door te voeren (Klein = tekstwijziging, Groot = herbouw van een flow).",
            },
          },
          required: ["title", "description", "priority", "effort"],
        },
      },
    },
    required: ["headline", "summary", "outcome", "conversion_likelihood", "biggest_dropoff_risk", "recommendations"],
  },
};

async function callClaude({ model, system, messages, tool, apiKey, maxTokens = 2048 }) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
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
  // Naast de ingevulde waarden geven we ook het ruwe tool_use-blok terug, zodat de
  // aanroeper het in de gespreksgeschiedenis kan opnemen (nodig voor stap-geheugen).
  return { input: toolUse.input, toolUse };
}

function stepSystemPrompt(persona, goal) {
  return `Je simuleert het gedrag van een echte (fictieve) klant die een website bezoekt.

Persona: ${persona.label} — ${persona.description}
Doel van deze klant op dit bezoek: ${goal}

Regels:
- Reageer zoals deze specifieke klant zou reageren, niet als een neutrale tester.
- Je onthoudt je eigen reis: je ziet je eerdere stappen en beslissingen in dit gesprek staan. Bouw daarop voort. Als je iets al geprobeerd hebt en het werkte niet, laat dat meewegen — herhaal niet blind dezelfde actie, en laat je geduld realistisch afnemen naarmate de reis stroever verloopt.
- Wees kritisch en realistisch: haak af bij verwarring, onduidelijke kosten, te veel stappen, of gebrek aan vertrouwen — precies zoals een echte klant van dit type zou doen.
- Wees eerlijk en ongezouten in "thought" en "note", ook als dat ongemakkelijk is voor de eigenaar van de site. Vermijd vage, diplomatieke of overdreven beleefde taal ("het zou fijn zijn als...") als er daadwerkelijk frictie is — benoem het probleem direct en concreet.
- Gebruik "friction_severity" eerlijk en met onderscheid: "geen" alleen als er werkelijk niets op te merken viel, en "ernstig" alleen als dit op zichzelf een reden is om af te haken. Twijfel, wachten of onduidelijkheid zijn minstens "licht", ook als de klant uiteindelijk doorgaat.
- Vul "expectation_gap" alleen in als er echt een kloof zit tussen wat je verwachtte en wat je aantrof — dat is voor de opdrachtgever vaak het waardevolste inzicht.
- BELANGRIJKE VEILIGHEIDSREGEL: als je bij een knop komt die een ECHTE bestelling, betaling of accountaanmaak zou afronden (bijv. "Plaats bestelling", "Betalen", "Account aanmaken", "Bevestigen en afrekenen"), klik deze dan NIET aan. Kies in plaats daarvan action "finish_converted" — de klant zou hier converteren, maar we voeren de daadwerkelijke afronding niet uit.
- Vul formuliervelden alleen met plausibele, volledig verzonnen gegevens (nooit echte namen, e-mails, adressen of betaalgegevens).
- Als er een cookiebanner, pop-up of overlay in beeld is die de pagina blokkeert, klik dan eerst op de meest logische "accepteren/sluiten"-knop daarvan voordat je verder gaat.
- Sommige elementen zijn gemarkeerd als "[ingesloten widget op de pagina]" — dit zijn embedded widgets van externe partijen (bijv. een reserverings- of boekingsapp die in de pagina zit). Behandel die gewoon als onderdeel van de pagina en gebruik ze als dat logisch is voor het doel van deze klant.
- Je antwoordt uitsluitend door de tool "browser_action" aan te roepen.`;
}

// frame = het Playwright-frame (hoofdpagina of iframe) waarin dit element daadwerkelijk
// staat — nodig omdat ingesloten widgets (reserveringsapps e.d.) vaak in een iframe zitten
// en page.evaluate() alleen in de hoofdpagina zou zoeken.
async function highlightAndScreenshot(page, frame, index, color) {
  const selector = `[data-ms-index="${index}"]`;
  const found = await frame
    .evaluate(
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
    )
    .catch(() => false);

  if (!found) return null;

  await page.waitForTimeout(150); // scrollIntoView / re-render laten bezinken
  const buffer = await page.screenshot({ type: "jpeg", quality: 60, fullPage: false });

  await frame
    .evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) {
        const prev = el.getAttribute("data-ms-prev-style") || "";
        el.setAttribute("style", prev);
        el.removeAttribute("data-ms-prev-style");
      }
    }, selector)
    .catch(() => {});

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

// De agent onthoudt zijn hele reis, maar de geschiedenis wordt ingedikt voordat we
// hem opnieuw meesturen. Wat waardevol is, blijft: wat de klant dacht, koos en of die
// actie lukte. Wat duur en overbodig is, gaat eruit: oude screenshots en de volledige
// elementenlijst van pagina's waar de klant allang weg is. Zonder dit groeit elke
// stap de kosten op, terwijl de agent aan een korte samenvatting genoeg heeft.
function compactHistory(conversation) {
  for (const message of conversation) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;

    message.content = message.content
      .map((block) => {
        if (block.type === "image") return null; // oude screenshots weglaten
        if (block.type === "text") {
          // Van het stap-bericht houden we alleen de eerste regel ("Stap N van M")
          // over; de elementenlijst eronder is niet meer relevant.
          const firstLine = (block.text || "").split("\n")[0];
          if (/^Stap \d+ van maximaal \d+\.?$/.test(firstLine.trim())) {
            return { type: "text", text: `${firstLine.trim()} (pagina-inhoud van toen hier ingekort)` };
          }
        }
        return block;
      })
      .filter(Boolean);

    // Een user-bericht mag nooit leeg raken.
    if (message.content.length === 0) {
      message.content = [{ type: "text", text: "(eerdere stap)" }];
    }
  }
}

async function runMysteryShopper({ url, persona, goal, maxSteps, apiKey, onStep, stepModel }) {
  // Alleen een expliciet toegestaan model overnemen; anders de serverstandaard.
  const resolvedStepModel = stepModel && STEP_MODELS[stepModel] ? stepModel : STEP_MODEL;
  const browser = await chromium.launch({ headless: true });
  const steps = [];

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    let page = await context.newPage();
    const knownPages = new Set([page]);

    // Native browser dialogs (alert/confirm/prompt) blokkeren Playwright volledig als
    // ze niet worden afgehandeld — dit voorkomt dat een test daarop vastloopt.
    function wireDialogHandling(p) {
      p.on("dialog", (dialog) => dialog.dismiss().catch(() => {}));
    }
    wireDialogHandling(page);

    // Sommige sites openen een widget (bijv. een reserverings-/boekingsapp) in een nieuw
    // tabblad of venster i.p.v. binnen de pagina zelf. We volgen de klant daar automatisch
    // naartoe, precies zoals een echte bezoeker dat zou doen.
    context.on("page", (newPage) => {
      knownPages.add(newPage);
      wireDialogHandling(newPage);
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await tryDismissCookieBanner(page);

    // Doorlopende gespreksgeschiedenis: hierdoor "onthoudt" de klant zijn eigen reis en
    // bouwt hij voort op wat hij al gezien en geprobeerd heeft, in plaats van elke stap
    // met een schone lei te beginnen. Dit is wat het gedrag samenhangend en menselijk maakt.
    const conversation = [];
    let pendingToolResult = null;

    for (let stepNumber = 1; stepNumber <= maxSteps; stepNumber++) {
      // Is er ondertussen een nieuw tabblad/venster geopend? Dan is dat waar de klant nu is.
      const openPages = Array.from(knownPages).filter((p) => !p.isClosed());
      const newest = openPages[openPages.length - 1];
      if (newest && newest !== page) {
        page = newest;
        await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
      }

      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      await tryDismissCookieBanner(page);

      const elements = await extractInteractiveElements(page);
      const screenshotBuffer = await page.screenshot({ type: "jpeg", quality: 55, fullPage: false });
      const screenshotBase64 = screenshotBuffer.toString("base64");

      // Dik de geschiedenis in vóórdat we de nieuwe stap toevoegen: de redenering
      // blijft, de dure ballast (oude screenshots + elementenlijsten) verdwijnt.
      compactHistory(conversation);

      const turnContent = [];
      if (pendingToolResult) turnContent.push(pendingToolResult);
      turnContent.push(...stepUserContent(stepNumber, maxSteps, elements, screenshotBase64));
      conversation.push({ role: "user", content: turnContent });

      let decision;
      let decisionToolUse;
      try {
        const result = await callClaude({
          model: resolvedStepModel,
          system: stepSystemPrompt(persona, goal),
          messages: conversation,
          tool: BROWSER_ACTION_TOOL,
          apiKey,
        });
        decision = result.input;
        decisionToolUse = result.toolUse;
      } catch (err) {
        steps.push({
          stepNumber,
          screenshot: screenshotBase64,
          thought: "Kon geen beslissing genereren.",
          emotion: "neutraal",
          friction: true,
          frictionSeverity: "ernstig",
          note: `Technische fout tijdens deze stap: ${err.message}`,
          action: "finish_abandoned",
        });
        break;
      }

      conversation.push({ role: "assistant", content: [decisionToolUse] });

      let displayScreenshot = screenshotBase64;
      const targetsElement =
        ["click", "fill", "select"].includes(decision.action) && Number.isInteger(decision.element_index);
      const targetMeta = targetsElement ? elements.find((el) => el.index === decision.element_index) : null;
      const targetFrame =
        targetMeta && page.frames()[targetMeta.frameIndex] ? page.frames()[targetMeta.frameIndex] : page.mainFrame();

      const severity = decision.friction_severity || "geen";
      const hasFriction = severity !== "geen";

      if (targetsElement) {
        try {
          const highlightColor = hasFriction ? "#E0533F" : "#6D4FE0";
          const annotated = await highlightAndScreenshot(page, targetFrame, decision.element_index, highlightColor);
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
        friction: hasFriction,
        frictionSeverity: severity,
        expectationGap: (decision.expectation_gap || "").trim() || null,
        note: decision.note,
        action: decision.action,
      };
      steps.push(stepRecord);
      if (onStep) onStep(stepRecord);

      if (decision.action === "finish_converted" || decision.action === "finish_abandoned") {
        break;
      }

      let actionOutcome;
      try {
        const locator = targetFrame.locator(`[data-ms-index="${decision.element_index}"]`).first();
        if (decision.action === "click") {
          await locator.click({ timeout: 5000 });
        } else if (decision.action === "fill") {
          await locator.fill(decision.value || "test", { timeout: 5000 });
        } else if (decision.action === "select") {
          await locator.selectOption(decision.value || "", { timeout: 5000 });
        }
        // Geef een eventueel nieuw geopend tabblad/venster (bijv. een reserveringswidget
        // die apart opent) een moment om te laden voordat de volgende stap begint.
        if (decision.action === "click") {
          await page.waitForTimeout(400);
        }
        actionOutcome = `Je actie (${decision.action}) is uitgevoerd. Hieronder zie je het resultaat.`;
      } catch (err) {
        stepRecord.note += ` (Let op: de actie kon technisch niet worden uitgevoerd: ${err.message.slice(0, 150)})`;
        stepRecord.friction = true;
        if (stepRecord.frictionSeverity === "geen") stepRecord.frictionSeverity = "matig";
        // De agent hoort te weten dat zijn actie mislukte — een echte klant merkt dat ook
        // (er gebeurt niets als je klikt) en zou daarop reageren.
        actionOutcome = `LET OP: je actie (${decision.action}) kon NIET worden uitgevoerd — er gebeurde niets toen je dit probeerde. Een echte klant zou dit merken. Reageer hierop zoals deze persona zou doen.`;
      }

      pendingToolResult = {
        type: "tool_result",
        tool_use_id: decisionToolUse.id,
        content: actionOutcome,
      };
    }

    const transcriptText = steps
      .map((s) => {
        const bits = [
          `Stap ${s.stepNumber}: actie=${s.action}, emotie=${s.emotion}, frictie=${s.frictionSeverity || (s.friction ? "matig" : "geen")}`,
          s.note,
        ];
        if (s.expectationGap) bits.push(`Verwachtingskloof: ${s.expectationGap}`);
        return bits.join(". ");
      })
      .join("\n");

    const frictionCount = steps.filter((s) => s.friction).length;
    const seriousFrictionCount = steps.filter((s) => s.frictionSeverity === "ernstig").length;

    const { input: finalReport } = await callClaude({
      model: REPORT_MODEL,
      system: `Je bent een ervaren CX/UX-consultant die op basis van een mystery-shopper transcript een scherp, eerlijk eindrapport schrijft in het Nederlands.
Wees kritisch en direct — dit rapport is voor een bedrijf dat écht wil weten wat er beter kan, niet voor een geruststellend praatje. Als er frictiepunten waren (en die staan expliciet in het transcript gemarkeerd, met ernst-niveau), moet dat duidelijk doorklinken in de samenvatting en de conversiekans-inschatting, ook als de klant uiteindelijk toch doorging. Vermijd generieke, af-en-toe-positieve taal die de werkelijke problemen verzacht.
Weeg de ernst mee: één "ernstig" frictiepunt weegt zwaarder dan drie "lichte". Als er verwachtingskloven in het transcript staan, zijn dat vaak de meest waardevolle inzichten — laat die terugkomen in je aanbevelingen.
Je antwoordt uitsluitend via de tool.`,
      messages: [
        {
          role: "user",
          content: `Persona: ${persona.label} — ${persona.description}\nDoel: ${goal}\nStappen met frictie: ${frictionCount} van de ${steps.length} (waarvan ${seriousFrictionCount} als ernstig beoordeeld)\n\nTranscript van de sessie:\n${transcriptText}\n\nSchrijf het eindrapport via de tool.`,
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
      headline: {
        type: "string",
        description:
          "Eén scherpe zin (max 90 tekens) die de kern van het vergelijkende oordeel samenvat. Dit is wat een directeur als eerste leest.",
      },
      cross_persona_summary: {
        type: "string",
        description:
          "2-4 zinnen: het belangrijkste patroon dat je ziet over alle persona's heen (Nederlands, direct en concreet, geen vage taal).",
      },
      common_dropoff_point: {
        type: "string",
        description:
          "VERPLICHT invullen. Het punt of probleem waar meerdere persona's op vastliepen of twijfelden. Als er géén gedeeld punt was, leg dan expliciet uit waarom de persona's juist verschillend reageerden — laat dit veld nooit leeg.",
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
            effort: {
              type: "string",
              enum: ["Klein", "Middel", "Groot"],
              description: "Hoeveel werk het kost om dit door te voeren (Klein = tekstwijziging, Groot = herbouw van een flow).",
            },
            affected_personas: {
              type: "array",
              items: { type: "string" },
              description: "Namen van de persona's die hierdoor geraakt werden.",
            },
          },
          required: ["title", "description", "priority", "effort", "affected_personas"],
        },
      },
    },
    required: ["headline", "cross_persona_summary", "common_dropoff_point", "prioritized_recommendations"],
  },
};

async function runComparison({ url, personaKeys, goal, maxSteps, apiKey, onProgress, stepModel }) {
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
      const { steps, finalReport } = await runMysteryShopper({ url, persona, goal, maxSteps, apiKey, stepModel });
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
  let comparisonError = null;

  // BELANGRIJK: dit synthese-verzoek mag NOOIT de hele vergelijking laten mislukken.
  // De individuele persona-rapporten zijn op dit punt al binnen en waardevol — als
  // alleen deze laatste, samenvattende Claude-aanroep faalt (bijv. door een rate
  // limit of een tijdelijke API-hik), tonen we gewoon de losse rapporten zonder
  // vergelijkende samenvatting in plaats van de gebruiker met "er ging iets mis" te
  // laten zitten terwijl er wel degelijk bruikbare resultaten zijn.
  if (successful.length > 0) {
    try {
      const summaryText = successful
        .map((r) => {
          const gaps = (r.steps || [])
            .filter((s) => s.expectationGap)
            .map((s) => `  - stap ${s.stepNumber}: ${s.expectationGap}`)
            .join("\n");
          return [
            `Persona: ${r.personaLabel}`,
            `Uitkomst: ${r.finalReport.outcome}, conversiekans: ${r.finalReport.conversion_likelihood}`,
            `Samenvatting: ${r.finalReport.summary}`,
            `Grootste afhaakrisico: ${r.finalReport.biggest_dropoff_risk}`,
            gaps ? `Verwachtingskloven:\n${gaps}` : null,
          ]
            .filter(Boolean)
            .join("\n");
        })
        .join("\n\n");

      const { input: comparisonResult } = await callClaude({
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
      comparison = comparisonResult;
    } catch (err) {
      console.error("Comparison synthesis failed (persona results are still returned):", err.message, err.stack);
      comparisonError = err.message;
      comparison = null;
    }
  }

  return { personaResults, comparison, comparisonError };
}

module.exports = {
  PERSONAS,
  MAX_STEPS_LIMIT,
  MAX_PERSONAS_PER_RUN,
  STEP_MODELS,
  DEFAULT_STEP_MODEL: STEP_MODEL,
  validateUrl,
  runMysteryShopper,
  runComparison,
};
