# Certificate demo

A small project the `certificates` workflow checks with the real cvc5 and Carcara: it accepts the laws, runs `tslaws check`
and `tslaws check --require-certify`, and prints the lock, so the log shows what a certificate looks like. The laws are
ordinary integer laws, two of them over loops (proved through the Horn solver, so not certifiable) and one over doubles.
