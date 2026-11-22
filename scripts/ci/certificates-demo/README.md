# Certificate demo

A small project the `certificates` workflow checks with the real cvc5 and Carcara: it accepts the laws, runs `tslaws check`
and `tslaws check --require-certify`, and prints the lock, so the log shows what a certificate looks like. Three laws are
straight-line integer, bigint and boolean arithmetic (certifiable today). The rest are not, each for a different reason:
two loop laws (proved through the Horn solver, which writes no proof), a law whose proof Carcara rejects, a law that
needs a rewrite rule cvc5 does not define, and one over doubles.
