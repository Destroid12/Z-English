# Z-English

**English from A to Z** — an English-learning platform with interactive slide lessons, an AI voice tutor (Z-AI), a lesson editor, community feed, and test/temporary session publishing. Built as a static multi-page app with a serverless backend.

## Stack

- **Frontend**: Vanilla HTML/CSS/JS (no build step)
  - `index.html` — landing, sign-in, student dashboard, admin panels, community, site-wide AI tutor (SPA)
  - `editor.html` — admin slide/session editor (elements, live preview, AI auto-fix, PPTX import, media upload)
  - `player.html` — interactive lesson player with gates, quizzes, tests and the voice tutor
- **Backend**: [Vercel](https://vercel.com) serverless functions (Node.js)
  - `api/backend.js` — action-dispatched REST API (`/api/backend?action=...`)
  - `api/paymob.js` — Paymob payment-link generator (`/api/paymob`)
- **Database**: [Supabase](https://supabase.com) (Postgres + `zenglish-media` storage bucket)
- **AI**: Google Gemini (tutor, slide auto-fix, answer grading, PPTX analysis) — free tier works
- **Payments**: Paymob (MENA-first, EGP)

## Architecture at a glance

```
Browser (index.html / editor.html / player.html)
        │  GET  /api/backend?action=...&token=...     (callBackendGet)
        │  POST /api/backend   body={action, ...}      (callBackend)
        ▼
Vercel serverless  api/backend.js  handler  → actions[action] dispatcher (~85 actions)
        ▼
Supabase (service-role key) ── 19 tables + zenglish-media bucket
        │
        ├── Google Gemini  (tutor, grading, auto-fix, PPTX)
        ├── Paymob         (payment links)
        └── Google OAuth   (admin Google sign-in)
```

The API preserves the exact action contract of the legacy Google Apps Script backend
(see `migrate/README.md` and `supabase/schema.sql`).

## Getting started

Requirements: Node.js 18+, the [Vercel CLI](https://vercel.com/docs/cli), a Supabase project.

```bash
# 1. Install dependencies
npm install

# 2. Create your local env file and fill it in (see .env.example)
Copy-Item .env.example .env    # Windows PowerShell

# 3. Apply the schema to Supabase (SQL Editor) or use the CLI migrations
#    supabase/migrations/0001_init.sql

# 4. Run locally (serves pages + API functions)
npm run dev        # => vercel dev
```

Open the printed local URL. Sign in as a student (admin-created account) or as an
admin via "Continue with Google" (`ADMIN_GOOGLE_EMAILS`).

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `SUPABASE_URL` | yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | **Server-only.** Never expose to the browser |
| `GEMINI_API_KEY` | yes | AI tutor / grading / auto-fix |
| `GEMINI_MODEL` | no | Default `gemini-3.1-flash-lite` |
| `ADMIN_GOOGLE_EMAILS` | no | Comma-separated admin Gmail allowlist |
| `GOOGLE_CLIENT_ID` | no | Google OAuth client for the admin button |
| `CONTACT_DESTINATION_EMAIL` | no | Contact-form recipient |
| `PAYMOB_API_KEY` | no* | *Required to generate payment links. Server-only |
| `PAYMOB_INTEGRATION_ID` | no* | *Required to generate payment links. Server-only |
| `PAYMOB_IFRAME_ID` | no* | *Required to generate payment links. Server-only |

## Deploying to Vercel

1. Push this repo to GitHub.
2. Import the repo at https://vercel.com/new (or `vercel` + `vercel --prod` from the CLI).
3. Add the environment variables above in **Project Settings → Environment Variables**.
4. Vercel auto-detects `api/*.js` as serverless functions; the HTML files are served as static assets.
5. Add `.github/workflows/ci.yml` for CI checks (free on public repos).

No `vercel.json` rewrites are needed — `/`, `/editor`, `/player` map to `index.html`,
`editor.html`, `player.html` via the static file system, and `/api/*` routes to functions.

## Migrations

The canonical schema is `supabase/schema.sql`. Versioned copies live in
`supabase/migrations/` and can be applied with the Supabase CLI:

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

The one-time migration from the legacy Google Sheets backend is documented in
`migrate/README.md` (`migrate/gs-to-supabase.js`).

## License

MIT (add `LICENSE` before public release).
