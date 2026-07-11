# Security Policy

## Supported versions

bgsd is currently at **0.11.x**. Security fixes are provided for the `0.11.x`
line. Older pre-release versions are not supported.

| Version | Supported |
|---------|-----------|
| 0.11.x  | Yes       |
| < 0.11  | No        |

## Reporting a vulnerability

Please report security vulnerabilities privately by email to
**filifonsecacagnazzo@gmail.com**. Do not open a public GitHub issue for a
security report.

Include as much of the following as you can:

- a description of the issue and its impact;
- the affected version or commit;
- clear steps to reproduce, or a proof-of-concept;
- any suggested remediation.

You will receive an acknowledgement, and we will work with you on a fix and a
coordinated disclosure. Please give us reasonable time to address the issue
before disclosing it publicly.

## Scope and threat model

bgsd is an orchestration layer that **runs autonomous agents, and those agents
execute code and shell commands inside isolated git worktrees.** Keep this in
mind when running it:

- **Agents run real code.** A session spawns worker agents that write files, run
  builds, and drive a real browser to verify the app. Only run bgsd on
  repositories and prompts you trust.
- **Agents never write to your production branch.** All integration lands on the
  standing `next` branch; the `next` to `main` merge is a manual, human-only
  step. This is enforced in code (a not-production-branch guard on every live
  mutation), not just documented.
- **Autonomous by design; the branch is the boundary.** A plain `/bgsd-sesh`
  runs the whole pipeline end-to-end (spawning parallel agents, real merges, and
  browser-driven verification) with no separate opt-in flag. The enforced safety
  boundary is the not-production-branch guard above: every live mutation refuses
  to run against `main`/`master`. Run bgsd only on repos and prompts you trust.
- **Environment files are propagated into worktrees.** Because git worktrees do
  not carry gitignored files, bgsd copies your configured `.env*` files from the
  repo root into each worktree so apps boot with their real environment. This
  means your secrets are duplicated into worktree directories for the duration
  of a run. Treat those directories, and any logs or artifacts under `.bgsd/`,
  as sensitive, and be careful not to commit or share them.

If you believe any of these guarantees can be bypassed, that is exactly the kind
of report we want to receive.
