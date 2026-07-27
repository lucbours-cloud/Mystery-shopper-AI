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
  const errorMessageEl = document.getElementById("error-message");
  const btnRetry = document.getElementById("btn-retry");
  const btnRestart = document.getElementById("btn-restart");
  const verdictCard = document.getElementById("verdict-card");
  const timelineEl = document.getElementById("timeline");
  const recommendationsEl = document.getElementById("recommendations");
  const lightbox = document.getElementById("lightbox");
  const lightboxImg = document.getElementById("lightbox-img");

  let selectedPersonaKey = null;
  let lastPayload = null;

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

  async function loadPersonas() {
    try {
      const res = await fetch("/api/personas");
      const data = await res.json();
      const entries = Object.entries(data.personas || {});
      personaGrid.innerHTML = entries
        .map(
          ([key, p], i) => `
          <label class="persona-card${i === 0 ? " selected" : ""}" data-key="${key}">
            <input type="radio" name="personaKey" value="${key}" ${i === 0 ? "checked" : ""} />
            <div class="p-title">${escapeHtml(p.label)}</div>
            <div class="p-desc">${escapeHtml(p.description)}</div>
          </label>`
        )
        .join("");
      selectedPersonaKey = entries.length ? entries[0][0] : null;

      personaGrid.querySelectorAll(".persona-card").forEach((card) => {
        card.addEventListener("click", () => {
          personaGrid.querySelectorAll(".persona-card").forEach((c) => c.classList.remove("selected"));
          card.classList.add("selected");
          selectedPersonaKey = card.dataset.key;
        });
      });
    } catch (err) {
      personaGrid.innerHTML = `<p class="lead">Kon persona's niet laden. Ververs de pagina.</p>`;
    }
  }
  loadPersonas();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!selectedPersonaKey) return;

    lastPayload = {
      url: urlField.value.trim(),
      personaKey: selectedPersonaKey,
      goal: goalField.value.trim(),
      maxSteps: Number(stepsField.value),
      consent: consentField.checked,
    };
    await runTest();
  });

  async function runTest() {
    showScreen("loading");
    try {
      const res = await fetch("/api/run-test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(lastPayload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Er ging iets mis tijdens de test.");
      }
      renderResults(data);
      showScreen("results");
    } catch (err) {
      errorMessageEl.textContent = err.message || "Er ging iets mis, probeer het opnieuw.";
      showScreen("error");
    }
  }

  btnRetry.addEventListener("click", () => {
    if (!lastPayload) {
      showScreen("input");
      return;
    }
    runTest();
  });

  btnRestart.addEventListener("click", () => {
    showScreen("input");
  });

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

  function renderResults(data) {
    const report = data.finalReport || {};

    verdictCard.innerHTML = `
      <div class="verdict-top">
        <span class="badge ${conversionBadgeClass(report.conversion_likelihood)}">Conversiekans: ${escapeHtml(
      report.conversion_likelihood
    )}</span>
        <span class="badge badge-outcome">${escapeHtml(outcomeLabel(report.outcome))}</span>
      </div>
      <p class="verdict-summary">${escapeHtml(report.summary)}</p>
      <p class="verdict-risk"><strong>Grootste risico op afhaken:</strong> ${escapeHtml(report.biggest_dropoff_risk)}</p>
    `;

    const steps = data.steps || [];
    timelineEl.innerHTML = steps
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

    timelineEl.querySelectorAll("img[data-full]").forEach((img) => {
      img.addEventListener("click", () => {
        lightboxImg.src = img.dataset.full;
        lightbox.hidden = false;
      });
    });

    const recos = report.recommendations || [];
    recommendationsEl.innerHTML = recos
      .map(
        (r) => `
        <div class="reco-card">
          <div class="reco-head">
            <h3>${escapeHtml(r.title)}</h3>
            <span class="badge ${priorityBadgeClass(r.priority)}">${escapeHtml(r.priority)}</span>
          </div>
          <p>${escapeHtml(r.description)}</p>
        </div>`
      )
      .join("");
  }

  lightbox.addEventListener("click", () => {
    lightbox.hidden = true;
    lightboxImg.src = "";
  });
})();
