import type { WebRoute } from '@e2e-dev/web';

/**
 * What the test browser may reach. Hosts accept a leading `*.` wildcard
 * (`*.stripe.com` matches `js.stripe.com` and `stripe.com`). Everything not listed is aborted.
 */
export interface NetworkPolicy {
  /** Hosts reachable with any method. `localhost` and `127.0.0.1` are always allowed. */
  readonly allow?: readonly string[];
  /** Hosts reachable with GET, HEAD and OPTIONS only (e.g. a staging API that must not be written to). */
  readonly readOnly?: readonly string[];
  /** Path prefixes aborted even on allowed hosts (e.g. the app's own `/api/facebook` proxy). */
  readonly blockPaths?: readonly string[];
  /** Print each newly blocked host/path once, to tune the policy. */
  readonly log?: boolean;
}

const POLICY_ENV = 'IL_E2E_NETWORK_POLICY';
const ALWAYS_ALLOWED = ['localhost', '127.0.0.1'];
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Called by `defineConfig`; workers read it back through the environment. */
export function registerNetworkPolicy(policy: NetworkPolicy | false): void {
  process.env[POLICY_ENV] = JSON.stringify(policy);
}

function currentPolicy(): NetworkPolicy | false {
  const raw = process.env[POLICY_ENV];
  return raw === undefined ? {} : (JSON.parse(raw) as NetworkPolicy | false);
}

function hostMatches(hostname: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2);
    return hostname === base || hostname.endsWith(`.${base}`);
  }
  return hostname === pattern;
}

export function decide(policy: NetworkPolicy, url: string, method: string): 'continue' | 'abort' {
  if (url.startsWith('data:') || url.startsWith('blob:')) return 'continue';
  const { hostname, pathname } = new URL(url);
  if ((policy.blockPaths ?? []).some((prefix) => pathname.startsWith(prefix))) return 'abort';
  if ([...ALWAYS_ALLOWED, ...(policy.allow ?? [])].some((pattern) => hostMatches(hostname, pattern))) {
    return 'continue';
  }
  if ((policy.readOnly ?? []).some((pattern) => hostMatches(hostname, pattern))) {
    return READ_METHODS.has(method) ? 'continue' : 'abort';
  }
  return 'abort';
}

const reported = new Set<string>();

export function createRouteGuard(): ((route: WebRoute) => Promise<void>) | undefined {
  const policy = currentPolicy();
  if (policy === false) return undefined;
  return async (route) => {
    const { url, method } = route.request;
    if (decide(policy, url, method) === 'continue') return route.continue();
    if (policy.log) {
      const { hostname, pathname } = new URL(url);
      const key = `${method} ${hostname}${pathname.split('/').slice(0, 3).join('/')}`;
      if (!reported.has(key)) {
        reported.add(key);
        console.warn(`[il-e2e-agent] blocked ${key}`);
      }
    }
    return route.abort();
  };
}
