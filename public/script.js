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
  const stepsValueEl = document.getElementById("steps-value");
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

  const comparisonHeroEl = document.getElementById("comparison-hero");
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

  stepsField.addEventListener("input", () => {
    stepsValueEl.textContent = stepsField.value;
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

  function renderTimeline(container, steps) {
    container.innerHTML = steps
      .map(
        (s) => `
        <div class="step-card${s.friction ? " friction" : ""}">
          <div class="step-thumb">
            <img src="data:image/jpeg;base64,${s.screenshot}" alt="Screenshot stap ${s.stepNumber}" data-full="data:image/jpeg;base64,${s.screenshot}" />
          </div>
          <div class="step-body">
            <div class="step-head">
              <span class="step-number">STAP ${s.stepNumber}</span>
              <span class="badge ${emotionBadgeClass(s.emotion)}">${escapeHtml(s.emotion)}</span>
              ${s.friction ? '<span class="badge badge-priority-hoog">Frictie</span>' : ""}
            </div>
            <p class="step-thought">"${escapeHtml(s.thought)}"</p>
            <p class="step-note">${escapeHtml(s.note)}</p>
          </div>
        </div>`
      )
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

    const dropoffText = comparison
      ? comparison.common_dropoff_point
      : "Niet beschikbaar.";

    comparisonHeroEl.innerHTML = `
      <div class="hero-label">Vergelijkend rapport — ${successful.length} van ${personaResults.length} persona's succesvol getest</div>
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
        <div class="hero-stat">
          <div class="hero-stat-value">${escapeHtml(majorityLevel(likelihoods))}</div>
          <div class="hero-stat-label">Meest voorkomende conversiekans</div>
        </div>
      </div>
      <p class="hero-dropoff"><strong>Gedeeld afhaakpunt:</strong> ${escapeHtml(dropoffText)}</p>
    `;
  }

  function renderComparisonRecommendations(comparison) {
    const recos = (comparison && comparison.prioritized_recommendations) || [];
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
            <span class="badge ${priorityBadgeClass(r.priority)}">${escapeHtml(r.priority)}</span>
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
              <span class="badge ${priorityBadgeClass(rec.priority)}">${escapeHtml(rec.priority)}</span>
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
    renderComparisonHero(result);
    renderComparisonRecommendations(result.comparison);
    renderPersonaTabsAndPanels(personaResults);
  }

  lightbox.addEventListener("click", () => {
    lightbox.hidden = true;
    lightboxImg.src = "";
  });
})();
