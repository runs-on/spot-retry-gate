const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");

const {
  PAGE_SIZE,
  SPOT_INTERRUPTION_ANNOTATION_TITLE,
  detectSpotInterruption,
  evaluateGate,
  parseJobResults,
  resolveCheckName,
  validateCheckName,
} = require("../.github/actions/detect/src/index.js");

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Forbidden",
    async json() {
      return body;
    },
  };
}

function detectorOptions(fetchImpl) {
  return {
    fetchImpl,
    apiUrl: "https://api.github.test",
    token: "token",
    repository: "runs-on/example",
    runId: "123",
    runAttempt: "2",
  };
}

test("accepts successful dependency results", () => {
  assert.deepEqual(
    parseJobResults(JSON.stringify({ test: { result: "success", outputs: {} } })),
    { dependenciesSucceeded: true },
  );
});

test("treats every non-success dependency result as a failure", () => {
  for (const result of ["failure", "cancelled", "skipped"]) {
    assert.deepEqual(parseJobResults(JSON.stringify({ test: { result } })), {
      dependenciesSucceeded: false,
    });
  }
  assert.deepEqual(parseJobResults("{}"), { dependenciesSucceeded: false });
});

test("rejects malformed dependency results", () => {
  for (const value of ["not-json", "[]", "null", '{"test":null}', '{"test":{"result":"neutral"}}']) {
    assert.throws(() => parseJobResults(value));
  }
});

test("rejects check names reserved by the reusable workflow", () => {
  for (const name of ["interrupted", "INTERRUPTED", "Detect Spot interruption", " detect spot interruption "]) {
    assert.throws(() => validateCheckName(name), /check_name cannot be/);
  }
  assert.doesNotThrow(() => validateCheckName("pass"));
  assert.doesNotThrow(() => validateCheckName("ready"));
});

test("treats an empty check name as the default", () => {
  assert.equal(resolveCheckName(""), "pass");
  assert.equal(resolveCheckName(undefined), "pass");
});

test("passes check_name from the reusable workflow to validation", () => {
  const workflow = fs.readFileSync(".github/workflows/merge-queue.yml", "utf8");
  assert.match(workflow, /check_name: \$\{\{ inputs\.check_name \}\}/);
});

test("skips annotation lookup when every dependency succeeded", async () => {
  let detectionCalls = 0;
  const result = await evaluateGate({
    jobResults: JSON.stringify({ test: { result: "success" } }),
    runAttempt: "1",
    detectInterruption: async () => {
      detectionCalls += 1;
      throw new Error("must not query GitHub");
    },
  });

  assert.deepEqual(result, { dependenciesSucceeded: true, spotInterrupted: false });
  assert.equal(detectionCalls, 0);
});

test("does not report an interruption after the first attempt", async () => {
  let detectionCalls = 0;
  const result = await evaluateGate({
    jobResults: JSON.stringify({ test: { result: "failure" } }),
    runAttempt: "2",
    detectInterruption: async () => {
      detectionCalls += 1;
      return true;
    },
  });

  assert.deepEqual(result, { dependenciesSucceeded: false, spotInterrupted: false });
  assert.equal(detectionCalls, 0);
});

test("looks for an interruption only for failed dependencies on attempt one", async () => {
  let detectionCalls = 0;
  const result = await evaluateGate({
    jobResults: JSON.stringify({ test: { result: "failure" } }),
    runAttempt: "1",
    detectInterruption: async () => {
      detectionCalls += 1;
      return true;
    },
  });

  assert.deepEqual(result, { dependenciesSucceeded: false, spotInterrupted: true });
  assert.equal(detectionCalls, 1);
});

test("rejects an invalid run attempt", async () => {
  await assert.rejects(
    evaluateGate({
      jobResults: JSON.stringify({ test: { result: "failure" } }),
      runAttempt: "unknown",
      detectInterruption: async () => false,
    }),
    /run_attempt must be a positive integer/,
  );
});

test("returns false for an ordinary failed job", async () => {
  const fetchImpl = async (url) => {
    if (url.pathname.endsWith("/jobs")) {
      return response({
        jobs: [
          {
            id: 1,
            conclusion: "failure",
            check_run_url: "https://api.github.test/repos/runs-on/example/check-runs/10",
          },
        ],
      });
    }
    return response([]);
  };

  assert.equal(await detectSpotInterruption(detectorOptions(fetchImpl)), false);
});

test("finds a Spot interruption among mixed failures", async () => {
  const fetchImpl = async (url) => {
    if (url.pathname.endsWith("/jobs")) {
      return response({
        jobs: [
          {
            id: 1,
            conclusion: "failure",
            check_run_url: "https://api.github.test/repos/runs-on/example/check-runs/10",
          },
          {
            id: 2,
            conclusion: "failure",
            check_run_url: "https://api.github.test/repos/runs-on/example/check-runs/20",
          },
        ],
      });
    }
    if (url.pathname.endsWith("/10/annotations")) {
      return response([{ title: "A normal failure" }]);
    }
    return response([{ title: SPOT_INTERRUPTION_ANNOTATION_TITLE }]);
  };

  assert.equal(await detectSpotInterruption(detectorOptions(fetchImpl)), true);
});

test("paginates jobs and annotations", async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(`${url.pathname}?${url.searchParams}`);
    const page = Number(url.searchParams.get("page"));
    if (url.pathname.endsWith("/jobs")) {
      if (page === 1) {
        return response({
          jobs: Array.from({ length: PAGE_SIZE }, (_, index) => ({
            id: index,
            conclusion: "success",
            check_run_url: null,
          })),
        });
      }
      return response({
        jobs: [
          {
            id: 101,
            conclusion: "failure",
            check_run_url: "https://api.github.test/repos/runs-on/example/check-runs/30",
          },
        ],
      });
    }
    if (page === 1) {
      return response(Array.from({ length: PAGE_SIZE }, () => ({ title: "Other" })));
    }
    return response([{ title: SPOT_INTERRUPTION_ANNOTATION_TITLE }]);
  };

  assert.equal(await detectSpotInterruption(detectorOptions(fetchImpl)), true);
  assert.equal(requests.filter((request) => request.includes("/jobs?")).length, 2);
  assert.equal(requests.filter((request) => request.includes("/annotations?")).length, 2);
});

test("fails closed when the GitHub API fails", async () => {
  const fetchImpl = async () => response({}, 403);
  await assert.rejects(
    detectSpotInterruption(detectorOptions(fetchImpl)),
    /GitHub API request failed.*403 Forbidden/,
  );
});
