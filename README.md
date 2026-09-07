# RunsOn Spot retry gate

Keep a pull request in GitHub's merge queue while RunsOn retries a job after an
EC2 Spot interruption.

RunsOn fails an interrupted job so GitHub includes it when RunsOn requests a
rerun of failed jobs. This reusable workflow publishes a different successful
check during a retryable interrupted attempt. The required check stays pending
until a later attempt publishes the real aggregate result.

This workflow supports GitHub.com. GitHub Enterprise Server does not support
the `$/` self-repository action reference used by reusable workflows.

## Usage

Trigger CI for pull requests and merge groups, then add one gate job after the
jobs that must pass:

```yaml
name: CI

on:
  pull_request:
  merge_group:

jobs:
  test:
    runs-on: runs-on=${{ github.run_id }}/runner=2cpu-linux-x64
    steps:
      - uses: actions/checkout@v7
      - run: make test

  merge-gate:
    if: ${{ always() }}
    needs: [test]
    permissions:
      actions: read
      checks: read
    uses: runs-on/spot-retry-gate/.github/workflows/merge-queue.yml@v1
    with:
      job_results: ${{ toJSON(needs) }}
```

Require only `merge-gate / pass` in the branch ruleset. Do not require the
individual Spot jobs.

The gate publishes these checks:

| Attempt | Check | Conclusion |
| --- | --- | --- |
| Normal completed attempt | `merge-gate / pass` | Aggregate result |
| Attempt 1 or 2 with an annotated Spot interruption | `merge-gate / interrupted` | Success |

The successful `interrupted` check does not satisfy the required `pass` check.
The merge queue waits while RunsOn reruns the failed jobs. GitHub carries
successful jobs into the new attempt without executing them again.

Every job that contributes to the aggregate result must appear in `needs`. Use
one non-matrix gate job. If every dependency succeeds, the gate publishes the
normal check without querying the GitHub API. RunsOn makes at most two automatic
reruns. Attempt 3 and later therefore publish the normal aggregate result.

Keep the workflow running until the gate finishes: RunsOn waits for the failed
attempt to complete before requesting the retry. Set the merge queue's status
check timeout long enough to cover that delay and the retry.

## Custom check name

Set `check_name` to change the normal suffix:

```yaml
  merge-gate:
    if: ${{ always() }}
    needs: [test]
    permissions:
      actions: read
      checks: read
    uses: runs-on/spot-retry-gate/.github/workflows/merge-queue.yml@v1
    with:
      job_results: ${{ toJSON(needs) }}
      check_name: ready
```

This publishes `merge-gate / ready` normally and `merge-gate / interrupted`
after a Spot interruption. Adding `name:` to the caller job changes the
`merge-gate` prefix too. The reserved suffixes `interrupted` and
`Detect Spot interruption` are rejected.

## Failure behavior

The workflow recognizes the exact `EC2 Spot interruption` error annotation
written by the RunsOn runner agent. When it finds no interruption, it fails the
normal check when:

- any dependency fails, is cancelled, or is skipped;
- `job_results` is empty or malformed; or
- GitHub's jobs or check-annotations API cannot be read while a dependency has
  failed on attempt 1 or 2.

When interrupted and ordinary failures occur together, the interrupted attempt
keeps the required check pending. Any ordinary failure that persists in the
retry then fails the normal check.

The workflow needs only `actions: read` and `checks: read`. It does not accept
secrets or write through the GitHub API.

### Forced runner termination

The gate recognizes only interruptions carrying the exact annotation. If the
runner is terminated before its post-job hook reports that annotation, the gate
fails the normal check. RunsOn may still have enough durable instance evidence
to retry the job. The gate cannot read that evidence with GitHub-only
permissions.

## Releasing

Run the **Release** workflow from `main`. Supply a stable version tag such as
`v1.0.0` and the source branch, which defaults to `main`:

```sh
gh workflow run release.yml --ref main -f tag=v1.0.0 -f branch=main
```

The workflow resolves the source branch once and runs the Node 24 tests on that
commit. It then creates an annotated version tag and creates or fast-forwards
the corresponding major branch (`v1`) to that exact commit in one atomic push.
If validation, tests, or publication fail, no partial release is published.

Version tags are never overwritten by this workflow. Versions must increase
within each major. Prereleases and existing tags are rejected. A tag named `v1`
would conflict with branch `v1` and is also rejected.

Treat major branches as release pointers. Develop on source branches, and keep
them descended from the previous release. Divergent history requires resolving
the source branch before releasing; the workflow never force-pushes or creates
a merge commit. To maintain an older major, release from a maintenance branch
that includes its previous release.

Consumers can use `@v1` to receive compatible releases or `@v1.0.0` to select a
fixed version. A full commit SHA provides the strongest pin. This workflow does
not create GitHub Release pages or generate release notes.

The workflow needs permission to create version tags and update major branches.
Repository rules must allow those updates by `GITHUB_TOKEN`. It runs validation
before publication because pushes made with that token do not trigger the usual
push workflows. No personal access token is required.

## License

[MIT](LICENSE)
