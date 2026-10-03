#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG_FILE = 'il-e2e-agent.config.ts';
const CONFIG_COMMANDS = new Set(['run', 'cache', 'mcp', 'explore']);

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith('-') && !argv[0].includes('.') ? argv.shift() : 'run';

if (process.env.ANTHROPIC_API_KEY) {
  console.warn(
    '[il-e2e-agent] ANTHROPIC_API_KEY is set, so Claude Code may bill that key instead of your Claude subscription. ' +
      'Unset it to run on your own login.',
  );
}

const args = [command, ...argv];
if (CONFIG_COMMANDS.has(command) && !argv.includes('--config')) {
  const config = resolve(CONFIG_FILE);
  if (!existsSync(config)) {
    console.error(`[il-e2e-agent] ${CONFIG_FILE} not found in ${process.cwd()}. Run il-e2e-agent from the folder that holds it.`);
    process.exit(2);
  }
  args.push('--config', config);
}

const e2eCli = join(dirname(fileURLToPath(import.meta.resolve('e2e'))), 'cli/bin.js');
const child = spawn(process.execPath, [e2eCli, ...args], {
  stdio: 'inherit',
  env: { E2E_TELEMETRY_DISABLED: '1', ...process.env },
});
child.on('exit', (code, signal) => (signal ? process.kill(process.pid, signal) : process.exit(code ?? 1)));
