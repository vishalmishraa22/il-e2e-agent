# il-e2e-agent

End-to-end browser tests written in plain English, executed by [tester-army/e2e](https://github.com/tester-army/e2e)
and driven by the **Claude Code installed on your machine**, signed in with your own Claude account.
No Anthropic API key is required.

```ts
import { test, expect } from 'il-e2e-agent';

test('a visitor reaches checkout', async ({ app, agent, browser }) => {
  await app.open('/pricing');
  await agent.act('Choose the monthly plan and continue to checkout.'); // Claude operates the page
  await expect(browser).toHaveURL(/\/checkout/);                         // deterministic check, no model
});
```

## Contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Installation](#installation)
- [Framework setup](#framework-setup): [Next.js](#nextjs) · [Nuxt](#nuxt) · [React (Vite)](#react-vite) · [Create React App](#create-react-app)
- [Configuration](#configuration)
- [Writing tests](#writing-tests)
- [Running tests](#running-tests)
- [Replay cache](#replay-cache)
- [Keeping it out of production builds](#keeping-it-out-of-production-builds)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)

## How it works

`e2e` runs your tests in a real browser (Playwright). Steps written as `agent.act('…')` are handed to
an agent; this package supplies that agent.

For each agent step, il-e2e-agent starts your installed Claude Code and gives it a small set of tools:
read the screen, tap, type, select, check, scroll, and run several of those in one batch. Claude reads
the page as an accessibility listing, performs the step, and reports whether it succeeded. Every action
goes through e2e's own action layer, so it is recorded.

Once a step has passed and a later check has confirmed the result, e2e saves the recorded actions.
**Later runs replay them directly, without calling Claude**, until the page changes enough that the
replay no longer matches. Claude then takes over from the current screen and the new path is recorded.

Each Claude Code session is isolated from your personal setup: no `CLAUDE.md`, hooks, built-in tools,
personal MCP servers or connected apps are loaded, and no session history is written.

## Requirements

| Requirement | Notes |
| --- | --- |
| Claude Code, installed and signed in | `curl -fsSL https://claude.ai/install.sh \| bash`, then `claude auth login`. Found on `PATH` or in `~/.local/bin`; set `IL_E2E_CLAUDE_PATH` to use a different binary. |
| Node.js 20.19 or later | |
| Playwright's Chromium | Once per machine: `npx playwright install chromium` |
| `ANTHROPIC_API_KEY` **not** set | If it is set, Claude Code may bill that key instead of your plan. The CLI prints a warning. |

Agent steps count against **your own** Claude plan's usage limits.

## Installation

Install as a dev dependency of your app:

```bash
npm install --save-dev github:vishalmishraa22/il-e2e-agent
npx playwright install chromium
```

Then create this layout in your project:

```
your-app/
├── package.json                 add a "test:e2e" script (below)
└── e2e/
    ├── il-e2e-agent.config.ts   app URL and network policy
    ├── tests/
    │   └── *.e2e.ts             your tests
    ├── support/                 optional shared helpers
    └── .gitignore
```

`e2e/.gitignore`. Run output stays local; the replay cache is committed so teammates replay recorded steps:

```gitignore
.e2e/*
!.e2e/cache/
```

`package.json` scripts:

```json
{
  "scripts": {
    "test:e2e": "il-e2e-agent run --config e2e/il-e2e-agent.config.ts",
    "test:e2e:fresh": "il-e2e-agent run --config e2e/il-e2e-agent.config.ts --no-cache"
  }
}
```

## Framework setup

Tests run against your app's **dev server**. Pick a port for tests (3100 below) so a test run never
collides with the dev server you already use, and start it before running the tests. Alternatively,
let the runner start it with `app.command` (see [Configuration](#configuration)).

### Next.js

```json
{ "scripts": { "dev:e2e": "next dev -p 3100" } }
```

`next build` type-checks every `.ts` file that `tsconfig.json` includes. Exclude the test folder so
production builds never depend on test code:

```jsonc
// tsconfig.json
{ "exclude": ["node_modules", "e2e"] }
```

### Nuxt

```json
{ "scripts": { "dev:e2e": "nuxt dev --port 3100" } }
```

Add the test folder to `.nuxtignore` so the dev server's file watcher skips it (test runs write files
under `e2e/.e2e/`):

```gitignore
e2e/**
```

If CI runs `nuxi typecheck`, also exclude `e2e/` there through `typescript.tsConfig.exclude` in
`nuxt.config.ts`.

### React (Vite)

```json
{ "scripts": { "dev:e2e": "vite --port 3100 --strictPort" } }
```

No further changes are needed with the default Vite templates: `tsconfig.app.json` only includes
`src/`, and Vite's watcher only reacts to files your app imports.

### Create React App

```json
{ "scripts": { "dev:e2e": "PORT=3100 BROWSER=none react-scripts start" } }
```

### Server-side tracking

The network policy below controls what the **test browser** can reach. Calls your **server** makes
(for example a Next.js route handler or Nuxt server route forwarding to an analytics or CRM API)
are outside its reach. If your app does this in development, turn it off in the `dev:e2e` script
with your app's own environment flags, and block the forwarding routes with `blockPaths`.

## Configuration

`e2e/il-e2e-agent.config.ts`:

```ts
import { defineConfig } from 'il-e2e-agent';

export default defineConfig({
  app: { url: 'http://localhost:3100' },
  timeout: 600_000,
  actionTimeout: 8_000,
  maxSteps: 40,
  network: {
    allow: ['*.stripe.com', '*.stripe.network', 'fonts.googleapis.com', 'fonts.gstatic.com'],
    readOnly: ['api-staging.example.com'],
    blockPaths: ['/api/analytics'],
    log: Boolean(process.env.E2E_NETWORK_LOG),
  },
});
```

`defineConfig` accepts every [e2e config option](https://e2e.tester.army/docs/reference/config)
except `targets` and `agents`, which it builds for you, plus:

| Option | Default | Description |
| --- | --- | --- |
| `app` | required | `url` of the app under test. Optionally `command` to let the runner start it, e.g. `{ executable: 'npm', args: ['run', 'dev:e2e'], cwd: '..', reuseExisting: true }`. |
| `model` | `'sonnet'` | Claude model for agent steps: `'sonnet'`, `'haiku'` or `'opus'`. |
| `effort` | `'low'` | Reasoning effort per agent step. Higher values think longer on every turn. |
| `maxSteps` | `25` | Actions a single `agent.act` may take. Raise it for long multi-screen steps. |
| `browser` | e2e defaults | Playwright web-engine options, e.g. `{ viewport: { width: 1280, height: 900 } }`. |
| `network` | localhost only | Which hosts the test browser may reach. `false` disables the guard. |

### Network policy

Every request the test browser makes is checked, and anything not explicitly allowed is aborted.
Development builds often send real analytics, advertising and CRM events. The policy keeps test runs
out of that data, and keeps tests from writing to shared backends.

| Field | Effect |
| --- | --- |
| `allow` | Hosts reachable with any method. `*.example.com` matches the domain and its subdomains. `localhost` and `127.0.0.1` are always allowed. |
| `readOnly` | Hosts reachable with `GET`, `HEAD` and `OPTIONS` only, e.g. a staging API your pages read from. |
| `blockPaths` | Path prefixes aborted on every host, including your own app's routes. |
| `log` | Prints each newly blocked host and path once. |

To build the list for a new project, start with only localhost allowed and run with
`E2E_NETWORK_LOG=1`. Each `[il-e2e-agent] blocked …` line names a host the page tried to reach:
- **Leave blocked:** trackers, pixels, tag managers and CRMs.
- **Add to `allow`:** what the page needs to work, such as payment widgets, fonts and image CDNs.
- **Add to `readOnly`:** APIs it only reads from.

## Writing tests

Tests live in `e2e/tests/*.e2e.ts`:

```ts
import { test, expect } from 'il-e2e-agent';

test('a returning visitor keeps their campaign parameters', async ({ app, agent, browser, screen }) => {
  await app.open('/landing?utm_source=newsletter');

  await agent.act('Start the sign-up flow using the main call-to-action.');
  await expect(browser).toHaveURL(/utm_source=newsletter/);

  await agent.act('Enter the email {email} and continue.', { params: { email: 'qa@example.com' } });
  await expect(screen.getByText('Check your inbox', { exact: false })).toBeVisible();
});
```

Guidelines:

- **Follow every `agent.act` with an `expect`.** The check confirms the step did the right thing, and
  only steps confirmed by a later check are recorded for replay.
- **One goal per `agent.act`.** Short, specific instructions are faster, cheaper and more reliable than
  one instruction covering a whole flow.
- **Check with `expect` wherever possible.** `expect`, `screen.*` and `browser.*` never call a model.
  `agent.assert`, `agent.waitFor` and `agent.extract` call Claude on every run, even when the steps
  before them are replayed.
- **Pass data as `params`** and reference it as `{name}` in the instruction. Wrap values that change on
  every run (timestamps, generated emails) in `unique()`, or the step is never replayed.
- **Prefer `exact: false` for copy checks** when text may come from a CMS or change case.
- **Never instruct the agent to submit real payments** or other irreversible actions against shared
  environments.

`test`, `expect`, `unique`, `credentials` and `secrets` are re-exported from e2e. The full test API is
documented at [e2e.tester.army/docs](https://e2e.tester.army/docs).

## Running tests

```bash
npm run dev:e2e                                  # terminal 1: the app on the test port

npm run test:e2e                                 # terminal 2: all tests
npm run test:e2e -- e2e/tests/checkout.e2e.ts    # one file
npm run test:e2e -- --headed                     # watch the browser
npm run test:e2e -- --reporter list,markdown     # writes e2e/.e2e/summary.md and failure pages
npm run test:e2e:fresh                           # ignore recordings and run every step live
```

Failure details, screenshots and traces are written to `e2e/.e2e/`. Start with
`e2e/.e2e/failures/` when a test fails.

The CLI sets `E2E_TELEMETRY_DISABLED=1` unless you set it yourself.

## Replay cache

- **First run of a step:** Claude performs it live, and the actions are recorded in `e2e/.e2e/cache/`.
- **Later runs:** the recording is replayed with no model call.
- **The page changes:** the replay hands over to Claude where it stopped matching, and the step is
  recorded again.
- **Changing a test's name, an instruction or its params** starts that step from scratch.

**Commit `e2e/.e2e/cache/`** so everyone on the team replays the same recordings instead of running
every step live on their own plan. Review cache changes in pull requests like any other test data.

## Keeping it out of production builds

This package is a development tool. Deployment and CI builds that install dev dependencies (for example
because the framework's build tooling lives there) should skip it. Remove it from `package.json` in the
build environment before installing:

```bash
npm pkg delete devDependencies.il-e2e-agent && npm install --include=dev
```

This changes the build's working copy only. Verified with both `npm install` and `npm ci` (npm 11).

AWS Amplify (`amplify.yml`):

```yaml
preBuild:
  commands:
    - npm pkg delete devDependencies.il-e2e-agent
    - npm install --include=dev
```

Vercel (`vercel.json`):

```json
{ "installCommand": "npm pkg delete devDependencies.il-e2e-agent && npm install" }
```

GitHub Actions:

```yaml
- run: npm pkg delete devDependencies.il-e2e-agent
- run: npm ci
```

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Claude Code was not found` | Install Claude Code and run `claude auth login`, or set `IL_E2E_CLAUDE_PATH`. |
| `il-e2e-agent.config.ts not found` | Pass `--config e2e/il-e2e-agent.config.ts`, as the scripts above do, or run from the folder that holds it. |
| `APP_UNREACHABLE` | The app isn't running on the configured URL. Start `npm run dev:e2e` first, or configure `app.command`. |
| A page renders broken or incomplete | A resource it needs is blocked. Run with `E2E_NETWORK_LOG=1` and add the host to `network.allow`. |
| A step takes long or exhausts its steps | Split the instruction into smaller `agent.act` calls, or raise `maxSteps`. |
| A recorded step keeps re-running live | Its instruction, params or test name changed, or a value differs on every run. Use `unique()` for those. |
| The dev server misbehaves while tests run | Exclude `e2e/` from its file watcher (`.nuxtignore` for Nuxt). |

## Limitations

- **Local use.** Agent steps run on the signed-in developer's own Claude plan, for their own use. Don't
  share sign-ins or run them on shared or automated infrastructure. Replays of committed recordings need
  no model.
- **Text, not pixels.** The agent reads the page's accessibility tree. Layout and visual correctness
  need separate visual testing.
- **`agent.assert`, `waitFor` and `extract` always run live**, so they use your plan on every run.
- **Pre-1.0 foundations.** e2e is still before 1.0, and this package pins exact versions of it.

## Disclaimer

il-e2e-agent is an independent project. It is not affiliated with, endorsed by or sponsored by
Anthropic. Claude and Claude Code are trademarks of Anthropic, PBC. Your use of Claude Code is governed
by Anthropic's terms for your plan.
