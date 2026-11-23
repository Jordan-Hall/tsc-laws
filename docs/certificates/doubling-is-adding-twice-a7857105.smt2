(set-logic ALL)
(declare-const a Int)
(assert (or (not (= (* a 2) (+ a a))) (not true)))
(check-sat)
