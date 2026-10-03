import { generateText, type LanguageModelUsage } from 'ai';
import { z } from 'zod';
import {
  claudeCode,
  createAiSdkMcpServer,
  type AiSdkLikeTool,
  type ClaudeCodeSettings,
  type EffortLevel,
} from 'ai-sdk-provider-claude-code';
import { isAgentError } from 'e2e/agent';
import { requireInstalledClaude } from './claude-binary.ts';
import type {
  AgentErrorCode,
  ExecutorObservation,
  ExecutorVerb,
  StepExecutor,
  StepExecutorContext,
  StepVerdict,
} from 'e2e';

export interface ClaudeCodeAgentOptions {
  /** Claude Code model alias or id: 'sonnet', 'haiku', 'opus'. */
  readonly model?: string;
  /** Claude Code turns allowed per agent step before it is reported as blocked. */
  readonly maxTurns?: number;
  /**
   * Reasoning effort for agent steps. Defaults to 'low': driving a UI step by step needs little
   * deliberation, and Claude Code's own default ('high') thinks on every turn, which is slow.
   */
  readonly effort?: EffortLevel;
  /** Claude Code binary to run. Defaults to the one installed on this machine (see claude-binary.ts). */
  readonly claudeExecutable?: string;
}

// The provider warns on every step that maxTurns above 20 is high; long steps are expected here.
(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS ??= false;

const SERVER = 'e2e';
const RUNTIME_STOPS = new Set<AgentErrorCode>(['STEP_BUDGET_EXHAUSTED', 'STEP_TIMEOUT', 'CANCELLED']);
const FAILED_CODES = ['ASSERTION_FAILED', 'ASSERTION_INCONCLUSIVE', 'ACTION_FAILED', 'LOCATOR_NOT_FOUND'] as const;
const BLOCKED_CODES = [
  'AUTOMATION_UNSUPPORTED',
  'ENVIRONMENT_UNAVAILABLE',
  'SEED_DATA_MISSING',
  'TEST_SETUP_FAILED',
  'AUTH_CREDENTIAL_INVALID',
  'AUTH_CREDENTIAL_UNAVAILABLE',
] as const;
// Above this share of changed lines a diff saves little, so the full listing is sent instead.
const FULL_LISTING_RATIO = 0.6;

// Runs Claude Code with nothing from ~/.claude (no CLAUDE.md, hooks, MCP servers or
// built-in tools) and without writing sessions to disk; it signs in with the local login.
// strictMcpConfig matters most: without it the user's own MCP servers and claude.ai
// connectors attach after the first tool call and add ~40k input tokens to every turn.
const ISOLATED: ClaudeCodeSettings = {
  tools: [],
  settingSources: [],
  strictMcpConfig: true,
  persistSession: false,
  verbatimPrompts: true,
  permissionPrompts: 'none',
};

const SYSTEM_PROMPT = `You are a QA agent testing a web app through tools. You see the app only as a listing with one element per line: "#id role "name" ...". Ids stay the same for as long as an element exists.

Screen updates:
- The step starts with the full listing.
- Every action returns only what changed: lines that appeared ("+") and ids that disappeared ("-"). Everything else is unchanged and its ids still work.
- When the path changes or most of the page changed, you get the full listing again. Call "observe" if you need it otherwise.

Working efficiently:
- Use "batch" to do several actions on one screen in a single call (fill every field, then click Continue). It stops at the first action that fails and tells you which.

Rules:
- Do exactly what the instruction asks, using only data the instruction or its params give. Never invent personal data.
- Prefer the visible, labelled control a real user would use.
- For an "assert" step, never change the app: only observe, then judge.
- When the step is done, or cannot be done, call "complete_step" exactly once:
  - passed: the screen shows the goal was reached (act) or the statement is true (assert).
  - failed: the app did not behave as required, or the statement is false. Use ASSERTION_INCONCLUSIVE when the screen does not prove it either way.
  - blocked: something outside the product stopped you (an environment error, a control your tools cannot operate).
- Your summary is one sentence naming the evidence on screen.`;

interface StepSettings {
  readonly modelId: string;
  readonly maxTurns: number;
  readonly base: ClaudeCodeSettings;
}

export function claudeCodeAgent(options: ClaudeCodeAgentOptions = {}) {
  const modelId = options.model ?? 'sonnet';
  const base: ClaudeCodeSettings = {
    ...ISOLATED,
    pathToClaudeCodeExecutable: options.claudeExecutable ?? requireInstalledClaude(),
  };
  return {
    executor: claudeCodeExecutor({
      modelId,
      maxTurns: options.maxTurns ?? 30,
      base: { ...base, effort: options.effort ?? 'low' },
    }),
    // Judges agent.waitFor / agent.extract, which e2e runs through its own structured-output call.
    model: claudeCode(modelId, base),
  };
}

function claudeCodeExecutor(settings: StepSettings): StepExecutor {
  return {
    name: 'claude-code',
    version: '2',
    cache: 'inherit',
    runStep: (ctx) => runStep(ctx, settings),
  };
}

async function runStep(ctx: StepExecutorContext, { modelId, maxTurns, base }: StepSettings): Promise<StepVerdict> {
  const controller = new AbortController();
  const abort = () => controller.abort(ctx.signal.reason);
  if (ctx.signal.aborted) abort();
  ctx.signal.addEventListener('abort', abort, { once: true });

  const state: StepState = { transcript: [], screen: new ScreenTracker(), abort: () => controller.abort() };
  const tools = buildTools(ctx, state);
  const model = claudeCode(modelId, {
    ...base,
    systemPrompt: SYSTEM_PROMPT,
    maxTurns,
    mcpServers: { [SERVER]: createAiSdkMcpServer(SERVER, tools) },
    allowedTools: Object.keys(tools).map((name) => `mcp__${SERVER}__${name}`),
  });

  const startedAt = new Date();
  try {
    const result = await generateText({
      model,
      prompt: await buildPrompt(ctx, state.screen),
      abortSignal: controller.signal,
    });
    ctx.budgets.recordModelCall({
      ...readUsage(result.usage),
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      provider: 'claude-code',
      modelId,
    });
  } catch (error) {
    if (state.hardStop) throw state.hardStop;
    if (state.verdict === undefined) throw error;
  } finally {
    ctx.signal.removeEventListener('abort', abort);
    ctx.attachTranscript(state.transcript.join('\n'));
  }

  if (state.hardStop) throw state.hardStop;
  return (
    state.verdict ?? {
      status: 'blocked',
      errorCode: 'AUTOMATION_UNSUPPORTED',
      summary: `Claude Code stopped without calling complete_step within ${maxTurns} turns.`,
    }
  );
}

interface StepState {
  transcript: string[];
  screen: ScreenTracker;
  verdict?: StepVerdict;
  hardStop?: unknown;
  abort: () => void;
}

/** Remembers the listing Claude last saw, so updates can carry only what changed. */
class ScreenTracker {
  private lines = new Set<string>();
  private path: string | undefined;

  full(screen: ExecutorObservation): string {
    this.remember(screen);
    return render(screen);
  }

  changes(screen: ExecutorObservation): string {
    const current = listingLines(screen);
    const added = current.filter((line) => !this.lines.has(line));
    const currentIds = new Set(current.map(idOf));
    const removed = [...this.lines].map(idOf).filter((id) => id !== undefined && !currentIds.has(id));
    const pathChanged = screen.path !== this.path;
    if (pathChanged || screen.treeUnavailable || added.length > current.length * FULL_LISTING_RATIO) {
      return `${pathChanged ? 'Navigated. ' : ''}Full screen:\n${this.full(screen)}`;
    }
    this.remember(screen);
    if (added.length === 0 && removed.length === 0) return 'No visible change.';
    return [
      added.length > 0 ? `+ appeared or changed:\n${added.join('\n')}` : undefined,
      removed.length > 0 ? `- gone: ${removed.map((id) => `#${id}`).join(' ')}` : undefined,
    ]
      .filter((part) => part !== undefined)
      .join('\n');
  }

  private remember(screen: ExecutorObservation): void {
    this.lines = new Set(listingLines(screen));
    this.path = screen.path;
  }
}

function listingLines(screen: ExecutorObservation): string[] {
  return screen.text.split('\n').filter((line) => line.trim() !== '');
}

function idOf(line: string): string | undefined {
  return /#(\w+)/.exec(line)?.[1];
}

function render(screen: ExecutorObservation): string {
  return [
    screen.path === undefined ? undefined : `Path: ${screen.path}`,
    screen.treeUnavailable ? 'The element list is unavailable right now; observe again.' : undefined,
    screen.text,
    screen.truncated ? '(listing truncated; scroll to see more)' : undefined,
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

const BATCH_ACTION = z.object({
  action: z.enum(['tap', 'type', 'select', 'check', 'press']),
  id: z.string(),
  text: z.string().optional().describe('type: the text to enter'),
  value: z.string().optional().describe('select: the option label or value'),
  checked: z.boolean().optional().describe('check: true or false'),
  key: z.string().optional().describe('press: a key such as "Enter"'),
});

function buildTools(ctx: StepExecutorContext, state: StepState) {
  const can = (verb: ExecutorVerb) => ctx.target.verbs.has(verb);
  const node = z.string().describe('Element id from the screen listing, e.g. "n12"');
  const target = (id: string) => ({ id: id.replace(/^#/, '') });

  const define = <S extends z.ZodObject>(
    name: string,
    description: string,
    inputSchema: S,
    body: (args: z.infer<S>) => Promise<string>,
  ): AiSdkLikeTool => ({
    description,
    inputSchema,
    execute: async (args: z.infer<S>) => {
      state.transcript.push(`→ ${name} ${JSON.stringify(args)}`);
      try {
        const output = await body(args);
        state.transcript.push(`← ${output.split('\n', 1)[0]}`);
        return output;
      } catch (error) {
        if (isAgentError(error) && RUNTIME_STOPS.has(error.code)) {
          state.hardStop = error;
          state.abort();
        }
        state.transcript.push(`✗ ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    },
  });

  const changes = async () => state.screen.changes(await ctx.observe());

  const act = <S extends z.ZodObject>(
    name: string,
    description: string,
    inputSchema: S,
    body: (args: z.infer<S>) => Promise<void>,
  ) =>
    define(name, description, inputSchema, async (args) => {
      await body(args);
      return `Done.\n${await changes()}`;
    });

  const tools: Record<string, AiSdkLikeTool> = {
    observe: define('observe', 'Read the full current screen listing.', z.object({}), async () =>
      state.screen.full(await ctx.observe()),
    ),
    complete_step: define(
      'complete_step',
      'Finish the step with a verdict. Call exactly once, last.',
      z.object({
        status: z.enum(['passed', 'failed', 'blocked']),
        summary: z.string().describe('One sentence naming the evidence on screen'),
        errorCode: z
          .enum([...FAILED_CODES, ...BLOCKED_CODES])
          .optional()
          .describe('Required for blocked; optional for failed; omit for passed'),
      }),
      async ({ status, summary, errorCode }) => {
        state.verdict = toVerdict(status, summary, errorCode);
        return 'Verdict recorded. Stop now.';
      },
    ),
  };

  if (ctx.step.kind === 'assert') return tools;

  const runOne = async (step: z.infer<typeof BATCH_ACTION>): Promise<void> => {
    const t = target(step.id);
    switch (step.action) {
      case 'tap':
        return ctx.actions.tap(t);
      case 'type':
        return ctx.actions.type(t, step.text ?? '');
      case 'select':
        return ctx.actions.select(t, step.value ?? '');
      case 'check':
        return ctx.actions.check(t, step.checked ?? true);
      case 'press':
        return ctx.actions.press(t, step.key ?? 'Enter');
    }
  };

  tools.batch = define(
    'batch',
    'Run several actions in order on the current screen (e.g. fill fields, then tap Continue). Stops at the first failure.',
    z.object({ actions: z.array(BATCH_ACTION).min(1).max(15) }),
    async ({ actions }) => {
      for (const [index, step] of actions.entries()) {
        if (!can(step.action)) throw new Error(`Action ${index + 1} (${step.action}) is not supported on this target.`);
        try {
          await runOne(step);
        } catch (error) {
          if (isAgentError(error) && RUNTIME_STOPS.has(error.code)) throw error;
          const reason = error instanceof Error ? error.message : String(error);
          return `Action ${index + 1} of ${actions.length} (${step.action} #${step.id}) failed: ${reason}\n${await changes()}`;
        }
      }
      return `Done (${actions.length} actions).\n${await changes()}`;
    },
  );

  if (can('tap')) {
    tools.tap = act('tap', 'Click or tap one element.', z.object({ id: node }), ({ id }) => ctx.actions.tap(target(id)));
  }
  if (can('type')) {
    tools.type = act('type', 'Fill a text field with a value.', z.object({ id: node, text: z.string() }), ({ id, text }) =>
      ctx.actions.type(target(id), text),
    );
  }
  if (can('typeSecret') && ctx.step.secrets.length > 0) {
    tools.type_secret = act(
      'type_secret',
      `Fill a field with a declared secret. Available: ${ctx.step.secrets.map((s) => `${s.name} (${s.purpose})`).join(', ')}.`,
      z.object({ id: node, name: z.string() }),
      ({ id, name }) => ctx.actions.typeSecret(target(id), name),
    );
  }
  if (can('select')) {
    tools.select = act(
      'select',
      'Choose an option in a select/dropdown by its visible label or value.',
      z.object({ id: node, value: z.string() }),
      ({ id, value }) => ctx.actions.select(target(id), value),
    );
  }
  if (can('check')) {
    tools.check = act(
      'check',
      'Set a checkbox, radio or switch to checked or unchecked.',
      z.object({ id: node, checked: z.boolean() }),
      ({ id, checked }) => ctx.actions.check(target(id), checked),
    );
  }
  if (can('scroll')) {
    tools.scroll = act(
      'scroll',
      'Scroll the page, or one scrollable element, by one screen.',
      z.object({ direction: z.enum(['up', 'down', 'left', 'right']), id: node.optional() }),
      ({ direction, id }) => ctx.actions.scroll(direction, id === undefined ? undefined : target(id)),
    );
  }
  if (can('scrollUntil')) {
    tools.scroll_until = act(
      'scroll_until',
      'Scroll until an element with this exact name or text is visible.',
      z.object({ text: z.string(), direction: z.enum(['up', 'down', 'left', 'right']) }),
      ({ text, direction }) => ctx.actions.scrollUntil(text, direction),
    );
  }
  if (can('navigate')) {
    tools.navigate = act(
      'navigate',
      'Go to an app-relative path or URL. Only when the instruction asks for it.',
      z.object({ url: z.string() }),
      ({ url }) => ctx.actions.navigate(url),
    );
  }
  if (can('back')) {
    tools.back = act('back', 'Go back one page.', z.object({}), () => ctx.actions.back());
  }

  return tools;
}

function toVerdict(status: StepVerdict['status'], summary: string, errorCode?: AgentErrorCode): StepVerdict {
  if (status === 'passed') return { status, summary };
  if (status === 'blocked') {
    const code = (BLOCKED_CODES as readonly string[]).includes(errorCode ?? '') ? errorCode : 'AUTOMATION_UNSUPPORTED';
    return { status, summary, errorCode: code };
  }
  const code = (FAILED_CODES as readonly string[]).includes(errorCode ?? '') ? errorCode : undefined;
  return code === undefined ? { status, summary } : { status, summary, errorCode: code };
}

async function buildPrompt(ctx: StepExecutorContext, screen: ScreenTracker): Promise<string> {
  const { step } = ctx;
  return [
    `Step kind: ${step.kind}`,
    `Instruction: ${step.instruction}`,
    step.params === undefined ? undefined : `Params: ${JSON.stringify(step.params)}`,
    ctx.agentContext ? `Context: ${ctx.agentContext}` : undefined,
    ctx.ledger ? `Earlier steps in this test:\n${ctx.ledger}` : undefined,
    ctx.replayedPrefix === undefined
      ? undefined
      : `A recorded replay already did part of this step and stopped (${ctx.replayedPrefix.stopReason}). Do not repeat these actions:\n- ${ctx.replayedPrefix.replayedActions.join('\n- ')}` +
        (ctx.replayedPrefix.uncertainAction
          ? `\nThis action may or may not have taken effect; check the screen before retrying it: ${ctx.replayedPrefix.uncertainAction}`
          : ''),
    `Current screen:\n${screen.full(await ctx.observe())}`,
  ]
    .filter((part) => part !== undefined)
    .join('\n\n');
}

function readUsage(usage: LanguageModelUsage | undefined) {
  const count = (value: unknown): number | undefined => {
    if (typeof value === 'number') return value;
    if (value !== null && typeof value === 'object' && typeof (value as { total?: unknown }).total === 'number') {
      return (value as { total: number }).total;
    }
    return undefined;
  };
  const details = (usage as { inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number } } | undefined)
    ?.inputTokenDetails;
  const fields = {
    inputTokens: count(usage?.inputTokens),
    outputTokens: count(usage?.outputTokens),
    cacheReadTokens: details?.cacheReadTokens,
    cacheWriteTokens: details?.cacheWriteTokens,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => typeof value === 'number')) as {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}
