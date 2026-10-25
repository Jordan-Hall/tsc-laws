// Records the intro video from the real dashboard and real laws, paced by the narration. Start `tslaws ui --no-open --port 4803`
// in examples/basic, `--port 4804` in examples/react and `--port 4805` in examples/e2e, render the voice with voice.ps1 into <vo>, then:
//   node record.mjs <vo-dir> <out-dir>
// It writes <out-dir>/video/*.webm and <out-dir>/timings.json (when each line starts, and the sound cues); mix.mjs lays the sound over it.
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
// The captions are the first sentence of each line, spelled the way it is written rather than the way it is said.
const written = (text) =>
  text
    .replace(/T S laws/g, 'tslaws')
    .replace(/V S Code/g, 'VS Code')
    .replace(/C I/g, 'CI')
    .replace(/axe core/g, 'axe-core');
const shortCaption = (text) => written(text.split(/(?<=[.?!])\s/)[0]);

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

const overlay = `
(() => {
  if (document.getElementById('__cap')) return;
  const s = document.createElement('style');
  s.textContent = '#__cap{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);max-width:1000px;padding:14px 26px;border-radius:12px;background:rgba(15,18,28,.92);color:#fff;font:600 21px/1.35 system-ui,Segoe UI,sans-serif;text-align:center;z-index:99999;box-shadow:0 6px 24px rgba(0,0,0,.35);transition:opacity .25s}#__cur{position:fixed;width:18px;height:18px;border-radius:50%;background:rgba(255,90,60,.8);border:2px solid #fff;z-index:100000;pointer-events:none;transform:translate(-50%,-50%);left:-50px;top:-50px}';
  document.head.append(s);
  const c = document.createElement('div'); c.id = '__cap'; c.style.opacity = 0; document.body.append(c);
  const k = document.createElement('div'); k.id = '__cur'; document.body.append(k);
  addEventListener('mousemove', (e) => { k.style.left = e.clientX + 'px'; k.style.top = e.clientY + 'px'; }, true);
})();`;

const caption = async (text) => {
  await page.evaluate(overlay);
  await page.evaluate((t) => {
    const c = document.getElementById('__cap');
    c.textContent = t;
    c.style.opacity = t ? 1 : 0;
  }, text);
};

/** Waits until the voice has finished the line it is on. */
const finishVoice = async () => {
  const left = voiceEnd - (Date.now() - t0);
  if (left > 0) await page.waitForTimeout(left + 450);
};

/** Starts a line of narration now (after the previous one ends) with a short caption. The voice plays while the page keeps going. */
const say = async (key, { subtitle = true } = {}) => {
  await finishVoice();
  timings[key] = (Date.now() - t0) / 1000;
  voiceEnd = Date.now() - t0 + lengths[key] * 1000;
  if (subtitle) await caption(shortCaption(lines[key]));
};

/** A full-screen card for a line that is about the idea and not about a screen. */
const card = async (key, title, sub = [], list = []) => {
  await say(key, { subtitle: false });
  await page.setContent(`<!doctype html><meta charset=utf-8><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0f1220;color:#fff;font-family:system-ui,Segoe UI,sans-serif">
    <div style="text-align:center;max-width:1100px;padding:0 40px"><div style="font-size:78px;font-weight:800;letter-spacing:-2px">${title}</div>
    ${sub.map((l) => `<div style="font-size:30px;margin-top:22px;color:#b9c0d8">${l}</div>`).join('')}
    ${list.length === 0 ? '' : `<ul style="list-style:none;padding:0;margin:34px auto 0;text-align:left;display:inline-block;font-size:30px;line-height:1.9">${list.map((l) => `<li><span style="color:#7dd3fc">&#10003;</span>&nbsp; ${l}</li>`).join('')}</ul>`}</div>`);
  await finishVoice();
};

const open = async (port) => {
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('#status');
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
  await page.waitForTimeout(350);
  cue('click');
  await locator.click();
};

await card('intro', 'tslaws', ['Laws for TypeScript.', 'Checked by a compiler, a prover and a real browser.']);
await card('what', 'You write the laws', ['The agent writes the code.', 'Every change is checked before it lands.']);

await open(4803);
await page.mouse.move(700, 300);
await say('basic');
await idle();
await say('fails');
await click(page.getByText('sortKeepsLength').first());
await say('shrunk');
await finishVoice();
await say('how');
await click(page.getByText('Source', { exact: true }).first());
await finishVoice();
await say('proved');
await click(page.getByText('addIdentity').first());
await finishVoice();
await say('tested');
await click(page.getByText('addCommutes').first());
await finishVoice();
await say('lock');
await page.waitForTimeout(1000);
await finishVoice();

await caption('');
await open(4804);
await page.mouse.move(700, 300);
await say('react');
await finishVoice();
await idle();
await say('all');
await finishVoice();
await say('a11y');
await click(page.getByText('boardIsAccessible').first());
await finishVoice();
await say('speed');
await click(page.getByText('addingATaskIsFast').first());
await finishVoice();
await say('block');
await click(page.getByText('addingATaskDoesNotBlock').first());
await finishVoice();
await say('rerun');
await click(page.locator('#run'));
await finishVoice();
await page.waitForTimeout(8000);
await idle();
await say('watch');
await finishVoice();

await caption('');
await open(4805);
await page.mouse.move(700, 300);
await say('e2e');
await finishVoice();
await say('e2erun');
await click(page.getByText('counterCountsTheUndone').first());
await finishVoice();
await page.waitForTimeout(3000);
await idle();

await caption('');
await card('more', 'And more', [
  'Mutation testing, a regression corpus, reporters for CI,',
  'a VS Code extension and a server agents can call.',
]);
await card(
  'benefits',
  'Why',
  [],
  [
    'Trust code you did not write',
    'Every bug comes with its smallest example',
    'Proof where possible, tests everywhere else',
    'Agents cannot weaken your rules',
    'You stay in TypeScript',
  ],
);
await card('outro', 'npm i -D tslaws', ['Then: npx tslaws init', 'github.com/Jordan-Hall/tsc-laws']);
await page.waitForTimeout(1500);

await context.close();
await browser.close();
writeFileSync(join(outDir, 'timings.json'), JSON.stringify({ lines: timings, cues }, null, 2));
console.log('recorded', timings, cues.length, 'cues');
