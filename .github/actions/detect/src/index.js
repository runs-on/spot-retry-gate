const fs = require("node:fs");

const SPOT_INTERRUPTION_ANNOTATION_TITLE = "EC2 Spot interruption";
const PAGE_SIZE = 100;
const VALID_JOB_RESULTS = new Set(["success", "failure", "cancelled", "skipped"]);

function parseJobResults(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`job_results must be valid JSON: ${error.message}`);
  }

  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("job_results must be a JSON object produced by toJSON(needs)");
  }

  const jobs = Object.entries(parsed);
  if (jobs.length === 0) {
    return { dependenciesSucceeded: false };
  }

  for (const [name, job] of jobs) {
    if (job === null || Array.isArray(job) || typeof job !== "object") {
      throw new Error(`job_results.${name} must be an object`);
    }
    if (!VALID_JOB_RESULTS.has(job.result)) {
      throw new Error(`job_results.${name}.result is invalid`);
    }
  }

  return {
    dependenciesSucceeded: jobs.every(([, job]) => job.result === "success"),
  };
}

async function githubApi(fetchImpl, apiUrl, token, pathname, page) {
  const url = new URL(pathname, `${apiUrl.replace(/\/$/, "")}/`);
  url.searchParams.set("per_page", String(PAGE_SIZE));
  url.searchParams.set("page", String(page));

  const response = await fetchImpl(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "runs-on-spot-retry-gate",
      "x-github-api-version": "2022-11-28",
    },
  });

  if (!response.ok) {
    throw new Error(
      `GitHub API request failed for ${url.pathname}: ${response.status} ${response.statusText}`,
    );
  }

  return response.json();
}

async function listAll(fetchPage) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const current = await fetchPage(page);
    if (!Array.isArray(current)) {
      throw new Error("GitHub API returned an unexpected pagination response");
    }
    items.push(...current);
    if (current.length < PAGE_SIZE) {
      return items;
    }
  }
}

async function detectSpotInterruption({
  fetchImpl,
  apiUrl,
  token,
  repository,
  runId,
  runAttempt,
}) {
  const [owner, repo, ...extra] = repository.split("/");
  if (!owner || !repo || extra.length > 0) {
    throw new Error("repository must use owner/name form");
  }

  const encodedOwner = encodeURIComponent(owner);
  const encodedRepo = encodeURIComponent(repo);
  const jobs = await listAll(async (page) => {
    const response = await githubApi(
      fetchImpl,
      apiUrl,
      token,
      `/repos/${encodedOwner}/${encodedRepo}/actions/runs/${encodeURIComponent(runId)}/attempts/${encodeURIComponent(runAttempt)}/jobs`,
      page,
    );
    if (!Array.isArray(response.jobs)) {
      throw new Error("GitHub API returned an unexpected jobs response");
    }
    return response.jobs;
  });

  for (const job of jobs) {
    if (job.conclusion !== "failure") {
      continue;
    }
    if (typeof job.check_run_url !== "string") {
      throw new Error(`Failed job ${job.id ?? "unknown"} has no check run URL`);
    }

    const checkRunId = new URL(job.check_run_url).pathname.split("/").at(-1);
    if (!/^\d+$/.test(checkRunId)) {
      throw new Error(`Failed job ${job.id ?? "unknown"} has an invalid check run URL`);
    }

    const annotations = await listAll((page) =>
      githubApi(
        fetchImpl,
        apiUrl,
        token,
        `/repos/${encodedOwner}/${encodedRepo}/check-runs/${checkRunId}/annotations`,
        page,
      ),
    );
    if (annotations.some((annotation) => annotation.title === SPOT_INTERRUPTION_ANNOTATION_TITLE)) {
      return true;
    }
  }

  return false;
}

function getInput(name) {
  const value = process.env[`INPUT_${name.toUpperCase()}`];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) {
    throw new Error("GITHUB_OUTPUT is not set");
  }
  fs.appendFileSync(outputFile, `${name}=${value}\n`);
}

function annotateError(message) {
  const escaped = message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  console.error(`::error title=Spot retry gate::${escaped}`);
}

async function main() {
  setOutput("spot_interrupted", "false");
  setOutput("dependencies_succeeded", "false");

  try {
    const { dependenciesSucceeded } = parseJobResults(getInput("JOB_RESULTS"));
    setOutput("dependencies_succeeded", String(dependenciesSucceeded));

    const spotInterrupted = await detectSpotInterruption({
      fetchImpl: fetch,
      apiUrl: getInput("API_URL"),
      token: getInput("GITHUB_TOKEN"),
      repository: getInput("REPOSITORY"),
      runId: getInput("RUN_ID"),
      runAttempt: getInput("RUN_ATTEMPT"),
    });
    setOutput("spot_interrupted", String(spotInterrupted));
  } catch (error) {
    annotateError(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  PAGE_SIZE,
  SPOT_INTERRUPTION_ANNOTATION_TITLE,
  detectSpotInterruption,
  listAll,
  parseJobResults,
};
