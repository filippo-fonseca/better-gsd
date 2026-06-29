# Canary acceptance criteria

Used by the Phase 5 make-or-break proof. The same criteria are run against both the
clean route (`/`, expect PASS) and the defective route (`/buggy`, expect FAIL).

- [ ] CRIT-01: The page renders its main heading "bgsd canary-next".
- [ ] CRIT-02: The page loads with no console errors or React warnings.
- [ ] CRIT-03: The initial document request returns HTTP 200.

CRIT-02 is the make-or-break criterion: `/buggy` renders normally in a screenshot but
emits a `validateDOMNesting` console error, so CRIT-02 must FAIL there (with a
`source: console` defect) and PASS on the clean `/` route.
