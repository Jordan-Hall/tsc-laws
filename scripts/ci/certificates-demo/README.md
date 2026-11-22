# Certificate demo

A small project the `certificates` workflow checks with the real cvc5 and Carcara: it accepts the laws, runs `tslaws check`
and `tslaws check --require-certify`, and prints the lock, so the log shows what a certificate looks like. Five laws are certified: straight-line bigint and boolean arithmetic, and two integer laws with range bounds
and a conditional. The rest are not certified, each for a different reason: two loop laws (proved through the Horn
solver, which writes no proof) and one over doubles (only property-tested).
