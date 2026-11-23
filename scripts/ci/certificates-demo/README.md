# Certificate demo

A small project the `certificates` workflow checks with the real cvc5 and Carcara: it accepts the laws, runs `tslaws check`
and `tslaws check --require-certify`, and prints the lock, so the log shows what a certificate looks like.

Seven laws are certified: straight-line bigint and boolean arithmetic, two integer laws with range bounds and a conditional,
and two laws about loops. For a loop, Z3 finds the invariant, cvc5 refutes the clauses with the invariant put in, and Carcara
checks that proof; the lock binds the certificate to the clauses the code yields. The one law left uncertified is over doubles,
which is only property-tested, so `--require-certify` fails on it.
