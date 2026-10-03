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

One command starts your dev server, runs the tests and stops the server again:

```bash
npm run test:e2e
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

```bash
npm install --save-dev il-e2e-agent
npx playwright install chromium
```

Project layout:

```
your-app/
├── package.json               il-e2e-agent devDependency + "test:e2e" script
├── il-e2e-agent.config.ts     dev-server command, network policy
├── .gitignore                 + the two lines below
└── e2e/
    ├── tests/
    │   └── *.e2e.ts           your tests
    └── support/               optional shared helpers
```

`package.json`:

```json
{
  "scripts": {
    "test:e2e": "il-e2e-agent run",
    "test:e2e:fresh": "il-e2e-agent run --no-cache"
  }
}
```

`.gitignore`: run output stays local; the replay cache is committed so teammates replay recorded steps:

```gitignore
.e2e/*
!.e2e/cache/
```

`il-e2e-agent run` reads `il-e2e-agent.config.ts` from the directory it runs in, which for an npm
script is the project root.

## Framework setup

The runner starts your dev server for each run and stops it when the run ends, whether it passed,
failed or was interrupted. Use `url: 'http://127.0.0.1:0'`: port `0` makes the runner pick a free
port every time and pass it to your command as `{port}`, so a test run never collides with a dev
server you already have open. Bind to `127.0.0.1` explicitly, because `localhost` can resolve to IPv6
only.

Avoid a fixed port. Some dev servers silently move to another port when the requested one is taken,
and the run would then test whatever else answers on it.

Every example below also uses `readyUrl`, a page the runner waits for before starting tests, so the
first compile happens before the first test.

### Next.js

```ts
// il-e2e-agent.config.ts
import { defineConfig } from 'il-e2e-agent';

export default defineConfig({
  tests: ['e2e/**/*.e2e.ts'],
  app: {
    url: 'http://127.0.0.1:0',
    command: { executable: 'npx', args: ['next', 'dev', '-H', '127.0.0.1', '-p', '{port}'], startupTimeout: 300_000 },
    readyUrl: 'http://127.0.0.1:{port}/',
  },
});
```

`next build` type-checks every `.ts` file `tsconfig.json` includes. Exclude the test files so production
builds never depend on them:

```jsonc
// tsconfig.json
{ "exclude": ["node_modules", "e2e", "il-e2e-agent.config.ts"] }
```

### Nuxt

```ts
// il-e2e-agent.config.ts
import { defineConfig } from 'il-e2e-agent';

export default defineConfig({
  tests: ['e2e/**/*.e2e.ts'],
  app: {
    url: 'http://127.0.0.1:0',
    command: { executable: 'npx', args: ['nuxt', 'dev', '--host', '127.0.0.1', '--port', '{port}'], startupTimeout: 300_000 },
    readyUrl: 'http://127.0.0.1:{port}/',
  },
});
```

Keep the dev server's file watcher away from the tests and their output. In `.nuxtignore`:

```gitignore
e2e/**
.e2e/**
```

If CI runs `nuxi typecheck`, exclude `e2e/` and `il-e2e-agent.config.ts` there through
`typescript.tsConfig.exclude` in `nuxt.config.ts`.

### React (Vite)

```ts
// il-e2e-agent.config.ts
import { defineConfig } from 'il-e2e-agent';

export default defineConfig({
  tests: ['e2e/**/*.e2e.ts'],
  app: {
    url: 'http://127.0.0.1:0',
    command: { executable: 'npx', args: ['vite', '--host', '127.0.0.1', '--port', '{port}', '--strictPort'] },
    readyUrl: 'http://127.0.0.1:{port}/',
  },
});
```

No other changes are needed with the default Vite templates: their TypeScript configs only include
`src/` and `vite.config.ts`.

### Create React App

```ts
// il-e2e-agent.config.ts
import { defineConfig } from 'il-e2e-agent';

export default defineConfig({
  tests: ['e2e/**/*.e2e.ts'],
  app: {
    url: 'http://127.0.0.1:0',
    command: {
      executable: 'npx',
      args: ['react-scripts', 'start'],
      env: { HOST: '127.0.0.1', PORT: '{port}', BROWSER: 'none' },
      startupTimeout: 300_000,
    },
    readyUrl: 'http://127.0.0.1:{port}/',
  },
});
```

### Using your own dev script

To run the dev server through an npm script, for example to set environment flags, pass the host and
port after `--`:

```ts
command: { executable: 'npm', args: ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '{port}'] },
```

The command runs without a shell and inherits only `PATH`, `HOME` and the temp-directory variables.
Pass anything else it needs through `command.env`.

### Server-side tracking

The [network policy](#network-policy) controls what the **test browser** can reach. Calls your
**server** makes (for example a route handler forwarding events to an analytics or CRM API) are outside
its reach. If your app does this in development, switch it off for test runs with your app's own
environment flags in `command.env`, and block the forwarding routes with `blockPaths`.

## Configuration

A complete `il-e2e-agent.config.ts`:

```ts
import { defineConfig } from 'il-e2e-agent';

export default defineConfig({
  tests: ['e2e/**/*.e2e.ts'],
  timeout: 600_000,
  actionTimeout: 8_000,
  maxSteps: 40,
  app: {
    url: 'http://127.0.0.1:0',
    command: {
      executable: 'npx',
      args: ['nuxt', 'dev', '--host', '127.0.0.1', '--port', '{port}'],
      env: { ANALYTICS_ENABLED: 'false' },
      startupTimeout: 300_000,
      log: '.e2e/logs/dev-server.log',
    },
    readyUrl: 'http://127.0.0.1:{port}/',
  },
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
| `app` | required | `url` of the app, `command` that starts it, and `readyUrl` to wait for. See [Framework setup](#framework-setup). |
| `tests` | `e2e/**/*.e2e.ts`, `tests/**/*.e2e.ts` | Test file globs, relative to the config file. |
| `model` | `'sonnet'` | Claude model for agent steps: `'sonnet'`, `'haiku'` or `'opus'`. |
| `effort` | `'low'` | Reasoning effort per agent step. Higher values think longer on every turn. |
| `maxSteps` | `25` | Actions a single `agent.act` may take. Raise it for long multi-screen steps. |
| `browser` | e2e defaults | Playwright web-engine options, e.g. `{ viewport: { width: 1280, height: 900 } }`. |
| `network` | localhost only | Which hosts the test browser may reach. `false` disables the guard. |

`command.log` keeps the dev server's output in a file instead of discarding it.

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
npm run test:e2e                                  # all tests
npm run test:e2e -- e2e/tests/checkout.e2e.ts     # one file, path relative to the project root
npm run test:e2e -- --headed                      # watch the browser
npm run test:e2e -- --reporter list,markdown      # also writes .e2e/summary.md and failure pages
npm run test:e2e:fresh                            # ignore recordings and run every step live
```

Failure details, screenshots and traces are written to `.e2e/`. Start with `.e2e/failures/` when a
test fails, and `.e2e/logs/dev-server.log` (if `command.log` is set) when the app didn't start.

The CLI sets `E2E_TELEMETRY_DISABLED=1` unless you set it yourself.

## Replay cache

- **First run of a step:** Claude performs it live, and the actions are recorded in `.e2e/cache/`.
- **Later runs:** the recording is replayed with no model call.
- **The page changes:** the replay hands over to Claude where it stopped matching, and the step is
  recorded again.
- **Renaming or moving a test file, changing a test's name, an instruction or its params** starts that
  step from scratch. Recordings are keyed by the test's path relative to the config file.

**Commit `.e2e/cache/`** so everyone on the team replays the same recordings instead of running every
step live on their own plan. Review cache changes in pull requests like any other test data.

## Keeping it out of production builds

This package is a development tool. Deployment and CI builds that install dev dependencies (for example
because the framework's build tooling lives there) should skip it. Remove it from `package.json` in the
build environment before installing:

```bash
npm pkg delete devDependencies.il-e2e-agent && npm install --include=dev
```

This changes the build's working copy only. Verified with both `npm install` and `npm ci` (npm 11).
Also exclude `il-e2e-agent.config.ts` and `e2e/` from any type-check your build runs (see
[Next.js](#nextjs)), since the package isn't installed there.

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
| `il-e2e-agent.config.ts not found` | Run from the project root (npm scripts do), or pass `--config <path>`. |
| `APP_UNREACHABLE` | The dev server didn't answer `readyUrl` within `startupTimeout`. Read `command.log`; raise `startupTimeout` for slow first compiles. |
| Tests run against the wrong app | The config uses a fixed port that something else was already using. Use `url: 'http://127.0.0.1:0'` with `{port}`. |
| A page renders broken or incomplete | A resource it needs is blocked. Run with `E2E_NETWORK_LOG=1` and add the host to `network.allow`. |
| A step takes long or exhausts its steps | Split the instruction into smaller `agent.act` calls, or raise `maxSteps`. |
| A recorded step keeps re-running live | Its instruction, params, test name or file path changed, or a value differs on every run. Use `unique()` for those. |
| The dev server misbehaves while tests run | Exclude `e2e/` and `.e2e/` from its file watcher (`.nuxtignore` for Nuxt). |

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
