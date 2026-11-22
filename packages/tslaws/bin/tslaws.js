#!/usr/bin/env node
import { main } from '../dist/cli.js';

// Let the process end by itself once `main` returns: every worker the CLI starts is unref'd. `process.exit()` skips
// the teardown of the JavaScript engine, and it can deadlock: it joins V8's background threads first, and a thread
// that is compiling code and needs a garbage collection waits for the main thread, which is now waiting for it. The
// report is already printed and the process never ends. Ending by itself tears the engine down properly.
process.exitCode = await main(process.argv.slice(2));

// Only if a handle somewhere would still hold the process open after that: end it anyway, a few seconds later.
setTimeout(() => process.exit(), 5000).unref();
