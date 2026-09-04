# RunsOn Spot retry gate

Keep a pull request in GitHub's merge queue while RunsOn retries a job after an
EC2 Spot interruption.

RunsOn fails an interrupted job so GitHub includes it when RunsOn requests a
rerun of failed jobs. This reusable workflow publishes a different successful
check during that first interrupted attempt. The required check stays pending
until the retry publishes the real aggregate result.

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
| Attempt with a Spot interruption | `merge-gate / interrupted` | Success |

The successful `interrupted` check does not satisfy the required `pass` check.
The merge queue waits while RunsOn reruns the failed jobs. GitHub carries
successful jobs into the new attempt without executing them again.

Every job that contributes to the aggregate result must appear in `needs`.
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
`merge-gate` prefix too.

## Failure behavior

The workflow recognizes the exact `EC2 Spot interruption` error annotation
written by the RunsOn runner agent. When it finds no interruption, it fails the
normal check when:

- any dependency fails, is cancelled, or is skipped;
- `job_results` is empty or malformed; or
- GitHub's jobs or check-annotations API cannot be read.

When interrupted and ordinary failures occur together, the interrupted attempt
keeps the required check pending. Any ordinary failure that persists in the
retry then fails the normal check.

The workflow needs only `actions: read` and `checks: read`. It does not accept
secrets or write through the GitHub API.

## License

[MIT](LICENSE)
