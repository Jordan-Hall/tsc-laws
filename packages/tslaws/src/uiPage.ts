import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ui/index.html sits one level above both src/ and dist/.
export const page = readFileSync(fileURLToPath(new URL('../ui/index.html', import.meta.url)), 'utf8');
