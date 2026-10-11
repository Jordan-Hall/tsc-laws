import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const probe = createServer();
await new Promise((resolve, reject) => {
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', resolve);
});
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));

const server = spawn(
  process.execPath,
  [require.resolve('next/dist/bin/next'), 'start', '--hostname', '0.0.0.0', '--port', String(port)],
  {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let output = '';
server.stdout.on('data', (data) => {
  output = `${output}${data}`.slice(-8_000);
});
server.stderr.on('data', (data) => {
  output = `${output}${data}`.slice(-8_000);
});
let startupError;
server.on('error', (error) => {
  startupError = error;
});
const stopped = new Promise((resolve) => server.once('exit', resolve));
const origin = `http://127.0.0.1:${port}`;
const headers = { 'user-agent': 'Mozilla/5.0', accept: 'text/html' };

async function* pages(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* pages(filename);
    else if (filename.endsWith('.mdx')) {
      const relative = path.relative(path.join(root, 'content/docs'), filename).replaceAll(path.sep, '/');
      yield {
        route: `/${relative.replace(/\.mdx$/, '').replace(/(^|\/)index$/, '')}`.replace(/\/$/, '') || '/',
        text: await readFile(filename, 'utf8'),
      };
    }
  }
}

try {
  let ready = false;
  let lastProbe = '';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (startupError) throw startupError;
    if (server.exitCode !== null) throw new Error(`Documentation server exited: ${output}`);
    try {
      const response = await fetch(origin, { headers, signal: AbortSignal.timeout(1_000), redirect: 'manual' });
      lastProbe = `HTTP ${response.status}, location ${response.headers.get('location')}`;
      if (response.ok) {
        ready = true;
        break;
      }
    } catch (error) {
      lastProbe = `${error.message}: ${error.cause?.message ?? ''}`;
    }
    await setTimeout(200);
  }
  assert.ok(ready, `Documentation server did not become ready (${lastProbe}): ${output}`);
  let checked = 0;
  for await (const { route, text } of pages(path.join(root, 'content/docs'))) {
    const title = text.match(/^title: (.+)$/m)[1];
    const html = await fetch(`${origin}${route}`, { headers });
    assert.equal(html.status, 200, `${route}: HTML status`);
    assert.match(html.headers.get('content-type'), /text\/html/);
    assert.match(await html.text(), /data-geistdocs-article="body"/, `${route}: missing article`);

    const markdownPath = route === '/' ? '/index.md' : `${route}.md`;
    const markdown = await fetch(`${origin}${markdownPath}`, { headers });
    assert.equal(markdown.status, 200, `${markdownPath}: Markdown status`);
    assert.match(markdown.headers.get('content-type'), /text\/markdown/);
    assert.ok((await markdown.text()).includes(title), `${markdownPath}: missing title`);

    const negotiated = await fetch(`${origin}${route}`, { headers: { ...headers, accept: 'text/markdown' } });
    assert.equal(negotiated.status, 200, `${route}: negotiated status`);
    assert.match(negotiated.headers.get('content-type'), /text\/markdown/);
    assert.ok((await negotiated.text()).includes(title), `${route}: missing negotiated title`);
    checked += 1;
  }

  const search = await fetch(`${origin}/api/search?query=variance`, { headers });
  assert.equal(search.status, 200);
  assert.ok((await search.json()).some((result) => result.id === '/typescript/type-system/variance'));
  const all = await fetch(`${origin}/llms.txt`, { headers });
  assert.equal(all.status, 200);
  const full = await all.text();
  assert.ok(full.includes('Conditional types') && full.includes('Getting started'));

  for (const route of ['/missing-page', '/missing-page.md']) {
    const response = await fetch(`${origin}${route}`, { headers });
    assert.equal(response.status, 404, `${route}: missing page status`);
  }
  console.log(
    `Verified HTML, Markdown, and content negotiation for ${checked} pages; search, full Markdown, and 404s passed.`,
  );
} finally {
  server.kill('SIGTERM');
  await Promise.race([stopped, setTimeout(5_000)]);
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
}
