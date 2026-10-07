# Paseo fork integration

This orphan branch owns fork automation only. `main` mirrors upstream exactly;
`dev` contains the entire monorepo plus the ordered patches in `manifest.json`.
Canonical patch branches remain the source for reviews and conflict resolution.
There are no releases, deployment jobs, signing changes, or updater changes here.

## Setup and run

1. Set this fork's default branch to `automation` and enable GitHub Actions for the fork.
2. Enable Issues in the fork so failures can create/update the single integration issue.
3. Open **Actions → Fork integration → Run workflow**, selecting `automation`.
   CLI equivalent: `gh workflow run integrate.yml --repo gerardbalaoro/paseo --ref automation`.
4. Inspect the `prepare`, `validate`, and `publish` jobs. Successful publication updates
   pristine `main` and generated `dev` together. The schedule runs daily at 02:30 UTC
   once this workflow is enabled on the default branch.

Use only the built-in `GITHUB_TOKEN` wired in the workflow. Do not replace it with
an app token or PAT: inherited upstream workflows deploy the website, update
release metadata, and mutate Nix files on a `main` push. GitHub suppresses
push-triggered workflows for built-in-token pushes; our separate validation job
checks the exact candidate before publication. See
[GitHub's trigger documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
Do not push `main` locally. No tags are fetched or published by this automation.
`[skip ci]` on generated dev is an additional precaution, not the main safety mechanism.

## Canonical branch ownership

PR #3795 is selected. Its writer is `external`: the existing ChatGPT task
**Maintain Paseo pull request** owns its daily synchronization at 08:00 Asia/Manila.
This workflow reads its current head and never updates it. Concurrent movement
causes publication to stop and ask for a fresh run.

Do not set `writer` to `actions` until the user approves transferring ownership
and the existing task has stopped writing that branch. The implemented Actions
mode rebases only when all PR authors are the named owner and no coauthor trailers
exist. Unknown identities or additional authors use a merge. Closed PRs are never
rewritten. Publication rechecks PR status, authors, refs, and upstream.

The branch list includes many unrelated inherited or experimental branches; none
are implicitly selected. Add a patch only after selection is approved. Order in
`patches` is integration order. Every entry requires a fork branch, upstream PR,
owner, and writer. Optional `preserve` entries pin important Git blob IDs.

## Failure and recovery

Conflicts stop the build without updating any remote branch. Resolve on the
canonical branch through its current owner, validate that change, then rerun.
There is no silent conflict skipping. An ancestor already in upstream or a fully
patch-equivalent series is recorded as integrated. A closed/merged PR flag alone
never drops a patch. Ambiguous squash merges or partial integration may require
manual inspection and a manifest change; this is intentionally conservative.

Generated dev uses a deterministic single snapshot commit over upstream, with
source refs and manifest provenance in its message. It integrates the net patch
range for each selected branch, including merge-based shared history, without
rewriting that canonical history. The QA image is checked by exact Git blob ID.
An existing dev without provenance, or an amended generated tree, is rejected.
Never make hand edits on dev: create a canonical patch branch instead.

Atomic publication uses explicit expected-head leases for every changed ref and
rechecks all selected input refs immediately before pushing. An external writer
can still move a read-only input after that final read; the published provenance
records the exact integrated head, and the next run integrates the later head.
No cross-repository atomic transaction can lock upstream main.

Validation runs server/dependency builds, whole-monorepo typecheck/lint/format,
and focused terminal/session/translation tests. It does not package, sign, deploy,
or run the prohibited full local test suite. Native platform validation and
interactive OS clipboard flows remain outside this workflow.

## Local framework tests

`python3 -m unittest discover -s tests -v`

The fixtures use temporary bare repositories: repeat builds, integrated patches,
conflicts, contributor rules, diverged main, unexpected dev edits, and remote races.
`python3 scripts/integrate.py build --repo /absolute/new/candidate --plan plan.json`
prepares a candidate without remote writes. Local full publication is blocked;
`--dev-only` is reserved for an explicitly reviewed, validated bootstrap after
checking inherited dev triggers. It still checks expected refs and PR metadata.
