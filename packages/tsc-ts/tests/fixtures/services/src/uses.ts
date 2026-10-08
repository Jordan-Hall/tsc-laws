import Lib = require('./umd');
import * as cjs from './cjs.js';
import UmdDefault from './umd';

const instance: Lib.Instance = Lib.create();
instance.run();
const version = Lib.version + UmdDefault.version + cjs.count;
const dynamic = import('./helpers.ts').then((m) => m.helper() + m.default());
export { version, dynamic };
