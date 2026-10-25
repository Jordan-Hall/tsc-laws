// Records the short intro video from the real dashboard and real laws, paced by the narration. Start `tslaws ui --no-open
// --port 4803` in examples/basic, `--port 4804` in examples/react and `--port 4805` in examples/e2e, render the voice with
// voice.mjs into <vo>, then:
//   node record.mjs <vo-dir> <out-dir>
// It writes <out-dir>/video/*.webm and <out-dir>/timings.json (when each line starts, and the sound cues); mix.mjs lays the sound over it.
// There are no captions: the screen shows the product and the voice says what matters.
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
await card('idea', 'You write the laws', ['The agent writes the code.', 'Nothing lands until they hold.']);

await open(4803);
await page.mouse.move(700, 300);
await say('run');
await idle();
await finishVoice();
await say('catch');
await click(page.getByText('sortKeepsLength').first());
await finishVoice();
await say('source');
await click(page.getByText('Source', { exact: true }).first());
await finishVoice();
await say('proved');
await click(page.getByText('addIdentity').first());
await finishVoice();
await say('lock');
await page.waitForTimeout(500);
await finishVoice();

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

await card('outro', 'tslaws', ['Trust the code you did not write.', 'npm i -D tslaws']);
await page.waitForTimeout(1200);

await context.close();
await browser.close();
writeFileSync(join(outDir, 'timings.json'), JSON.stringify({ lines: timings, cues }, null, 2));
console.log('recorded', timings, cues.length, 'cues');
