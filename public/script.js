(function () {
  "use strict";

  const screens = {
    input: document.getElementById("screen-input"),
    loading: document.getElementById("screen-loading"),
    error: document.getElementById("screen-error"),
    results: document.getElementById("screen-results"),
  };

  const form = document.getElementById("form");
  const urlField = document.getElementById("url");
  const goalField = document.getElementById("goal");
  const stepsField = document.getElementById("maxSteps");
  const depthOptionsEl = document.getElementById("depth-options");
  const consentField = document.getElementById("consent");
  const personaGrid = document.getElementById("persona-grid");
  const maxPersonasEl = document.getElementById("max-personas");
  const errorMessageEl = document.getElementById("error-message");
  const btnRetry = document.getElementById("btn-retry");
  const btnRestart = document.getElementById("btn-restart");
  const btnSubmit = document.getElementById("btn-submit");

  const loadingTitleEl = document.getElementById("loading-title");
  const loadingDetailEl = document.getElementById("loading-detail");
  const progressFillEl = document.getElementById("progress-fill");
  const progressPersonasEl = document.getElementById("progress-personas");

  const reportMetaEl = document.getElementById("report-meta");
  const comparisonHeroEl = document.getElementById("comparison-hero");
  const journeyTimelineEl = document.getElementById("journey-timeline");
  const comparisonRecommendationsEl = document.getElementById("comparison-recommendations");
  const personaTabsEl = document.getElementById("persona-tabs");
  const personaPanelsEl = document.getElementById("persona-panels");

  const lightbox = document.getElementById("lightbox");
  const lightboxImg = document.getElementById("lightbox-img");

  let personaMeta = {}; // key -> {label, description}
  let selectedKeys = new Set();
  let maxPersonas = 4;
  let lastPayload = null;
  let pollTimer = null;

  function showScreen(name) {
    Object.entries(screens).forEach(([key, el]) => {
      el.hidden = key !== name;
    });
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML;
  }

  depthOptionsEl.querySelectorAll(".depth-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      depthOptionsEl.querySelectorAll(".depth-btn").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      stepsField.value = btn.dataset.value;
    });
  });

  // ---------- Persona multi-select ----------
  async function loadPersonas() {
    try {
      const res = await fetch("/api/personas");
      const data = await res.json();
      personaMeta = data.personas || {};
      maxPersonas = data.maxPersonas || 4;
      maxPersonasEl.textContent = maxPersonas;

      const entries = Object.entries(personaMeta);
      personaGrid.innerHTML = entries
        .map(
          ([key, p], i) => `
          <label class="persona-card${i === 0 ? " selected" : ""}" data-key="${key}">
            <input type="checkbox" name="personaKey" value="${key}" ${i === 0 ? "checked" : ""} />
            <span class="persona-check" aria-hidden="true"></span>
            <div class="p-title">${escapeHtml(p.label)}</div>
            <div class="p-desc">${escapeHtml(p.description)}</div>
          </label>`
        )
        .join("");

      selectedKeys = new Set(entries.length ? [entries[0][0]] : []);
      applyPersonaLimitUI();

      personaGrid.querySelectorAll(".persona-card").forEach((card) => {
        card.addEventListener("click", (e) => {
          e.preventDefault();
          const key = card.dataset.key;
          if (selectedKeys.has(key)) {
            selectedKeys.delete(key);
          } else {
            if (selectedKeys.size >= maxPersonas) return;
            selectedKeys.add(key);
          }
          syncPersonaCardUI();
        });
      });
    } catch (err) {
      personaGrid.innerHTML = `<p class="lead">Kon persona's niet laden. Ververs de pagina.</p>`;
    }
  }

  function syncPersonaCardUI() {
    personaGrid.querySelectorAll(".persona-card").forEach((card) => {
      const key = card.dataset.key;
      const isSelected = selectedKeys.has(key);
      card.classList.toggle("selected", isSelected);
      const input = card.querySelector("input");
      if (input) input.checked = isSelected;
    });
    applyPersonaLimitUI();
  }

  function applyPersonaLimitUI() {
    const atLimit = selectedKeys.size >= maxPersonas;
    personaGrid.querySelectorAll(".persona-card").forEach((card) => {
      const key = card.dataset.key;
      const isSelected = selectedKeys.has(key);
      card.classList.toggle("disabled", atLimit && !isSelected);
    });
    btnSubmit.disabled = selectedKeys.size === 0;
  }

  loadPersonas();

  // ---------- Form submit ----------
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (selectedKeys.size === 0) return;

    lastPayload = {
      url: urlField.value.trim(),
      personaKeys: Array.from(selectedKeys),
      goal: goalField.value.trim(),
      maxSteps: Number(stepsField.value),
      consent: consentField.checked,
    };
    await startTest();
  });

  async function startTest() {
    showScreen("loading");
    setupProgressUI(lastPayload.personaKeys);
    loadingTitleEl.textContent =
      lastPayload.personaKeys.length > 1
        ? "De AI-klanten doorlopen nu jullie website..."
        : "De AI-klant doorloopt nu jullie website...";
    loadingDetailEl.textContent = "Bezig met opstarten...";
    progressFillEl.style.width = "4%";

    try {
      const res = await fetch("/api/start-test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(lastPayload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Er ging iets mis tijdens de test.");
      }
      pollStatus(data.jobId);
    } catch (err) {
      showError(err.message || "Er ging iets mis, probeer het opnieuw.");
    }
  }

  function setupProgressUI(personaKeys) {
    progressPersonasEl.innerHTML = personaKeys
      .map((key) => `<span class="progress-chip" data-key="${key}">${escapeHtml((personaMeta[key] || {}).label || key)}</span>`)
      .join("");
  }

  function updateProgressUI(progress, personaKeys) {
    const total = personaKeys.length;
    const chips = progressPersonasEl.querySelectorAll(".progress-chip");

    if (progress.phase === "synthesizing") {
      loadingDetailEl.textContent = "Alle persona's zijn getest — bezig met de vergelijkende analyse...";
      chips.forEach((chip) => {
        chip.classList.remove("active");
        chip.classList.add("done");
      });
      progressFillEl.style.width = "94%";
      return;
    }

    const idx = typeof progress.personaIndex === "number" ? progress.personaIndex : 0;
    const label = progress.personaLabel || "";
    if (label) {
      loadingDetailEl.textContent = `Persona ${idx + 1} van ${total}: ${label}...`;
    }

    chips.forEach((chip, i) => {
      chip.classList.remove("active", "done");
      if (i < idx) chip.classList.add("done");
      else if (i === idx) chip.classList.add("active");
    });

    const pct = total > 0 ? Math.min(92, 8 + (idx / total) * 84) : 10;
    progressFillEl.style.width = `${pct}%`;
  }

  function pollStatus(jobId) {
    clearTimeout(pollTimer);

    async function tick() {
      try {
        const res = await fetch(`/api/test-status/${jobId}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || "Kon testvoortgang niet ophalen.");
        }

        if (data.progress) updateProgressUI(data.progress, lastPayload.personaKeys);

        if (data.status === "done") {
          progressFillEl.style.width = "100%";
          renderResults(data.result);
          showScreen("results");
          return;
        }
        if (data.status === "error") {
          showError(data.error || "Er ging iets mis tijdens de test.");
          return;
        }
        pollTimer = setTimeout(tick, 1800);
      } catch (err) {
        showError(err.message || "Er ging iets mis, probeer het opnieuw.");
      }
    }

    tick();
  }

  function showError(message) {
    clearTimeout(pollTimer);
    errorMessageEl.textContent = message;
    showScreen("error");
  }

  btnRetry.addEventListener("click", () => {
    if (!lastPayload) {
      showScreen("input");
      return;
    }
    startTest();
  });

  btnRestart.addEventListener("click", () => {
    clearTimeout(pollTimer);
    showScreen("input");
  });

  // ---------- Badge helpers ----------
  function conversionBadgeClass(level) {
    const n = (level || "").toLowerCase();
    if (n.includes("hoog")) return "badge-conv-hoog";
    if (n.includes("laag")) return "badge-conv-laag";
    return "badge-conv-gemiddeld";
  }

  function priorityBadgeClass(level) {
    const n = (level || "").toLowerCase();
    if (n.includes("hoog")) return "badge-priority-hoog";
    if (n.includes("laag")) return "badge-priority-laag";
    return "badge-priority-gemiddeld";
  }

  function effortBadgeClass(effort) {
    const n = (effort || "").toLowerCase();
    if (n.includes("klein")) return "badge-effort-klein";
    if (n.includes("groot")) return "badge-effort-groot";
    return "badge-effort-middel";
  }

  // Frictie is niet langer aan/uit maar een schaal — dat maakt het rapport eerlijker
  // (één ernstig probleem weegt zwaarder dan drie kleine ergernissen).
  const SEVERITY_META = {
    licht: { label: "Lichte frictie", cls: "badge-sev-licht", color: "#c9a227", radius: 6 },
    matig: { label: "Matige frictie", cls: "badge-sev-matig", color: "#d97b28", radius: 7.5 },
    ernstig: { label: "Ernstige frictie", cls: "badge-sev-ernstig", color: "#d63f28", radius: 9 },
  };

  function severityOf(step) {
    const s = step.frictionSeverity || (step.friction ? "matig" : "geen");
    return SEVERITY_META[s] ? s : "geen";
  }

  function emotionBadgeClass(emotion) {
    const n = (emotion || "").toLowerCase();
    if (n.includes("enthousiast")) return "badge-emotion-enthousiast";
    if (n.includes("gefrustreerd")) return "badge-emotion-gefrustreerd";
    if (n.includes("twijfel")) return "badge-emotion-twijfelend";
    return "badge-emotion-neutraal";
  }

  function outcomeLabel(outcome) {
    if (outcome === "converted") return "Klant zou converteren";
    if (outcome === "abandoned") return "Klant haakte af";
    return "Sessie onvolledig";
  }

  const EMOTION_VALUE = { gefrustreerd: 1, twijfelend: 2, neutraal: 3, enthousiast: 4 };
  const EMOTION_COLOR = {
    gefrustreerd: "#f87171",
    twijfelend: "#facc15",
    neutraal: "#22d3ee",
    enthousiast: "#4ade80",
  };

  function renderEmotionChart(container, steps) {
    if (!steps.length) {
      container.innerHTML = '<p class="emotion-chart-empty">Geen stappen om te tonen.</p>';
      return;
    }

    const width = 760;
    const height = 180;
    const padX = 36;
    const padY = 26;
    const n = steps.length;

    const xFor = (i) => (n === 1 ? width / 2 : padX + (i / (n - 1)) * (width - 2 * padX));
    const yFor = (emotion) => {
      const v = EMOTION_VALUE[emotion] || 3;
      return padY + (1 - (v - 1) / 3) * (height - 2 * padY);
    };

    const points = steps.map((s, i) => ({
      x: xFor(i),
      y: yFor(s.emotion),
      color: EMOTION_COLOR[s.emotion] || EMOTION_COLOR.neutraal,
      friction: s.friction,
      stepNumber: s.stepNumber,
      emotion: s.emotion,
    }));

    const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");

    const gridLines = [1, 2, 3, 4]
      .map((v) => {
        const y = padY + (1 - (v - 1) / 3) * (height - 2 * padY);
        return `<line x1="${padX}" y1="${y}" x2="${width - padX}" y2="${y}" stroke="rgba(255,255,255,0.08)" stroke-width="1" />`;
      })
      .join("");

    const dots = points
      .map(
        (p) => `
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${p.friction ? 7 : 5}"
          fill="${p.color}" stroke="${p.friction ? "#f87171" : "#0b0713"}" stroke-width="${p.friction ? 2 : 1.5}">
          <title>Stap ${p.stepNumber}: ${p.emotion}${p.friction ? " (frictie)" : ""}</title>
        </circle>`
      )
      .join("");

    const labels = ["Gefrustreerd", "Twijfelend", "Neutraal", "Enthousiast"]
      .map((label, i) => {
        const v = i + 1;
        const y = padY + (1 - (v - 1) / 3) * (height - 2 * padY);
        return `<text x="4" y="${(y + 3).toFixed(1)}" font-size="10" fill="#a79fc0">${label}</text>`;
      })
      .join("");

    const stepLabels = points
      .map((p) => `<text x="${p.x.toFixed(1)}" y="${height - 6}" font-size="9" fill="#a79fc0" text-anchor="middle">${p.stepNumber}</text>`)
      .join("");

    container.innerHTML = `
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Emotieverloop tijdens de sessie">
        ${gridLines}
        <defs>
          <linearGradient id="line-grad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stop-color="#8b5cf6" />
            <stop offset="100%" stop-color="#22d3ee" />
          </linearGradient>
        </defs>
        <path d="${linePath}" fill="none" stroke="url(#line-grad)" stroke-width="2.5" />
        ${dots}
        ${labels}
        ${stepLabels}
      </svg>`;
  }

  const OUTCOME_RING_COLOR = { converted: "#2fb380", abandoned: "#e0533f" };

  function truncateLabel(label, max) {
    if (!label) return "";
    return label.length > max ? label.slice(0, max - 1) + "…" : label;
  }

  // Het vlaggenschip-visual van het vergelijkende rapport: alle persona's naast elkaar
  // op één gedeelde stappen-as, zodat in één oogopslag zichtbaar is of frictie zich op
  // hetzelfde punt in de reis opstapelt (i.p.v. losse lijstjes per persona doorlezen).
  function renderJourneyTimeline(container, personaResults) {
    if (!personaResults.length) {
      container.innerHTML = '<p class="emotion-chart-empty">Geen persona-resultaten om te tonen.</p>';
      return;
    }

    const maxStepCount = Math.max(1, ...personaResults.map((r) => (r.steps ? r.steps.length : 0)));
    const laneHeight = 58;
    const padTop = 22;
    const padBottom = 24;
    const padLeft = 172;
    const padRight = 36;
    const width = 900;
    const height = padTop + padBottom + personaResults.length * laneHeight;

    const xFor = (stepIdx) =>
      maxStepCount === 1
        ? padLeft + (width - padLeft - padRight) / 2
        : padLeft + (stepIdx / (maxStepCount - 1)) * (width - padLeft - padRight);

    const parts = [];

    personaResults.forEach((r, laneIdx) => {
      const y = padTop + laneIdx * laneHeight + laneHeight / 2;
      const hasSteps = r.steps && r.steps.length > 0;

      parts.push(
        `<text x="0" y="${(y - 6).toFixed(1)}" font-size="12" font-weight="700" fill="#201c27" font-family="Inter, sans-serif">${escapeHtml(
          truncateLabel(r.personaLabel, 24)
        )}</text>`
      );

      if (!hasSteps) {
        parts.push(
          `<text x="0" y="${(y + 11).toFixed(1)}" font-size="10" fill="#c23f2b" font-family="Inter, sans-serif">niet volledig getest</text>`
        );
        parts.push(
          `<line x1="${padLeft}" y1="${y}" x2="${width - padRight}" y2="${y}" stroke="#e9e2d4" stroke-width="1.5" stroke-dasharray="4 4" />`
        );
        return;
      }

      parts.push(`<line x1="${padLeft}" y1="${y}" x2="${width - padRight}" y2="${y}" stroke="#e9e2d4" stroke-width="1.5" />`);

      const points = r.steps.map((s, i) => ({ x: xFor(i), s }));
      const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
      parts.push(`<path d="${linePath}" fill="none" stroke="#d3c7ef" stroke-width="2.5" />`);

      points.forEach((p, i) => {
        const color = EMOTION_COLOR[p.s.emotion] || EMOTION_COLOR.neutraal;
        const sev = severityOf(p.s);
        const meta = SEVERITY_META[sev];
        const radius = meta ? meta.radius : 5;
        const isLast = i === points.length - 1;
        const outcomeColor =
          isLast && p.s.action === "finish_converted"
            ? OUTCOME_RING_COLOR.converted
            : isLast && p.s.action === "finish_abandoned"
            ? OUTCOME_RING_COLOR.abandoned
            : null;

        if (outcomeColor) {
          parts.push(
            `<circle cx="${p.x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(radius + 5).toFixed(
              1
            )}" fill="none" stroke="${outcomeColor}" stroke-width="2" />`
          );
        }

        // Ernstige frictie krijgt een zachte "halo" zodat je pijnpunten al ziet
        // voordat je iets gelezen hebt.
        if (sev === "ernstig") {
          parts.push(
            `<circle cx="${p.x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(radius + 4).toFixed(
              1
            )}" fill="${meta.color}" opacity="0.16" />`
          );
        }

        const tooltip = [
          `${r.personaLabel} — stap ${p.s.stepNumber}`,
          `Gevoel: ${p.s.emotion}${meta ? ` (${meta.label.toLowerCase()})` : ""}`,
          p.s.note || "",
          p.s.expectationGap ? `Verwachtingskloof: ${p.s.expectationGap}` : "",
        ]
          .filter(Boolean)
          .join("\n");

        parts.push(
          `<circle cx="${p.x.toFixed(1)}" cy="${y.toFixed(1)}" r="${radius}" fill="${color}" stroke="${
            meta ? meta.color : "#ffffff"
          }" stroke-width="${meta ? 2 : 1.5}" class="journey-dot"><title>${escapeHtml(tooltip)}</title></circle>`
        );
      });
    });

    for (let i = 0; i < maxStepCount; i++) {
      parts.push(
        `<text x="${xFor(i).toFixed(1)}" y="${(height - 4).toFixed(1)}" font-size="9.5" fill="#948c9e" text-anchor="middle" font-family="Inter, sans-serif">${
          i + 1
        }</text>`
      );
    }

    container.innerHTML = `
      <svg viewBox="0 0 ${width} ${height}" style="width:100%; height:auto;" role="img" aria-label="Customer journey van alle persona's naast elkaar op één tijdlijn">
        ${parts.join("\n")}
      </svg>
      <div class="journey-legend">
        <span class="journey-legend-group">
          <span class="journey-legend-title">Gevoel</span>
          <span class="journey-legend-item"><span class="journey-legend-dot" style="background:${EMOTION_COLOR.enthousiast}"></span>Enthousiast</span>
          <span class="journey-legend-item"><span class="journey-legend-dot" style="background:${EMOTION_COLOR.neutraal}"></span>Neutraal</span>
          <span class="journey-legend-item"><span class="journey-legend-dot" style="background:${EMOTION_COLOR.twijfelend}"></span>Twijfelend</span>
          <span class="journey-legend-item"><span class="journey-legend-dot" style="background:${EMOTION_COLOR.gefrustreerd}"></span>Gefrustreerd</span>
        </span>
        <span class="journey-legend-group">
          <span class="journey-legend-title">Ernst</span>
          <span class="journey-legend-item"><span class="journey-legend-dot journey-dot-sm" style="background:#fff; border:2px solid ${SEVERITY_META.licht.color};"></span>Licht</span>
          <span class="journey-legend-item"><span class="journey-legend-dot" style="background:#fff; border:2px solid ${SEVERITY_META.matig.color};"></span>Matig</span>
          <span class="journey-legend-item"><span class="journey-legend-dot journey-dot-lg" style="background:#fff; border:2px solid ${SEVERITY_META.ernstig.color};"></span>Ernstig</span>
        </span>
        <span class="journey-legend-group">
          <span class="journey-legend-title">Einde</span>
          <span class="journey-legend-item"><span class="journey-legend-ring" style="border-color:${OUTCOME_RING_COLOR.converted};"></span>Conversie</span>
          <span class="journey-legend-item"><span class="journey-legend-ring" style="border-color:${OUTCOME_RING_COLOR.abandoned};"></span>Afhaken</span>
        </span>
      </div>
    `;
  }

  function renderTimeline(container, steps) {
    container.innerHTML = steps
      .map((s) => {
        const sev = severityOf(s);
        const meta = SEVERITY_META[sev];
        return `
        <div class="step-card${meta ? " friction sev-" + sev : ""}">
          <div class="step-thumb">
            <img src="data:image/jpeg;base64,${s.screenshot}" alt="Screenshot stap ${s.stepNumber}" data-full="data:image/jpeg;base64,${s.screenshot}" />
          </div>
          <div class="step-body">
            <div class="step-head">
              <span class="step-number">STAP ${s.stepNumber}</span>
              <span class="badge ${emotionBadgeClass(s.emotion)}">${escapeHtml(s.emotion)}</span>
              ${meta ? `<span class="badge ${meta.cls}">${meta.label}</span>` : ""}
            </div>
            <p class="step-thought">"${escapeHtml(s.thought)}"</p>
            <p class="step-note">${escapeHtml(s.note)}</p>
            ${
              s.expectationGap
                ? `<div class="expectation-gap">
                     <span class="expectation-gap-label">Verwachtingskloof</span>
                     <span>${escapeHtml(s.expectationGap)}</span>
                   </div>`
                : ""
            }
          </div>
        </div>`;
      })
      .join("");

    container.querySelectorAll("img[data-full]").forEach((img) => {
      img.addEventListener("click", () => {
        lightboxImg.src = img.dataset.full;
        lightbox.hidden = false;
      });
    });
  }

  // ---------- Results rendering ----------
  function majorityLevel(values) {
    const counts = {};
    values.forEach((v) => {
      const key = (v || "").trim();
      if (!key) return;
      counts[key] = (counts[key] || 0) + 1;
    });
    let best = null;
    let bestCount = -1;
    Object.entries(counts).forEach(([k, c]) => {
      if (c > bestCount) {
        best = k;
        bestCount = c;
      }
    });
    return best || "—";
  }

  function renderComparisonHero(result) {
    const { personaResults, comparison } = result;
    const successful = personaResults.filter((r) => r.finalReport);
    const convertedCount = successful.filter((r) => r.finalReport.outcome === "converted").length;
    const likelihoods = successful.map((r) => r.finalReport.conversion_likelihood);

    const summaryText = comparison
      ? comparison.cross_persona_summary
      : "Er kon geen vergelijkende analyse worden gegenereerd (mogelijk faalden alle persona-tests).";

    const dropoffText = (comparison && comparison.common_dropoff_point) || "";

    // Tel alle ernstige frictiepunten over alle persona's heen — dat is het getal
    // waar een opdrachtgever als eerste naar kijkt.
    const seriousCount = personaResults.reduce(
      (acc, r) => acc + (r.steps || []).filter((s) => severityOf(s) === "ernstig").length,
      0
    );

    comparisonHeroEl.innerHTML = `
      <div class="hero-label">Vergelijkend rapport — ${successful.length} van ${personaResults.length} persona's succesvol getest</div>
      ${comparison && comparison.headline ? `<h3 class="hero-headline">${escapeHtml(comparison.headline)}</h3>` : ""}
      <p class="hero-summary">${escapeHtml(summaryText)}</p>
      <div class="hero-stats">
        <div class="hero-stat">
          <div class="hero-stat-value">${personaResults.length}</div>
          <div class="hero-stat-label">Persona's getest</div>
        </div>
        <div class="hero-stat">
          <div class="hero-stat-value">${convertedCount}/${successful.length || 0}</div>
          <div class="hero-stat-label">Zouden converteren</div>
        </div>
        <div class="hero-stat${seriousCount > 0 ? " hero-stat-alert" : ""}">
          <div class="hero-stat-value">${seriousCount}</div>
          <div class="hero-stat-label">Ernstige frictiepunten</div>
        </div>
        <div class="hero-stat">
          <div class="hero-stat-value">${escapeHtml(majorityLevel(likelihoods))}</div>
          <div class="hero-stat-label">Meest voorkomende conversiekans</div>
        </div>
      </div>
      ${
        dropoffText
          ? `<p class="hero-dropoff"><strong>Gedeeld afhaakpunt:</strong> ${escapeHtml(dropoffText)}</p>`
          : ""
      }
    `;
  }

  function renderReportMeta(result) {
    const url = result.url || "";
    let host = url;
    try {
      host = new URL(url).host + new URL(url).pathname.replace(/\/$/, "");
    } catch {
      /* laat de ruwe url staan als hij niet te parsen is */
    }
    const now = new Date();
    const stamp = now.toLocaleDateString("nl-NL", { day: "numeric", month: "long", year: "numeric" });

    reportMetaEl.innerHTML = `
      <div class="report-meta-main">
        <span class="report-meta-eyebrow">Mystery shopper-rapport</span>
        <span class="report-meta-url">${escapeHtml(host)}</span>
      </div>
      <div class="report-meta-side">
        <span class="report-meta-goal">Doel: ${escapeHtml(result.goal || "—")}</span>
        <span class="report-meta-date">${escapeHtml(stamp)}</span>
      </div>
    `;
  }

  function renderComparisonRecommendations(comparison, personaResults) {
    let recos = (comparison && comparison.prioritized_recommendations) || [];

    if (!recos.length) {
      // De vergelijkende synthese leverde zelf geen lijst op (kan gebeuren) — val terug
      // op de individuele aanbevelingen per persona zodat deze sectie nooit leeg oogt.
      const priorityRank = { Hoog: 0, Gemiddeld: 1, Laag: 2 };
      const combined = [];
      (personaResults || []).forEach((r) => {
        if (!r.finalReport || !Array.isArray(r.finalReport.recommendations)) return;
        r.finalReport.recommendations.forEach((rec) => {
          const key = (rec.title || "").trim().toLowerCase();
          const existing = combined.find((c) => c._key === key);
          if (existing) {
            if (!existing.affected_personas.includes(r.personaLabel)) {
              existing.affected_personas.push(r.personaLabel);
            }
            return;
          }
          combined.push({ ...rec, _key: key, affected_personas: [r.personaLabel] });
        });
      });
      combined.sort((a, b) => (priorityRank[a.priority] ?? 1) - (priorityRank[b.priority] ?? 1));
      recos = combined.slice(0, 5);
    }

    if (!recos.length) {
      comparisonRecommendationsEl.innerHTML = `<p class="lead">Geen aanbevelingen beschikbaar.</p>`;
      return;
    }
    comparisonRecommendationsEl.innerHTML = recos
      .map(
        (r) => `
        <div class="reco-card">
          <div class="reco-head">
            <h3>${escapeHtml(r.title)}</h3>
            <span class="reco-badges">
              <span class="badge ${priorityBadgeClass(r.priority)}">Impact: ${escapeHtml(r.priority)}</span>
              ${r.effort ? `<span class="badge ${effortBadgeClass(r.effort)}">Inspanning: ${escapeHtml(r.effort)}</span>` : ""}
            </span>
          </div>
          <p>${escapeHtml(r.description)}</p>
          <div class="reco-affected">
            ${(r.affected_personas || []).map((p) => `<span class="reco-affected-tag">${escapeHtml(p)}</span>`).join("")}
          </div>
        </div>`
      )
      .join("");
  }

  function renderPersonaTabsAndPanels(personaResults) {
    personaTabsEl.innerHTML = personaResults
      .map((r, i) => {
        const dotColor = r.error
          ? "#f87171"
          : r.finalReport && r.finalReport.outcome === "converted"
          ? "#4ade80"
          : r.finalReport && r.finalReport.outcome === "abandoned"
          ? "#f87171"
          : "#facc15";
        return `
        <button type="button" class="tab-btn${i === 0 ? " active" : ""}" data-tab-index="${i}">
          <span class="tab-dot" style="color:${dotColor}"></span>
          ${escapeHtml(r.personaLabel)}
        </button>`;
      })
      .join("");

    personaPanelsEl.innerHTML = personaResults
      .map((r, i) => `<div class="persona-panel${i === 0 ? " active" : ""}" data-panel-index="${i}"></div>`)
      .join("");

    personaResults.forEach((r, i) => {
      const panel = personaPanelsEl.querySelector(`[data-panel-index="${i}"]`);
      if (r.error || !r.finalReport) {
        panel.innerHTML = `
          <div class="persona-error-card">
            <strong>${escapeHtml(r.personaLabel)}</strong> kon niet volledig getest worden.
            <p>${escapeHtml(r.error || "Onbekende fout tijdens deze test.")}</p>
          </div>`;
        return;
      }

      const report = r.finalReport;
      panel.innerHTML = `
        <div class="verdict-card">
          <div class="verdict-top">
            <span class="badge ${conversionBadgeClass(report.conversion_likelihood)}">Conversiekans: ${escapeHtml(
        report.conversion_likelihood
      )}</span>
            <span class="badge badge-outcome">${escapeHtml(outcomeLabel(report.outcome))}</span>
          </div>
          ${report.headline ? `<h3 class="verdict-headline">${escapeHtml(report.headline)}</h3>` : ""}
          <p class="verdict-summary">${escapeHtml(report.summary)}</p>
          <p class="verdict-risk"><strong>Grootste risico op afhaken:</strong> ${escapeHtml(report.biggest_dropoff_risk)}</p>
        </div>

        <h2 class="emotion-title">Emotieverloop tijdens de sessie</h2>
        <div class="emotion-chart" data-role="emotion-chart"></div>

        <h2 class="timeline-title">Stap voor stap</h2>
        <p class="legend">
          <span class="legend-swatch legend-friction"></span> gemarkeerd element = frictiepunt
          &nbsp;&nbsp;
          <span class="legend-swatch legend-normal"></span> gemarkeerd element = normale actie
        </p>
        <div class="timeline" data-role="timeline"></div>

        <h2 class="reco-title">Individuele aanbevelingen</h2>
        <div class="recommendations" data-role="recommendations"></div>
      `;

      renderEmotionChart(panel.querySelector('[data-role="emotion-chart"]'), r.steps || []);
      renderTimeline(panel.querySelector('[data-role="timeline"]'), r.steps || []);

      const recosEl = panel.querySelector('[data-role="recommendations"]');
      const recos = report.recommendations || [];
      recosEl.innerHTML = recos
        .map(
          (rec) => `
          <div class="reco-card">
            <div class="reco-head">
              <h3>${escapeHtml(rec.title)}</h3>
              <span class="reco-badges">
                <span class="badge ${priorityBadgeClass(rec.priority)}">Impact: ${escapeHtml(rec.priority)}</span>
                ${rec.effort ? `<span class="badge ${effortBadgeClass(rec.effort)}">Inspanning: ${escapeHtml(rec.effort)}</span>` : ""}
              </span>
            </div>
            <p>${escapeHtml(rec.description)}</p>
          </div>`
        )
        .join("");
    });

    personaTabsEl.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = btn.dataset.tabIndex;
        personaTabsEl.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        personaPanelsEl.querySelectorAll(".persona-panel").forEach((p) => {
          p.classList.toggle("active", p.dataset.panelIndex === idx);
        });
      });
    });
  }

  function renderResults(result) {
    const personaResults = result.personaResults || [];
    renderReportMeta(result);
    renderComparisonHero(result);
    renderJourneyTimeline(journeyTimelineEl, personaResults);
    renderComparisonRecommendations(result.comparison, personaResults);
    renderPersonaTabsAndPanels(personaResults);
  }

  lightbox.addEventListener("click", () => {
    lightbox.hidden = true;
    lightboxImg.src = "";
  });
})();
