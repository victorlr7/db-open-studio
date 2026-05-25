<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# DBOpenStudio public OSS rules

This repository is intended to be public and open source. Every change must preserve that assumption.

- Never commit secrets, real database URLs, passwords, service role keys, Supabase JWT secrets, local JSON workspaces, `.env*` files except `.env.example`, `.next`, test output, or generated build artifacts.
- Prefer generic examples in docs. Use placeholders such as `<project-ref>`, `<password>`, `<host>`, and `postgresql://user:password@host:5432/database`.
- Keep installation and deployment documentation current when changing environment variables, scripts, persistence behavior, migrations, ports, or setup steps.
- Keep `.env.example` in sync with all supported environment variables.
- Validate public onboarding after meaningful changes: `npm run lint`, `npm run build`, and relevant Playwright tests.
- If adding a feature that needs external infrastructure, document both the local fallback and the remote/Supabase path.
- DBOpenStudio must remain usable after cloning with no private credentials: `npm install`, optional `.env.local`, then `npm run dev`.
- DBOpenStudio-owned database objects use the `dbos_*` namespace. Do not introduce new internal prefixes without an explicit migration plan.
