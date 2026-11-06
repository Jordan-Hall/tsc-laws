// Renders the results as markdown: one table per workload and size, plus a list of where tslaws is slower.
const seconds = (stat) => (stat === null || stat === undefined ? 'n/a' : (stat.median / 1000).toFixed(2));
const secondsP95 = (stat) => (stat === null || stat === undefined ? 'n/a' : (stat.p95 / 1000).toFixed(2));
const mb = (stat, pick) => (stat === null || stat === undefined ? 'n/a' : (stat[pick] / 2 ** 20).toFixed(0));
const rate = (stat) =>
  stat === null || stat === undefined ? 'n/a' : stat.median < 10 ? stat.median.toFixed(1) : stat.median.toFixed(0);

const titles = {
  'unit-prop': 'Unit and property tests',
  'unit-example': 'Unit tests, example based',
  browser: 'Browser tests',
  e2e: 'End-to-end tests',
};

/** Where tslaws loses: cold or warm median wall time above a comparable tool's. */
function slowerThan(results) {
  const lines = [];
  for (const mine of results.summaries.filter((s) => s.tool === 'tslaws' && s.cold.wallMs !== null)) {
    for (const other of results.summaries.filter(
      (s) =>
        s.workload === mine.workload &&
        s.size === mine.size &&
        s.tool !== 'tslaws' &&
        s.equivalent &&
        !s.probe &&
        s.cold.wallMs !== null,
    )) {
      const parts = [];
      for (const phase of ['cold', 'warm']) {
        const a = mine[phase].wallMs?.median;
        const b = other[phase].wallMs?.median;
        if (a !== undefined && b !== undefined && a > b)
          parts.push(`${phase} ${(a / 1000).toFixed(2)} s against ${(b / 1000).toFixed(2)} s (${(a / b).toFixed(1)}x)`);
      }
      const rss = mine.cold.peakRssBytes?.median;
      const otherRss = other.cold.peakRssBytes?.median;
      if (rss !== undefined && otherRss !== undefined && rss > otherRss)
        parts.push(
          `peak RSS ${(rss / 2 ** 20).toFixed(0)} MB against ${(otherRss / 2 ** 20).toFixed(0)} MB (${(rss / otherRss).toFixed(1)}x)`,
        );
      if (parts.length > 0)
        lines.push(
          `- ${titles[mine.workload]}, ${mine.size} tests: tslaws is slower or larger than ${other.label}: ${parts.join('; ')}.`,
        );
    }
  }
  return lines;
}

export function renderMarkdown(results) {
  const { environment: env } = results;
  const out = [];
  out.push('# tslaws benchmark results', '');
  out.push(
    `Run started ${env.startedAt} on ${env.platform}, ${env.cpu} (${env.logicalCores} logical cores), ${env.memoryGiB} GiB RAM, Node ${env.node}, Chrome ${env.chrome.version}.`,
  );
  out.push(
    `tslaws ${env.tools.tslaws} from ${env.tslawsSource.branch} at ${env.tslawsSource.commit}${env.tslawsSource.uncommittedFiles > 0 ? ` (${env.tslawsSource.uncommittedFiles} uncommitted files under packages/tslaws/src and dist)` : ''}.`,
  );
  out.push(
    `Pinned: ${Object.entries(env.tools)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}.`,
  );
  out.push(
    `Parameters: ${env.parameters.repeats} repeats per cell; ${env.parameters.runs} generated inputs per property test; ${env.parameters.browserRuns} DOM walk-throughs per browser test; ${env.parameters.e2eRuns} fresh-context click-throughs per e2e test. Seconds are wall time; median and p95 (nearest rank) over the repeats. Peak RSS is ${env.rssMeasured}.`,
  );
  out.push('');
  const keys = [...new Set(results.summaries.map((s) => `${s.workload}|${s.size}`))];
  for (const key of keys) {
    const [workload, size] = key.split('|');
    const rows = results.summaries.filter((s) => s.workload === workload && s.size === Number(size));
    const baseline = rows.find((s) => s.tool === 'tslaws');
    out.push(`## ${titles[workload]}, ${size} tests`, '');
    out.push(
      '| Tool | Cold median s | Cold p95 s | Warm median s | Warm p95 s | Tests/s cold | Tests/s warm | Peak RSS median MB | Peak RSS p95 MB | Cold vs tslaws | Repeats |',
    );
    out.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const s of rows) {
      const ratio =
        baseline?.cold.wallMs && s.cold.wallMs
          ? `${(s.cold.wallMs.median / baseline.cold.wallMs.median).toFixed(2)}x`
          : 'n/a';
      const name = `${s.label}${s.equivalent ? '' : ' *'}`;
      if (s.failure !== undefined && s.cold.wallMs === null) {
        out.push(`| ${name} | failed | | | | | | | | | 0 |`);
        continue;
      }
      out.push(
        `| ${name} | ${seconds(s.cold.wallMs)} | ${secondsP95(s.cold.wallMs)} | ${seconds(s.warm.wallMs)} | ${secondsP95(s.warm.wallMs)} | ${rate(s.cold.testsPerSecond)} | ${rate(s.warm.testsPerSecond)} | ${mb(s.cold.peakRssBytes, 'median')} | ${mb(s.cold.peakRssBytes, 'p95')} | ${ratio} | ${s.repeats} |`,
      );
    }
    out.push('');
    const notes = rows.filter((s) => s.note !== undefined || !s.equivalent);
    for (const s of notes) out.push(`- ${s.label}${s.equivalent ? '' : ' (*)'}: ${s.note ?? 'does different work'}.`);
    for (const s of rows.filter((r) => r.failure !== undefined))
      out.push(
        `- ${s.label} ${s.probe ? 'fails as the probe expected' : 'FAILED'}: ${s.failure.split('\n')[0].slice(0, 300)}`,
      );
    out.push('');
  }
  const slower = slowerThan(results);
  out.push('## Where tslaws is slower', '');
  out.push(...(slower.length > 0 ? slower : ['tslaws was not slower than any comparable tool in this run.']), '');
  out.push(
    "Cold means the tool's own caches are cleared first; the operating system file cache is not. Warm means a second run after one source file changed, caches kept. Rows marked * do different work and are not like for like.",
    '',
  );
  return out.join('\n');
}
