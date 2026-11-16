// CWE-601: a redirect target is on the same origin or on an allowlist.
import * as fc from 'fast-check';
import { show } from './cwe.ts';
import { securityLaw } from './law.ts';
import type { SecurityLaw } from './law.ts';

/** A hostile redirect target for a law parameter: `law safe(u: RedirectTarget) => redirects.holds(u)`. */
export type RedirectTarget = string & { readonly __tslawsRedirect: true };

const schemes = [
  '',
  '/',
  '//',
  '///',
  '////',
  '\\\\',
  '/\\',
  '\\/',
  'http:',
  'https:',
  'http://',
  'https://',
  'https:/',
  'http:\\\\',
  '//\t',
  '/\t/',
  ' //',
  '\t//',
  '\n//',
  '%2f%2f',
  '/%2f',
  '/%5c',
  '/./',
  '//.',
  'javascript:',
  'data:text/html,',
  'vbscript:',
];
const paths = ['', '/', '/home', '/login?next=/', '?x=1', '#frag', '/%2e%2e/x', '//x'];

/** Host names of the allowlist entries (a wildcard becomes a sample host) and lookalikes of them. */
function allowedHosts(allow: readonly string[]): string[] {
  return allow.flatMap((entry) => {
    const host = entry.includes('://') ? new URL(entry).hostname : entry.replace(/^\*\./, 'sub.');
    return [host, `${host}.evil.example`, `evil${host}`, host.replace(/^sub\./, '')];
  });
}

/** Hosts that look like `trusted` or hide an attacker's, for the trusted host name `trusted`. */
function hosts(trusted: string, allow: readonly string[] = []): string[] {
  return [
    ...allowedHosts(allow),
    'evil.example',
    'evil.example@',
    '@evil.example',
    `${trusted}@evil.example`,
    `${trusted}.evil.example`,
    `evil.example/.${trusted}`,
    `evil.example#.${trusted}`,
    `evil.example?.${trusted}`,
    `evil.example\\.${trusted}`,
    `evil.example%2f.${trusted}`,
    `evil.example:80@${trusted}`,
    `evil。example`,
    `${trusted}。evil.example`,
    '127.0.0.1',
    '[::1]',
    '0x7f.1',
    trusted,
    `evil${trusted}`,
    `${trusted}evil.example`,
  ];
}

/** The fixed attacks `holds` checks on every call, for the trusted host name. */
export function redirectCorpus(trusted: string, allow: readonly string[] = []): string[] {
  return [
    ...allowedHosts(allow).flatMap((host) => [`http://${host}`, `https://${host}`, `//${host}`]),
    '//evil.example',
    '///evil.example',
    '////evil.example',
    'https://evil.example',
    'https:evil.example',
    'https:/evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    'http:\\\\evil.example',
    '/%09/evil.example',
    '\t//evil.example',
    ' //evil.example',
    `//evil.example@${trusted}`,
    `https://${trusted}@evil.example`,
    `https://${trusted}.evil.example`,
    `https://evil.example#@${trusted}`,
    `https://evil.example\\@${trusted}`,
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
  ];
}

export function redirectTargets(trusted = 'app.example', allow: readonly string[] = []): fc.Arbitrary<RedirectTarget> {
  return fc
    .oneof(
      {
        weight: 8,
        arbitrary: fc
          .tuple(fc.constantFrom(...schemes), fc.constantFrom(...hosts(trusted, allow)), fc.constantFrom(...paths))
          .map(([scheme, host, path]) => scheme + host + path),
      },
      { weight: 1, arbitrary: fc.string() },
    )
    .map((u) => u as RedirectTarget);
}

export interface OpenRedirectOptions {
  /** The origin of the app, as in `https://app.example`. Relative targets resolve against it. */
  origin: string;
  /** Other places a redirect may go: host names (`accounts.example`, `*.example.org`) or origins (`https://pay.example`). */
  allow?: readonly string[];
}

function allowed(url: URL, origin: URL, allow: readonly string[]): boolean {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.origin === origin.origin) return true;
  return allow.some((entry) => {
    if (entry.includes('://')) return url.origin === new URL(entry).origin;
    if (entry.startsWith('*.')) return url.hostname.endsWith(entry.slice(1)) && url.hostname.length > entry.length - 1;
    return url.hostname === entry.toLowerCase();
  });
}

/**
 * CWE-601. `redirect(target)` returns the URL to redirect to. Read the way a browser reads a `Location` header (the
 * WHATWG URL rules: backslashes, tabs, `//host` and the like), it must be on `origin` or on the allowlist, or the
 * function must refuse by throwing or returning nothing.
 */
export function openRedirect(
  redirect: (target: string) => unknown,
  options: OpenRedirectOptions,
): SecurityLaw<RedirectTarget> {
  const origin = new URL(options.origin);
  const allow = options.allow ?? [];
  return securityLaw<RedirectTarget>({
    id: 'open-redirect',
    cwe: ['CWE-601'],
    title: 'a redirect target is same-origin or on the allowlist',
    input: redirectTargets(origin.hostname, allow),
    corpus: redirectCorpus(origin.hostname, allow) as RedirectTarget[],
    verdict: (input) => {
      let result: unknown;
      try {
        result = redirect(input);
      } catch {
        return undefined;
      }
      if (result === undefined || result === null || result === false) return undefined;
      const text = String(result);
      let url: URL;
      try {
        url = new URL(text, origin);
      } catch {
        return undefined;
      }
      return allowed(url, origin, allow)
        ? undefined
        : {
            detail: `redirect(${show(input)}) returned ${show(text)}, which goes to ${url.origin} (allowed: ${[origin.origin, ...allow].join(', ')})`,
          };
    },
  });
}
