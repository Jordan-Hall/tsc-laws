// Records the illustrated explainer: what tslaws is and what it offers, with no test-running screens. It is a story in flat
// pictures, paced by the narration; the code and the command output in it are the real ones (examples/checkout, captures/).
// Render the voice first:  NARRATION=explainer.json KOKORO_DIR=<dir> node voice.mjs <vo> <voice>
// Then:                    node explain.mjs <vo-dir> <out-dir>      and   node mix.mjs <vo-dir> <out-dir> <result.mp4>
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const [voDir, outDir] = process.argv.slice(2);
const lines = JSON.parse(readFileSync(new URL(process.env.NARRATION ?? 'explainer.json', import.meta.url), 'utf8'));
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

// The checkout example's real sources, plus the proposal that was checked for captures/proposed.txt.
const exampleFile = (name) =>
  readFileSync(
    new URL(name.includes('proposed') ? `captures/${name}` : `../../examples/checkout/src/${name}`, import.meta.url),
    'utf8',
  );
// One law declaration of a file, without the comment above it.
const lawOf = (name, law) => {
  const text = exampleFile(name);
  const start = text.indexOf(`export law ${law}`);
  return text.slice(start, text.indexOf('\n}\n', start) + 2);
};
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
.term div{overflow-wrap:anywhere}.term .ok{color:#4ade80;font-weight:700}.term .bad{color:#ff6b61;font-weight:700}.term .dim{color:#8f99c8}
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
        .replace(/^(FAILED|TAMPERED|UNCOVERED)/, '<span class="bad">$1</span>')
        .replace(/(counterexample: .*)$/, '<span class="bad">$1</span>');
      return `<div class="a" ${at(start + i * gap)}>${html}</div>`;
    })
    .join('');
// Rows of real output, with the proof certificate verdicts coloured: certified green, uncertified amber.
const vRows = (rows, start, gap) =>
  rows
    .map((l, i) => {
      const html = esc(l)
        .replace(/^(PROVED)/, '<span class="ok">$1</span>')
        .replace(/^(FAILED|ERROR|TAMPERED|FAIL)\b/, '<span class="bad">$1</span>')
        .replace(/^(TESTED|warn)\b/, '<span style="color:#f2c230;font-weight:700">$1</span>')
        .replace(/(counterexample: .*)$/, '<span class="bad">$1</span>')
        .replace(/certificate: (certified)/, 'certificate: <span class="ok">$1</span>')
        .replace(/(uncertified)/, '<span style="color:#f2c230;font-weight:700">$1</span>')
        .replace(/^(── .* ──)/, '<span class="dim">$1</span>');
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
  Array.from(
    { length: Math.floor(h / 22) },
    (_, i) =>
      `<line x1="${x + 14}" x2="${x + w - 14 - ((i * 37) % 90)}" y1="${y + 18 + i * 22}" y2="${y + 18 + i * 22}" stroke="${i % 6 === 3 ? '#c8372d' : '#6a6a80'}" stroke-width="3"/>`,
  ).join('');

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
         "law('total is never negative',\n  (price: int, coupon: int) => {\n    assume(price >= 0 && coupon >= 0);\n    return total(price, coupon) >= 0;\n  });\n\n// or, with the keyword:\n// export law totalNeverNegative(\n//   price: int, coupon: int) { ... }",
       )}</div>
       <div class="pill a" style="--d:1.6s;left:60px;top:680px;background:var(--pink)">you write the rule, once</div>
       <div class="pill a" style="--d:2.6s;left:60px;top:770px;background:#fff8">a call, or a keyword</div>
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
  d_title: () =>
    doc(
      'var(--cream)',
      `<div class="sun a" style="width:300px;height:300px;right:90px;top:90px"></div>
       <div class="abs a" style="left:80px;top:300px;font-size:96px;font-weight:300;line-height:1.05">Laws,<br>migration,<br>and who says</div>
       <div class="abs a" style="--d:.7s;left:80px;top:610px;font-size:200px;font-weight:600;color:var(--red);line-height:1">yes</div>
       <div class="abs a mono" style="--d:1.4s;left:84px;top:840px;font-size:30px;color:#6a6a80">tslaws</div>`,
    ),
  d_picture: () =>
    doc(
      'var(--cream)',
      `<div class="abs a mono" style="left:60px;top:40px;font-size:28px;color:var(--blue)">cart.ts</div>
       <div class="code a" style="--d:.2s;left:60px;top:80px;width:840px;font-size:21px">${codeHtml(exampleFile('cart.ts').split('\n').slice(1).join('\n').trim())}</div>
       <div class="abs a mono" style="--d:1.2s;left:60px;top:280px;font-size:28px;color:var(--blue)">cart.laws.ts</div>
       <div class="code a" style="--d:1.4s;left:60px;top:320px;width:840px;font-size:21px">${codeHtml(lawOf('cart.laws.ts', 'totalNeverNegative'))}</div>
       ${['proved', 'bounded', 'tested', 'open', 'failed']
         .map(
           (s, i) =>
             `<div class="pill a" style="--d:${[4.6, 7.2, 8.4, 9.6, 10.8][i]}s;left:${60 + i * 172}px;top:700px;width:156px;text-align:center;font-size:30px;background:${['#b9e0c4', '#bcd6f0', '#f6e08a', '#e0d6c4', '#f2b3b3'][i]}">${s}</div>`,
         )
         .join('')}
       <div class="abs a" style="--d:3.4s;left:60px;top:790px;font-size:36px">a solver proves it, for every input, where it can</div>
       <div class="abs a" style="--d:6.6s;left:60px;top:850px;font-size:36px;color:#6a6a80">otherwise it is tested with generated inputs</div>`,
    ),
  d_more: () => {
    const tiles = [
      ['real browser', '◧', '#2c3ea3', 1.2, 82],
      ['coverage gate', '▣', '#2f9e5e', 3.2, 82],
      ['lock file', '≡', '#c8372d', 5.4, 82],
      ['editor', '{ }', '#2c3ea3', 8.2, 82],
      ['MCP server', 'MCP', '#2f9e5e', 9.8, 64],
      ['bundler plugins', '.tsrx', '#c8372d', 11.6, 56],
    ];
    return doc(
      'var(--cream)',
      `<div class="abs a" style="left:70px;top:70px;font-size:64px;font-weight:300">and the rest of the toolbox</div>
       ${tiles
         .map(
           ([label, glyph, color, d, size], i) =>
             `<div class="a" style="--d:${d}s;position:absolute;left:${70 + (i % 3) * 290}px;top:${230 + Math.floor(i / 3) * 330}px;width:260px;height:290px;text-align:center">
               <div style="height:210px;border-radius:26px;background:${color};border:4px solid ${ink};box-shadow:8px 8px 0 ${ink};color:#fff;font:700 ${size}px 'JetBrains Mono';display:grid;place-items:center">${glyph}</div>
               <div style="font-size:36px;margin-top:16px">${label}</div></div>`,
         )
         .join('')}`,
    );
  },
  d_pin: () =>
    doc(
      '#e8dfc6',
      `<div class="abs a" style="left:60px;top:60px;font-size:60px;font-weight:300">pin down today's behaviour</div>
       <div class="pill a" style="--d:1.2s;left:60px;top:190px;background:#fff8">total(100, 30) → 70</div>
       <div class="pill a" style="--d:1.9s;left:60px;top:280px;background:#fff8">total(10, 50) → 0</div>
       <div class="term" style="left:60px;top:430px;width:840px;height:250px;font-size:21px"><div class="a" ${at(3)}><span class="dim">$ tslaws check</span></div>${termLines(capture('checkout-good.txt'), 3.6, 0.7)}</div>
       <div class="abs a" style="--d:5.4s;left:60px;top:740px;font-size:44px">the laws hold the behaviour still</div>`,
    ),
  d_port: () =>
    doc(
      '#d9d0e8',
      `<svg class="abs" width="960" height="960"><g class="a" style="--d:.2s">${stripes(60, 90, 300, 190)}</g>
        <g class="a" style="--d:.8s;stroke:${ink};stroke-width:6;fill:none"><path d="M390 185 H530"/><path d="M530 185 l-18 -14 M530 185 l-18 14"/></g>
        <g class="a" style="--d:1.2s">${stripes(560, 90, 300, 190)}</g></svg>
       <div class="abs a" style="--d:.3s;left:60px;top:290px;font-size:34px">today</div>
       <div class="abs a" style="--d:1.3s;left:560px;top:290px;font-size:34px">changed or ported</div>
       <div class="term" style="left:60px;top:360px;width:840px;height:330px;font-size:21px"><div class="a" ${at(2.4)}><span class="dim">$ tslaws check</span></div>${termLines(capture('coverage.txt'), 3, 0.9)}</div>
       <div class="abs a" style="--d:3.2s;left:60px;top:730px;font-size:42px;color:#1d7a43">the laws pass: the behaviour survived</div>
       <div class="abs a" style="--d:6.6s;left:60px;top:810px;font-size:42px;color:var(--red)">no law reaches shipping: still unprotected</div>`,
    ),
  d_lock: () => {
    const tamper = capture('checkout-tamper.txt').slice(0, 2);
    return doc(
      '#d9d0e8',
      `<svg class="abs a" style="left:70px;top:90px" width="260" height="300"><path d="M60 140 V90 a70 70 0 0 1 140 0 V140" fill="none" stroke="${ink}" stroke-width="22"/><rect x="30" y="130" width="200" height="150" rx="16" fill="#f2c230" stroke="${ink}" stroke-width="8"/><circle cx="130" cy="195" r="18" fill="${ink}"/><rect x="123" y="195" width="14" height="50" fill="${ink}"/></svg>
       <div class="note a" style="--d:.4s;left:380px;top:130px;width:500px">the safety net stays put</div>
       <div class="term" style="left:60px;top:470px;width:840px;height:250px"><div class="a" ${at(1.6)}><span class="dim">$ tslaws check   # a law was edited</span></div>${termLines(tamper, 2.2, 0.7)}</div>`,
    );
  },
  d_propose: () =>
    doc(
      'var(--cream)',
      `<div class="abs a mono" style="left:60px;top:40px;font-size:28px;color:var(--blue)">shipping.proposed.laws.ts</div>
       <div class="code a" style="--d:.3s;left:60px;top:90px;width:840px;font-size:26px">${codeHtml(lawOf('shipping.proposed.laws.ts', 'zeroCouponChangesNothing'))}</div>
       <div class="pill a" style="--d:1.4s;left:60px;top:330px;background:#fff8;font-size:30px">written by an agent</div>
       <div class="term" style="left:60px;top:430px;width:840px;height:170px"><div class="a" ${at(3)}><span class="dim">$ tslaws check --proposed</span></div>${termLines(capture('proposed.txt'), 3.8, 0.7)}</div>
       <div class="pill a" style="--d:5.4s;left:60px;top:680px;background:var(--pink)">a proposal protects nothing yet</div>
       <div class="pill a" style="--d:7.6s;left:60px;top:780px;background:var(--mint)">a person decides</div>`,
    ),
  d_refuse: () =>
    doc(
      '#ecd27a',
      `<div class="abs a" style="left:60px;top:50px;font-size:56px;font-weight:300">accept refuses an agent</div>
       <div class="term" style="left:60px;top:150px;width:840px;height:250px;font-size:23px"><div class="a" ${at(0.8)}><span class="dim">$ tslaws accept   # no terminal</span></div>${termLines(capture('accept-refused.txt'), 1.6, 0.9)}</div>
       <div class="term" style="left:60px;top:450px;width:840px;height:170px;font-size:23px"><div class="a" ${at(5)}><span class="dim">$ CI=1 tslaws accept</span></div>${termLines(capture('accept-ci.txt'), 5.8, 0.9)}</div>
       <div class="abs a" style="--d:7s;left:60px;top:690px;font-size:44px">a person at a terminal, and never in CI</div>`,
    ),
  d_grant: () =>
    doc(
      '#e8dfc6',
      `<div class="pill a" style="--d:.2s;left:60px;top:40px;background:var(--mint);font-size:26px">real output</div>
       <div class="term" style="left:60px;top:100px;width:840px;height:150px"><div class="a" ${at(0.5)}><span class="dim">$ tslaws delegate status</span></div>${termLines(capture('delegate-status.txt'), 1.1, 0.7)}</div>
       <div class="pill a" style="--d:2.6s;left:60px;top:290px;background:var(--yellow);font-size:26px">illustration, drawn from docs/laws.md</div>
       <div class="card a" style="--d:3s;left:60px;top:350px;width:840px;height:400px;border-style:dashed;background:#fff9"></div>
       <div class="abs a mono" style="--d:3.4s;left:90px;top:380px;font-size:26px;color:#6a6a80"># a person, at a terminal</div>
       <div class="abs a mono" style="--d:3.8s;left:90px;top:425px;font-size:30px;font-weight:700">$ tslaws delegate grant --for 8h</div>
       <div class="abs a mono" style="--d:6s;left:90px;top:500px;font-size:24px;color:var(--blue)">~/.tslaws/delegation.json</div>
       <div class="abs a mono" style="--d:6.6s;left:90px;top:545px;font-size:24px;line-height:1.5;white-space:pre">{ "grants": [{
    "root": "&lt;this project&gt;",
    "expires": "&lt;now + 8 hours&gt;"
}] }</div>
       <div class="abs a" style="--d:9.2s;left:60px;top:790px;font-size:42px">in your home directory, outside the repository</div>`,
    ),
  d_log: () =>
    doc(
      '#e8dfc6',
      `<div class="pill a" style="--d:.2s;left:60px;top:40px;background:var(--yellow);font-size:26px">illustration, drawn from docs/laws.md</div>
       <div class="abs a" style="--d:.6s;left:60px;top:110px;font-size:50px;font-weight:300">while the grant is live</div>
       <div class="card a" style="--d:1.2s;left:60px;top:210px;width:840px;height:300px;border-style:dashed;background:#fff9"></div>
       <div class="abs a mono" style="--d:1.6s;left:90px;top:240px;font-size:24px;color:var(--blue)">.tslaws/accept.log</div>
       <div class="abs a mono" style="--d:2s;left:90px;top:290px;font-size:25px;line-height:1.5;white-space:pre">&lt;time&gt;  delegated  &lt;grant expiry&gt;
&lt;lock hash before&gt; → &lt;lock hash after&gt;</div>
       <div class="abs a mono" style="--d:3.4s;left:90px;top:410px;font-size:28px;font-weight:700;color:var(--red)">DELEGATED ACCEPT</div>
       <div class="abs a" style="--d:4.2s;left:60px;top:570px;font-size:44px">every delegated accept is logged</div>
       <div class="abs a mono" style="--d:5.6s;left:60px;top:700px;font-size:40px;font-weight:700">$ tslaws delegate revoke</div>
       <div class="abs a" style="--d:6.4s;left:60px;top:780px;font-size:44px;color:#1d7a43">revoking is one command</div>`,
    ),
  d_honest: () =>
    doc(
      'var(--cream)',
      `<div class="abs a" style="left:60px;top:50px;font-size:60px;font-weight:300">the honest limit</div>
       <div class="card a" style="--d:.6s;left:60px;top:170px;width:400px;height:420px;border-color:var(--red);background:#fff8"></div>
       <div class="abs a" style="--d:.8s;left:90px;top:200px;width:340px;font-size:42px;font-weight:600;color:var(--red)">not a sandbox</div>
       <div class="abs a" style="--d:2.2s;left:90px;top:300px;width:340px;font-size:34px;line-height:1.3">an agent running as you could write the grant file itself</div>
       <div class="card a" style="--d:4.6s;left:500px;top:170px;width:400px;height:420px;border-color:var(--green);background:#fff8"></div>
       <div class="abs a" style="--d:4.8s;left:530px;top:200px;width:340px;font-size:42px;font-weight:600;color:var(--green)">a decision</div>
       <div class="abs" style="left:530px;top:300px;width:340px;font-size:34px;line-height:1.35">
        <div class="a" style="--d:5.8s">made by a person</div><div class="a" style="--d:6.8s">bounded in time</div>
        <div class="a" style="--d:7.8s">kept outside the repo</div><div class="a" style="--d:8.8s">audited in a log</div></div>`,
    ),
  d_outro: () =>
    doc(
      'var(--red)',
      `<div class="sun a" style="width:240px;height:240px;right:110px;top:110px"></div>
       <div class="abs a" style="--d:.3s;left:80px;top:310px;font-size:190px;font-weight:600;color:#fff;letter-spacing:-4px">tslaws</div>
       <div class="abs a mono" style="--d:1.2s;left:86px;top:560px;font-size:46px;color:var(--yellow)">npm i -D tslaws</div>
       <div class="abs a mono" style="--d:3.4s;left:86px;top:660px;font-size:36px;color:#fff">github.com/Jordan-Hall/tsc-laws</div>`,
    ),
  // What is new in tslaws v1. Real output is from captures/ (run locally, or from the `certificates` CI job for the proof
  // certificates, which needs cvc5 and Carcara); a yellow pill marks an illustration, a mint pill marks real output.
  v_hook: () =>
    doc(
      'var(--cream)',
      `<div class="sun a" style="width:280px;height:280px;right:80px;top:80px"></div>
       <div class="abs a" style="left:80px;top:250px;font-size:100px;font-weight:300;line-height:1.1">tests sample.</div>
       <div class="abs a" style="--d:2.2s;left:80px;top:390px;font-size:100px;font-weight:600;line-height:1.1;color:var(--red)">laws prove.</div>
       <div class="abs a" style="--d:4.6s;left:80px;top:540px;font-size:62px;font-weight:300;line-height:1.2">and now, proofs carry<br><span style="font-weight:600;color:var(--blue);font-size:96px">certificates</span></div>
       <div class="abs a mono" style="--d:7s;left:84px;top:840px;font-size:30px;color:#6a6a80">what is new in tslaws 1.0</div>`,
    ),
  v_mono: () => {
    const pkg = (name, x, y, d) =>
      `<div class="card a mono" style="--d:${d}s;left:${x}px;top:${y}px;width:190px;height:150px;padding:14px;font-size:20px;line-height:1.35;background:#fff"><b style="font-size:24px;color:var(--blue)">${name}</b><br>laws<br>config<br>approvers · accept</div>`;
    return doc(
      'var(--cream)',
      `<div class="pill a" style="--d:.2s;left:60px;top:40px;background:var(--yellow);font-size:26px">illustration, drawn from docs/monorepo.md</div>
       <div class="abs a" style="--d:.4s;left:60px;top:110px;font-size:58px;font-weight:300">monorepos</div>
       <div class="card a mono" style="--d:1s;left:60px;top:230px;width:840px;height:90px;padding:20px 26px;font-size:26px;background:#fff">tslaws.json   <span class="ty">"projects": ["apps/*", "packages/*"]</span></div>
       ${pkg('packages/core', 60, 380, 2)}${pkg('packages/ui', 290, 380, 3.4)}${pkg('packages/docs', 520, 380, 4.8)}${pkg('apps/web', 750, 380, 6.2)}
       <div class="abs a" style="--d:7.6s;left:60px;top:580px;width:840px;font-size:38px;line-height:1.35"><span style="color:var(--red);font-weight:600">one</span> GitHub flow covers the repo</div>
       <div class="abs a" style="--d:11s;left:60px;top:660px;width:840px;font-size:38px;line-height:1.35">VS Code follows the <span style="color:var(--blue);font-weight:600">open file's</span> project</div>
       <div class="abs a" style="--d:14s;left:60px;top:760px;width:840px;font-size:38px;line-height:1.35;font-weight:300">each package: its own laws, lock and accept</div>`,
    );
  },
  v_changed: () => {
    const rows = capture('mono-changed.txt').filter((l) =>
      /^(--changed|  (apps|packages)|── |PROVED|TESTED|\d+ projects)/.test(l),
    );
    return doc(
      '#d9e6f2',
      `<div class="pill a" style="--d:.2s;left:60px;top:40px;background:var(--mint);font-size:26px">real output, a sample monorepo</div>
       <div class="term" style="left:60px;top:110px;width:840px;height:560px;font-size:19px"><div class="a" ${at(0.6)}><span class="dim">$ tslaws check --changed main   # core changed</span></div>${vRows(rows, 1.4, 0.7)}</div>
       <div class="note a" style="--d:11s;left:60px;top:720px;width:560px;font-size:32px">packages/docs is not selected</div>
       <div class="abs a" style="--d:12.5s;left:60px;top:830px;font-size:36px;font-weight:300">nothing that depends on your change is missed</div>`,
    );
  },
  v_cert: () => {
    const step = (x, label, sub, d, color) =>
      `<div class="card a" style="--d:${d}s;left:${x}px;top:330px;width:200px;height:200px;background:${color};text-align:center;padding-top:44px"><div style="font-size:34px;font-weight:600">${label}</div><div class="mono" style="font-size:19px;margin-top:10px">${sub}</div></div>`;
    const arrow = (x, d) =>
      `<div class="abs a" style="--d:${d}s;left:${x}px;top:395px;font-size:56px;color:var(--ink)">&rarr;</div>`;
    return doc(
      'var(--cream)',
      `<div class="pill a" style="--d:.2s;left:60px;top:40px;background:var(--yellow);font-size:26px">illustration, drawn from docs/certificates.md</div>
       <div class="abs a" style="--d:.4s;left:60px;top:120px;font-size:62px;font-weight:300">proof certificates</div>
       ${step(60, 'law', 'proved', 1.2, '#fff8')}${arrow(268, 2.4)}${step(330, 'cvc5', 'writes an Alethe proof', 3.2, '#bcd6f0')}${arrow(538, 5)}${step(600, 'Carcara', 'checks the proof', 6, '#f6e08a')}${arrow(808, 8)}
       <div class="abs a" style="--d:8.6s;left:845px;top:395px;font-size:40px;font-weight:600;color:var(--green)">ok</div>
       <div class="abs a" style="--d:10.5s;left:60px;top:620px;width:840px;font-size:44px;line-height:1.3">two programs agree before a law says <span style="color:var(--green);font-weight:600">certified</span></div>
       <div class="abs a mono" style="--d:13s;left:60px;top:790px;font-size:26px;color:#6a6a80">depends on cvc5 1.4.2 and Carcara</div>`,
    );
  },
  v_cert_real: () => {
    const rows = capture('certify-check.txt').filter(
      (l) => !/^\s+assuming:/.test(l) && !/^\s+(Only|solver|Z3)/.test(l),
    );
    return doc(
      '#d9d0e8',
      `<div class="pill a" style="--d:.2s;left:60px;top:40px;background:var(--mint);font-size:26px">real output, CI job: cvc5 1.4.2 + Carcara</div>
       <div class="term" style="left:40px;top:110px;width:880px;height:790px;font-size:17px;line-height:1.5;padding:20px 24px"><div class="a" ${at(0.6)}><span class="dim">$ tslaws check</span></div>${vRows(rows, 1.2, 1.05)}</div>`,
    );
  },
  v_cert_bind: () => {
    const rows = capture('certify-require.txt').filter((l) => /^(ERROR|PROVED|exit status)/.test(l));
    const lock = readFileSync(new URL('captures/certify-lock.txt', import.meta.url), 'utf8').split(/\r?\n/);
    const from = lock.findIndex((l) => l.includes('"src/math.laws.ts::addition commutes": {'));
    const rec = lock
      .slice(from, from + 6)
      .map((l) => l.replace(/^ {4}/, ''))
      .map((l) => l.replace(/"([0-9a-f]{12})[0-9a-f]+"/g, '"$1..."'));
    return doc(
      '#ecd27a',
      `<div class="pill a" style="--d:.2s;left:60px;top:40px;background:var(--mint);font-size:26px">real output, CI job</div>
       <div class="term" style="left:60px;top:110px;width:840px;height:300px;font-size:17px"><div class="a" ${at(0.6)}><span class="dim">$ tslaws check --require-certify</span></div>${vRows(rows, 1.2, 0.5)}</div>
       <div class="abs a mono" style="--d:6.5s;left:60px;top:440px;font-size:24px;color:var(--blue)">tsc-laws.lock</div>
       <div class="code" style="left:60px;top:480px;width:840px;font-size:21px;line-height:1.45;padding:18px 26px">${rec.map((l, i) => `<div class="a" ${at(7 + i * 0.6)}>${esc(l)}</div>`).join('')}</div>
       <div class="abs a" style="--d:12s;left:60px;top:800px;width:840px;font-size:36px;line-height:1.3">edit the law and the certificate is void</div>`,
    );
  },
  v_loops: () => {
    const source = readFileSync(new URL('../ci/certificates-demo/src/math.ts', import.meta.url), 'utf8');
    const start = source.indexOf('export function largest');
    const fn = source.slice(start, source.indexOf('\n}\n', start) + 2).replace(' as int', '');
    const step = (y, label, d, color) =>
      `<div class="card a" style="--d:${d}s;left:520px;top:${y}px;width:380px;height:92px;background:${color};padding:14px 20px;font-size:28px;line-height:1.2">${label}</div>`;
    return doc(
      'var(--cream)',
      `<div class="pill a" style="--d:.2s;left:60px;top:40px;background:var(--yellow);font-size:26px">illustration, drawn from docs/laws.md</div>
       <div class="abs a" style="--d:.4s;left:60px;top:110px;font-size:58px;font-weight:300">loop invariants</div>
       <div class="code a" style="--d:1s;left:60px;top:230px;width:430px;font-size:21px;line-height:1.5;padding:20px 22px">${codeHtml(fn)}</div>
       ${step(230, 'z3 Spacer finds the invariant (CHC)', 3, '#bcd6f0')}
       ${step(350, 'plain z3 checks it again', 6, '#b9e0c4')}
       ${step(470, 'Eldarica or Golem cross-check, if installed', 9, '#fff8')}
       <div class="abs a" style="--d:12s;left:60px;top:700px;width:840px;font-size:42px;line-height:1.35">arrays of <span style="font-weight:600;color:var(--red)">any length</span></div>
       <div class="abs a" style="--d:14.5s;left:60px;top:780px;width:840px;font-size:42px;line-height:1.35;font-weight:300">a loop is proved, not just bounded</div>`,
    );
  },
  v_loops_real: () => {
    const all = capture('certify-check.txt');
    const rows = [];
    for (let i = 0; i < all.length; i++)
      if (/^PROVED   (counting up|the largest)/.test(all[i])) rows.push(all[i], all[i + 1], all[i + 2]);
    return doc(
      '#b9c6d8',
      `<div class="pill a" style="--d:.2s;left:60px;top:40px;background:var(--mint);font-size:26px">real output, CI job</div>
       <div class="term" style="left:40px;top:130px;width:880px;height:560px;font-size:20px"><div class="a" ${at(0.6)}><span class="dim">$ tslaws check</span></div>${vRows(rows, 1.2, 1.4)}</div>
       <div class="abs a" style="--d:6s;left:60px;top:740px;width:840px;font-size:38px;line-height:1.3">the invariant is printed beside the law</div>
       <div class="abs a" style="--d:9s;left:60px;top:820px;width:840px;font-size:34px;font-weight:300">proved, but no certificate for it yet</div>`,
    );
  },
  v_sec: () => {
    const chips = [
      ['path traversal', 'CWE-22'],
      ['prototype pollution', 'CWE-1321'],
      ['open redirect', 'CWE-601'],
      ['ReDoS', 'CWE-1333'],
      ['XSS', 'CWE-79'],
      ['integer issues', 'CWE-190'],
      ['validation', 'CWE-20'],
    ];
    const rows = capture('security-paths.txt');
    return doc(
      'var(--cream)',
      `<div class="pill a" style="--d:.2s;left:60px;top:40px;background:var(--mint);font-size:26px">real output, a sample project</div>
       ${chips.map(([n, c], i) => `<div class="card a mono" style="--d:${0.6 + i * 0.45}s;left:${60 + (i % 4) * 215}px;top:${110 + Math.floor(i / 4) * 78}px;width:200px;height:64px;padding:7px 10px;font-size:15px;line-height:1.35;background:#fff"><b style="font-size:17px">${n}</b><br><span class="ty">${c}</span></div>`).join('')}
       <div class="code a" style="--d:5.5s;left:60px;top:290px;width:840px;font-size:22px;padding:16px 26px"><span class="kw">return</span> name.replace(<span class="ty">'../'</span>, <span class="ty">''</span>);   <span class="cm">// strips ../</span></div>
       <div class="term" style="left:60px;top:400px;width:840px;height:430px;font-size:18px"><div class="a" ${at(7)}><span class="dim">$ tslaws check</span></div>${vRows(rows, 7.6, 1.2)}</div>`,
    );
  },
  v_deps: () => {
    const rows = readFileSync(new URL('captures/security-deps.txt', import.meta.url), 'utf8')
      .split(/\r?\n/)
      .filter((l) => l && !/^\s+(Lodash|Regular|lodash)/.test(l));
    return doc(
      '#d9e6f2',
      `<div class="pill a" style="--d:.2s;left:60px;top:40px;background:var(--mint);font-size:26px">real output, against OSV</div>
       <div class="term" style="left:40px;top:110px;width:880px;height:600px;font-size:17px"><div class="a" ${at(0.6)}><span class="dim">$ tslaws security deps --no-cache</span></div>${vRows(rows, 1.4, 0.9)}</div>
       <div class="abs a" style="--d:9s;left:60px;top:760px;width:840px;font-size:38px;line-height:1.3">in CI, <span class="mono" style="color:var(--red)">--no-cache</span>: every run asks again</div>`,
    );
  },
  v_accept: () => {
    const lane = (y, title, steps, d) =>
      `<div class="abs a" style="--d:${d}s;left:60px;top:${y}px;font-size:40px;font-weight:600;color:var(--blue)">${title}</div>` +
      steps
        .map(
          (s, i) =>
            `<div class="card a mono" style="--d:${d + 0.8 + i * 0.9}s;left:${60 + i * 285}px;top:${y + 60}px;width:255px;height:120px;padding:14px 16px;font-size:20px;line-height:1.35;background:#fff">${s}</div>`,
        )
        .join('');
    return doc(
      'var(--cream)',
      `<div class="pill a" style="--d:.2s;left:60px;top:40px;background:var(--yellow);font-size:26px">illustration, drawn from docs/github.md</div>
       <div class="abs a" style="--d:.4s;left:60px;top:105px;font-size:54px;font-weight:300">accepting laws</div>
       ${lane(200, 'local', ['a person at a terminal', 'tslaws accept', 'tsc-laws.lock written'], 1)}
       ${lane(430, 'GitHub, on demand', ['manual run of the merge workflow', 'the person has maintain access', 'still the head of the branch'], 7)}
       <div class="note a" style="--d:15s;left:60px;top:700px;width:760px;font-size:32px">branch moved? it accepts nothing, and says so</div>
       <div class="card a mono" style="--d:17s;left:60px;top:810px;width:840px;height:70px;padding:16px 20px;font-size:22px;background:#fff">the workflow commits tsc-laws.lock as the bot</div>`,
    );
  },
  v_oidc: () =>
    doc(
      '#b9c6d8',
      `<div class="pill a" style="--d:.2s;left:60px;top:40px;background:var(--yellow);font-size:26px">illustration, drawn from release.yml</div>
       <div class="abs a" style="--d:.4s;left:60px;top:105px;font-size:54px;font-weight:300">trusted publishing</div>
       <div class="code a" style="--d:1.2s;left:60px;top:210px;width:840px;font-size:25px;line-height:1.5"><span class="cm"># release.yml</span>
permissions:
  <span class="kw">id-token</span>: write
...
npm publish "$package" <span class="kw">--provenance</span> --access public</div>
       <div class="abs a" style="--d:5s;left:60px;top:520px;width:840px;font-size:38px;line-height:1.4">GitHub signs a short lived identity</div>
       <div class="abs a" style="--d:7s;left:60px;top:580px;width:840px;font-size:38px;line-height:1.4">npm trusts that workflow</div>
       <div class="abs a" style="--d:9s;left:60px;top:680px;width:840px;font-size:38px">every package carries provenance</div>
       <div class="note a" style="--d:11s;left:60px;top:780px;width:560px;font-size:40px;background:var(--yellow)">no npm tokens</div>`,
    ),
  v_outro: () =>
    doc(
      'var(--red)',
      `<div class="sun a" style="width:240px;height:240px;right:110px;top:110px"></div>
       <div class="abs a" style="--d:.3s;left:80px;top:300px;font-size:190px;font-weight:600;color:#fff;letter-spacing:-4px">tslaws</div>
       <div class="abs a" style="--d:1s;left:86px;top:520px;font-size:96px;font-weight:300;color:#fff">1.0.0</div>
       <div class="abs a mono" style="--d:2.2s;left:86px;top:680px;font-size:46px;color:var(--yellow)">npm i -D tslaws</div>
       <div class="abs a mono" style="--d:4s;left:86px;top:770px;font-size:36px;color:#fff">github.com/Jordan-Hall/tsc-laws</div>`,
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
// A cold start (web fonts fetched for the first scene) leaves blank frames before the first scene. Cut them, and move every
// scene time back by the same amount, so the voice and the pictures stay together.
const lead = Math.max(0, timings[Object.keys(timings)[0]] - 0.3);
if (lead > 0.5) {
  const dir = join(outDir, 'video');
  const file = join(
    dir,
    readdirSync(dir).find((f) => f.endsWith('.webm')),
  );
  const cut = join(dir, 'cut.tmp');
  const run = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-y',
      '-ss',
      lead.toFixed(3),
      '-i',
      file,
      '-c:v',
      'libvpx-vp9',
      '-crf',
      '28',
      '-b:v',
      '0',
      '-f',
      'webm',
      cut,
    ],
    { encoding: 'utf8' },
  );
  if (run.status !== 0) throw new Error(run.stderr);
  renameSync(cut, file);
  for (const key of Object.keys(timings)) timings[key] -= lead;
}
writeFileSync(join(outDir, 'timings.json'), JSON.stringify({ lines: timings, cues }, null, 2));
console.log('recorded', timings);
