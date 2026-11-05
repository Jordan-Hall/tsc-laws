'use strict';

// "Write a law for this function": the text of a first, proposed law for an exported function. It goes in a
// `*.proposed.laws.ts` file beside the source, never in an accepted laws file and never in the lock; a person reads it,
// runs `tslaws check --proposed` and promotes it. Pure.

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `src/cart.ts` gives `src/cart.proposed.laws.ts`. Null for anything that is not a plain TypeScript source file. */
function proposedPath(rel) {
  const m = /^(.*?)\.[cm]?ts$/.exec(rel);
  if (m === null || /\.(?:d|laws|proposed|browser|e2e)$/.test(m[1])) return null;
  return `${m[1]}.proposed.laws.ts`;
}

/** The text between the bracket that opens at `text[at]` and its partner, or null when it never closes. */
function balanced(text, at) {
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    const c = text[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c) && --depth === 0) return text.slice(at + 1, i);
  }
  return null;
}

/** Splits a parameter list at its top-level commas, counting `<>` as brackets (but not the `>` of `=>`). */
function splitTop(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if ('([{<'.includes(ch)) depth++;
    else if (')]}'.includes(ch) || (ch === '>' && text[i - 1] !== '=')) depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else current += ch;
  }
  if (current.trim() !== '') parts.push(current.trim());
  return parts;
}

/** The parameter list of function `name` in `text`, as `[{name, type}]`; null when it is not a function declaration. */
function parametersOf(text, name) {
  const word = escapeRegExp(name);
  const decl = new RegExp(
    `(?:\\bfunction\\s*\\*?\\s+${word}\\s*(?:<[^(]*>)?\\s*\\(|\\b(?:const|let|var)\\s+${word}\\s*(?::[^=]+)?=\\s*(?:async\\s+)?(?:<[^(]*>)?\\s*\\()`,
  );
  const m = decl.exec(text);
  if (m === null) return null;
  const inside = balanced(text, m.index + m[0].length - 1);
  if (inside === null) return null;
  const parts = splitTop(inside);
  return parts.map((p, i) => {
    const plain = /^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)\s*\??\s*(?::\s*([\s\S]+?))?\s*(?:=[\s\S]*)?$/.exec(p);
    if (plain !== null) return { name: plain[1], type: plain[2]?.trim() ?? 'unknown' };
    const typed = /:\s*([\s\S]+?)\s*(?:=[\s\S]*)?$/.exec(p);
    return { name: `arg${i + 1}`, type: typed?.[1] ?? 'unknown' };
  });
}

/**
 * @param {{name: string, sourceRel: string, sourceText: string}} o
 * @returns {string} the law, with the import it needs
 */
function lawSkeleton({ name, sourceRel, sourceText }) {
  const params = parametersOf(sourceText, name) ?? [];
  const base = sourceRel.replace(/^.*\//, '').replace(/\.[cm]?ts$/, '');
  const list = params.map((p) => `${p.name}: ${p.type}`).join(', ');
  const args = params.map((p) => p.name).join(', ');
  return [
    `import { ${name} } from './${base}';`,
    '',
    `// A first claim about ${name}. Replace it with what must hold for every input, run \`npx tslaws check --proposed\`,`,
    '// and, once you are happy with it, move it into the accepted laws file yourself.',
    `export law ${name}Holds(${list}) {`,
    `  const result = ${name}(${args});`,
    '  return result === result;',
    '}',
    '',
  ].join('\n');
}

/**
 * Adds the law to the proposed file's text, which may be empty: a law of that name already there is left as it is.
 * @returns {{text: string, added: boolean}}
 */
function addToProposed(existing, name, skeleton) {
  const declared = new RegExp(`\\blaw\\s+(?:proved\\s+)?${escapeRegExp(`${name}Holds`)}\\s*[(<]`);
  if (declared.test(existing)) return { text: existing, added: false };
  if (existing.trim() === '') return { text: skeleton, added: true };
  // The import line of a second function goes with its law; an import already there is not repeated.
  const [importLine, ...rest] = skeleton.split('\n');
  const body = existing.includes(importLine) ? rest.join('\n').replace(/^\n/, '') : skeleton;
  return { text: `${existing.replace(/\s*$/, '')}\n\n${body}`, added: true };
}

module.exports = { proposedPath, parametersOf, lawSkeleton, addToProposed };
