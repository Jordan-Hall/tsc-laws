# Security laws

`tslaws/security` is a pack of laws tagged with a [CWE](https://cwe.mitre.org) id. Each builder takes one of your own
functions (a path sanitiser, an HTML escaper, a merge) and returns a law about it. A failing law names the CWE in its
message, so the tag appears in the text, JUnit and GitHub reporters.

`tslaws security deps` is a separate check. It looks up the npm packages your covered code imports in
[OSV](https://osv.dev) and fails on known advisories.

These are laws about stated properties. They are not a scanner. See [Limits](#limits).

## The builders

| CWE          | Builder                                 | The law                                                                                           |
| ------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| CWE-22       | `pathTraversal(sanitise, { base })`     | The returned path, resolved against `base`, stays inside it. Rejecting the input is safe.         |
| CWE-79       | `htmlEscaping(escape, { context })`     | The output holds no unescaped `<`, `"`, `'` or `` ` `` (what the context needs).                  |
| CWE-1321     | `prototypeSafeMerge(merge)`             | `merge(target, source)` with `__proto__` or `constructor.prototype` keys leaves prototypes alone. |
| CWE-1321     | `prototypeSafeSet(set)`                 | The same for `set(target, path, value)`, dotted or array paths.                                   |
| CWE-1321     | `prototypeSafeParse(parse)`             | The same for `parse(text)` that builds objects.                                                   |
| CWE-400/1333 | `redos(fn, { budgetMs, maxLength })`    | `fn` returns within the time budget on adversarial inputs of growing length.                      |
| CWE-20       | `inputValidation(validator, predicate)` | Everything the validator accepts satisfies the predicate (accepted set is a subset).              |
| CWE-190/681  | `safeArithmetic(op, { exact })`         | The helper returns the exact result, or refuses; it never rounds, wraps or truncates.             |
| CWE-601      | `openRedirect(redirect, { origin })`    | The redirect target is on `origin` or on the allowlist, read as a browser reads it.               |

Every builder returns a `SecurityLaw` with:

- `holds(input)`: use it as a law body. It checks a fixed corpus of known attacks first, then the input, and throws a
  `CweViolation` (`[CWE-22] sanitise("../x") returned ...`) or returns `true`.
- `run({ runs, seed })` and `assert({ runs, seed })`: run the law in a plain test, with no compiler involved.
- `cwe`, `id` and `title`.

## Usage in a law file

A parameter typed with one of the payload types (`PathPayload`, `HtmlPayload`, `PollutionPayload`, `PollutionPath`,
`UntrustedInput`, `RedosAttack`, `IntPair`, `RedirectTarget`) is generated from the adversarial inputs of that builder.
Loading `tslaws/security` registers them.

```ts
// sanitise.laws.ts
import { htmlEscaping, pathTraversal } from 'tslaws/security';
import type { HtmlPayload, PathPayload } from 'tslaws/security';
import { escapeHtml } from './escape';
import { safePath } from './files';

const traversal = pathTraversal(safePath, { base: '/srv/files' });
const escaping = htmlEscaping(escapeHtml, { context: 'attribute' });

export law staysInsideBase(p: PathPayload) => traversal.holds(p);
export law escapesAttributes(s: HtmlPayload) => escaping.holds(s);
```

Without the compiler, in any test runner:

```ts
import { pathTraversal } from 'tslaws/security';

pathTraversal(safePath, { base: '/srv/files' }).assert();
```

### CWE-22: path traversal

```ts
pathTraversal(sanitise, { base: '/srv/files', flavour: 'both', checkDecoded: false });
```

`sanitise(input)` returns a path (relative to `base` or absolute), or throws, or returns nothing to refuse. Payloads
mix `../`, encoded and double-encoded dots, absolute roots, drive letters, UNC shares, null bytes and Windows
separators. `flavour` is `both` by default, because the same string reaches POSIX and Windows. A null byte in the
result fails.

Caught: `p.replace('../', '')` (`....//` survives). Passes: resolve against the base and compare.

### CWE-79: HTML escaping

```ts
htmlEscaping(escape, { context: 'html' | 'attribute' | 'unquoted-attribute' });
```

`attribute` is the default and forbids `<`, `"`, `'` and `` ` `` in the output. `html` (text content) forbids `<`. The
output must be a string.

Caught: `s.replace('<', '&lt;')` (replaces the first only, ignores quotes). Passes: escape `& < > " ' `` ` `` everywhere.

### CWE-1321: prototype pollution

```ts
prototypeSafeMerge(merge);
prototypeSafeSet(set, { pathFormat: 'dotted' | 'array' });
prototypeSafeParse(parse);
```

The payloads are `__proto__`, `constructor.prototype` and `prototype` keys, nested and in JSON text. The law
snapshots `Object.prototype`, `Array.prototype` and `Function.prototype` before each call, restores them after, and
fails when a call changed them or added the marker `tslawsPolluted`. A function may skip the key, refuse by throwing,
or copy it as an own property.

### CWE-400 and CWE-1333: time budget and ReDoS

```ts
redos((input) => emailPattern.test(input), { budgetMs: 100, maxLength: 20000 });
```

Inputs grow along a length ladder from attack shapes (`aaaa...!`, nested quantifier bait, whitespace runs, long
repeats). The law stops at the first call over `budgetMs` and reports its length. The function must be synchronous.
Pick a budget well above normal run time, since timing is noisy.

### CWE-20: input validation

```ts
inputValidation(isPort, (s) => /^(0|[1-9]\d{0,4})$/.test(s) && Number(s) <= 65535, { seeds: ['80', '8080'] });
```

You state the predicate: what a valid input is. Every input the validator accepts must satisfy it. The validator may
accept less. `seeds` are valid examples; the law also tries their mutations (trailing newline, null byte, padding, other
scripts' digits). For validators over other types, pass `{ input: fc.integer() }` (a fast-check arbitrary).

Caught: an unanchored `/\d+/`. A throw from the validator counts as a refusal.

### CWE-190 and CWE-681: integers

```ts
safeArithmetic(add, { exact: 'add', overflow: 'refuse', unsafeInputs: false });
```

The law compares the helper to the exact bigint result. `exact` is `add`, `sub`, `mul`, or your own function on
bigints. Where the exact result is not a safe integer, the helper must throw or return `NaN`, `null` or `undefined`
(`overflow: 'refuse'`), or may return the signed safe-integer limit (`'saturate'`). A wrapping 32-bit result or a
rounded sum fails as CWE-190. With `unsafeInputs: true` it also feeds values above 2^53, fractions, `NaN` and
`Infinity`, and the helper must refuse them (CWE-681).

### CWE-601: open redirect

```ts
openRedirect(redirect, { origin: 'https://app.example', allow: ['accounts.example', '*.pay.example'] });
```

`redirect(target)` returns the URL to redirect to, or refuses. The result is resolved with the WHATWG `URL` rules (the
ones a browser applies to `Location`: backslashes, tabs, `//host`, `user@host`). It must be on `origin` or the
allowlist (a host name, `*.suffix`, or an origin). Only `http:` and `https:` pass.

Caught: `target.startsWith('/')` (`//evil.example`). Passes: build a `URL` and compare origins.

## The OSV check of dependencies

```sh
tslaws security deps [--offline] [--fail-on low|moderate|high|critical] [--no-cache] [--json]
```

1. Collects the npm packages imported by the files under `cover` in `tslaws.json` (type-only imports, relative paths,
   Node built-ins and `node:` and URL specifiers are skipped).
2. Resolves each to `name@version` from the nearest lockfile (`package-lock.json`, `npm-shrinkwrap.json`,
   `pnpm-lock.yaml`, `yarn.lock` or `bun.lock`), searching upward from the project, and from `node_modules` when there is
   no lockfile. If a lockfile holds several versions of a package, all are checked.
3. Asks `https://api.osv.dev/v1/querybatch`, then reads each advisory from `/v1/vulns/{id}` for its severity, aliases and
   fixed versions.
4. Prints each advisory with its GHSA and CVE ids and the versions that fix it. It exits 1 when one is at or above
   `security.failOn`.

Exit codes: 0 passed, 1 an advisory at or above the threshold, 2 the check could not run (network down, bad option).

What is sent: package names, versions and the ecosystem `npm`, and advisory ids to read. Never source code, file
paths, the repository name or the project's own package name. Workspace-linked packages and private packages are not
sent either.

Severity comes from the advisory's `database_specific.severity`, else a CVSS v3 base score computed from its vector,
else `critical` for `MAL-` (malicious package) ids, else `unknown`. An `unknown` advisory is listed and never fails.

### Configuration

```json
{
  "cover": ["src/**/*.ts"],
  "security": {
    "failOn": "high",
    "offline": false,
    "cache": true,
    "cacheTtlHours": 24,
    "ignore": ["GHSA-xxxx-xxxx-xxxx"]
  }
}
```

| Option          | Default | Meaning                                                                                   |
| --------------- | ------- | ----------------------------------------------------------------------------------------- |
| `failOn`        | `high`  | Lowest severity that fails: `low`, `moderate`, `high`, `critical`. `--fail-on` overrides. |
| `offline`       | `false` | Never touch the network; answer from the cache. `--offline` sets it.                      |
| `cache`         | `true`  | Keep answers in `.tslaws/osv-cache.json`. `--no-cache` skips it for one run.              |
| `cacheTtlHours` | `24`    | How long a cached answer stays fresh when online. Offline runs accept any age.            |
| `ignore`        | `[]`    | Advisory ids (GHSA, CVE or OSV) a person has reviewed. Listed as `ignored`, never fail.   |

Offline with an empty or partial cache lists the packages it could not check, and does not fail for them. Add
`.tslaws/` to `.gitignore`, or commit the cache to share answers with an air-gapped CI.

## Limits

- The laws check the properties stated here, on generated and fixed inputs. A pass is not a proof, and not a
  vulnerability scan. Use a scanner and a review for the rest.
- A builder knows nothing about how your function is called. A sanitiser that is correct and then used wrongly is not
  caught.
- The ReDoS law measures wall-clock time of a synchronous call. It can miss an attack shape it does not generate, and
  a loaded machine can push a fast function over the budget.
- CWE-79 checks the characters in the output, not the whole page. Context-sensitive sinks (script blocks, URLs, CSS)
  need their own laws.
- CWE-190 and CWE-681 cover arithmetic helpers through `safeArithmetic`. Other conversions are not covered.
- The OSV check covers packages the covered code imports and the versions in the lockfile. It does not read
  transitive dependencies, and it cannot resolve a path alias or an uninstalled package (those are listed as not
  checked). Records that only have a CVSS v4 vector have an `unknown` severity.
- The check needs a lockfile or `node_modules`, and the OSV database is only as current as its last update.
