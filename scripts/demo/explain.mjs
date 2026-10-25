// Records the illustrated explainer: what tslaws is and what it offers, with no test-running screens. It is a story in flat
// pictures, paced by the narration; the code and the command output in it are the real ones (examples/checkout, captures/).
// Render the voice first:  NARRATION=explainer.json KOKORO_DIR=<dir> node voice.mjs <vo> <voice>
// Then:                    node explain.mjs <vo-dir> <out-dir>      and   node mix.mjs <vo-dir> <out-dir> <result.mp4>
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const [voDir, outDir] = process.argv.slice(2);
const lines = JSON.parse(readFileSync(new URL('explainer.json', import.meta.url), 'utf8'));
const seconds = (file) =>
  Number(
    spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], {
      encoding: 'utf8',
    }).stdout,
  );
const lengths = Object.fromEntries(Object.keys(lines).map((key) => [key, seconds(join(voDir, `${key}.wav`))]));
const capture = (name) =>
  readFileSync(new URL(`captures/${name}`, import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !/^\s+(hint|reproduce):/.test(l) && !/^\d+ laws:/.test(l));

const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const ink = '#1b1b30';
const css = `
@import url('https://fonts.googleapis.com/css2?family=Josefin+Sans:wght@300;400;600&family=JetBrains+Mono:wght@400;700&display=swap');
:root{--cream:#efe7d3;--ink:${ink};--yellow:#f2c230;--blue:#2c3ea3;--navy:#141a3a;--red:#c8372d;--pink:#f2b3b3;--green:#2f9e5e;--mint:#b9e0c4}
*{box-sizing:border-box}
body{margin:0;width:960px;height:960px;overflow:hidden;background:var(--bg,var(--cream));color:var(--ink);font-family:'Josefin Sans','Segoe UI',sans-serif;position:relative}
.a{opacity:0;animation:in .8s cubic-bezier(.2,.8,.2,1) forwards;animation-delay:var(--d,0s)}
@keyframes in{from{opacity:0;transform:translateY(26px) scale(.96)}to{opacity:1;transform:none}}
.abs{position:absolute}
.mono{font-family:'JetBrains Mono',Consolas,monospace}
.sun{position:absolute;border-radius:50%;background:var(--yellow)}
.card{position:absolute;background:#fff8;border:3px solid var(--ink);border-radius:14px}
.note{position:absolute;background:var(--pink);border:3px solid var(--ink);padding:14px 20px;font-size:34px;line-height:1.25;border-radius:6px;box-shadow:6px 6px 0 var(--ink)}
.term{position:absolute;background:var(--navy);color:#e8ecff;border-radius:14px;padding:26px 30px;font:25px/1.6 'JetBrains Mono',Consolas,monospace;box-shadow:8px 8px 0 #0004}
.term .ok{color:#4ade80;font-weight:700}.term .bad{color:#ff6b61;font-weight:700}.term .dim{color:#8f99c8}
.pill{position:absolute;padding:6px 18px;border-radius:8px;font:600 32px 'Josefin Sans';border:3px solid var(--ink)}
.cap{position:absolute;left:0;right:0;text-align:center;font-size:42px;font-weight:300}
.code{position:absolute;background:#fffdf5;border:3px solid var(--ink);border-radius:12px;padding:26px 30px;font:27px/1.55 'JetBrains Mono',Consolas,monospace;white-space:pre}
.kw{color:var(--red);font-weight:700}.ty{color:var(--blue)}.cm{color:#8a8a9a}
`;
const doc = (bg, body) => `<!doctype html><meta charset=utf-8><style>${css}</style><body style="--bg:${bg}">${body}`;
const at = (d) => `style="--d:${d}s"`;
const star = (i, hot) => {
  const x = 40 + ((i * 97) % 880);
  const y = 60 + ((i * 53 + (i % 7) * 31) % 600);
  return { x, y, hot };
};
const dots = (n, litIndexes, delayFor) =>
  Array.from({ length: n }, (_, i) => {
    const s = star(i);
    const lit = litIndexes.includes(i);
    return `<circle class="a" ${at(delayFor(i))} cx="${s.x}" cy="${s.y}" r="${lit ? 7 : 4}" fill="${lit ? '#f2c230' : '#e8ecff'}"/>${lit ? `<circle class="a" ${at(delayFor(i) + 0.2)} cx="${s.x}" cy="${s.y}" r="18" fill="none" stroke="#f2c230" stroke-width="3"/>` : ''}`;
  }).join('');
const termLines = (rows, start, gap) =>
  rows
    .map((l, i) => {
      const html = esc(l)
        .replace(/^(PROVED)/, '<span class="ok">$1</span>')
        .replace(/^(FAILED|TAMPERED)/, '<span class="bad">$1</span>')
        .replace(/(counterexample: .*)$/, '<span class="bad">$1</span>');
      return `<div class="a" ${at(start + i * gap)}>${html}</div>`;
    })
    .join('');
const codeHtml = (text) =>
  esc(text)
    .replace(/\b(export|law|return|import|from|assume)\b/g, '<span class="kw">$1</span>')
    .replace(/\b(number|int)\b/g, '<span class="ty">$1</span>')
    .replace(/(\/\/.*)$/gm, '<span class="cm">$1</span>');

const stripes = (x, y, w, h) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#fffdf5" stroke="${ink}" stroke-width="4"/>` +
  Array.from({ length: Math.floor(h / 22) }, (_, i) => `<line x1="${x + 14}" x2="${x + w - 14 - ((i * 37) % 90)}" y1="${y + 18 + i * 22}" y2="${y + 18 + i * 22}" stroke="${i % 6 === 3 ? '#c8372d' : '#6a6a80'}" stroke-width="3"/>`).join('');

const scenes = {
  title: () =>
    doc(
      'var(--cream)',
      `<div class="sun a" style="width:300px;height:300px;right:90px;top:90px"></div>
       <div class="abs a" style="left:80px;top:250px;font-size:92px;font-weight:300;line-height:1.05">Why agents<br>need</div>
       <div class="abs a" style="--d:.5s;left:80px;top:470px;font-size:210px;font-weight:600;color:var(--red);line-height:1">laws</div>
       <div class="abs a mono" style="--d:1s;left:84px;top:760px;font-size:30px;color:#6a6a80">tslaws</div>`,
    ),
  stack: () =>
    doc(
      'var(--cream)',
      `<div class="sun a" style="width:260px;height:260px;right:120px;top:120px"></div>
       <svg class="abs" width="960" height="960"><g class="a" style="--d:.2s">${stripes(160, 380, 520, 360)}</g>
       <polygon class="a" style="--d:.3s" points="680,380 760,330 760,690 680,740" fill="${'#2c3ea3'}" stroke="${ink}" stroke-width="4"/>
       <polygon class="a" style="--d:.3s" points="160,380 240,330 760,330 680,380" fill="#fffdf5" stroke="${ink}" stroke-width="4"/></svg>
       <div class="abs a" style="--d:.5s;left:80px;top:90px;font-size:150px;font-weight:600;color:var(--red)">3,000</div>
       <div class="abs a" style="--d:.7s;left:86px;top:250px;font-size:48px;font-weight:300">lines, written by your agent</div>`,
    ),
  read: () =>
    doc(
      '#b9c6d8',
      `<div class="sun" style="width:220px;height:220px;left:110px;top:90px"></div>
       <svg class="abs" width="960" height="960"><g>${stripes(380, 100, 440, 700)}</g>
       <g class="a" style="--d:.4s"><circle cx="560" cy="430" r="120" fill="#fffdf5cc" stroke="${ink}" stroke-width="10"/><line x1="650" y1="520" x2="780" y2="650" stroke="${ink}" stroke-width="18" stroke-linecap="round"/></g></svg>
       <div class="abs a" style="--d:.9s;left:70px;top:420px;font-size:40px">you asked:</div>
       <div class="note a" style="--d:1.1s;left:70px;top:480px;width:360px">add a coupon code at checkout</div>
       <div class="abs a" style="--d:2s;left:200px;top:640px;font-size:200px;font-weight:600;color:var(--red)">?</div>`,
    ),
  rules: () =>
    doc(
      '#ecd27a',
      `<div class="card a" style="--d:.1s;left:70px;top:520px;width:240px;height:300px;transform:rotate(-4deg)"></div>
       <div class="card a" style="--d:.2s;left:360px;top:540px;width:240px;height:300px"></div>
       <div class="card a" style="--d:.3s;left:650px;top:520px;width:240px;height:300px;transform:rotate(4deg)"></div>
       <div class="note a mono" style="--d:.5s;left:150px;top:120px;width:660px;font-size:36px;transform:rotate(-1.5deg)"><b>RULES.md</b><br>· never charge a negative total<br>· keep the tests green</div>
       <svg class="abs" width="960" height="960"><ellipse class="a" style="--d:1.6s" cx="480" cy="690" rx="140" ry="60" fill="none" stroke="${'#c8372d'}" stroke-width="6"/>
       <g class="a" style="--d:2s" stroke="#c8372d" stroke-width="10" stroke-linecap="round"><line x1="640" y1="440" x2="690" y2="500"/><line x1="690" y1="440" x2="640" y2="500"/></g></svg>
       <div class="cap a" style="--d:2.6s;top:860px;font-size:44px">a request, not a guarantee</div>`,
    ),
  tests: () =>
    doc(
      'var(--navy)',
      `<svg class="abs" width="960" height="960" style="top:0">${dots(150, [4, 33, 58, 91, 117], (i) => 0.1 + (i % 30) * 0.02)}</svg>
       <div class="abs a" style="--d:.2s;left:0;right:0;top:20px;text-align:center;color:#e8ecff;font-size:46px;font-weight:300">every possible input</div>
       <div class="abs a" style="--d:2.2s;left:70px;top:700px;color:var(--yellow);font-size:50px">tests: the cases someone thought of</div>
       <div class="abs a mono" style="--d:3.4s;left:70px;top:790px;color:#e8ecff99;font-size:30px">written by the same agent</div>`,
    ),
  law: () =>
    doc(
      '#e8dfc6',
      `<div class="abs a mono" style="right:60px;top:60px;font-size:30px;color:var(--blue)">cart.laws.ts</div>
       <div class="code a" style="--d:.3s;left:60px;top:140px;width:840px;font-size:29px">${codeHtml(
         'export law totalNeverNegative(\n  price: int, coupon: int) {\n  assume(price >= 0 && coupon >= 0);\n  return total(price, coupon) >= 0;\n}',
       )}</div>
       <div class="pill a" style="--d:1.6s;left:60px;top:560px;background:var(--pink)">you write the rule, once</div>
       <div class="pill a" style="--d:2.6s;left:60px;top:650px;background:#fff8">plain TypeScript</div>
       <div class="sun a" style="--d:.2s;width:150px;height:150px;right:70px;bottom:80px"></div>`,
    ),
  every: () =>
    doc(
      '#1d2a7a',
      `<svg class="abs" width="960" height="960">${dots(150, [], (i) => 0.3 + i * 0.045)}</svg>
       <div class="abs" style="left:0;right:0;top:20px;text-align:center;color:#e8ecff;font-size:46px;font-weight:300">generated inputs, hunting for a break</div>
       <div class="pill a" style="--d:6.4s;left:70px;top:740px;background:var(--mint);font-size:52px">proved for every input ✓</div>`,
    ),
  gate: () =>
    doc(
      'var(--cream)',
      `<div class="sun a" style="width:130px;height:130px;left:70px;top:230px"></div>
       <div class="abs a" style="--d:.1s;left:70px;top:390px;font-size:44px">agent</div>
       <div class="code a" style="--d:.3s;left:60px;top:470px;width:250px;height:180px;padding:20px;font-size:22px">${codeHtml('total(\n  price, coupon)')}</div>
       <svg class="abs" width="960" height="960"><g class="a" style="--d:1.2s;stroke:${ink};stroke-width:6;fill:none"><path d="M320 560 H400"/><path d="M400 560 l-18 -14 M400 560 l-18 14"/></g>
       <g class="a" style="--d:3.4s;stroke:#2f9e5e;stroke-width:8;fill:none"><path d="M700 560 H780"/><path d="M780 560 l-18 -14 M780 560 l-18 14"/></g>
       <g class="a" style="--d:5.2s;stroke:#c8372d;stroke-width:8;fill:none;stroke-linecap:round"><path d="M550 650 V760"/><line x1="515" y1="760" x2="585" y2="800"/><line x1="585" y1="760" x2="515" y2="800"/></g></svg>
       <div class="abs a" style="--d:1.5s;left:410px;top:430px;width:280px;height:230px;background:var(--blue);border:4px solid ${ink};border-radius:140px 140px 10px 10px;box-shadow:8px 8px 0 #0003"></div>
       <div class="abs a" style="--d:1.8s;left:410px;top:520px;width:280px;text-align:center;color:#fff;font-size:48px;font-weight:600">your laws</div>
       <div class="abs a" style="--d:3.6s;left:780px;top:480px;font-size:44px;color:var(--green);font-weight:600">lands ✓</div>
       <div class="abs a" style="--d:5.4s;left:620px;top:790px;font-size:40px;color:var(--red)">fails: stays out</div>`,
    ),
  story1: () =>
    doc(
      '#2f9e5e',
      `<div class="abs a" style="left:60px;top:60px;font-size:48px;color:#fff">you: "add a coupon code at checkout"</div>
       <div class="pill a" style="--d:.8s;left:60px;top:150px;background:#fff8;font-size:30px">the agent's first try</div>
       <div class="code a mono" style="--d:1.2s;left:60px;top:240px;width:840px;font-size:30px">${codeHtml(
         'export function total(price, coupon) {\n  return price - coupon;\n}',
       )}</div>
       <div class="abs a" style="--d:3s;left:60px;top:560px;background:var(--mint);border:3px solid ${ink};border-radius:10px;padding:10px 24px;font-size:44px;font-weight:600">its tests: all pass ✓</div>`,
    ),
  story2: () =>
    doc(
      '#2f9e5e',
      `<div class="abs a" style="left:60px;top:50px;font-size:46px;color:#fff;--d:.1s">a coupon bigger than the basket</div>
       <div class="pill a" style="--d:.8s;left:60px;top:140px;background:#fff8">basket 0</div>
       <div class="pill a" style="--d:1.4s;left:270px;top:140px;background:#fff8">coupon 1</div>
       <div class="pill a" style="--d:2s;left:490px;top:140px;background:var(--pink);color:var(--red)">total −1</div>
       <div class="note a" style="--d:3s;left:60px;top:250px;font-size:34px">law: total is never below zero</div>
       <div class="term" style="left:60px;top:370px;width:840px;height:300px">
        <div class="a" ${at(4)}><span class="dim">$ tslaws check</span></div>${termLines(capture('checkout-bad.txt').slice(0, 3), 4.8, 0.9)}</div>
       <div class="abs a" style="--d:8s;left:60px;top:720px;font-size:44px;color:#fff">the smallest case that breaks it, and a seed to replay it</div>`,
    ),
  story3: () =>
    doc(
      '#2f9e5e',
      `<div class="abs a" style="left:60px;top:50px;font-size:46px;color:#fff">fix the code, not the law</div>
       <div class="code a mono" style="--d:.8s;left:60px;top:150px;width:840px;font-size:30px"><span style="color:#c8372d">- return price - coupon;</span>
<span style="color:#1d7a43">+ return Math.max(0, price - coupon);</span></div>
       <div class="term" style="left:60px;top:400px;width:840px;height:250px">
        <div class="a" ${at(2)}><span class="dim">$ tslaws check</span></div>${termLines(capture('checkout-good.txt'), 2.8, 0.9)}</div>
       <div class="abs a" style="--d:4.4s;left:60px;top:700px;font-size:48px;color:#fff">proved, for every price and every coupon</div>`,
    ),
  lock: () => {
    const tamper = capture('checkout-tamper.txt').slice(0, 2);
    return doc(
      '#d9d0e8',
      `<svg class="abs a" style="left:70px;top:90px" width="260" height="300"><path d="M60 140 V90 a70 70 0 0 1 140 0 V140" fill="none" stroke="${ink}" stroke-width="22"/><rect x="30" y="130" width="200" height="150" rx="16" fill="#f2c230" stroke="${ink}" stroke-width="8"/><circle cx="130" cy="195" r="18" fill="${ink}"/><rect x="123" y="195" width="14" height="50" fill="${ink}"/></svg>
       <div class="note a" style="--d:.5s;left:380px;top:120px;width:500px">laws are locked</div>
       <div class="note a" style="--d:1.5s;left:380px;top:230px;width:500px;background:#fff8;font-size:30px">only you can accept a change</div>
       <div class="term" style="left:60px;top:470px;width:840px;height:250px"><div class="a" ${at(3)}><span class="dim">$ tslaws check   # the agent edited a law</span></div>${termLines(tamper, 3.8, 0.8)}</div>`,
    );
  },
  where: () => {
    const tiles = [
      ['terminal', '>_', '#2c3ea3'],
      ['CI', '✓', '#2f9e5e'],
      ['editor', '{ }', '#c8372d'],
      ['Claude Code hook', '⚑', '#f2c230'],
      ['real browser', '◧', '#2c3ea3'],
      ['whole apps', '▣', '#2f9e5e'],
    ];
    return doc(
      'var(--cream)',
      `<div class="abs a" style="left:70px;top:70px;font-size:64px;font-weight:300">runs where the work happens</div>
       ${tiles
         .map(
           ([label, glyph, color], i) =>
             `<div class="a" style="--d:${0.6 + i * 0.9}s;position:absolute;left:${70 + (i % 3) * 290}px;top:${230 + Math.floor(i / 3) * 330}px;width:260px;height:290px;text-align:center">
               <div style="height:210px;border-radius:26px;background:${color};border:4px solid ${ink};box-shadow:8px 8px 0 ${ink};color:#fff;font:700 82px 'JetBrains Mono';display:grid;place-items:center">${glyph}</div>
               <div style="font-size:38px;margin-top:16px">${label}</div></div>`,
         )
         .join('')}`,
    );
  },
  outro: () =>
    doc(
      'var(--red)',
      `<div class="sun a" style="width:240px;height:240px;right:110px;top:110px"></div>
       <div class="abs a" style="--d:.3s;left:80px;top:330px;font-size:190px;font-weight:600;color:#fff;letter-spacing:-4px">tslaws</div>
       <div class="abs a" style="--d:1.2s;left:86px;top:580px;font-size:56px;font-weight:300;color:#fff">Trust the code you did not write.</div>
       <div class="abs a mono" style="--d:2s;left:86px;top:720px;font-size:40px;color:var(--yellow)">npm i -D tslaws</div>`,
    ),
};

const W = 960;
const browser = await chromium
  .launch({ channel: 'chrome', headless: false })
  .catch(() => chromium.launch({ channel: 'msedge', headless: false }));
const context = await browser.newContext({
  viewport: { width: W, height: W },
  recordVideo: { dir: join(outDir, 'video'), size: { width: W, height: W } },
});
const page = await context.newPage();
const t0 = Date.now();
const timings = {};
const cues = [];
let voiceEnd = 0;
for (const key of Object.keys(lines)) {
  const left = voiceEnd - (Date.now() - t0);
  if (left > 0) await page.waitForTimeout(left + 250);
  await page.setContent(scenes[key](), { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  timings[key] = (Date.now() - t0) / 1000;
  voiceEnd = Date.now() - t0 + lengths[key] * 1000;
}
await page.waitForTimeout(Math.max(0, voiceEnd - (Date.now() - t0)) + 1200);
await context.close();
await browser.close();
writeFileSync(join(outDir, 'timings.json'), JSON.stringify({ lines: timings, cues }, null, 2));
console.log('recorded', timings);
