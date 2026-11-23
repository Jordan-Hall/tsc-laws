# Proof certificates

Z3 says a law is proved when the negated law is `unsat`. That answer is a claim, and you trust Z3 to be right. A
certificate lets a second program check it: cvc5 proves the same query again and writes the proof in the
[Alethe](https://verit.loria.fr/documentation/alethe-spec.pdf) format, and [Carcara](https://github.com/ufmg-smite/carcara),
a small independent proof checker, checks that proof step by step.

The [certificate gallery](certificates/README.md) shows real ones: each law of the demo project with its source, lock hashes,
loop invariants, a proof excerpt, the full problem and proof files, and the Carcara command that checks them.

## What it guarantees

A law with the status `certified` has an `unsat` proof that Carcara accepted for the SMT-LIB problem `tslaws` built from the
law. It does not extend the proof: the law still stands on the same assumptions (shown as `assuming: ...`), and a
`bounded` proof stays `bounded` (its certificate covers the bounded query).

It does not cover:

- the translation from your TypeScript to SMT-LIB (`symbolic.ts`); cvc5 and Carcara read the problem as it is
- Carcara and cvc5 themselves, though a proof is far smaller to trust than a solver run
- laws whose query uses floating point (`number`) or strings. Alethe has no rules for them, so those laws are
  `uncertified (the law uses floating-point numbers ...)`. Laws over `int`, `bigint` and `boolean` are the
  ones that can be certified, subject to what cvc5 can prove in Alethe: if cvc5 prints no proof, the law is
  `uncertified (cvc5 gave no Alethe proof (...))`.

## Laws about loops

A loop with no written `invariant(...)` is proved by finding one: Z3's Spacer engine solves the loop's Horn clauses and
returns an invariant `Inv`, and Z3 checks that answer again (see [Laws](laws.md)). Spacer is not asked to be right; the
certificate checks the invariant instead of trusting it:

1. `tslaws` puts the invariant in place of `Inv` in every clause (entry, one pass of the body, and the loop's exit
   implying the law, with the obligations of the body) and joins them in one problem that asks whether some clause fails
   for some values. That problem has no quantifier and no unknown predicate.
2. cvc5 answers `unsat` and writes an Alethe proof of it, and Carcara checks the proof, as for any other law.

`unsat` means every clause holds for every value, so `Inv` is true on entry, kept by every pass and enough for the law. That
holds for any `Inv`, so nothing depends on how Spacer found it. The result reads `certificate: certified` beside the
`loop 1 invariant over (...)` line. The Horn clauses are the translation from your code, which a certificate never covers,
and the same limits as above apply (integers and booleans only, and no `mod`).

The invariant can differ from run to run, so the record cannot bind to the problem as the other laws do. It binds to the
Horn text instead, which the code alone yields, and `tslaws accept` rebuilds that text from the compiled code. The lock
record carries a `systemHash` for it. `.tslaws/certificates/` keeps two more files for such a law, the clauses (`.horn`) and
the invariants (`.inv`). Accept checks that the clauses hash as the record says and are the ones the law yields now, then
puts the saved invariants into the saved clauses itself and requires the result to be exactly the saved problem, so the
invariants cannot be swapped for others that make a different problem. Then Carcara checks the proof of that problem again.

Eldarica and Golem, when installed, still confirm the invariant independently; that is a cross-check of the proof search and
no part of the certificate.

## Turning it on

```json
{ "certify": true }
```

or `tslaws check --certify` for one run. The value is `true`, `false` (the default) or `"require"` (`--require-certify`
for one run).

When Z3 proves a law, `tslaws` writes the query (without Z3's timeout option and `(get-model)`, with `(set-logic ALL)`)
to a file and runs

```
cvc5 --lang smt2 --dump-proofs --proof-format-mode=alethe --proof-granularity=dsl-rewrite --no-proof-alethe-res-pivots \
     --dag-thresh=0 --simplification=none --enum-inst-interleave --cegqi-all --tlimit <proof timeout> problem.smt2
carcara check proof.alethe problem.smt2 --allow-int-real-subtyping --expand-let-bindings [--rare-file rules.rare]
```

The `dsl-rewrite` granularity keeps cvc5 from writing unchecked `hole` steps for its rewrites; it writes `rare_rewrite` steps
instead, which Carcara checks against the rule's declaration. `tslaws` gets those declarations (`rules.rare`) by asking the
cvc5 binary for its rewrite-rule database (`-o rare-db`) and keeping the rules the proof names, so they never come from a
file beside the proof.

Two details matter for laws over `int`, whose range obligations repeat bounds and use `ite` and `div`:

- `--no-proof-alethe-res-pivots`. With pivots on, cvc5 names the pivot literal of each `resolution` step, and for a clause
  that repeats a literal Carcara does not find the named pivot ("pivot was not found") and refuses a sound proof. With the
  option off Carcara finds the pivots itself, as it does in cvc5's own regressions.
- Two rules are declared by `tslaws` and not taken from cvc5 1.4.2's database: `ite-eq` (cvc5 cites it but leaves it out
  of `-o rare-db`, cvc5 issue 12801) and `arith-int-div-total` (cvc5 writes `div_total`, which Carcara does not read; the
  vendored rule states the same equality with `div`). These rules are part of what you trust, together with cvc5 and
  Carcara; Carcara still checks each step that uses them against the declaration. Remove them when a cvc5 release declares
  them in a form Carcara reads.
- `mod` is not covered. A proof about `mod` also needs `mod-elim`, which cvc5 1.4.2 does not declare, and `tslaws` adds
  no rule it cannot show to be sound, so a law that uses `mod` is `uncertified` and the reason names `mod-elim`.

If cvc5 uses a rule that neither cvc5 nor `tslaws` declares, the law is `uncertified` and the reason names the rule. If
Carcara cannot read a rule file, the reason says so; that is not a rejected proof. Laws in these gaps still prove with Z3;
they only lack a certificate.

The proof counts only if cvc5 answers `unsat` and Carcara prints `valid` and exits 0. A proof Carcara reports as `holey`
(some steps unchecked) is not certified.

Each proved or bounded law then has a certificate status in its result (`certificate` in `--json`, a `certificate:` line
in the text report):

| status                 | meaning                                                               |
| ---------------------- | --------------------------------------------------------------------- |
| `certified`            | Carcara accepted the proof                                            |
| `uncertified (reason)` | no proof, or Carcara did not accept it; the reason says which and why |
| `unavailable (reason)` | cvc5 or Carcara is missing                                            |

Without `"require"`, certifying never changes a law's status or the exit code: an `uncertified` or `unavailable` law is
still `proved`. With `"require"`, any proved or bounded law that is not `certified` is an `error`, so CI fails when a
proof cannot be checked or a tool is missing.

## Installing the tools

- A recent cvc5 (one with Alethe proof output), from [cvc5.github.io](https://cvc5.github.io) or the [releases](https://github.com/cvc5/cvc5/releases).
  Put `cvc5` on the PATH or set `TSLAWS_CVC5` to its path.
- A recent Carcara, built with Rust: `cargo build --release` in a clone of
  [ufmg-smite/carcara](https://github.com/ufmg-smite/carcara). Put `carcara` on the PATH or set `TSLAWS_CARCARA`.

If either is missing the certificate is `unavailable`, which is not a failure unless `"certify": "require"` is set. The
options above follow cvc5's documented Alethe workflow; if a newer cvc5 or Carcara changes them, the law is
`uncertified` with the tool's message rather than wrongly certified.

## In the lock

`tslaws check --certify` keeps each certified proof in `.tslaws/certificates/` (the `.smt2` problem and the `.alethe`
proof, so Carcara can run again on them) and the hashes in `.tslaws/certificates.json`. Anyone can write those files, so
`tslaws accept` trusts none of them. For each record it checks that:

- the law is unchanged (the record's `law` is the law's hash now);
- the record's `problemHash` is the hash of a problem the law yields now: accept rebuilds the SMT-LIB problem of every
  law from the compiled code, without a solver, so a change to code the law calls voids the certificate even when the
  law's own text is unchanged;
- the saved `.smt2` and `.alethe` exist and hash as the record says;
- Carcara accepts them again, now, and its verdict hashes to the record's `checkerHash`.

A record that fails any step is dropped and accept says why. With Carcara missing (or cvc5, for a proof with `rare_rewrite`
steps), no new certificate is recorded.
Records already in the lock are kept only while their law and problem still match. The records that pass are copied into
`tsc-laws.lock` beside the law's own hash:

```json
{
  "laws": { "laws/math.laws.ts::addition commutes": "<law hash>" },
  "certificates": {
    "laws/math.laws.ts::addition commutes": {
      "law": "<law hash>",
      "problemHash": "<sha-256 of the SMT-LIB problem>",
      "systemHash": "<sha-256 of the Horn clauses, for a law proved with loop invariants only>",
      "proofHash": "<sha-256 of the Alethe proof>",
      "checkerHash": "<sha-256 of Carcara's verdict, bound to the problem and proof>"
    }
  }
}
```

`tslaws check` also compares the lock's record with the problem it just proved, and tells you when they differ. A lock with
no certified laws has no `certificates` key. The GitHub accept workflow writes only certificates its own run produced for
the laws it accepts, and carries none over from the lock it replaces.

With `"certify": "require"` a law that is proved or bounded and has no certified proof is an error, including a law whose
proof the second solver did not confirm (`uncertified: no certificate produced` when nothing was attempted).

## In CI

```yaml
- run: sudo apt-get install -y cvc5 # or download a release and set TSLAWS_CVC5
- run: ./install-carcara.sh # your own step: build or cache the carcara binary, then set TSLAWS_CARCARA
- run: npx tslaws check --require-certify
```

Use `--certify` without `--require-certify` to see which laws certify without failing the build on the ones that cannot.

## Badges

Two [shields.io endpoint](https://shields.io/badges/endpoint-badge) badges show where a project stands: `laws: N proved` and
`certificates: N verified`. An endpoint badge reads a small JSON file from a URL, so a file committed to the repository and
served by `raw.githubusercontent.com` is enough. You do not need GitHub Pages.

[![tslaws](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2FJordan-Hall%2Ftsc-laws%2Fmain%2Fdocs%2Fcertificates%2Fbadge-laws.json)](certificates/README.md)
[![certificates](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2FJordan-Hall%2Ftsc-laws%2Fmain%2Fdocs%2Fcertificates%2Fbadge-certificates.json)](certificates/README.md)

- `laws` counts the laws Z3 proved. It is green when every law is proved and yellow otherwise (`7 of 8 proved`), and for a
  project with no laws.
- `certificates` counts the laws a checker accepted a proof of: from the run, or from a certificate in the lock that is still
  for its law. It is green when every law is certified and yellow otherwise (`7 of 8 verified`).

This repository's own badges link to the [certificate gallery](certificates/README.md). The `certificates` workflow writes
their JSON (`docs/certificates/badge-laws.json` and `badge-certificates.json`) with the rest of the gallery, from the same
data, and fails when the committed files no longer match a fresh run.

### Badges for your project

```sh
npx tslaws badge --certify
```

`tslaws badge` checks the project (or reads the output of `tslaws check --json` from `--report FILE`, so a CI job that has
already checked does not check twice), writes `badge-laws.json` and `badge-certificates.json` into `badges/` (a directory you commit, so the badge URLs resolve) and
prints the markdown that shows them. When a law is certified it also writes a certificates page, `badges/README.md`, that lists
each law with its status and its proof files, which it copies to `badges/certificates/`. Both badges link to that page:

```text
laws: 8 proved
certificates: 8 verified
wrote badges/badge-laws.json and badges/badge-certificates.json; commit them and add to your README:

[![tslaws](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Facme%2Fwidgets%2Fmain%2Fbadges%2Fbadge-laws.json)](https://github.com/acme/widgets/blob/main/badges/README.md)
[![certificates](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Facme%2Fwidgets%2Fmain%2Fbadges%2Fbadge-certificates.json)](https://github.com/acme/widgets/blob/main/badges/README.md)

both badges link to badges/README.md, the certificates page written beside them
```

| Flag                | Meaning                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `--out DIR`         | where to write the files; default `badges`. Keep it out of `.gitignore`: the badge URLs read the committed files                         |
| `--report FILE`     | the output of `tslaws check --json` for one project, instead of a new check                                                              |
| `--repo OWNER/NAME` | the GitHub repository for the URLs; default `$GITHUB_REPOSITORY`, then the `origin` remote, else the placeholder `OWNER/REPO`            |
| `--branch NAME`     | the branch the files are served from; default `main`                                                                                     |
| `--link URL`        | where both badges link; default the certificates page in the output directory, or `tsc-laws.lock` on the branch when no law is certified |
| `--certify`         | check with certificates on, as in `tslaws check --certify`, so the page has proofs to list                                               |

The command writes only the badge files, the page and its copies of the proofs, and never touches the lock. It does not delete files from an earlier run. In a monorepo, pick the project with `--project`.

To keep the badges current, regenerate them on `main` and commit the change. This job needs `contents: write`, so give it to
that job only:

```yaml
name: badges
on:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  badges:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 24
      - run: npm ci
      - run: npx tslaws check --certify --json > report.json || true
      - run: npx tslaws badge --report report.json --out badges
      - run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add badges
          git diff --cached --quiet || (git commit -m "chore: update badges" && git push)
```

The check step ends with `|| true` so that a failing law still updates the badge instead of leaving the old one. Failing laws
stay failing in the build job that runs `tslaws check`. A branch with required reviews or status checks refuses the push; push to
a branch of its own (and pass `--branch`), or run the job with a token that may push.
