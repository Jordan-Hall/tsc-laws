// Test case properties shared by the translated checker's tests and corpus.
import { readFileSync } from 'node:fs';

// Whether the check oracle checks a case as JavaScript: every @filename unit is JavaScript and it
// sets @checkJs. The translated checker only checks TypeScript.
export function isCheckedJs(file) {
  let units = 0;
  let checkJs = false;
  for (const [, name, value] of readFileSync(file, 'utf8').matchAll(/^[ \t]*\/\/[ \t]*@(\w+)[ \t]*:([^\r\n]*)/gim)) {
    if (name.toLowerCase() === 'filename') {
      if (!/\.(js|jsx|cjs|mjs)$/i.test(value.trim())) return false;
      units++;
    } else if (name.toLowerCase() === 'checkjs') checkJs = value.split(',')[0].trim().toLowerCase() === 'true';
  }
  return units > 0 && checkJs;
}
