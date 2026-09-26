# Tomok

Schedule investigations and reviewed project memory, built on the eve chat template.
The [hackathon build plan](docs/tomok-company/hackathon/build-plan.md) and
[high-level design](docs/tomok-company/hackathon/high-level-design.md) now live in
this repository. The port includes the source-file viewers, MongoDB evidence
import, saved investigations, and human-reviewed memory from the `tomok` repo,
including its in-progress memory changes.

The product routes are `/files`, `/investigations`, `/memory`, `/replays`, and `/missions`. Web code lives
under `apps/web`; the eve agent and its project tools live under `agent`.
The newer eve service composition in `vercel.ts` remains in place.

Use Node 24+ and `pnpm install`. Keep the eight registered source files in
`data/kiewit/bp-tunnel/` (gitignored). Validate them with
`pnpm import:project --dry-run`. To enable investigations and reviewed memory,
set `MONGODB_URI` and `MONGODB_DATABASE` in the root `.env.local`, then run
`pnpm import:project` and `pnpm dev:services`. Sign in with Vercel mode also needs
`TOMOK_PROJECT_VIEWER_IDS`; password mode represents one trusted operator.
Web-only `pnpm dev:web` reads environment files from `apps/web`, so pass the
same environment explicitly when running the web service on its own.

Checks: `pnpm test:tomok`, `pnpm test:project-files`, `pnpm typecheck`,
`pnpm build:web`, and `pnpm test:project-files:api` (after building the web app).
`pnpm build:eve` builds the separate agent.

Case replay starts with July 13–14 observations, then explicitly reveals July
15–16 in a new saved reassessment. Each stage stores its selected source excerpts,
schedule basis, and reviewed-note revisions in MongoDB. Its citations open frozen
excerpts; full files and live memory are explicitly outside the replay. The
undated field plan is assumed context, so this is a reporting-date exercise rather
than a reconstruction of what was historically known. Reviewed-note pages offer
an explicit new-replay action to capture currently applicable notes; retries
preserve the existing stages. Memory review links return to their originating
replay or investigation without changing its saved evidence.

Reassessment suggests review for interpretations citing affected planning rows
and preserves mappings and memory history. A person must make any memory status
change. Each saved stage can open a fresh conversation permanently bound to its
cutoff and saved revisions. MongoDB stores the owner/session/stage binding before
the first message; eve stores the conversation stream. Refresh restores a bounded
transcript snapshot and resumes from its cursor. `/replays` lists the owner's 20
most recently started cases with both saved stages; each stage lists its 20 most
recently opened conversations with resume links. Older saved URLs remain valid.
These lists are private and do not use the template's browser chat list.
Transcript retention depends on the eve runtime. Revealing later reports requires
a separate stage and a fresh conversation.

Replay turns expose only `get_replay_context`. Live project tools, external
connections, and profile memory are unavailable; execution guards and every eve
session route also check the server binding. Reset/clear cannot erase a replay's
conversation history. Optional shell, file, web, and delegation defaults are
disabled for this project agent. Chat session authorization now requires MongoDB
so unavailable scope storage cannot silently widen access. Ordinary project chats
retain the authored project tools and configured connections.

Atlas Vector Search ranks evidence and optionally current reviewed notes using
Voyage 4 with 1,024 dimensions. Run `pnpm search:project` after importing, then
`pnpm search:project --status` and `pnpm search:project --verify`. Atlas generates
the embeddings natively; no separate embedding-provider credential is needed.
Derived search documents preserve the source import and note histories. Date,
project, import, and current eligible revision filters apply before ranking;
returned text comes from the authorized source records. Index lag or failure is
reported as keyword fallback. Evidence answers also include the current eligible
reviewed notes. Frozen replay chats keep their saved evidence scope.
MongoDB currently labels Automated Embedding as a preview feature in its
[documentation](https://www.mongodb.com/docs/vector-search/crud-embeddings/automated-embedding/).

Archive missions use one eve agent to choose, read, and extract facts from bounded
source jobs. The first preset inventories all eight registered files and processes
nine units: one XER activity neighborhood, four SOE worksheet rows, and four daily
report rows. MongoDB owns the mission queue, leases, immutable result references,
coverage, report, and policy history. eve owns durable model/tool execution and
the session stream. An accepted turn runs without an open browser; the separate
worker reconciles pending deliveries and interrupted work.

For local missions, configure the same `TOMOK_MISSION_DISPATCH_SECRET` in both
services and the CLI worker using the root `.env.development.local`. Use a random
value of at least 16 characters. The
[archive mission deployment guide](docs/setup-and-deploy.md#archive-missions)
includes a command that creates it without printing it, then starts both services
and `pnpm missions:worker --host localhost:3001`. The worker is required in local
development because eve dev does not fire schedules automatically. Deployed
reconciliation uses the authored `reconcile_missions` schedule and needs a host
that actually runs scheduled tasks.

Mission tools resolve their source scope from a server-bound session, enforce
serial leases and bounded work/model budgets, and keep extracted facts and draft
lessons separate from reviewed project memory. The current adaptive policy only
omits genuinely empty workbook cells from model context. The live nine-unit
comparison reduced serialized context bytes by 5.85% while passing
the fixed source-preservation checks. This measures context bytes on inspected
records; model token savings, extraction accuracy, and generalization have not
been measured. A live process restart preserved two committed source outputs and
continued in a replacement session. After explicit bounded budget resumes, the
rehearsal completed all 13 jobs across nine source units and saved an unreviewed
report. Development verification caught unsupported date-provenance and schedule
interpretations; the corrected draft retains the original report history and
flags four immutable fact labels for review. See the runbook for the measured
recovery mechanism, corrections, and remaining deployment checks.

Jae's accepted interpretation/target milestone, public-source permissions, and
domain acceptance of the complete demo remain pending. The local rehearsal is
documented in [the demo runbook](docs/tomok-company/hackathon/demo-runbook.md).

## Chat template setup

A Next.js chat template for [eve](https://eve.dev) that starts with password access and browser-persisted chats, then upgrades to durable memory, Sign in with Vercel, Neon, and Upstash when you need a production multi-user application.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?demo-description=A%20persisted%20Next.js%20chat%20template%20for%20eve%2C%20built%20with%20shadcn%2Fui%2C%20Tailwind%20CSS%2C%20Streamdown%2C%20Better%20Auth%2C%20Drizzle%2C%20and%20Neon.&demo-image=https%3A%2F%2Fimages.ctfassets.net%2Fe5382hct74si%2FYXYTquqpBmvVFbASdIvrC%2Fbb50d21ba7866882d90e25d842b6fc02%2Feve-chat-no-bg.png&demo-title=eve%20Chat%20Template&demo-url=https%3A%2F%2Fchat.eve.dev&env=EVE_CHAT_PASSWORD&envDescription=Choose%20a%20strong%20password%20to%20protect%20your%20agent%20%2816%2B%20characters%20recommended%29.&envLink=https%3A%2F%2Fgithub.com%2Fvercel%2Feve%2Fblob%2Fmain%2Fapps%2Ftemplates%2Feve-chat-template%2Fdocs%2Fsetup-and-deploy.md&from=templates&project-name=eve%20Chat%20Template&repository-name=eve-chat-template&repository-url=https%3A%2F%2Fgithub.com%2Fvercel%2Feve%2Ftree%2Fmain%2Fapps%2Ftemplates%2Feve-chat-template)

## Quick Start

Deploy the starter without provisioning a database or other Marketplace products:

1. Click **Deploy with Vercel**.
2. Enter a strong `EVE_CHAT_PASSWORD` (16+ characters recommended).
3. Open the deployed app and enter that password.

Chats and eve session cursors are stored in that browser. They are not shared across browsers or users. The starter does not enable cross-session long-term memory on Vercel until you set up Blob storage; see [Long-Term Memory](docs/setup-and-deploy.md#long-term-memory).

Starter mode is intended for one trusted operator: anyone with the password
shares the same agent identity and connection grants.

## Deployment Modes

| Mode              | Selected when                                                       | Authentication                            | Chat persistence     | Long-term memory                        |
| ----------------- | ------------------------------------------------------------------- | ----------------------------------------- | -------------------- | --------------------------------------- |
| Starter           | `EVE_CHAT_PASSWORD` is configured                                   | Shared password and secure session cookie | Browser localStorage | Shared Vercel Blob document after setup |
| Production        | Neon, Upstash, and all Sign in with Vercel variables are configured | Sign in with Vercel                       | Neon                 | Per-user Vercel Blob document           |
| Local development | Neither mode is configured and `next dev` is running locally        | Local development identity                | Browser localStorage | Process-local                           |

Production mode takes precedence when its complete environment is present. The app fails closed in a production deployment when neither mode is configured. See [Setup and Deployment](docs/setup-and-deploy.md) for the upgrade path.

## Getting Started

For the starter and production setup flows, see [Setup and Deployment](docs/setup-and-deploy.md). For the runtime architecture, streaming model, persistence flow, and extension points, see [How the Chatbot Works](docs/how-the-chatbot-works.md).

Use Node.js 24 or newer and install dependencies with pnpm:

```bash
nvm use
pnpm install
```

Link the existing Vercel project and pull its development credentials:

```bash
pnpm exec vercel link --scope tomok-1987fe8e --project tomok-mongodb
pnpm exec node scripts/pull-env.mjs
```

This pull preserves local variables absent from Vercel, including MongoDB credentials,
and saves the previous file as a gitignored `.env.local.backup-*` with owner-only access.
Values present in Vercel are refreshed. Avoid pulling directly over `.env.local`
with `vercel env pull`, which replaces the file.

Start the web app and eve together:

```bash
pnpm dev:services
```

The project includes a compatible Vercel CLI. `pnpm dev` and `pnpm dev:web` run
only the frontend, without the agent. The model uses Vercel AI Gateway with the
linked project's OIDC credential; no separate Anthropic API key is required.

To require the same password locally, put this in `.env.local`:

```bash
EVE_CHAT_PASSWORD=<at-least-16-characters>
```

To upgrade the linked project to production mode, run the setup script. It provisions private Vercel Blob storage for memory, Neon, and Upstash; registers Sign in with Vercel; pulls environment variables; and runs migrations. Blob usage may incur charges:

```bash
./scripts/setup.sh
# Or: ./scripts/setup.sh --scope <team-slug>
```

Production mode requires:

```bash
DATABASE_URL=
BETTER_AUTH_SECRET=
NEXT_PUBLIC_VERCEL_APP_CLIENT_ID=
VERCEL_APP_CLIENT_SECRET=
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
KV_REST_API_URL=
KV_REST_API_TOKEN=
```

Other optional environment variables:

```bash
# Override the app origin for custom production domains.
BETTER_AUTH_URL=

# Enable hosted Vercel Connect integrations.
SLACK_CONNECTOR=
LINEAR_CONNECTOR=
NOTION_CONNECTOR=
SENTRY_CONNECTOR=
```

Create optional Vercel Connect integrations:

```bash
# Slack channel
vercel connect create slack --name eve-chat-template --triggers
vercel connect attach <slack-connector-uid> --triggers --trigger-path /eve/v1/slack --yes

# MCP connections
vercel connect create mcp.notion.com --name notion
vercel connect create https://mcp.linear.app/mcp --name linear
vercel connect create https://mcp.sentry.dev/mcp --name sentry
```

The deploy button does not require these integrations. For manual setup, put the returned connector UIDs in `SLACK_CONNECTOR`, `NOTION_CONNECTOR`, `LINEAR_CONNECTOR`, and `SENTRY_CONNECTOR`. Local development falls back to `slack/eve-chat-template`, `notion`, `linear`, and `sentry`, so connectors created with the names above work without editing `agent/`.

The composer only shows its connections menu when at least one MCP connector is configured. Password-only starter deployments therefore omit the menu and do not prompt eve to use unavailable connections.

If the connector is not attached to the linked project, run:

```bash
vercel connect attach <connector-uid> --yes
pnpm exec node scripts/pull-env.mjs
```

Production mode only: create the database tables:

```bash
pnpm db:migrate
```

For production, run migrations with Vercel production env vars:

```bash
vercel env run -e production -- pnpm db:migrate
```

Start the complete local chat app:

```bash
pnpm dev:services
```

Use `pnpm dev:web` for frontend-only development.

## What Is Included

- Text chat with an eve agent through same-origin `/eve/v1/*` routes
- Password access with browser-backed chat history by default
- Optional Better Auth sign-in with Vercel
- Optional Neon-backed cross-device chat history
- Optional Upstash Redis rate limiting in production mode
- Optional long-term memory in a private Vercel Blob document (per user in production mode)
- Drizzle schema and migrations for production mode under `apps/web/lib/db`
- Saved eve session cursors and event snapshots in either storage mode
- Sidebar history with delete and new-chat actions
- Vercel Connect-backed Notion, Linear, and Sentry MCP connections
- Vercel Connect-backed Slack channel route at `/eve/v1/slack`
- Composer-level connections menu
- First-message chat titles derived locally from the user's prompt
- Streamdown markdown rendering for assistant text and reasoning
- shadcn/Tailwind components for messages, tools, HITL prompts, and composer

This template intentionally does not include file uploads, guest mode, NextAuth/Auth.js, or AI Elements.

## Agent Code

Edit the agent in `agent/agent.ts`. Its behavior is defined in `agent/instructions.md`, tools live in `agent/tools/`, and `agent/memory/profile.ts` defines per-user long-term memory.

The browser talks to eve with `useEveAgent()` from `eve/react`; the app stores eve stream events and session state so `/chat/[id]` can resume the same durable conversation after refresh.
