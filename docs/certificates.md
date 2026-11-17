# Proof certificates

Z3 says a law is proved when the negated law is `unsat`. That answer is a claim, and you trust Z3 to be right. A
certificate lets a second program check it: cvc5 proves the same query again and writes the proof in the
[Alethe](https://verit.loria.fr/documentation/alethe-spec.pdf) format, and [Carcara](https://github.com/ufmg-smite/carcara),
a small independent proof checker, checks that proof step by step.

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

## Turning it on

```json
{ "certify": true }
```

or `tslaws check --certify` for one run. The value is `true`, `false` (the default) or `"require"` (`--require-certify`
for one run).

When Z3 proves a law, `tslaws` writes the query (without Z3's timeout option and `(get-model)`, with `(set-logic ALL)`)
to a file and runs

```
cvc5 --lang smt2 --dump-proofs --proof-format-mode=alethe --proof-granularity=dsl-rewrite --proof-alethe-res-pivots \
     --dag-thresh=0 --simplification=none --enum-inst-interleave --cegqi-all --tlimit <proof timeout> problem.smt2
carcara check proof.alethe problem.smt2 --allow-int-real-subtyping --expand-let-bindings [--rare-file rules.rare]
```

The `dsl-rewrite` granularity keeps cvc5 from writing unchecked `hole` steps for its rewrites; it writes `rare_rewrite` steps
instead, which Carcara checks against the rule's declaration. `tslaws` gets those declarations (`rules.rare`) by asking the
cvc5 binary for its rewrite-rule database (`-o rare-db`) and keeping the rules the proof names, so they never come from a
file beside the proof. If cvc5 does not declare a rule its proof uses (cvc5 1.4.2 proves some `ite` laws with `ite-eq`, which
it does not declare), the law is `uncertified` and the reason names the rule.

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
