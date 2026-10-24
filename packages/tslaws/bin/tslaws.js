#!/usr/bin/env node
import { main } from '../dist/cli.js';

// Z3's worker threads would keep the process alive.
process.exit(await main(process.argv.slice(2)));
