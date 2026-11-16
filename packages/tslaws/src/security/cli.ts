// `tslaws security deps [--offline] [--fail-on LEVEL] [--no-cache] [--json]`
import { readConfig } from '../coverage.ts';
import { parseSecurityConfig } from './deps/config.ts';
import { checkDeps, renderDeps } from './deps/run.ts';
import type { FetchLike } from './deps/osv.ts';
import { parseSeverity } from './deps/severity.ts';

export const securityUsage = `tslaws security deps [--offline] [--fail-on low|moderate|high|critical] [--no-cache] [--json]   check the npm packages the covered code imports against OSV (sends package names and versions only; exit 1 when an advisory is at or above security.failOn, default high)`;

/** Exit status: 0 passed, 1 an advisory at or above the threshold, 2 the check could not run. */
export async function securityCommand(
  cwd: string,
  args: string[],
  flags: Map<string, string | true>,
  write: (text: string) => void,
  fetch?: FetchLike,
): Promise<number> {
  if (args[0] !== 'deps') {
    write(`${securityUsage}\n`);
    return 2;
  }
  try {
    const config = readConfig(cwd);
    const security = parseSecurityConfig(config.security);
    const flag = flags.get('fail-on');
    const failOn = flag === undefined ? undefined : parseSeverity(flag);
    if (flag !== undefined && (failOn === undefined || failOn === 'unknown'))
      throw new Error(`--fail-on must be low, moderate, high or critical, got ${String(flag)}`);
    const report = await checkDeps({
      cwd,
      cover: config.cover,
      config: security,
      failOn: failOn as typeof security.failOn | undefined,
      offline: flags.has('offline') ? true : undefined,
      noCache: flags.has('no-cache'),
      fetch,
    });
    write(flags.has('json') ? `${JSON.stringify(report, null, 2)}\n` : renderDeps(report));
    return report.failed ? 1 : 0;
  } catch (error) {
    write(
      `security deps: ${error instanceof Error ? error.message : String(error)}\nUse --offline to check from the cache (.tslaws/osv-cache.json) without the network.\n`,
    );
    return 2;
  }
}
