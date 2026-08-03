# AI Mystery Shopper

Een AI-agent die zelf, als gesimuleerde klant, een website doorloopt (via een
headless browser) en rapporteert waar echte klanten zouden twijfelen of afhaken —
met screenshots per stap en een eindrapport met concrete aanbevelingen.

Onderdeel van **Customer Journey Intelligence**. Gebouwd door Luc Bours.

Belangrijk: de agent rondt nooit een echte bestelling, betaling of accountaanmaak
af. Bij een laatste bevestigingsknop stopt hij en registreert dat als
conversiemoment, zonder de actie echt uit te voeren.

## Structuur

- `lib/agent.js` — de agent-logica: Playwright-loop, de aanroepen naar Claude, rapportage
- `server.js` — Express-server (job/polling API rond de agent)
- `public/` — de visuele frontend (input, laadscherm, resultaten met tijdlijn)
- `Dockerfile` — zorgt dat Chromium + alle benodigde systeem-libraries meekomen

## Modelkeuze en kosten

De tool gebruikt twee modellen:

| Rol | Standaard | Wat het doet |
| --- | --- | --- |
| Brein (per stap) | `claude-opus-5` | Bekijkt de screenshot en beslist wat de klant doet |
| Rapportage | `claude-sonnet-5` | Schrijft de eindrapporten (tekst-only, geen beelden) |

Het brein is verreweg de grootste kostenpost: het krijgt per stap een screenshot
mee, en beelden zijn duur in tokens.

**Gemeten kosten** (3 persona's × 5 stappen, tegen een eenvoudige testsite):

- Totaal: ongeveer **€0,57 per test** (ca. 35 tests op een saldo van €20)
- Per persona: ongeveer **€0,19**

Wil je goedkoper testen, dan zijn er drie knoppen — van meeste naar minste effect:

1. **Minder persona's tegelijk.** De kosten schalen vrijwel lineair: 1 persona in
   plaats van 3 is ongeveer een derde van de prijs.
2. **Een kortere test.** De optie "Kort" (3 stappen) in plaats van "Normaal" (5)
   scheelt ruwweg 40%.
3. **Een lichter brein.** Sonnet in plaats van Opus is ongeveer 1,7× goedkoper,
   ten koste van wat scherpte in de observaties.

Je kunt de modellen wisselen zonder de code aan te raken, via environment
variables (op Render: onder "Environment"):

```
MYSTERY_SHOPPER_STEP_MODEL=claude-sonnet-5
MYSTERY_SHOPPER_REPORT_MODEL=claude-haiku-4-5
```

Laat je ze weg, dan gebruikt de tool de standaardwaarden uit de tabel hierboven.

## Waarom Render (en niet Netlify/Vercel)?

Deze tool heeft een "echte" server nodig die een headless browser kan draaien en
die niet na een paar seconden wordt afgekapt — dat past niet goed bij Netlify's
of Vercel's serverless functions. Render's "Web Service" (op basis van de
meegeleverde Dockerfile) is hier wel geschikt voor.

## Live zetten (Render)

1. Upload deze map naar een nieuwe GitHub-repository (zelfde manier als bij het
   vorige project: "Add file" → "Upload files", of per bestand met volledig pad
   aanmaken als een map niet goed meekomt bij het slepen).
2. Ga naar render.com → maak een account (kan met GitHub inloggen).
3. Klik "New +" → "Web Service" → kies je repository.
4. Render herkent de `Dockerfile` automatisch (kies "Docker" als omgeving als
   daarom gevraagd wordt) — je hoeft verder niets aan de build-instellingen te
   wijzigen.
5. Voeg bij "Environment Variables" toe: naam `ANTHROPIC_API_KEY`, waarde = jouw key.
6. Kies het gratis plan ("Free") als die optie er is, en klik "Create Web Service" /
   "Deploy".
7. De allereerste build duurt wat langer dan je gewend bent (Chromium downloaden
   kost een paar minuten) — dat is normaal. Daarna staat de tool live op een
   `.onrender.com`-adres.

Let op: op het gratis Render-plan "slaapt" de service na een periode van
inactiviteit, waardoor de eerste aanvraag na een tijdje wat trager kan zijn
(de server moet dan even opstarten) — dat is normaal gedrag van een gratis plan.
