<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## RPM Club handoff

This repository is the RPM Club product: a Next.js 16 / React 19 / TypeScript app with PostgreSQL, a Telegram Mini App, staff admin, loyalty, rentals, notifications, giveaways, and roulette. Read `README.md` first, then the relevant files under `docs/` and `deploy/` before changing behavior or operating production.

### Local development

- Node.js 22.x. Install with `npm ci`; start with `npm run dev` and open `http://127.0.0.1:3001/preview`.
- Local database setup: `npm run setup:local`. It uses Docker and local environment configuration; do not run setup or migrations against production by assumption.
- Useful checks: `npm run typecheck`, `npm run lint`, `npm test`. Integration tests require a dedicated test database; see `README.md`.
- Run the app's documented checks when they are relevant to the task. Never claim a check passed unless it was run.

### Architecture and change workflow

- API handlers: `src/app/api`; shared domain logic: `src/lib`; UI: `src/components`; database migrations: `db/migrations`.
- Preserve domain invariants and contracts in `docs/CORE-CONTRACT.md`, `docs/SPECIFICATION.md`, and feature-specific docs. Add a migration for schema changes; do not edit an already-applied migration.
- This project uses a customized/newer Next.js version. Follow the Next.js agent rules above and read the relevant installed guide in `node_modules/next/dist/docs/` before Next.js changes.
- Keep changes focused, preserve existing user work, and inspect `git status` before commits. Do not deploy, alter production data, or send real Telegram messages unless explicitly asked.

### Secrets and deployment

- Never read out, copy, commit, or share `.env.local`, `.env.telegram`, `.env.vercel`, credentials, tokens, private keys, or production data. `.env.example` is the safe template.
- Environment files are ignored for new files, but some local env files may be tracked in this working copy. Check `git ls-files` and inspect the proposed commit contents before publishing; remove secrets from any export and rotate credentials if they were exposed.
- Deployment procedures and operational risks are documented in `deploy/README.md`, `deploy/VPS-RELEASE.md`, and `docs/OPERATIONS.md`. Do not infer production access from local configuration.
