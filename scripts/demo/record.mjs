// Records the intro video from the real dashboard and real laws: start `tslaws ui --no-open --port 4803` in examples/basic and --port 4804 in examples/react, then run this. Output: video/*.webm (convert with ffmpeg).
import { chromium } from 'playwright-core';

const W = 1360;
const H = 800;
const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch({ channel: 'msedge' }));
const context = await browser.newContext({
  viewport: { width: W, height: H },
  recordVideo: { dir: 'video', size: { width: W, height: H } },
});
const page = await context.newPage();

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

const card = async (title, lines, ms) => {
  await page.setContent(`<!doctype html><meta charset=utf-8><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0f1220;color:#fff;font-family:system-ui,Segoe UI,sans-serif">
    <div style="text-align:center;max-width:1100px;padding:0 40px"><div style="font-size:84px;font-weight:800;letter-spacing:-2px">${title}</div>
    ${lines.map((l) => `<div style="font-size:30px;margin-top:22px;color:#b9c0d8">${l}</div>`).join('')}</div>`);
  await page.waitForTimeout(ms);
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
const glide = async (locator) => {
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + 30, box.y + box.height / 2, { steps: 25 });
};
const click = async (locator) => {
  await glide(locator);
  await page.waitForTimeout(350);
  await locator.click();
};

// 1. Intro.
await card(
  'tslaws',
  ['Write the laws. Let an agent write the code.', 'Every change is checked against the laws before it lands.'],
  6500,
);

// 2. A project with a bug: laws find it.
await open(4803);
await page.mouse.move(700, 300);
await caption('A project with five laws. tslaws is checking them now: proofs, property tests, counterexamples.');
await idle();
await page.waitForTimeout(2500);
await caption('One law fails. The code drops duplicate numbers when sorting.');
await click(page.getByText('sortKeepsLength').first());
await page.waitForTimeout(5000);
await caption('The counterexample is shrunk to the smallest input that breaks the law, so an agent can fix it.');
await page.waitForTimeout(5500);
await click(page.getByText('addIdentity').first());
await caption('"proved": a Z3 proof that holds for every number, not a sample.');
await page.waitForTimeout(5000);
await click(page.getByText('addCommutes').first());
await caption('"tested": 100s of generated inputs, with a recorded seed to replay any failure.');
await page.waitForTimeout(5000);

// 3. Browser laws on a real React app.
await caption('');
await open(4804);
await page.mouse.move(700, 300);
await caption('Same dashboard for a React app. Component and end-to-end laws run in a real browser.');
await page.waitForTimeout(3500);
const browserRow = page.getByText('browser', { exact: true }).first();
await browserRow.waitFor({ timeout: 60000 }).catch(() => undefined);
await page.waitForTimeout(1000);
await idle();
await page.waitForTimeout(2000);
await caption('Component laws, accessibility laws, speed laws and model laws: one dashboard, one run.');
await page.waitForTimeout(4500);
await click(page.getByText('boardIsAccessible').first());
await caption('Accessibility: axe-core audits the real rendered board for every generated state.');
await page.waitForTimeout(5500);
await click(page.getByText('addingATaskIsFast').first());
await caption('Speed: adding a task must stay under budget, timed in the browser on boards of up to 200 tasks.');
await page.waitForTimeout(5500);
await click(page.getByText('addingATaskDoesNotBlock').first());
await caption('And it must not block the main thread: long tasks are measured in the page.');
await page.waitForTimeout(5000);
await click(page.locator('#run'));
await caption('Run everything again: live frames of the real page under test, while each law runs.');
await page.waitForTimeout(16000);
await idle();
await caption('Edit a file and it reruns on its own.');
await page.waitForTimeout(3000);

// 4. Outro.
await caption('');
await card(
  'npm i -D tslaws',
  [
    'TypeScript stays TypeScript. Laws are checked by the compiler, the prover and a real browser.',
    'github.com/Jordan-Hall/tsc-laws',
  ],
  7000,
);

await context.close();
await browser.close();
console.log('recorded');
