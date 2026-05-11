# GENESIS Website Builder

AI-powered website builder. Users provide their business info and Claude generates a complete, single-file HTML website which is rendered in a live preview.

## Stack
- Node.js 20+ (ESM)
- Express
- `@anthropic-ai/sdk`
- Vanilla HTML/CSS frontend served as a static asset

## Endpoints
- `GET /` — frontend (`index.html`)
- `GET /health` — `{ status: "ok" }`
- `POST /api/generate` — body `{ businessType, businessName, location, description }` → `{ success, html }`

## Local development
```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start
# open http://localhost:3000
```

## Environment variables
- `ANTHROPIC_API_KEY` (required) — Anthropic API key
- `PORT` (optional) — defaults to 3000

## Deploy (Railway)
1. Create a new Railway project from this GitHub repo (`Cannibusny/genesis-website-builder`).
2. Railway auto-detects Node.js and runs `npm start`.
3. Add an env var: `ANTHROPIC_API_KEY`.
4. Deploy — Railway will assign a public URL.
