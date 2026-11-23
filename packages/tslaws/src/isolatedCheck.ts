// The child that `checkIsolated` (isolate.ts) starts: runs one check with the environment it was given, which holds no
// credentials, and sends the report back to the parent. It never talks to GitHub.
import { check } from './check.ts';
import { configureJobs } from './pool.ts';
import type { ChildRequest } from './isolate.ts';

process.once('message', async (request: ChildRequest) => {
  let reply: { report: unknown } | { error: string };
  try {
    configureJobs({ flag: request.jobs });
    reply = { report: await check(request.options, request.enforceLock) };
  } catch (error) {
    reply = { error: error instanceof Error ? error.message : String(error) };
  }
  // Z3's worker threads would keep the process alive, so leave once the reply is on its way.
  process.send!(reply, () => process.exit(0));
});
