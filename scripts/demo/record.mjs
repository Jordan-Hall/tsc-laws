// Records the intro video from the real dashboard and real laws, paced by the narration. Start `tslaws ui --no-open --port 4803`
// in examples/basic and `--port 4804` in examples/react, render the voice with voice.ps1 into <vo>, then:
//   node record.mjs <vo-dir> <out-dir>
// It writes <out-dir>/video/*.webm and <out-dir>/timings.json (when each line starts); mix.mjs lays the voice over it.
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
const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch({ channel: 'msedge' }));
const context = await browser.newContext({
  viewport: { width: W, height: H },
  recordVideo: { dir: join(outDir, 'video'), size: { width: W, height: H } },
});
const page = await context.newPage();
const t0 = Date.now();
const timings = {};
let voiceEnd = 0;

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
  if (left > 0) await page.waitForTimeout(left + 350);
};

/** Starts a line of narration now (after the previous one ends) with its words as the caption. The voice plays while the page keeps going. */
const say = async (key, { subtitle = true } = {}) => {
  await finishVoice();
  timings[key] = (Date.now() - t0) / 1000;
  voiceEnd = Date.now() - t0 + lengths[key] * 1000;
  if (subtitle) await caption(lines[key]);
};

const card = async (key, title, sub) => {
  await say(key, { subtitle: false });
  await page.setContent(`<!doctype html><meta charset=utf-8><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0f1220;color:#fff;font-family:system-ui,Segoe UI,sans-serif">
    <div style="text-align:center;max-width:1100px;padding:0 40px"><div style="font-size:84px;font-weight:800;letter-spacing:-2px">${title}</div>
    ${sub.map((l) => `<div style="font-size:30px;margin-top:22px;color:#b9c0d8">${l}</div>`).join('')}</div>`);
  await finishVoice();
};

const open = async (port) => {
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('#status');
};
const idle = async (timeout = 180000) => {
  await page.waitForFunction(() => !/Running/.test(document.getElementById('status')?.textContent ?? 'Running'), null, {
    timeout,
  });
};
const click = async (locator) => {
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + 30, box.y + box.height / 2, { steps: 25 });
  await page.waitForTimeout(350);
  await locator.click();
};

await card('intro', 'tslaws', [
  'Write the laws. Let an agent write the code.',
  'Every change is checked against the laws before it lands.',
]);

await open(4803);
await page.mouse.move(700, 300);
await say('basic');
await idle();
await say('fails');
await click(page.getByText('sortKeepsLength').first());
await say('shrunk');
await finishVoice();
await say('proved');
await click(page.getByText('addIdentity').first());
await finishVoice();
await say('tested');
await click(page.getByText('addCommutes').first());
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
await card('outro', 'npm i -D tslaws', [
  'TypeScript stays TypeScript. Laws are checked by the compiler, the prover and a real browser.',
  'github.com/Jordan-Hall/tsc-laws',
]);
await page.waitForTimeout(1500);

await context.close();
await browser.close();
writeFileSync(join(outDir, 'timings.json'), JSON.stringify(timings, null, 2));
console.log('recorded', timings);
