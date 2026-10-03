#!/usr/bin/env node
// postinstall: the Claude Agent SDK installs its own ~215 MB Claude Code binary as an optional
// per-platform package. il-e2e-agent always runs the developer's installed Claude Code (it refuses to
// start without one), so the bundled copy is never used and is deleted. npm cannot skip just that
// one optional package (--omit=optional would also drop esbuild's platform binary, which e2e needs).
import { existsSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let sdkDir;
try {
  sdkDir = dirname(fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk')));
} catch {
  process.exit(0);
}

const platformPackage = `claude-agent-sdk-${process.platform}-${process.arch}`;
const candidates = [
  join(sdkDir, '..', platformPackage, 'claude'),
  join(sdkDir, '..', `${platformPackage}-musl`, 'claude'),
  join(sdkDir, 'node_modules', '@anthropic-ai', platformPackage, 'claude'),
];

for (const bundled of candidates.filter(existsSync)) {
  const megabytes = Math.round(statSync(bundled).size / 1024 / 1024);
  unlinkSync(bundled);
  console.log(`[il-e2e-agent] Removed the Agent SDK's bundled Claude Code (${megabytes} MB); your installed one is used.`);
}
