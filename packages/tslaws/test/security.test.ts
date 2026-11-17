// Each builder of tslaws/security catches a known vulnerable implementation and passes a fixed one.
import assert from 'node:assert/strict';
import { posix } from 'node:path';
import { describe, it } from 'node:test';
import {
  CweViolation,
  htmlEscaping,
  inputValidation,
  openRedirect,
  pathTraversal,
  prototypeSafeMerge,
  prototypeSafeParse,
  prototypeSafeSet,
  redos,
  safeArithmetic,
} from '../dist/security/index.js';
import type { SecurityLaw } from '../dist/security/index.js';

const opts = { runs: 300, seed: 7 };

/** The law fails on `bad` with the tag, and holds on `good`. */
function catches<I>(law: (impl: 'bad' | 'good') => SecurityLaw<I>, tag: string): void {
  const bad = law('bad').run(opts);
  assert.equal(bad.ok, false, 'the vulnerable implementation must fail');
  assert.ok(bad.message?.startsWith(`[${tag}]`), `message ${bad.message} must start with [${tag}]`);
  assert.ok(bad.counterexample !== undefined);
  assert.throws(
    () => law('bad').assert(opts),
    (e: unknown) => e instanceof CweViolation && e.message.startsWith(`[${tag}]`),
  );
  const good = law('good').run(opts);
  assert.equal(good.ok, true, `the fixed implementation must pass: ${good.message}`);
}

describe('CWE-22 path traversal', () => {
  const base = '/srv/files';
  const naive = (p: string): string => posix.join(base, p.replace('../', ''));
  const fixed = (p: string): string => {
    if (p.includes('\0')) throw new Error('null byte');
    const full = posix.resolve(base, p.replaceAll('\\', '/'));
    if (!full.startsWith(`${posix.resolve(base)}/`) && full !== posix.resolve(base)) throw new Error('outside');
    return full;
  };
  it('catches a replace-once sanitiser and passes a resolving one', () => {
    catches((impl) => pathTraversal(impl === 'bad' ? naive : fixed, { base, flavour: 'posix' }), 'CWE-22');
  });
  it('catches a sanitiser that only checks for a prefix, and a null byte', () => {
    const prefixOnly = (p: string): string => (p.startsWith('/') ? p : `${base}/${p}`);
    assert.equal(pathTraversal(prefixOnly, { base, flavour: 'posix' }).run(opts).ok, false);
    const nul = pathTraversal((p) => `${base}/${p.replaceAll('..', '')}`, { base, flavour: 'posix' }).run(opts);
    assert.equal(nul.ok, false);
  });
  it('reads the result under Windows rules too: a drive letter passes posix and fails both', () => {
    const noDots = (p: string): string | undefined =>
      p.includes('..') || p.includes('\0') ? undefined : p.replace(/^\/+/, '');
    assert.equal(pathTraversal(noDots, { base, flavour: 'posix' }).run(opts).ok, true);
    const both = pathTraversal(noDots, { base, flavour: 'both' }).run(opts);
    assert.equal(both.ok, false);
    assert.match(both.message ?? '', /under win32 rules/);
  });
  it('holds() throws a tagged violation for use as a law body', () => {
    const law = pathTraversal(naive, { base, flavour: 'posix' });
    assert.throws(() => law.holds('x' as never), /^CweViolation: \[CWE-22\] sanitise\(/);
    assert.equal(pathTraversal(fixed, { base, flavour: 'posix' }).holds('a/b' as never), true);
  });
});

describe('CWE-79 HTML escaping', () => {
  const lt = (s: string): string => s.replace('<', '&lt;');
  const textOnly = (s: string): string => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const full = (s: string): string =>
    s
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
      .replaceAll('`', '&#96;');
  it('catches replace-once escaping and passes a full escaper', () => {
    catches((impl) => htmlEscaping(impl === 'bad' ? lt : full), 'CWE-79');
  });
  it('depends on the context: a text-only escaper passes for html and fails for attributes', () => {
    assert.equal(htmlEscaping(textOnly, { context: 'html' }).run(opts).ok, true);
    const attribute = htmlEscaping(textOnly, { context: 'attribute' }).run(opts);
    assert.equal(attribute.ok, false);
    assert.match(attribute.message ?? '', /unescaped "\\""|unescaped "'"|unescaped "`"/);
  });
  it('rejects an escaper that returns something other than a string', () => {
    assert.equal(htmlEscaping(() => 42).run(opts).ok, false);
  });
});

describe('CWE-1321 prototype pollution', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vulnerableMerge = (target: any, source: any): any => {
    for (const key in source) {
      if (source[key] !== null && typeof source[key] === 'object') {
        if (target[key] === undefined) target[key] = Array.isArray(source[key]) ? [] : {};
        vulnerableMerge(target[key], source[key]);
      } else target[key] = source[key];
    }
    return target;
  };
  const safeMerge = (target: any, source: any): any => {
    for (const key of Object.keys(source)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      if (source[key] !== null && typeof source[key] === 'object') {
        if (!Object.hasOwn(target, key)) target[key] = Array.isArray(source[key]) ? [] : {};
        safeMerge(target[key], source[key]);
      } else target[key] = source[key];
    }
    return target;
  };
  const vulnerableSet = (target: any, path: string, value: unknown): void => {
    const keys = path.split('.');
    let node = target;
    for (const key of keys.slice(0, -1)) node = node[key] ??= {};
    node[keys.at(-1)!] = value;
  };
  const safeSet = (target: any, path: string, value: unknown): void => {
    const keys = path.split('.');
    if (keys.some((k) => k === '__proto__' || k === 'constructor' || k === 'prototype')) throw new Error('refused');
    vulnerableSet(target, path, value);
  };
  it('catches a recursive merge and passes one that skips prototype keys', () => {
    catches((impl) => prototypeSafeMerge(impl === 'bad' ? vulnerableMerge : safeMerge), 'CWE-1321');
  });
  it('catches a path setter and passes a guarded one', () => {
    catches((impl) => prototypeSafeSet(impl === 'bad' ? vulnerableSet : safeSet), 'CWE-1321');
  });
  it('catches a parser that merges into a plain object and passes JSON.parse', () => {
    catches(
      (impl) => prototypeSafeParse(impl === 'bad' ? (t) => vulnerableMerge({}, JSON.parse(t)) : (t) => JSON.parse(t)),
      'CWE-1321',
    );
  });
  it('leaves the prototypes as it found them after a polluting run', () => {
    prototypeSafeMerge(vulnerableMerge).run(opts);
    assert.equal(({} as Record<string, unknown>).tslawsPolluted, undefined);
    assert.equal(Object.hasOwn(Object.prototype, 'tslawsPolluted'), false);
  });
  it('accepts array paths', () => {
    const arraySet = (target: any, path: string[], value: unknown): void =>
      vulnerableSet(target, path.join('.'), value);
    assert.equal(prototypeSafeSet(arraySet, { pathFormat: 'array' }).run(opts).ok, false);
  });
});

describe('CWE-400/1333 ReDoS', () => {
  it('catches nested quantifiers and passes a linear pattern', () => {
    catches(
      (impl) => redos(impl === 'bad' ? (s) => /^(a+)+$/.test(s) : (s) => /^a+$/.test(s), { budgetMs: 50 }),
      'CWE-400/CWE-1333',
    );
  });
  it('catches a quadratic pattern on a long input', () => {
    const quadratic = (s: string): boolean => /^(\s*a)*\s*$/.test(s) || /(\s+)$/.test(s);
    const outcome = redos(quadratic, { budgetMs: 20, maxLength: 60000 }).run({ runs: 40, seed: 3 });
    assert.equal(outcome.ok, false);
  });
  it('names the length and the attack in the message', () => {
    const outcome = redos((s) => /^(a+)+$/.test(s), { budgetMs: 50 }).run(opts);
    assert.match(outcome.message ?? '', /took \d+ ms \(budget 50 ms\) on \d+ characters/);
  });
});

describe('CWE-20 input validation', () => {
  const isPort = (s: string): boolean => /^(0|[1-9]\d{0,4})$/.test(s) && Number(s) <= 65535;
  it('catches an unanchored pattern and passes an anchored one', () => {
    catches(
      (impl) =>
        inputValidation(
          impl === 'bad' ? (s) => /\d+/.test(s) : (s) => /^(0|[1-9][0-9]{0,4})$/.test(s) && Number(s) <= 65535,
          isPort,
          { seeds: ['80', '8080', '65535'] },
        ),
      'CWE-20',
    );
  });
  it('catches a validator that lets a trailing newline through, using seed mutations', () => {
    const outcome = inputValidation(
      (s) => /^\d+\s*$/.test(s),
      (s) => /^\d+$/.test(s),
      { seeds: ['42'] },
    ).run(opts);
    assert.equal(outcome.ok, false);
  });
  it('takes any type with an input generator', async () => {
    const fc = await import('fast-check');
    const law = inputValidation<number>(
      (n) => n > 0,
      (n) => n > 10,
      { input: fc.integer({ min: -5, max: 50 }) },
    );
    assert.equal(law.run(opts).ok, false);
    assert.equal(
      inputValidation<number>(
        (n) => n > 20,
        (n) => n > 10,
        { input: fc.integer({ min: -5, max: 50 }) },
      ).run(opts).ok,
      true,
    );
  });
});

describe('CWE-190/681 integers', () => {
  const unchecked = (a: number, b: number): number => a + b;
  const checkedAdd = (a: number, b: number): number => {
    const r = a + b;
    if (!Number.isSafeInteger(r)) throw new RangeError('overflow');
    return r;
  };
  it('catches an add that rounds past 2^53 and passes a checked one', () => {
    catches((impl) => safeArithmetic(impl === 'bad' ? unchecked : checkedAdd, { exact: 'add' }), 'CWE-190');
  });
  it('catches a multiply that overflows, and a wrapping 32-bit multiply', () => {
    assert.equal(safeArithmetic((a, b) => a * b, { exact: 'mul' }).run(opts).ok, false);
    assert.equal(safeArithmetic((a, b) => Math.imul(a, b), { exact: 'mul' }).run(opts).ok, false);
    const checked = (a: number, b: number): number => {
      const r = a * b;
      if (!Number.isSafeInteger(r)) throw new RangeError('overflow');
      return r;
    };
    assert.equal(safeArithmetic(checked, { exact: 'mul' }).run(opts).ok, true);
  });
  it('accepts saturation only when allowed', () => {
    const saturating = (a: number, b: number): number =>
      Math.max(-Number.MAX_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, a + b));
    assert.equal(safeArithmetic(saturating, { exact: 'add' }).run(opts).ok, false);
    assert.equal(safeArithmetic(saturating, { exact: 'add', overflow: 'saturate' }).run(opts).ok, true);
    const clampsLow = (a: number, b: number): number => Math.max(-1000, a + b);
    assert.equal(
      safeArithmetic(clampsLow, { exact: 'add', overflow: 'saturate' }).run(opts).ok,
      false,
      'clamping to a small limit is a wrong result',
    );
  });
  it('tags CWE-681 when an unsafe operand is accepted', () => {
    const outcome = safeArithmetic(checkedAdd, { exact: 'add', unsafeInputs: true }).run(opts);
    assert.equal(outcome.ok, false);
    assert.match(outcome.message ?? '', /^\[CWE-681\]/);
    const strict = (a: number, b: number): number => {
      if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) throw new TypeError('not a safe integer');
      return checkedAdd(a, b);
    };
    assert.equal(safeArithmetic(strict, { exact: 'add', unsafeInputs: true }).run(opts).ok, true);
  });
  it('takes a custom exact operation', () => {
    const law = safeArithmetic(() => Number.MAX_SAFE_INTEGER, { exact: () => BigInt(Number.MAX_SAFE_INTEGER) });
    assert.equal(law.run(opts).ok, true);
  });
});

describe('CWE-601 open redirect', () => {
  const origin = 'https://app.example';
  const startsWithSlash = (t: string): string | undefined => (t.startsWith('/') ? t : undefined);
  const safe = (t: string): string | undefined => {
    let url: URL;
    try {
      url = new URL(t, origin);
    } catch {
      return undefined;
    }
    return url.origin === origin ? url.href : undefined;
  };
  it('catches a leading-slash check and passes an origin comparison', () => {
    catches((impl) => openRedirect(impl === 'bad' ? startsWithSlash : safe, { origin }), 'CWE-601');
  });
  it('catches a host check by substring, and an allowlist check by suffix', () => {
    assert.equal(openRedirect((t) => (t.includes('app.example') ? t : undefined), { origin }).run(opts).ok, false);
    const suffix = (t: string): string | undefined => {
      try {
        return new URL(t, origin).hostname.endsWith('example') ? t : undefined;
      } catch {
        return undefined;
      }
    };
    assert.equal(openRedirect(suffix, { origin, allow: ['accounts.example'] }).run(opts).ok, false);
  });
  it('lets the allowlist through, by host, origin and wildcard', () => {
    const allowOnly = (t: string): string | undefined => {
      try {
        const url = new URL(t, origin);
        return url.origin === origin ||
          url.hostname === 'accounts.example' ||
          (url.hostname.endsWith('.pay.example') && url.hostname.length > '.pay.example'.length)
          ? url.href
          : undefined;
      } catch {
        return undefined;
      }
    };
    assert.equal(openRedirect(allowOnly, { origin, allow: ['accounts.example', '*.pay.example'] }).run(opts).ok, true);
    assert.equal(openRedirect(allowOnly, { origin, allow: ['https://accounts.example'] }).run(opts).ok, false);
  });
  it('rejects a javascript: target', () => {
    assert.equal(openRedirect(() => 'javascript:alert(1)', { origin }).run(opts).ok, false);
  });
});
