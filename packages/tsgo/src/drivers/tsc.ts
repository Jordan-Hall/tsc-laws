// Runs the translated tsc command line. Usage: tsc [tsc options] [files]
import * as checkhost from '../tsgo/checkhost.js';
import * as classes from '../tsgo/classes.js';
import { initDone, keepClasses, fromHostString } from '../go/base.js';
import { initHost } from './host.js';

// Lets scriptc lower every class before use; never runs.
if (keepClasses()) classes.keepAll();
initDone();

const host = new checkhost.Host();
initHost(host);
const args = process.argv.slice(2).map(fromHostString);
const status = checkhost.RunTSC(host, args);
process.exit(status);
