# Configuration

This guide explains how to run DBOpenStudio locally, with Supabase-backed
persistence, and with the optional AI assistant.

Most contributors should start with local JSON mode. It needs no external
services and is enough to try the app or work on UI/features.

## Mode Matrix

| Mode | Env vars | Auth | Persistence | Good for |
| --- | --- | --- | --- | --- |
| Local JSON | none | local user selector | `data/dbopenstudio.json` | development, demos, trying the app |
| Supabase Auth + Supabase Postgres persistence | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `DBOPENSTUDIO_DATABASE_URL` | Supabase Auth | Supabase Postgres | real users, shared remote persistence |
| Standalone Postgres app persistence | not supported | not implemented | plain Postgres | future work |
| AI assistant | `NEXT_PUBLIC_DBOPENSTUDIO_AI_ENABLED`, `OPENAI_API_KEY`, optional `OPENAI_MODEL` and `OPENAI_PLANNER_MODEL` | follows app mode | unchanged | model suggestions and bulk edits |

Source database import is separate from app persistence. You can run
DBOpenStudio in local JSON mode and still import a schema from any reachable
Postgres or Supabase database.

## Local JSON

Use this when cloning the repo for the first time.

```bash
cp .env.example .env.local
npm run dev
```

Keep all values empty in `.env.local`.

The local workspace file is ignored by git:

```txt
data/dbopenstudio.json
```

Set `DBOPENSTUDIO_LOCAL_STORE_PATH` only when you need an isolated local JSON
workspace, for example in tests or demos.

Local JSON mode is intentionally simple. It uses a local user selector instead
of Supabase Auth and writes the workspace file on the machine running Next.js.
Do not use it as production persistence on serverless platforms, because local
filesystem writes are usually ephemeral.

## Supabase Auth + Postgres App Persistence

Use this when you want DBOpenStudio users and projects to be persisted remotely.
This mode uses Supabase Auth for login and Supabase Postgres for app
persistence. The app schema references Supabase Auth objects such as
`auth.users` and `auth.uid()`, so standalone Postgres app persistence is not
supported yet.

Do not point `DBOPENSTUDIO_DATABASE_URL` at Neon, Railway, RDS, Docker Postgres
or another standalone Postgres server for DBOpenStudio app persistence. Those
databases do not provide Supabase Auth objects, so the app schema and runtime
queries will fail. Standalone Postgres is supported as a **source database** for
schema import, not as the DBOpenStudio app database.

Required environment:

```env
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable-or-anon-key>
DBOPENSTUDIO_DATABASE_URL=postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres
```

For local Supabase CLI, use the values printed by `supabase status`. The
database URL usually looks like:

```env
DBOPENSTUDIO_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
```

If the direct hosted database host is not reachable from your network, use the
Supabase pooler connection string instead:

```env
DBOPENSTUDIO_DATABASE_URL=postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
```

Apply the initial app database schema:

```bash
npm run db:setup
```

The setup script reads `DBOPENSTUDIO_DATABASE_URL` from the shell or
`.env.local` and requires the `psql` client to be installed locally. If you
prefer the Supabase SQL Editor, paste and run `supabase/schema.sql`.

Hosted Supabase projects require email confirmation by default for password
signups. Disable email confirmation in Authentication, Providers, Email if you
want users to sign in immediately after signup. Email confirmation, email
changes, password recovery and secure password change flows require email
delivery; Supabase's default hosted email service is limited and intended for
testing, so production deployments should configure custom SMTP.

To avoid emails during registration, disable `Confirm email` in Supabase Auth.
DBOpenStudio will work with email/password signups without SMTP for simple
account creation. Password recovery and secure email-change flows still require
SMTP/email delivery.

DBOpenStudio does not need a Supabase service-role key for normal operation.
Logged-in users edit their own profile and projects through Supabase Auth and
row-level security policies.

## Source Database Import

Source database import is separate from app persistence.

You can import a schema from:

- local Postgres;
- remote Postgres;
- Supabase direct database host;
- Supabase pooler.

Configure the source database from the Import modal in the UI. Those credentials
are not required in `.env.local`.

Imports show a table-level synchronization summary before applying changes. A
user can import all tables, import none, or choose per table whether the imported
definition replaces the current model.

Imported tables are not automatically added to the canvas. Add them from the
left table list after import.

The import modal can save the full import form for the active project. Passwords
and full connection strings are encrypted in browser local storage. Project
metadata, JSON exports and database-backed app persistence only store
non-sensitive connection metadata.

## Project JSON Import/Export

DBOpenStudio project exports use this envelope:

```json
{
  "format": "dbopenstudio.project",
  "version": 1,
  "exportedAt": "2026-05-23T00:00:00.000Z",
  "project": {}
}
```

The export includes the logical model, AI project context, snapshot, canvas state, views and
generated migration SQL. Importing validates the file and creates a new project;
it does not replace the active project.

Project exports are meant for portability and backup. Runtime AI requests use a
compact model context instead of sending the full project export whenever
possible.

## UI Language

DBOpenStudio uses English by default and includes complete Spanish and Catalan dictionaries.
The active language is saved per user as `locale`.

- Local JSON mode persists the preference in `data/dbopenstudio.json`.
- Database-backed persistence stores it in `public.dbos_profiles.locale`.
- Add or edit copy in `src/lib/i18n.ts`, never directly in React components.
- New user-facing copy must include English, Spanish, and Catalan values.

## AI Assistant

The AI assistant is disabled unless this flag is set:

```env
NEXT_PUBLIC_DBOPENSTUDIO_AI_ENABLED=true
```

The OpenAI token must stay server-side:

```env
OPENAI_API_KEY=<your-openai-api-key>
OPENAI_MODEL=gpt-5-mini
OPENAI_PLANNER_MODEL=gpt-5-mini
```

When enabled, the canvas toolbar shows an `AI` button. The chat sends the current
prompt and a compact schema manifest to a lightweight context planner first. The
planner chooses the smallest model context package needed for the final response,
and the proposal request receives only that compact context. Users can cancel the
proposal without changing the model.

Each project can also store a capped AI context brief. Use it for domain rules,
architecture preferences, naming conventions, compliance constraints or notes
that should guide table and relationship design. The AI route receives that
brief, the planner-selected model context, a compacted chat summary and the
latest chat turns on every request.

## Security Notes

- `NEXT_PUBLIC_*` variables are visible to the browser. Only use publishable keys there.
- `DBOPENSTUDIO_DATABASE_URL` is server-only and must never be exposed to the browser.
- `OPENAI_API_KEY` is server-only and must never be exposed to the browser.
- Never use a Supabase service role key in this app unless a future server-only feature explicitly needs it and documents the risk.
- Keep `.env.local` private.
