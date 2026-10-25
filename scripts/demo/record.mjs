// Records the intro video from the real dashboard, the real laws and real command output, paced by the narration. Start
// `tslaws ui --no-open --port 4803` in examples/basic, `--port 4804` in examples/react and `--port 4805` in examples/e2e,
// render the voice with voice.mjs into <vo>, then:
//   node record.mjs <vo-dir> <out-dir>
// It writes <out-dir>/video/*.webm and <out-dir>/timings.json (when each line starts, and the sound cues); mix.mjs lays the sound over it.
// captures/ holds the output of `tslaws check` on examples/basic, as is and after an agent edits a law. There are no captions:
// the screen shows the product and the voice says what matters.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const [voDir, outDir] = process.argv.slice(2);
const lines = JSON.parse(readFileSync(new URL('narration.json', import.meta.url), 'utf8'));
const seconds = (file) =>
  Number(
    spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], {
      encoding: 'utf8',
    }).stdout,
  );
const lengths = Object.fromEntries(Object.keys(lines).map((key) => [key, seconds(join(voDir, `${key}.wav`))]));

const W = 1360;
const H = 800;
const browser = await chromium
  .launch({ channel: 'chrome', headless: false })
  .catch(() => chromium.launch({ channel: 'msedge', headless: false }));
const context = await browser.newContext({
  viewport: { width: W, height: H },
  recordVideo: { dir: join(outDir, 'video'), size: { width: W, height: H } },
});
const page = await context.newPage();
const t0 = Date.now();
const timings = {};
const cues = [];
let voiceEnd = 0;
const cue = (type) => cues.push({ type, t: (Date.now() - t0) / 1000 });

// A dot that follows the mouse, so a viewer sees what is being clicked.
const pointer = `
(() => {
  if (document.getElementById('__cur')) return;
  const s = document.createElement('style');
  s.textContent = '#__cur{position:fixed;width:18px;height:18px;border-radius:50%;background:rgba(255,90,60,.8);border:2px solid #fff;z-index:100000;pointer-events:none;transform:translate(-50%,-50%);left:-50px;top:-50px}';
  document.head.append(s);
  const k = document.createElement('div'); k.id = '__cur'; document.body.append(k);
  addEventListener('mousemove', (e) => { k.style.left = e.clientX + 'px'; k.style.top = e.clientY + 'px'; }, true);
})();`;

/** Waits until the voice has finished the line it is on, and a breath more. */
const finishVoice = async () => {
  const left = voiceEnd - (Date.now() - t0);
  if (left > 0) await page.waitForTimeout(left + 300);
};

/** Starts a line of narration now, after the previous one ends. The voice plays while the page keeps going. */
const say = async (key) => {
  await finishVoice();
  timings[key] = (Date.now() - t0) / 1000;
  voiceEnd = Date.now() - t0 + lengths[key] * 1000;
};

const card = async (key, title, sub = []) => {
  await say(key);
  await page.setContent(`<!doctype html><meta charset=utf-8><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0f1220;color:#fff;font-family:system-ui,Segoe UI,sans-serif">
    <div style="text-align:center;max-width:1100px;padding:0 40px"><div style="font-size:84px;font-weight:800;letter-spacing:-2px;line-height:1.1">${title}</div>
    ${sub.map((l) => `<div style="font-size:32px;margin-top:24px;color:#b9c0d8">${l}</div>`).join('')}</div>`);
  await finishVoice();
};

const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const frame = (title) => `<!doctype html><meta charset=utf-8><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0f1220;font-family:system-ui,Segoe UI,sans-serif">
  <div style="width:1180px;background:#171b2e;border-radius:14px;box-shadow:0 30px 80px #0008;overflow:hidden">
  <div style="padding:12px 18px;background:#1f2440;display:flex;gap:8px;align-items:center"><i style="width:12px;height:12px;border-radius:50%;background:#ff5f57"></i><i style="width:12px;height:12px;border-radius:50%;background:#febc2e"></i><i style="width:12px;height:12px;border-radius:50%;background:#28c840"></i><span style="color:#8a93b8;margin-left:12px;font:15px ui-monospace,Consolas,monospace">${title}</span></div>
  <pre id="t" style="margin:0;padding:28px 34px;min-height:380px;color:#dfe5ff;font:24px/1.55 ui-monospace,Cascadia Code,Consolas,monospace;white-space:pre-wrap"></pre></div>`;
const show = (html) => page.evaluate((h) => (document.getElementById('t').innerHTML = h), html);

/** The real law source, typed out as if written live, over the length of the line being spoken. */
const typeCode = async (key, file, code) => {
  await say(key);
  await page.setContent(frame(file));
  const step = Math.max(2500, lengths[key] * 1000 - 1800) / code.length;
  for (let i = 1; i <= code.length; i++) {
    const html = esc(code.slice(0, i))
      .replace(/\b(export|law|proved)\b/g, '<b style="color:#c792ea">$1</b>')
      .replace(/\b(number|string|boolean)\b/g, '<span style="color:#ffcb6b">$1</span>');
    await show(`${html}<span style="background:#dfe5ff"> </span>`);
    await page.waitForTimeout(step);
  }
  await finishVoice();
};

/** A terminal that types the command and prints the real output captured from running it. */
const terminal = async (key, command, output) => {
  await say(key);
  await page.setContent(frame('terminal'));
  const color = (l) =>
    esc(l)
      .replace(/^(PROVED)/, '<b style="color:#4ade80">$1</b>')
      .replace(/^(FAILED|TAMPERED)/, '<b style="color:#f87171">$1</b>')
      .replace(/^(TESTED)/, '<b style="color:#fbbf24">$1</b>');
  let typed = '';
  for (const ch of `$ ${command}`) {
    typed += ch;
    await show(esc(typed));
    await page.waitForTimeout(45);
  }
  await page.waitForTimeout(400);
  cue('click');
  const printed = [];
  for (const l of output) {
    printed.push(color(l));
    if (/^(FAILED|TAMPERED)/.test(l)) cue('fail');
    if (/^PROVED/.test(l)) cue('pass');
    await show(`${esc(typed)}\n${printed.join('\n')}`);
    await page.waitForTimeout(/^ /.test(l) ? 120 : 420);
  }
  await finishVoice();
};
const capture = (name) =>
  readFileSync(new URL(`captures/${name}`, import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !/^\s+hint:/.test(l));

const open = async (port) => {
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('#status');
  await page.evaluate(pointer);
};
/** Waits for a run to end, with a sound for how it ended. */
const idle = async (timeout = 180000) => {
  await page.waitForFunction(() => !/Running/.test(document.getElementById('status')?.textContent ?? 'Running'), null, {
    timeout,
  });
  cue(/Failing/.test(await page.locator('#status').innerText()) ? 'fail' : 'pass');
};
const click = async (locator) => {
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + 30, box.y + box.height / 2, { steps: 25 });
  await page.waitForTimeout(300);
  cue('click');
  await locator.click();
};

await card('hook', 'Done?', ['Your agent says so.']);
await card('pain', 'Its own tests', ['Written by the agent.', 'For the agent.']);
await card('idea', 'You write the laws', ['The agent writes the code.', 'Nothing lands until they hold.']);

await typeCode(
  'write',
  'src/math.laws.ts',
  'export law addCommutes(a: number, b: number) => add(a, b) === add(b, a);\n\nexport law proved addIdentity(a: number) => add(a, 0) === a;\n',
);

await open(4803);
await page.mouse.move(700, 300);
await say('run');
await idle();
await click(page.getByText('addIdentity').first());
await finishVoice();
await say('catch');
await click(page.getByText('sortKeepsLength').first());
await finishVoice();

await terminal('lock', 'tslaws check   # after the agent edits addIdentity', capture('tamper.txt'));

await open(4804);
await page.mouse.move(700, 300);
await say('browser');
await click(page.locator('#run'));
await finishVoice();
await page.waitForTimeout(6000);

await open(4805);
await page.mouse.move(700, 300);
await say('e2e');
await click(page.locator('#run'));
await finishVoice();
await page.waitForTimeout(5000);

await terminal('install', 'npm i -D tslaws && npx tslaws check', capture('check.txt'));
await card('outro', 'tslaws', ['Trust the code you did not write.', 'npm i -D tslaws']);
await page.waitForTimeout(1200);

await context.close();
await browser.close();
writeFileSync(join(outDir, 'timings.json'), JSON.stringify({ lines: timings, cues }, null, 2));
console.log('recorded', timings, cues.length, 'cues');
