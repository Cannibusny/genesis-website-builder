# GENESIS Website Builder

AI-powered website builder. Users provide their business brief and Claude generates a production-grade single-file HTML site that is rendered in a live preview, with built-in **SEO scoring**, **A/B variant generation**, **analytics injection**, and **cannabis-compliance** support.

## Live deployment

https://web-production-c33c8e.up.railway.app

## Stack
- Node.js 20+ (ESM)
- Express 4
- `@anthropic-ai/sdk` (Claude Sonnet 4.5)
- Vanilla HTML/CSS/JS frontend (no build step) served as a static asset
- Optional service worker for offline shell caching

## What v2 adds (vs v1)
- **Theme presets** — Obsidian Aurora · Porcelain Lux · Cannabis Heritage · Studio Default
- **Multi-variant A/B output** — 1, 2, or 3 distinct creative directions in one request, tabbed in the preview
- **SEO scoring** — every generated site is scored 0–100 against 14 checks (title, description, OG, canonical, JSON-LD, viewport, alt coverage, structured headings, etc.) with actionable recommendations
- **Analytics injection** — pass a GA4 Measurement ID and/or Meta Pixel ID and the snippets are injected into generated HTML server-side
- **Cannabis / age-gated compliance** — auto-detected (or manually toggled) for dispensaries/CBD/hemp businesses. Generates: age-verification modal, FDA disclaimer, license display, "no medical claims" language, state-aware notes
- **Performance** — caching headers on static assets, service worker for offline shell, lazy-load hints in generated sites, defer-loaded JS
- **Frontend polish** — gradient mesh background, scroll-triggered reveals, micro-interactions, accessible focus states, `prefers-reduced-motion` support

## Endpoints
- `GET /` — frontend (`index.html`)
- `GET /sw.js` — service worker
- `GET /health` — `{ status: "ok", service: "genesis-website-builder", version: "2.0.0" }`
- `POST /api/generate` — generate one or more variants of a website
  - body: `{ businessType, businessName, location, description, theme?, variantCount?, analytics?: { ga4, metaPixel }, compliance?: { ageGate, minAge, state, licenseNumber } }`
  - response: `{ success, html, seo, variants: [{ html, seo, variantHint }], meta }`
- `POST /api/seo-score` — score an arbitrary HTML string
  - body: `{ html }`
  - response: `{ success, score, grade, checks, recommendations }`

## Local development
```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start
# open http://localhost:3000
```

## Environment variables
- `ANTHROPIC_API_KEY` (required) — Anthropic API key
- `PORT` (optional) — defaults to 3000 locally; Railway injects `8080`

## Deploy (Railway)
1. Create a new Railway project from this GitHub repo (`Cannibusny/genesis-website-builder`).
2. Railway auto-detects Node.js (Railpack) and runs `npm start`.
3. Add env var: `ANTHROPIC_API_KEY`.
4. Generate a public domain on the `web` service. Make sure the **target port matches `process.env.PORT`** (Railway injects `8080`).
5. Deploy.

## Notes on the SEO scorer
The scorer is intentionally lightweight: it uses regex checks on the rendered HTML (no DOM parser) so it stays fast and zero-dependency. It is good at catching structural omissions (missing meta description, no JSON-LD, multiple `<h1>`, missing canonical) but does not crawl, render JS, or measure Core Web Vitals. Use it as a directional quality gate, not a Lighthouse replacement.

## Notes on A/B variants
"A/B variants" means the model generates 2–3 distinct creative directions for the same brief (Bold/Editorial, Minimal/Trust, Story-Driven). It does **not** wire up live visitor segmentation or experiment routing — that requires hosted experimentation infrastructure outside the scope of a single-file generator.
