# DBOpenStudio

DBOpenStudio is a visual database model designer for Supabase and Postgres.

It is not a database admin client. The app imports a schema snapshot, lets you
organize and edit a target model on a canvas, compares both states, and generates
SQL migrations you can review and run yourself.

## Features

- Project-based visual database modeling.
- Local JSON mode with no external services required.
- Optional Supabase Auth with Supabase Postgres-backed persistence.
- Visual canvas with tables, columns, resize, collapse, hide/show and multiple views.
- Drag columns inside table nodes to reorder fields visually and logically.
- Foreign key tools for non-identifying, identifying and many-to-many relationships.
- Import schema snapshots from Supabase or any reachable Postgres database.
- Export/import complete projects as portable JSON.
- English UI by default, with Spanish and Catalan included.
- Diff imported snapshots against the visual model.
- Generate SQL migrations with warnings for risky changes.
- Optional AI assistant for model proposals and migration review summaries.
- Playwright E2E coverage for the main local workflow.

## Requirements

- Node.js 20 or newer.
- npm 10 or newer.
- Optional: a Supabase project or local Supabase stack if you want database-backed app persistence.
- Optional: Postgres/Supabase credentials for source schema import.

## Quick Start

This is the fastest way to try DBOpenStudio. It does not require Supabase,
Postgres, SMTP or OpenAI.

```bash
git clone git@github.com:victorlr7/db-open-studio.git
cd db-open-studio
npm install
cp .env.example .env.local
npm run dev
```

Open:

```txt
http://localhost:7500
```

With an empty `.env.local`, DBOpenStudio runs in local mode and stores workspace
data in `data/dbopenstudio.json`. That file is ignored by git.

For database-backed users and shared projects, configure Supabase later by
following [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## Supported Runtime Modes

| Mode | Supported | What it uses | Notes |
| --- | --- | --- | --- |
| Local JSON workspace | Yes | `data/dbopenstudio.json` | No Supabase, no Postgres, no external services. Best for local development and demos. |
| Local Supabase workspace | Yes | Supabase CLI Auth + local Supabase Postgres | Use `supabase status` values and apply `supabase/schema.sql`. |
| Hosted Supabase workspace | Yes | Supabase Auth + hosted Supabase Postgres | Use the project URL, publishable key and direct or pooler database URL. |
| Standalone Postgres workspace | No | Plain Postgres only | Not supported for DBOpenStudio app persistence yet because the app schema depends on Supabase Auth objects such as `auth.users` and `auth.uid()`. |
| Source schema import from Postgres | Yes | UI-provided source DB credentials | Separate from app persistence. You can import from local Postgres, hosted Postgres, Supabase direct DB or Supabase pooler. |

There are two different database concepts in DBOpenStudio:

- **App persistence database**: where DBOpenStudio stores its own users,
  projects, snapshots, visual models, project sharing data and generated
  migrations. Remote app persistence currently requires Supabase Auth +
  Supabase Postgres.
- **Source database import target**: the external database whose schema you want
  to inspect or import into a project. This can be any reachable Postgres or
  Supabase database and is configured from the Import modal, not from `.env`.

If you point `DBOPENSTUDIO_DATABASE_URL` at a plain Postgres database that is not
part of a Supabase project, DBOpenStudio remote app persistence will not work.
The app schema and runtime queries expect Supabase Auth objects such as
`auth.users` and `auth.uid()`. Use local JSON mode instead, or use local/hosted
Supabase.

## Environment Variables

All supported variables are documented in `.env.example`. Most contributors can
leave every value empty and use local JSON mode.

| Variable | Required | Scope | Description |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Optional | Browser/server | Supabase project URL used for Supabase Auth. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Optional | Browser/server | Supabase publishable anon key used for Supabase Auth. |
| `DBOPENSTUDIO_DATABASE_URL` | Optional | Server only | Supabase Postgres connection string where DBOpenStudio stores its own app data. Do not use a standalone Postgres URL here yet. |
| `DBOPENSTUDIO_LOCAL_STORE_PATH` | Optional | Server only | Override the local JSON workspace path. Useful for isolated tests or demos. Defaults to `data/dbopenstudio.json`. |
| `NEXT_PUBLIC_DBOPENSTUDIO_AI_ENABLED` | Optional | Browser/server | Shows the AI assistant UI and enables the AI API route when set to `true`. |
| `OPENAI_API_KEY` | Optional | Server only | OpenAI API key used by the AI assistant. Required only when AI is enabled. |
| `OPENAI_MODEL` | Optional | Server only | OpenAI model for AI proposals. Defaults to `gpt-5-mini`. |
| `OPENAI_PLANNER_MODEL` | Optional | Server only | OpenAI model for the lightweight context-planning step. Defaults to `OPENAI_MODEL`. |

Important rules:

- Do not commit `.env.local`.
- Do not commit real passwords, service role keys or database URLs.
- Use `.env.example` for placeholders only.
- If the Supabase Auth variables and `DBOPENSTUDIO_DATABASE_URL` are not all set, the app uses local JSON mode.
- If the Supabase Auth variables and `DBOPENSTUDIO_DATABASE_URL` are set, the app enables Supabase Auth and Supabase Postgres-backed app persistence.
- `DBOPENSTUDIO_DATABASE_URL` must point to the Supabase Postgres database that has the Supabase `auth` schema. Standalone Postgres app persistence is not supported yet.
- Never expose `OPENAI_API_KEY` as a `NEXT_PUBLIC_*` variable.

## Persistence Modes

### 1. Local JSON Mode

Best for development and trying the project.

Setup:

```bash
cp .env.example .env.local
npm run dev
```

Leave these values empty:

```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
DBOPENSTUDIO_DATABASE_URL=
```

Data is stored at:

```txt
data/dbopenstudio.json
```

This file is ignored by git. Set `DBOPENSTUDIO_LOCAL_STORE_PATH` only if you
need a separate local workspace file for tests or demos.

### 2. Supabase Auth + Supabase Postgres App Persistence

Best when you want real users and saved projects in a persistent database.

This mode uses Supabase Auth for login and stores DBOpenStudio workspace data in
Supabase Postgres. The app schema references Supabase objects such as
`auth.users` and `auth.uid()`, so a standalone Postgres database such as Neon,
Railway, Docker Postgres, RDS or self-hosted Postgres is not currently supported
for DBOpenStudio app persistence.

This is about DBOpenStudio's own app persistence only. You can still import a
schema from those databases from the Import modal.

Supported app-persistence targets:

- Hosted Supabase project.
- Local Supabase stack started with the Supabase CLI.

Set:

```env
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable-or-anon-key>
DBOPENSTUDIO_DATABASE_URL=postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres
```

For local Supabase, use the values printed by `supabase status`. A typical local
setup looks like:

```env
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<local-anon-key>
DBOPENSTUDIO_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
```

If your network cannot reach the direct Supabase database host, use the Supabase pooler:

```env
DBOPENSTUDIO_DATABASE_URL=postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
```

#### Supabase Auth email behavior

Hosted Supabase projects require email confirmation by default for password
signups. You can disable that requirement in the Supabase dashboard under
Authentication, Providers, Email, by turning off email confirmation. Local
Supabase projects have email confirmation disabled by default.

To avoid emails during registration, disable `Confirm email` in Supabase Auth.
DBOpenStudio will work with email/password signups without SMTP for simple
account creation. Password recovery and secure email-change flows still require
SMTP/email delivery.

Signup confirmation, email changes, password recovery and secure password
change flows send emails. Supabase hosted projects include a limited default
email service for testing, but production deployments should configure custom
SMTP in Supabase Auth. DBOpenStudio does not require a Supabase service role key
for normal profile editing; logged-in users update their own email/password via
Supabase Auth.

Then apply the initial app database schema.

Using the setup script:

```bash
npm run db:setup
```

The script reads `DBOPENSTUDIO_DATABASE_URL` from the shell or `.env.local` and
requires the `psql` client to be installed locally.

Using Supabase SQL Editor:

1. Open your Supabase project.
2. Go to SQL Editor.
3. Paste and run `supabase/schema.sql`.

The internal app tables use the `dbos_*` prefix. This is the DBOpenStudio
persistence namespace, not your imported business schema.

Supabase hosted projects normally use the physical database name `postgres` in
connection strings. For a clean open-source deployment, name the Supabase project
`dbopenstudio` and keep DBOpenStudio-owned database objects under the `dbos_*`
prefix.

Important distinction: app persistence and source database import are separate.
DBOpenStudio app persistence currently supports local JSON or Supabase Postgres.
The source database you import from can be Supabase, local Postgres, hosted
Postgres, or any reachable Postgres-compatible database.

### 3. Optional AI Assistant

The AI assistant is off by default. Enable it with:

```env
NEXT_PUBLIC_DBOPENSTUDIO_AI_ENABLED=true
OPENAI_API_KEY=<your-openai-api-key>
OPENAI_MODEL=gpt-5-mini
OPENAI_PLANNER_MODEL=gpt-5-mini
```

The assistant appears as an `AI` button in the canvas toolbar. Each request first
runs a lightweight context-planning step that decides which compact model context
is needed, then the proposal step receives only that context. The app does not
apply AI changes automatically: review the proposal, then choose whether to apply
or cancel it.

When AI is enabled, each project card also shows a context button. Use it to add
a long project brief: domain explanation, business rules, naming conventions,
constraints and architecture preferences. This text is capped to keep requests
focused, saved with the project, exported in project JSON and sent to the AI
assistant.

The AI panel supports multiple chats per project. Older chat turns are compacted
into a running summary and only recent messages travel with each request to keep
token usage controlled.

When AI is enabled, generated migrations can also request an AI description.
The description is generated server-side from the migration SQL, diff summary
and project context, then stored with the migration so it can be reopened later
without another OpenAI request.

Projects can be shared with another DBOpenStudio user by email after that user
exists in the app profile table. The project owner can permanently delete the
project. Shared users can edit the project and generate migrations, but deleting
from their project list only unlinks their own access. Migration history records
which user generated each migration.

The OpenAI key is used only from the server route. Do not put it in browser
variables or commit it to git.

## Importing a Source Database

Source database import is configured in the UI from the `Import` modal.

You can import from:

- Supabase direct Postgres connection.
- Supabase session or transaction pooler.
- Local Postgres.
- Any remote Postgres reachable from the machine running DBOpenStudio.

You can provide either:

- a full connection string, or
- host, port, database, username, password, schema and SSL settings.

Imports first show a synchronization summary. You can choose all tables, no
tables, or decide table by table whether DBOpenStudio should keep the current
model or replace it with the imported definition.

Imported tables are not automatically placed on the canvas. They appear in the
left table list and can be added by clicking or dragging them into the canvas.

The import modal includes `Save all import settings in this browser`.
When enabled, DBOpenStudio stores the full import form, including passwords or
connection strings, encrypted in browser local storage for that project. Project
metadata, JSON exports and database-backed app persistence still store only
non-sensitive connection metadata.

Example local Postgres import values:

```txt
host: localhost
port: 5432
database: my_app
username: postgres
password: <local-password>
schema: public
ssl: false
```

Example Supabase pooler connection string:

```txt
postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
```

## App Workflow

1. Create or select a project.
2. Import a schema snapshot from Supabase/Postgres, or start from an empty model.
3. Add tables and columns.
4. Add relationships visually or from the column FK selector.
5. Use views to keep canvases focused by domain, for example `Users`, `Billing` or `Catalog`.
6. Optionally ask the AI assistant for model changes and review its proposal.
7. Save the project.
8. Generate a migration.
9. Review the SQL and warnings before running it in your own migration workflow.

## Views

Projects have one logical model and multiple canvas views.

- The model contains all tables, columns and relationships.
- Each view stores only visual canvas organization: visible tables, positions, sizes, collapsed state and viewport.
- Every project has a `Main view`.
- New views start empty so you can add only the tables relevant to that area.

## Translations

The default UI language is English. Spanish and Catalan are included and should
stay complete.

- Translation dictionaries live in `src/lib/i18n.ts`.
- User-facing copy must use `t("key")` from the translation system.
- Every new English key must have matching Spanish and Catalan translations.
- The selected language is stored on the user profile as `locale`.
- Local JSON mode stores `locale` in `data/dbopenstudio.json`.
- Database-backed persistence stores `locale` in `public.dbos_profiles`.

## Project JSON Export

Use `Export JSON` from the canvas toolbar to download a portable
project file. The file includes:

- logical model: schemas, tables, columns, indexes and foreign keys;
- snapshot metadata and imported schema, if present;
- AI project context, if present;
- canvas state: visible tables, positions, sizes and collapsed state;
- all project views;
- generated migrations metadata and SQL.

Use `Import JSON` to create a new project from that file. Importing
does not overwrite the currently open project.

The AI assistant no longer sends this full export on every request. It first asks
OpenAI to choose the required context scope, then sends a compact model context
for the final response.

## More Documentation

- [Configuration guide](docs/CONFIGURATION.md): runtime modes, Supabase setup,
  AI setup and security notes.
- [Architecture notes](docs/ARCHITECTURE.md): persistence model, canvas layout,
  large-schema design and technical roadmap.

## Development

```bash
npm run dev
npm run lint
npm run build
npm run test:e2e
npm test
```

`npm test` runs lint, production build and Playwright E2E tests.
`npm run db:setup` loads `.env.local` and applies `supabase/schema.sql` when
`DBOPENSTUDIO_DATABASE_URL` is configured for Supabase-backed persistence.

The dev server runs on:

```txt
http://localhost:7500
```

## Repository Safety

The repository is configured to ignore:

- `.env*` except `.env.example`
- `data/*.json`
- `.tmp/`
- `.next/`
- `node_modules/`
- `test-results/`
- `playwright-report/`
- `next-env.d.ts`

Before opening a PR, verify no secrets are tracked:

```bash
git status --short --ignored
git ls-files | grep -E '(^\.env|^data/|test-results|playwright-report|node_modules|\.next)' || true
```

Database object naming:

- DBOpenStudio-owned tables, indexes, functions and triggers use the `dbos_*`
  prefix.
- Fresh installs create the auth profile trigger as
  `dbos_on_auth_user_created`.
- Do not commit SQL, migrations or code that introduce real project refs,
  passwords, connection strings or service-role keys.
- Keep source database credentials in `.env.local`, deployment secrets, or the
  encrypted browser-local import settings. They must not appear in exported
  project JSON or committed files.

## Deployment

DBOpenStudio can be deployed anywhere Next.js can run.

For Vercel:

1. Import the GitHub repository.
2. Set Supabase environment variables if you want Supabase Auth and database-backed persistence.
3. Leave env vars empty if you only want to run local JSON mode during development. JSON mode is not suitable for serverless production because filesystem writes are ephemeral.
4. Run `npm run db:setup` before using database-backed persistence.

For self-hosted Node:

```bash
npm install
npm run build
npm run start
```

Set environment variables in your process manager or container runtime.

## Current Limitations

- DBOpenStudio generates SQL but does not execute migrations.
- Advanced rename detection is not implemented.
- RLS policies, triggers, functions and views are not fully modeled yet.
- Generic Postgres app persistence without Supabase Auth is not implemented yet. Local JSON is the no-auth persistence mode.

## License

MIT. See `LICENSE`.
