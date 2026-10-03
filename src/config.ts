import type { E2EConfig } from 'e2e';
import { web, type WebOptions } from '@e2e-dev/web';
import { claudeCodeAgent, type ClaudeCodeAgentOptions } from './agent.ts';
import { registerNetworkPolicy, type NetworkPolicy } from './network.ts';

type TargetApp = NonNullable<E2EConfig['targets'][number]['app']>;

export interface ClaudeE2EConfig extends Omit<E2EConfig, 'targets' | 'agents'> {
  /** The app under test: its URL and, optionally, the command that starts it. */
  readonly app: TargetApp;
  /** Report label for the target; defaults to `web`. */
  readonly name?: string;
  /** Options for the Playwright web engine (viewport, browser, …). */
  readonly browser?: WebOptions;
  /** Claude Code model alias for agent steps: 'sonnet' (default), 'haiku' or 'opus'. */
  readonly model?: string;
  /** Reasoning effort for agent steps: 'low' (default), 'medium', 'high', … */
  readonly effort?: ClaudeCodeAgentOptions['effort'];
  /** Actions one `agent.act` may take; e2e's default is 25. */
  readonly maxSteps?: number;
  /** Hosts the test browser may reach; `false` turns the guard off. Default: localhost only. */
  readonly network?: NetworkPolicy | false;
  /** Extra named agents, passed through to e2e unchanged. */
  readonly agents?: E2EConfig['agents'];
}

export function defineConfig(config: ClaudeE2EConfig): E2EConfig {
  const { app, name, browser, model, effort, maxSteps, network, agents, ...rest } = config;
  registerNetworkPolicy(network ?? {});
  return {
    ...rest,
    tests: rest.tests ?? ['e2e/**/*.e2e.ts', 'tests/**/*.e2e.ts'],
    targets: [{ name: name ?? 'web', engine: web(browser), app }],
    agents: {
      default: { ...claudeCodeAgent({ model, effort }), ...(maxSteps === undefined ? {} : { maxSteps }) },
      ...agents,
    },
  };
}
