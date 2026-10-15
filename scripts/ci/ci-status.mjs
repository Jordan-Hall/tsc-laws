// Reads CI results for main from the GitHub API (GET requests only).
//
// Usage:
//   node scripts/ci/ci-status.mjs latest-green
//     Prints the latest main commit whose CI run (push to main, ci.yml) succeeded in every job.
//   node scripts/ci/ci-status.mjs require-green <sha> [--wait <minutes>]
//     Exits 0 if the CI run for the push of <sha> to main succeeded in every job. Waits up to --wait minutes
//     (default 0) for a queued or running run to finish. Exits 1, printing why, otherwise.
//
// Reads GITHUB_REPOSITORY (owner/name, default vercel-labs/tsc-ts) and GITHUB_TOKEN when set.
const repo = process.env.GITHUB_REPOSITORY ?? 'vercel-labs/tsc-ts';
const workflow = 'ci.yml';

async function get(path) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(`https://api.github.com/repos/${repo}/${path}`, { headers });
  if (!response.ok) throw new Error(`GET ${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

/** CI runs for pushes to main, newest first. */
async function mainRuns(query = '') {
  const data = await get(`actions/workflows/${workflow}/runs?branch=main&event=push&per_page=100${query}`);
  return data.workflow_runs;
}

/** Every job of a run's latest attempt. */
async function jobs(run) {
  const all = [];
  for (let page = 1; ; page++) {
    const data = await get(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`);
    all.push(...data.jobs);
    if (all.length >= data.total_count || data.jobs.length === 0) return all;
  }
}

/** Why a completed run does not count as green, or undefined if it does. */
async function notGreen(run) {
  if (run.conclusion !== 'success') return `the run concluded ${run.conclusion}`;
  // Pushes to main run the full matrix (select-tests.mjs --full), so a successful push run is a full run.
  const bad = (await jobs(run)).filter((job) => job.conclusion !== 'success' && job.conclusion !== 'skipped');
  if (bad.length > 0) return `jobs did not succeed: ${bad.map((j) => `${j.name} (${j.conclusion})`).join(', ')}`;
  return undefined;
}

const describe = (run) => `${run.head_sha} (${run.display_title}), run ${run.html_url}, ${run.updated_at}`;

async function latestGreen() {
  for (const run of await mainRuns('&status=completed')) {
    if ((await notGreen(run)) === undefined) {
      console.log(describe(run));
      return 0;
    }
  }
  console.log('no green CI run on main among the latest 100');
  return 1;
}

async function requireGreen(sha, waitMinutes) {
  const deadline = Date.now() + waitMinutes * 60_000;
  for (;;) {
    const runs = (await mainRuns(`&head_sha=${sha}`)).filter((run) => run.head_sha === sha);
    // The newest run for the commit; re-running jobs updates that run.
    const run = runs[0];
    if (run === undefined) {
      const { status } = await get(`compare/main...${sha}`);
      if (status !== 'identical' && status !== 'behind') {
        console.log(`refusing ${sha}: the commit is not on main, so it has no post-merge CI run`);
        return 1;
      }
      if (Date.now() >= deadline) {
        console.log(`refusing ${sha}: no CI run for a push of this commit to main`);
        return 1;
      }
      console.log(`waiting for a CI run on ${sha}`);
    } else if (run.status === 'completed') {
      const reason = await notGreen(run);
      if (reason === undefined) {
        console.log(`CI is green on ${describe(run)}`);
        return 0;
      }
      console.log(`refusing ${sha}: ${reason} (${run.html_url})`);
      return 1;
    } else if (Date.now() >= deadline) {
      console.log(`refusing ${sha}: CI is still ${run.status} after ${waitMinutes} minutes (${run.html_url})`);
      return 1;
    } else console.log(`waiting for CI on ${sha}: ${run.status} (${run.html_url})`);
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
}

const [command, ...args] = process.argv.slice(2);
const waitAt = args.indexOf('--wait');
const wait = waitAt >= 0 ? Number(args[waitAt + 1]) : 0;
if (command === 'latest-green') process.exitCode = await latestGreen();
else if (command === 'require-green' && /^[0-9a-f]{40}$/.test(args[0] ?? ''))
  process.exitCode = await requireGreen(args[0], wait);
else {
  console.error('usage: ci-status.mjs latest-green | require-green <40-character sha> [--wait <minutes>]');
  process.exitCode = 2;
}
