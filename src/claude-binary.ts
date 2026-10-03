import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export const CLAUDE_PATH_ENV = 'IL_E2E_CLAUDE_PATH';

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The developer's installed Claude Code: env override, then PATH, then the installer's default locations. */
export function findInstalledClaude(): string | undefined {
  const override = process.env[CLAUDE_PATH_ENV];
  if (override) return executable(override) ? override : undefined;
  const fromPath = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, 'claude'));
  const defaults = [join(homedir(), '.local', 'bin', 'claude'), join(homedir(), '.claude', 'local', 'claude')];
  return [...fromPath, ...defaults].find(executable);
}

export function requireInstalledClaude(): string {
  const found = findInstalledClaude();
  if (found) return found;
  throw new Error(
    'il-e2e-agent: Claude Code was not found. Install it (curl -fsSL https://claude.ai/install.sh | bash), ' +
      `sign in with \`claude auth login\`, or point ${CLAUDE_PATH_ENV} at the binary.`,
  );
}
