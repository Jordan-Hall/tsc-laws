// The tslaws v1 film, drawn in code. build.mjs bundles this with three.js and timing.json into film.html.
// window.renderAt(t) is a pure function of t: every position, colour and letter is computed from the time alone
// (no clock, no Math.random, no state carried from one frame to the next), so any frame renders the same cold.
import * as THREE from 'three';

const TIMING = window.__TIMING__;
const { fps: FPS, palette: PAL, springs: SPR, squash: SQ, events: EV } = TIMING;
const W = TIMING.size[0];
const H = TIMING.size[1];
const SUB = TIMING.motionBlur.subframes;
const SHUTTER = TIMING.motionBlur.shutter;
const col = (hex) => new THREE.Color(hex);
const SANS = '"Segoe UI Variable Display", "Segoe UI", "Helvetica Neue", Arial, sans-serif';
const MONO = '"Cascadia Code", "Cascadia Mono", Consolas, "SF Mono", monospace';

// ---------- maths: closed-form springs, easing, hashing ----------
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const mix = (a, b, s) => a + (b - a) * s;
const smooth = (a, b, x) => {
  const u = clamp((x - a) / (b - a));
  return u * u * (3 - 2 * u);
};
// Step response of a damped spring, 0 at t=0 settling to 1. zeta 1.0 for text and UI, 0.8 for objects, 0.5 for the character.
function step(kind, t) {
  if (t <= 0) return 0;
  const { zeta, omega } = SPR[kind];
  if (zeta >= 1) return 1 - (1 + omega * t) * Math.exp(-omega * t);
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * omega * t) * (Math.cos(wd * t) + ((zeta * omega) / wd) * Math.sin(wd * t));
}
const ev = (name) => EV[name];
const since = (f, name) => (f - EV[name]) / FPS; // seconds since an event
const sp = (kind, f, name) => step(kind, since(f, name));
const halton = (i, b) => {
  let f = 1;
  let r = 0;
  while (i > 0) {
    f /= b;
    r += f * (i % b);
    i = Math.floor(i / b);
  }
  return r;
};

// ---------- renderer ----------
const canvas = document.createElement('canvas');
canvas.width = W;
canvas.height = H;
document.body.style.cssText = 'margin:0;background:#000;overflow:hidden';
document.body.appendChild(canvas);
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,
  preserveDrawingBuffer: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(1);
renderer.setSize(W, H, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
const rtOpts = { type: THREE.HalfFloatType, depthBuffer: true, samples: 0, colorSpace: THREE.LinearSRGBColorSpace };
const sceneRT = new THREE.WebGLRenderTarget(W, H, rtOpts);
const accumRT = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, depthBuffer: false });
const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const quadGeo = new THREE.PlaneGeometry(2, 2);
const addMat = new THREE.ShaderMaterial({
  uniforms: { map: { value: sceneRT.texture }, weight: { value: 1 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
  fragmentShader:
    'uniform sampler2D map; uniform float weight; varying vec2 vUv; void main(){ gl_FragColor = vec4(texture2D(map, vUv).rgb * weight, 1.); }',
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneFactor,
  depthTest: false,
  depthWrite: false,
});
const grade = TIMING.grade;
const finalMat = new THREE.ShaderMaterial({
  uniforms: {
    map: { value: accumRT.texture },
    frame: { value: 0 },
    vignette: { value: grade.vignette },
    grain: { value: grade.grain },
    exposure: { value: grade.exposure },
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
  fragmentShader: `
    uniform sampler2D map; uniform float frame, vignette, grain, exposure; varying vec2 vUv;
    vec3 aces(vec3 x){ x *= 0.62; return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0., 1.); }
    float hash(vec2 p){ p = fract(p*vec2(443.897, 441.423)); p += dot(p, p.yx+19.19); return fract((p.x+p.y)*p.x); }
    void main(){
      vec3 c = texture2D(map, vUv).rgb * exposure;
      c = aces(c);
      c = mix(c, c * vec3(1.03, 1.0, 0.95), 0.5);              // warm grade
      vec2 d = vUv - 0.5; c *= 1.0 - vignette * dot(d, d) * 2.6;
      c = pow(c, vec3(1.0/2.2));                                // display gamma
      c += (hash(gl_FragCoord.xy + frame * 1.37) - 0.5) * grain / 255.0;
      gl_FragColor = vec4(c, 1.);
    }`,
  depthTest: false,
  depthWrite: false,
});
const quad = new THREE.Mesh(quadGeo, addMat);
const quadScene = new THREE.Scene();
quadScene.add(quad);

// ---------- scene ----------
const scene = new THREE.Scene();
scene.background = col(PAL.sky);
scene.fog = new THREE.FogExp2(col(PAL.sky), TIMING.grade.fog);
const key = new THREE.DirectionalLight(col(PAL.key), 3.0);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -3;
key.shadow.camera.right = 3;
key.shadow.camera.top = 3;
key.shadow.camera.bottom = -3;
key.shadow.camera.near = 0.5;
key.shadow.camera.far = 14;
key.shadow.bias = -0.0006;
key.shadow.normalBias = 0.02;
key.shadow.radius = 4;
scene.add(key, key.target);
const rim = new THREE.DirectionalLight(col(PAL.rim), 0.9);
scene.add(rim, rim.target);
scene.add(new THREE.HemisphereLight(col(PAL.fill), col(PAL.desk), 1.15));

const std = (color, rough = 0.6, extra = {}) =>
  new THREE.MeshStandardMaterial({ color: col(color), roughness: rough, metalness: 0, ...extra });
function mesh(geo, mat, parent, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  if (parent) parent.add(m);
  return m;
}
const box = (w, h, d, mat, parent, x, y, z) => mesh(new THREE.BoxGeometry(w, h, d), mat, parent, x, y, z);
const cyl = (r1, r2, h, mat, parent, x, y, z, seg = 24) =>
  mesh(new THREE.CylinderGeometry(r1, r2, h, seg), mat, parent, x, y, z);
const ball = (r, mat, parent, x, y, z) => mesh(new THREE.SphereGeometry(r, 32, 20), mat, parent, x, y, z);

// Floor: warm paper with a map grid, like the line the story travels along.
function gridTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const g = c.getContext('2d');
  g.fillStyle = PAL.desk;
  g.fillRect(0, 0, 1024, 1024);
  g.strokeStyle = PAL.deskLine;
  g.lineWidth = 3;
  for (let i = 0; i <= 8; i++) {
    g.beginPath();
    g.moveTo(i * 128, 0);
    g.lineTo(i * 128, 1024);
    g.moveTo(0, i * 128);
    g.lineTo(1024, i * 128);
    g.stroke();
  }
  g.lineWidth = 7;
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(1024, 0);
  g.moveTo(0, 0);
  g.lineTo(0, 1024);
  g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 16;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const floorTex = gridTexture();
floorTex.repeat.set(160, 60);
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(160, 60),
  new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.9 }),
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);
// The line: an ink rail along the desk with a brass stop at every station.
const railMat = std(PAL.ink, 0.5);
box(90, 0.012, 0.05, railMat, scene, 38, 0.006, 1.15).castShadow = false;
for (let i = 0; i < 9; i++) {
  const stop = cyl(0.2, 0.2, 0.014, std(PAL.brass, 0.4), scene, i * 3.2, 0.007, 1.15, 40);
  stop.castShadow = false;
  const ring = cyl(0.12, 0.12, 0.016, std(PAL.paper, 0.5), scene, i * 3.2, 0.008, 1.15, 40);
  ring.castShadow = false;
}

// ---------- text on cards ----------
function canvasTex(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 16;
  tex.colorSpace = THREE.SRGBColorSpace;
  return { c, g: c.getContext('2d'), tex, key: '' };
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
const KEYWORDS = new Set(['export', 'law', 'const', 'return', 'assume', 'number']);
function tokens(line) {
  return line.match(/\s+|[A-Za-z_][\w]*|\d+|&&|>=|<=|<|>|[^\sA-Za-z_\d]/g) ?? [];
}
function drawCode(g, lines, x0, y0, size, lineH, chars, caret, editedLine) {
  g.font = `500 ${size}px ${MONO}`;
  g.textBaseline = 'alphabetic';
  const cw = g.measureText('M').width;
  let left = chars;
  lines.forEach((line, li) => {
    let x = x0;
    const y = y0 + li * lineH;
    for (const tok of tokens(line)) {
      if (left <= 0) break;
      const part = tok.slice(0, left);
      left -= part.length;
      let color = PAL.ink;
      if (KEYWORDS.has(tok)) color = PAL.burnt;
      else if (tok === 'proved') color = PAL.green;
      else if (/^[A-Za-z_]\w*$/.test(tok) && line.includes(tok + '(')) color = PAL.steel;
      else if (/^\d+$/.test(tok)) color = PAL.burnt;
      if (editedLine === li && /^(<|<=)$/.test(tok)) color = PAL.red;
      g.fillStyle = color;
      g.fillText(part, x, y);
      x += cw * part.length;
    }
    if (left <= 0 && caret) {
      g.fillStyle = PAL.ink;
      g.fillRect(x + 2, y - size * 0.82, size * 0.12, size * 1.0);
    }
    left -= 1;
  });
}
function drawPlaque(ct, w, h, accent, body) {
  const g = ct.g;
  g.clearRect(0, 0, w, h);
  g.fillStyle = PAL.paper;
  g.fillRect(0, 0, w, h);
  g.fillStyle = accent;
  g.fillRect(0, 0, w, h * 0.035);
  g.strokeStyle = 'rgba(30,28,25,0.12)';
  g.lineWidth = 4;
  g.strokeRect(2, 2, w - 4, h - 4);
  body(g);
  ct.tex.needsUpdate = true;
}
function roundedShape(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}
// A standing plaque: paper face, thin rounded body, two small feet. Origin at the foot line, centre of the base.
function makeCard(w, h, ct) {
  const geo = new THREE.ExtrudeGeometry(roundedShape(w, h, 0.05), {
    depth: 0.03,
    bevelEnabled: true,
    bevelSize: 0.008,
    bevelThickness: 0.008,
    bevelSegments: 2,
    curveSegments: 6,
  });
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / w + 0.5, pos.getY(i) / h + 0.5);
  const grp = new THREE.Group();
  const face = new THREE.MeshStandardMaterial({ map: ct.tex, roughness: 0.55 });
  const body = new THREE.Mesh(geo, [face, std(PAL.paper, 0.7)]);
  body.position.set(0, h / 2 + 0.07, -0.015);
  body.castShadow = true;
  body.receiveShadow = true;
  grp.add(body);
  box(w * 0.7, 0.03, 0.2, std(PAL.ink, 0.5), grp, 0, 0.015, 0);
  grp.userData.size = [w, h];
  return grp;
}
// A stamp that drops onto a card and bounces: one picture-frame before contact it is at full height.
function makeStamp(label, color, w = 0.62, h = 0.2) {
  const ct = canvasTex(512, Math.round(512 * (h / w)));
  const g = ct.g;
  g.clearRect(0, 0, ct.c.width, ct.c.height);
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineWidth = 14;
  roundRect(g, 10, 10, ct.c.width - 20, ct.c.height - 20, 26);
  g.stroke();
  g.font = `800 ${Math.round(ct.c.height * 0.5)}px ${SANS}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, ct.c.width / 2, ct.c.height / 2 + 4);
  ct.tex.needsUpdate = true;
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: ct.tex, transparent: true, depthWrite: false, toneMapped: false }),
  );
  m.renderOrder = 5;
  const g2 = new THREE.Group();
  g2.add(m);
  return g2;
}
// Where a stamp is, `f` frames into the story: falls in 8 frames, then rebounds on an object spring.
function stampPose(f, eventName, rest, rotZ) {
  const dt = f - ev(eventName);
  if (dt < -8) return null;
  if (dt < 0) {
    const u = (dt + 8) / 8;
    return { lift: 0.5 * (1 - u * u), scale: 1.5 - 0.5 * u * u, rot: rotZ };
  }
  const s = step('object', dt / FPS);
  return { lift: 0, scale: mix(1.12, 1, s), rot: rotZ, dip: (1 - s) * 0.012 };
}

// ---------- the mascot: Tally, a round law clerk ----------
const tally = new THREE.Group();
const tallyBody = new THREE.Group();
tally.add(tallyBody);
{
  const brass = std(PAL.brass, 0.5);
  const ink = std(PAL.ink, 0.4);
  const white = std('#FFFFFF', 0.35);
  const body = ball(0.28, brass, tallyBody, 0, 0.34, 0);
  body.scale.set(1, 1.07, 0.98);
  tally.userData.bodyMesh = body;
  // paper collar and bow tie: the clerk
  const bowL = mesh(new THREE.ConeGeometry(0.05, 0.1, 16), std(PAL.burnt, 0.5), tallyBody, -0.06, 0.2, 0.27);
  bowL.rotation.z = Math.PI / 2;
  const bowR = mesh(new THREE.ConeGeometry(0.05, 0.1, 16), std(PAL.burnt, 0.5), tallyBody, 0.06, 0.2, 0.27);
  bowR.rotation.z = -Math.PI / 2;
  ball(0.025, std(PAL.burnt, 0.5), tallyBody, 0, 0.2, 0.27);
  // eyes in round glasses
  const eyes = [];
  const pupils = [];
  for (const sx of [-1, 1]) {
    const eye = ball(0.07, white, tallyBody, sx * 0.105, 0.44, 0.235);
    eye.scale.set(1, 1, 0.5);
    eyes.push(eye);
    const pupil = ball(0.036, ink, tallyBody, sx * 0.105, 0.44, 0.27);
    pupil.scale.set(1, 1, 0.5);
    pupils.push(pupil);
    const ring = mesh(new THREE.TorusGeometry(0.098, 0.011, 10, 36), ink, tallyBody, sx * 0.105, 0.44, 0.258);
    ring.castShadow = false;
  }
  const bridge = cyl(0.008, 0.008, 0.05, ink, tallyBody, 0, 0.45, 0.262, 8);
  bridge.rotation.z = Math.PI / 2;
  const smile = mesh(new THREE.TorusGeometry(0.05, 0.01, 8, 20, Math.PI), ink, tallyBody, 0, 0.34, 0.262);
  smile.rotation.z = Math.PI;
  const mouthO = ball(0.03, ink, tallyBody, 0, 0.32, 0.262);
  mouthO.scale.set(1, 1.3, 0.4);
  // left hand, and the right arm that holds the gavel
  ball(0.065, brass, tallyBody, -0.285, 0.3, 0.05);
  const arm = new THREE.Group();
  arm.position.set(0.275, 0.34, 0.05);
  tallyBody.add(arm);
  ball(0.065, brass, arm, 0.04, -0.04, 0);
  const gavel = new THREE.Group();
  gavel.position.set(0.045, -0.04, 0.02);
  arm.add(gavel);
  cyl(0.011, 0.011, 0.2, std(PAL.wood, 0.6), gavel, 0, 0.1, 0, 10);
  const head = cyl(0.036, 0.036, 0.12, std(PAL.wood, 0.5), gavel, 0, 0.21, 0, 16);
  head.rotation.z = Math.PI / 2;
  for (const sx of [-1, 1]) {
    const foot = ball(0.085, std('#5A3B22', 0.6), tally, sx * 0.12, 0.045, 0.07);
    foot.scale.set(1, 0.55, 1.35);
  }
  tally.userData = { ...tally.userData, eyes, pupils, smile, mouthO, arm, gavel };
}
tally.traverse((o) => {
  if (o.isMesh) {
    o.castShadow = true;
    o.receiveShadow = true;
  }
});
scene.add(tally);

// Tally's squash and stretch for a hop that takes off at frame `take` and lands at `land`.
function hopPose(f, hop) {
  const cf = SQ.crouchFrames;
  const tf = SQ.takeoffFrames;
  const air = hop.land - hop.take;
  if (f < hop.take - cf) return null;
  if (f < hop.take) {
    const u = smooth(hop.take - cf, hop.take, f);
    return { y: 0, sx: mix(1, SQ.crouch[0], u), sy: mix(1, SQ.crouch[1], u), phase: 'crouch' };
  }
  if (f < hop.land) {
    const u = (f - hop.take) / air;
    const y = hop.h * 4 * u * (1 - u);
    const k = smooth(0, tf / air, u * 1);
    const toNeutral = smooth(0.2, 0.9, u);
    const sx = mix(mix(SQ.crouch[0], SQ.takeoff[0], k), 1.04, toNeutral);
    const sy = mix(mix(SQ.crouch[1], SQ.takeoff[1], k), 0.96, toNeutral);
    return { y, sx, sy, u, phase: 'air' };
  }
  const s = step('character', (f - hop.land) / FPS);
  return { y: 0, sx: mix(SQ.land[0], 1, s), sy: mix(SQ.land[1], 1, s), phase: 'land' };
}
const MOVES = TIMING.moves;
const HOPS = MOVES.filter((m) => m.type === 'hop');
function tallyState(f) {
  // position: the latest place or landed hop, then any hop or run in progress
  let pos = MOVES[0].pos;
  let posAt = -1;
  for (const m of MOVES) {
    if (m.type === 'place' && m.f <= f && m.f >= posAt) {
      pos = m.pos;
      posAt = m.f;
    }
    if (m.type === 'hop' && m.land <= f && m.land >= posAt) {
      pos = m.to;
      posAt = m.land;
    }
  }
  let x = pos[0];
  let z = pos[1];
  let y = 0;
  let sx = 1;
  let sy = 1;
  let yawOverride = null;
  for (const h of HOPS) {
    const p = hopPose(f, h);
    if (!p || h.land + 120 < f) continue;
    if (p.phase === 'air') {
      const u = (f - h.take) / (h.land - h.take);
      const e = smooth(0, 1, u);
      x = mix(h.from[0], h.to[0], e);
      z = mix(h.from[1], h.to[1], e);
    } else if (p.phase === 'crouch') {
      x = h.from[0];
      z = h.from[1];
    }
    y = p.y;
    sx = p.sx;
    sy = p.sy;
  }
  for (const m of MOVES) {
    if (m.type !== 'run' || f < m.from || f >= m.to) continue;
    const t = (f - m.from) / FPS;
    const th = -1.2 + t * 1.55;
    x = m.center[0] + Math.cos(th) * m.radius;
    z = m.center[1] + Math.sin(th) * m.radius;
    const ph = (t / 0.3) % 1;
    y = 0.1 * 4 * ph * (1 - ph);
    const settle = ph < 0.18 ? step('character', ph * 0.3) : 1;
    sx = mix(SQ.land[0] * 0.9, 1, settle);
    sy = mix(SQ.land[1] * 1.1, 1, settle);
    yawOverride = Math.atan2(-Math.sin(th), Math.cos(th)) * 0.6 + 0.9;
  }
  // breathing, only while standing
  if (y === 0 && sx === 1 && sy === 1) {
    const b = Math.sin((f / FPS) * Math.PI * 2 * 0.45);
    sy = 1 + 0.012 * b;
    sx = 1 - 0.008 * b;
  }
  return { x, y, z, sx, sy, yawOverride };
}
const GAZE = TIMING.gaze;
function gazeAt(f) {
  let i = 0;
  while (i + 1 < GAZE.length && GAZE[i + 1].f <= f) i++;
  const a = GAZE[Math.max(0, i - 1)].at;
  const b = GAZE[i].at;
  const s = step('character', (f - GAZE[i].f) / FPS);
  return [mix(a[0], b[0], s), mix(a[1], b[1], s), mix(a[2], b[2], s)];
}
function blink(f) {
  const t = f / FPS;
  const k = Math.floor(t / 3.1);
  const local = t - k * 3.1 - 2.9;
  if (local < 0 || local > 0.16) return 1;
  return 1 - 0.92 * Math.sin((Math.PI * local) / 0.16);
}
function poseTally(f, seated) {
  const s = tallyState(f);
  tally.position.set(s.x, s.y, s.z);
  tallyBody.scale.set(s.sx * (seated ? 1.1 : 1), s.sy * (seated ? 0.9 : 1), s.sx * (seated ? 1.1 : 1));
  const g = gazeAt(f);
  const dx = g[0] - s.x;
  const dz = g[2] - s.z;
  let yaw = clamp(Math.atan2(dx, dz), -1.0, 1.0) * 0.55;
  if (s.yawOverride !== null) yaw = s.yawOverride;
  tally.rotation.y = yaw;
  const { eyes, pupils, smile, mouthO, arm } = tally.userData;
  const u = tally.userData;
  // startle: wide eyes and an open mouth for 40 frames after the beat
  const st = TIMING.acts.startles.reduce((a, e) => (f >= e && f < e + 44 ? Math.max(a, 1 - (f - e) / 44) : a), 0);
  const cheer = TIMING.acts.cheers.some((e) => f >= e && f < e + 60);
  const bl = blink(f);
  for (const e of eyes) e.scale.set(1 + 0.25 * st, (1 + 0.25 * st) * bl, 0.5);
  const lx = clamp((dx * Math.cos(yaw) - dz * Math.sin(yaw)) * 0.02, -0.025, 0.025);
  const ly = clamp((g[1] - 0.45) * 0.03, -0.015, 0.02);
  pupils.forEach((p, i) => p.position.set((i ? 1 : -1) * 0.105 + lx, 0.44 + ly, 0.27));
  smile.visible = st < 0.25;
  mouthO.visible = st >= 0.25;
  smile.scale.set(cheer ? 1.3 : 1, cheer ? 1.3 : 1, 1);
  // gavel arm: rest, and a tap that raises it and brings it down on the beat
  let a = -0.15;
  for (const e of TIMING.acts.taps) {
    const dt = f - e;
    if (dt >= -20 && dt < 0) a = mix(-0.15, 1.9, smooth(-20, -2, dt));
    else if (dt >= 0) {
      const sp2 = step('character', dt / FPS);
      a = mix(1.9, -0.15, sp2);
      if (dt > 70) a = -0.15;
    }
  }
  if (cheer) a = Math.max(a, 1.2 + 0.2 * Math.sin(f * 0.4));
  arm.rotation.z = a;
  return s;
}
window.mascotWorld = (f) => poseTally(f, false);

// ---------- stations ----------
const stations = [];
for (let i = 0; i < 9; i++) {
  const g = new THREE.Group();
  g.position.x = i * 3.2;
  scene.add(g);
  stations.push(g);
}
const GAPS = {};
const lawLines = TIMING.text.law;
const lawChars = lawLines.join('\n').length;
const edited = lawLines.map((l, i) =>
  i === 3 ? TIMING.text.lawEdited.padStart(l.length, ' ').replace(/^ +/, '  ') : l,
);

// Station 0: the desk, a law card that types itself.
const lawA = canvasTex(1536, 1024);
const cardA = makeCard(1.5, 1.0, lawA);
stations[0].add(cardA);
{
  // desk dressing: a lamp and a few books
  const s = stations[0];
  const lamp = new THREE.Group();
  s.add(lamp);
  lamp.position.set(-1.6, 0, -0.5);
  cyl(0.13, 0.15, 0.04, std(PAL.ink, 0.4), lamp, 0, 0.02, 0);
  const a1 = cyl(0.015, 0.015, 0.5, std(PAL.brassDark, 0.4), lamp, 0, 0.27, 0, 10);
  const a2 = cyl(0.015, 0.015, 0.4, std(PAL.brassDark, 0.4), lamp, 0.12, 0.55, 0, 10);
  a2.rotation.z = -0.9;
  const shade = cyl(0.04, 0.15, 0.16, std(PAL.burnt, 0.5), lamp, 0.3, 0.64, 0, 24);
  shade.rotation.z = -0.6;
  for (let i = 0; i < 3; i++)
    box(
      0.5 - i * 0.05,
      0.06,
      0.34,
      std([PAL.steel, PAL.burnt, PAL.green][i], 0.6),
      s,
      1.55,
      0.03 + i * 0.062,
      -0.55,
    ).rotation.y = 0.2 * i;
}
function updateA(f, redraw) {
  const p = ev('lawIn');
  const x = mix(2.6, 0.55, sp('ui', f, 'lawIn'));
  cardA.position.set(x, 0, -0.15);
  cardA.visible = f >= p - 4;
  if (redraw) {
    const n = Math.round(clamp((f - ev('lawTypeStart')) / (ev('lawTypeEnd') - ev('lawTypeStart'))) * lawChars);
    const caret = f < ev('lawDone') + 40 && Math.floor(f / 18) % 2 === 0;
    const k = `${n}${caret ? 1 : 0}`;
    if (lawA.key !== k) {
      lawA.key = k;
      drawPlaque(lawA, 1536, 1024, PAL.green, (g) => drawCode(g, lawLines, 90, 190, 54, 106, n, caret));
    }
  }
}

// Station 1: the solver, an arch with a lever, gears and a lamp. A card passes through.
const sB = stations[1];
const steel = std(PAL.steel, 0.5);
const steelDark = std(PAL.steelDark, 0.5);
const brassMat = std(PAL.brass, 0.4, { metalness: 0.3 });
box(0.5, 1.1, 0.7, steel, sB, -0.7, 0.55, 0);
box(0.5, 1.1, 0.7, steel, sB, 0.7, 0.55, 0);
box(1.9, 0.3, 0.7, steelDark, sB, 0, 1.0, 0);
box(2.3, 0.1, 0.9, std(PAL.ink, 0.5), sB, 0, 0.05, 0);
const gearGeo = new THREE.CylinderGeometry(0.17, 0.17, 0.05, 12);
const gearA = mesh(gearGeo, brassMat, sB, -0.45, 1.24, 0.15);
gearA.rotation.x = Math.PI / 2;
const gearB = mesh(gearGeo, std(PAL.brassDark, 0.4, { metalness: 0.3 }), sB, -0.17, 1.24, 0.15);
gearB.rotation.x = Math.PI / 2;
const lamp = ball(
  0.09,
  new THREE.MeshStandardMaterial({ color: col('#555'), roughness: 0.3, emissive: col('#000') }),
  sB,
  0.35,
  1.2,
  0.1,
);
const sweep = box(
  0.03,
  0.8,
  0.5,
  new THREE.MeshBasicMaterial({ color: col('#A5E8C0'), transparent: true, opacity: 0.55, toneMapped: false }),
  sB,
  0,
  0.55,
  0,
);
sweep.castShadow = false;
const leverPivot = new THREE.Group();
leverPivot.position.set(-0.7, 0.6, 0.37);
sB.add(leverPivot);
cyl(0.018, 0.018, 0.4, std(PAL.ink, 0.4), leverPivot, 0, -0.2, 0, 10);
ball(0.05, std(PAL.red, 0.4), leverPivot, 0, -0.4, 0);
const labelSolver = canvasTex(512, 160);
{
  const g = labelSolver.g;
  g.fillStyle = PAL.paper;
  g.fillRect(0, 0, 512, 160);
  g.fillStyle = PAL.ink;
  g.font = `800 96px ${SANS}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('solver', 256, 84);
  labelSolver.tex.needsUpdate = true;
  const plaque = new THREE.Mesh(
    new THREE.PlaneGeometry(0.64, 0.2),
    new THREE.MeshStandardMaterial({ map: labelSolver.tex, roughness: 0.6 }),
  );
  plaque.position.set(0, 1.0, 0.356);
  sB.add(plaque);
}
const lawB = canvasTex(1024, 720);
const cardB = makeCard(0.8, 0.56, lawB);
sB.add(cardB);
{
  drawPlaque(lawB, 1024, 720, PAL.green, (g) => drawCode(g, lawLines, 42, 170, 34, 70, 9999, false));
}
const lawB2 = canvasTex(1024, 720);
const cardB2 = makeCard(0.8, 0.56, lawB2);
sB.add(cardB2);
const stampProved = makeStamp('proved', PAL.green);
stampProved.scale.setScalar(1);
sB.add(stampProved);
const stampFailed = makeStamp('failed', PAL.red);
sB.add(stampFailed);
function cardTravel(f, inEv, startEv, endEv, exitEv) {
  // x of the card: slide in, wait before the tunnel, pass through, rest on the far side
  const slideIn = sp('ui', f, inEv);
  let x = mix(-2.2, -1.05, slideIn);
  if (f >= startEv) x = mix(-1.05, 1.5, smooth(startEv, endEv, f));
  return x;
}
function updateB(f, redraw) {
  gearA.rotation.y = f * (f > ev('slideStart') && f < ev('slideEnd') + 20 ? 0.16 : f > ev('machineOn') ? 0.03 : 0);
  gearB.rotation.y = -gearA.rotation.y * 1.2 + 0.2;
  leverPivot.rotation.z = mix(0.6, -0.5, sp('object', f, 'leverPull'));
  const scanning = f >= ev('slideStart') && f <= ev('slideEnd') + 8;
  sweep.visible = scanning;
  sweep.position.x = -0.4 + 0.8 * Math.abs((((f - ev('slideStart')) / 38) % 2) - 1);
  // lamp colour tells the verdict
  let lc = '#555555';
  let le = '#000000';
  if (f >= ev('machineOn')) {
    lc = '#E8A33D';
    le = '#7A4A10';
  }
  if (f >= ev('proveStamp')) {
    lc = '#2E9E5B';
    le = '#1A6B3A';
  }
  if (f >= ev('cardB2_in') + 40) {
    lc = '#D2402F';
    le = '#8B2218';
  }
  if (f >= ev('failStamp') + 120) {
    lc = '#555555';
    le = '#000000';
  }
  lamp.material.color.set(lc);
  lamp.material.emissive.set(le);
  // card one: arrives, is fed through, comes out proved
  const showB = f >= ev('cardB_in') - 2 && f < 1040;
  cardB.visible = showB;
  const xB = cardTravel(f, 'cardB_in', ev('slideStart'), ev('slideEnd'));
  cardB.position.set(xB, 0, -0.12);
  const sB1 = stampPose(f, 'proveStamp', 0, -0.1);
  stampProved.visible = !!sB1 && f < 1040;
  if (sB1) {
    stampProved.position.set(xB + 0.05, 0.07 + 0.56 * 0.45 + sB1.lift, 0.03);
    stampProved.scale.setScalar(sB1.scale);
    stampProved.rotation.z = sB1.rot;
    stampProved.position.z = 0.06 + sB1.lift * 0.8;
  }
  // card two: finds a counterexample
  cardB2.visible = f >= ev('cardB2_in') - 2 && f < 1360;
  const x2 = f < ev('cardB2_out') ? mix(-2.0, 1.5, smooth(ev('cardB2_in'), ev('cardB2_out'), f)) : 1.5;
  cardB2.position.set(x2, 0, -0.12);
  const sB2 = stampPose(f, 'failStamp', 0, 0.08);
  stampFailed.visible = !!sB2;
  if (sB2) {
    stampFailed.position.set(x2 + 0.1, 0.07 + 0.56 * 0.12 + sB2.lift, 0.06 + sB2.lift * 0.8);
    stampFailed.scale.setScalar(sB2.scale);
    stampFailed.rotation.z = sB2.rot;
  }
  if (redraw && cardB2.visible) {
    const typed = clamp((f - ev('failType')) / 50);
    const k = `${Math.round(typed * 100)}`;
    if (lawB2.key !== k) {
      lawB2.key = k;
      drawPlaque(lawB2, 1024, 720, PAL.red, (g) => {
        g.fillStyle = PAL.ink;
        g.textAlign = 'left';
        g.font = `700 70px ${SANS}`;
        const a = 'counterexample'.slice(0, Math.round(typed * 14));
        g.fillText(a, 60, 250);
        g.font = `600 150px ${MONO}`;
        g.fillStyle = PAL.red;
        const b = '[[3,3]]'.slice(0, Math.max(0, Math.round(((typed - 0.3) / 0.7) * 7)));
        g.fillText(b, 60, 470);
      });
    }
  }
}

// Station 2: certificates. cvc5 prints a scroll, Carcara's loupe checks it row by row.
const sC = stations[2];
const printer = new THREE.Group();
printer.position.set(-0.95, 0, -0.1);
sC.add(printer);
box(0.8, 0.5, 0.6, std(PAL.steel, 0.5), printer, 0, 0.3, 0);
box(0.86, 0.06, 0.66, std(PAL.steelDark, 0.5), printer, 0, 0.58, 0);
box(0.44, 0.07, 0.04, std(PAL.ink, 0.5), printer, 0.2, 0.22, 0.31);
const labelCvc = canvasTex(512, 160);
{
  const g = labelCvc.g;
  g.fillStyle = PAL.paper;
  g.fillRect(0, 0, 512, 160);
  g.fillStyle = PAL.ink;
  g.font = `800 100px ${MONO}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('cvc5', 256, 86);
  labelCvc.tex.needsUpdate = true;
  const p = new THREE.Mesh(
    new THREE.PlaneGeometry(0.5, 0.16),
    new THREE.MeshStandardMaterial({ map: labelCvc.tex, roughness: 0.6 }),
  );
  p.position.set(-0.1, 0.38, 0.305);
  printer.add(p);
}
const scrollTex = canvasTex(2048, 256);
{
  const g = scrollTex.g;
  g.fillStyle = '#FFFDF6';
  g.fillRect(0, 0, 2048, 256);
  g.fillStyle = PAL.ink;
  for (let r = 0; r < 8; r++) {
    const x0 = 40 + r * 250;
    const lens = [150, 190, 110, 170, 130, 190, 150, 100];
    g.globalAlpha = 0.75;
    g.fillRect(x0, 70, lens[r], 12);
    g.fillRect(x0, 120, lens[(r + 3) % 8] * 0.8, 12);
    g.fillRect(x0, 170, lens[(r + 5) % 8] * 0.6, 12);
    g.globalAlpha = 1;
  }
  scrollTex.tex.needsUpdate = true;
}
const SCROLL_LEN = 2.0;
const scrollMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(SCROLL_LEN, 0.25),
  new THREE.MeshStandardMaterial({ map: scrollTex.tex, roughness: 0.8 }),
);
scrollMesh.rotation.x = -Math.PI / 2;
scrollMesh.receiveShadow = true;
scrollMesh.castShadow = true;
sC.add(scrollMesh);
const checks = [];
{
  const ct = canvasTex(128, 128);
  const g = ct.g;
  g.clearRect(0, 0, 128, 128);
  g.strokeStyle = PAL.green;
  g.lineWidth = 22;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(26, 68);
  g.lineTo(54, 96);
  g.lineTo(104, 32);
  g.stroke();
  ct.tex.needsUpdate = true;
  for (let i = 0; i < 8; i++) {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(0.14, 0.14),
      new THREE.MeshBasicMaterial({ map: ct.tex, transparent: true, depthWrite: false, toneMapped: false }),
    );
    m.rotation.x = -Math.PI / 2;
    sC.add(m);
    checks.push(m);
  }
}
const loupe = new THREE.Group();
sC.add(loupe);
{
  mesh(new THREE.TorusGeometry(0.15, 0.022, 14, 40), std(PAL.brassDark, 0.35, { metalness: 0.4 }), loupe, 0, 0, 0);
  const glass = mesh(
    new THREE.CircleGeometry(0.145, 40),
    new THREE.MeshStandardMaterial({
      color: col(PAL.glass),
      transparent: true,
      opacity: 0.28,
      roughness: 0.05,
      depthWrite: false,
    }),
    loupe,
    0,
    0,
    0,
  );
  glass.castShadow = false;
  const handle = cyl(0.022, 0.026, 0.3, std(PAL.wood, 0.5), loupe, 0, -0.3, 0, 12);
  handle.position.set(0, -0.3, 0);
}
const labelCarcara = canvasTex(512, 160);
{
  const g = labelCarcara.g;
  g.fillStyle = PAL.paper;
  g.fillRect(0, 0, 512, 160);
  g.fillStyle = PAL.ink;
  g.font = `800 92px ${SANS}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('Carcara', 256, 86);
  labelCarcara.tex.needsUpdate = true;
}
const signCarcara = new THREE.Mesh(
  new THREE.PlaneGeometry(0.5, 0.16),
  new THREE.MeshStandardMaterial({ map: labelCarcara.tex, roughness: 0.6 }),
);
signCarcara.position.set(0, 0.0, 0.0);
const lawC = canvasTex(1024, 720);
const cardC = makeCard(0.9, 0.62, lawC);
sC.add(cardC);
drawPlaque(lawC, 1024, 720, PAL.green, (g) => drawCode(g, lawLines, 42, 170, 34, 70, 9999, false));
const stampC1 = makeStamp('proved', PAL.green, 0.5, 0.16);
const stampC2 = makeStamp('certified', PAL.steel, 0.58, 0.16);
sC.add(stampC1, stampC2, signCarcara);
function updateC(f) {
  cardC.position.set(mix(-2.4, 0.5, sp('ui', f, 'cardC_in')), 0, -0.6);
  const shown = (name) => f >= ev(name);
  stampC1.visible = f >= ev('cardC_in');
  stampC1.position.set(cardC.position.x - 0.12, 0.07 + 0.62 * 0.28, -0.52);
  stampC1.rotation.z = -0.08;
  const sc = stampPose(f, 'certStamp', 0, 0.07);
  stampC2.visible = !!sc;
  if (sc) {
    stampC2.position.set(cardC.position.x + 0.12, 0.07 + 0.62 * 0.62 + sc.lift, -0.52 + sc.lift * 0.8);
    stampC2.scale.setScalar(sc.scale);
    stampC2.rotation.z = sc.rot;
  }
  // scroll: printed out of the slot, longer every frame
  const u = smooth(ev('printStart'), ev('printEnd'), f);
  const len = Math.max(0.001, u * SCROLL_LEN);
  scrollMesh.visible = f >= ev('printStart');
  scrollMesh.scale.set(len / SCROLL_LEN, 1, 1);
  scrollMesh.position.set(-0.6 + len / 2, 0.012, 0.42);
  scrollTex.tex.repeat.set(len / SCROLL_LEN, 1);
  scrollTex.tex.offset.set(0, 0);
  // the loupe walks the scroll; each tick lands when it reaches its row
  const lx = f < ev('loupeIn') ? -1.7 : mix(-0.5, 0.95, smooth(ev('tick0') - 20, ev('tick7') + 10, f));
  const lxEntry = f >= ev('loupeIn') && f < ev('tick0') - 20 ? mix(-1.7, -0.5, sp('ui', f, 'loupeIn')) : lx;
  loupe.position.set(lxEntry, 0.2, 0.55);
  loupe.rotation.x = -Math.PI / 2 + 0.25;
  loupe.visible = f >= ev('loupeIn') - 2;
  signCarcara.visible = f >= ev('loupeIn');
  signCarcara.position.set(-0.55 + 0.0, 0.1, 0.8);
  signCarcara.rotation.x = -0.9;
  signCarcara.position.set(lxEntry - 0.0, 0.015, 0.78);
  signCarcara.rotation.x = -Math.PI / 2;
  checks.forEach((m, i) => {
    const e = `tick${i}`;
    const vis = f >= ev(e);
    m.visible = vis;
    m.position.set(-0.5 + i * 0.2 + 0.05, 0.02, 0.42 - 0.07);
    m.scale.setScalar(mix(0.01, 1, step('object', since(f, e))));
  });
}

// Station 3: a loop. Tally runs the track; the invariant is a ring that holds on every lap.
const sD = stations[3];
{
  const track = mesh(new THREE.TorusGeometry(0.55, 0.035, 12, 80), std(PAL.ink, 0.5), sD, 0, 0.03, 0);
  track.rotation.x = Math.PI / 2;
  track.castShadow = false;
}
const invWall = mesh(
  new THREE.CylinderGeometry(0.62, 0.62, 0.5, 64, 1, true),
  new THREE.MeshStandardMaterial({
    color: col(PAL.green),
    transparent: true,
    opacity: 0.22,
    side: THREE.DoubleSide,
    depthWrite: false,
    roughness: 0.4,
  }),
  sD,
  0,
  0.25,
  0,
);
invWall.castShadow = false;
const invRing = mesh(new THREE.TorusGeometry(0.62, 0.03, 12, 80), std(PAL.green, 0.4), sD, 0, 0.5, 0);
invRing.rotation.x = Math.PI / 2;
const lawD = canvasTex(1024, 720);
const cardD = makeCard(0.9, 0.62, lawD);
cardD.position.set(1.35, 0, -0.5);
sD.add(cardD);
drawPlaque(lawD, 1024, 720, PAL.green, (g) => drawCode(g, lawLines, 42, 170, 34, 70, 9999, false));
const signInv = canvasTex(768, 256);
{
  const g = signInv.g;
  g.fillStyle = PAL.paper;
  g.fillRect(0, 0, 768, 256);
  g.fillStyle = PAL.green;
  g.fillRect(0, 0, 768, 14);
  g.fillStyle = PAL.ink;
  g.font = `800 120px ${SANS}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('invariant', 384, 140);
  signInv.tex.needsUpdate = true;
}
const signInvMesh = makeCard(0.9, 0.3, signInv);
signInvMesh.position.set(-1.35, 0, -0.5);
sD.add(signInvMesh);
const stampD = makeStamp('certified', PAL.steel, 0.58, 0.16);
sD.add(stampD);
function updateD(f) {
  const k = step('object', since(f, 'invOn'));
  const on = f >= ev('invOn');
  invWall.visible = on;
  invRing.visible = on;
  invWall.scale.set(mix(0.05, 1, k), 1, mix(0.05, 1, k));
  invRing.scale.set(mix(0.05, 1, k), mix(0.05, 1, k), 1);
  signInvMesh.visible = f >= ev('invOn') - 20;
  const sd = stampPose(f, 'certStampD', 0, 0.07);
  stampD.visible = !!sd;
  if (sd) {
    stampD.position.set(1.4, 0.07 + 0.62 * 0.28 + sd.lift, -0.42 + sd.lift * 0.8);
    stampD.scale.setScalar(sd.scale);
    stampD.rotation.z = sd.rot;
  }
}

// Station 4: the lock. A padlock closes on the law; an edit pops it open.
const sE = stations[4];
const lawE = canvasTex(1536, 1024);
const cardE = makeCard(1.3, 0.9, lawE);
cardE.position.set(-0.1, 0, -0.2);
sE.add(cardE);
const lock = new THREE.Group();
lock.position.set(1.15, 0, 0.2);
sE.add(lock);
box(0.4, 0.32, 0.16, std(PAL.brass, 0.35, { metalness: 0.3 }), lock, 0, 0.16, 0);
const shackle = new THREE.Group();
shackle.position.set(-0.12, 0.32, 0);
lock.add(shackle);
const sh = mesh(
  new THREE.TorusGeometry(0.12, 0.028, 12, 28, Math.PI),
  std('#BFC4C8', 0.3, { metalness: 0.7 }),
  shackle,
  0.12,
  0,
  0,
);
cyl(0.028, 0.028, 0.08, std('#BFC4C8', 0.3, { metalness: 0.7 }), shackle, 0, -0.02, 0, 12);
const keyhole = ball(0.025, std(PAL.ink, 0.5), lock, 0, 0.16, 0.08);
const stampT = makeStamp('tampered', PAL.red, 0.7, 0.2);
sE.add(stampT);
const penG = new THREE.Group();
sE.add(penG);
cyl(0.014, 0.014, 0.36, std(PAL.red, 0.4), penG, 0, 0, 0, 10);
const tip = cyl(0.014, 0.0, 0.05, std(PAL.ink, 0.4), penG, 0, -0.2, 0, 10);
function updateE(f, redraw) {
  const isEdited = f >= ev('textSwap');
  // shackle: closed on lockClose, open once the law is edited
  let lift = 0.09;
  let turn = 0.0;
  if (f >= ev('lockClose')) {
    lift = mix(0.09, 0, sp('object', f, 'lockClose'));
  }
  if (f >= ev('lockOpen')) {
    lift = mix(0, 0.1, sp('object', f, 'lockOpen'));
    turn = mix(0, -1.0, sp('object', f, 'lockOpen'));
  }
  shackle.position.y = 0.32 + lift;
  shackle.rotation.y = turn;
  const pose = stampPose(f, 'tamperStamp', 0, -0.06);
  stampT.visible = !!pose;
  if (pose) {
    stampT.position.set(-0.1, 0.07 + 0.9 * 0.55 + pose.lift, -0.1 + pose.lift * 0.8);
    stampT.scale.setScalar(pose.scale);
    stampT.rotation.z = pose.rot;
  }
  // pen scribbles on the assume line, then the text changes
  const pf = f - ev('penStart');
  penG.visible = pf >= -6 && pf < 80;
  penG.position.set(
    -0.55 + 0.7 * smooth(0, 34, pf) + Math.sin(pf * 0.9) * 0.02,
    0.6 + 0.18 * smooth(0, 34, pf) - 0.02 * Math.sin(pf * 1.3),
    0.12,
  );
  penG.rotation.z = -0.5;
  if (redraw) {
    const k = isEdited ? 'e' : 'o';
    if (lawE.key !== k) {
      lawE.key = k;
      drawPlaque(lawE, 1536, 1024, isEdited ? PAL.red : PAL.green, (g) =>
        drawCode(g, isEdited ? edited : lawLines, 90, 190, 54, 106, 9999, false, isEdited ? 3 : -1),
      );
    }
  }
}

// Station 5: the gate. A proposed law cannot lift the bar; a person presses promote.
const sF = stations[5];
const barMat = std(PAL.burnt, 0.5);
cyl(0.05, 0.05, 0.85, std(PAL.ink, 0.5), sF, -0.45, 0.425, 0, 16);
cyl(0.05, 0.05, 0.85, std(PAL.ink, 0.5), sF, 0.45, 0.425, 0, 16);
const barPivot = new THREE.Group();
barPivot.position.set(-0.45, 0.72, 0);
sF.add(barPivot);
box(0.9, 0.07, 0.07, barMat, barPivot, 0.45, 0, 0);
for (let i = 0; i < 4; i++) box(0.09, 0.075, 0.075, std(PAL.paper, 0.5), barPivot, 0.12 + i * 0.22, 0, 0);
box(0.8, 0.05, 0.5, std(PAL.wood, 0.6), sF, -1.4, 0.03, 0);
box(0.8, 0.05, 0.5, std(PAL.wood, 0.6), sF, 1.45, 0.03, -0.15);
const pedestal = new THREE.Group();
pedestal.position.set(0.9, 0, 0.55);
sF.add(pedestal);
box(0.32, 0.4, 0.32, std(PAL.ink, 0.5), pedestal, 0, 0.2, 0);
const button = cyl(0.11, 0.11, 0.07, std(PAL.red, 0.4), pedestal, 0, 0.43, 0, 32);
const labelPromote = canvasTex(512, 160);
{
  const g = labelPromote.g;
  g.fillStyle = PAL.paper;
  g.fillRect(0, 0, 512, 160);
  g.fillStyle = PAL.ink;
  g.font = `800 92px ${SANS}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('promote', 256, 86);
  labelPromote.tex.needsUpdate = true;
  const p = new THREE.Mesh(
    new THREE.PlaneGeometry(0.28, 0.09),
    new THREE.MeshStandardMaterial({ map: labelPromote.tex, roughness: 0.6 }),
  );
  p.position.set(0, 0.22, 0.162);
  pedestal.add(p);
}
const lawF = canvasTex(1024, 720);
const cardF = makeCard(0.8, 0.56, lawF);
sF.add(cardF);
const proposedCT = canvasTex(1024, 720);
function drawProposed(solid) {
  drawPlaque(proposedCT, 1024, 720, solid ? PAL.green : PAL.brassDark, (g) => {
    drawCode(g, lawLines, 42, 170, 34, 70, 9999, false);
    if (!solid) {
      g.strokeStyle = PAL.brassDark;
      g.lineWidth = 10;
      g.setLineDash([36, 24]);
      g.strokeRect(14, 14, 996, 692);
    }
  });
}
cardF.children[0].material[0].map = proposedCT.tex;
const stampP = makeStamp('proposed', PAL.brassDark, 0.5, 0.15);
sF.add(stampP);
// person: a simple figure, taller than Tally, in a navy jacket
const person = new THREE.Group();
sF.add(person);
const personArm = new THREE.Group();
{
  const suit = std(PAL.suit, 0.55);
  const skin = std(PAL.skin, 0.6);
  mesh(new THREE.CapsuleGeometry(0.17, 0.34, 8, 16), suit, person, 0, 0.62, 0);
  ball(0.14, skin, person, 0, 1.02, 0);
  const legL = mesh(new THREE.CapsuleGeometry(0.06, 0.28, 6, 10), std(PAL.ink, 0.5), person, -0.08, 0.2, 0);
  const legR = mesh(new THREE.CapsuleGeometry(0.06, 0.28, 6, 10), std(PAL.ink, 0.5), person, 0.08, 0.2, 0);
  person.userData = { legL, legR };
  ball(0.02, std(PAL.ink, 0.4), person, -0.05, 1.04, 0.13);
  ball(0.02, std(PAL.ink, 0.4), person, 0.05, 1.04, 0.13);
  personArm.position.set(-0.19, 0.78, 0);
  person.add(personArm);
  const a = mesh(new THREE.CapsuleGeometry(0.05, 0.3, 6, 10), suit, personArm, 0, -0.16, 0);
  ball(0.055, skin, personArm, 0, -0.34, 0);
  const a2 = mesh(new THREE.CapsuleGeometry(0.05, 0.3, 6, 10), suit, person, 0.24, 0.64, 0);
  a2.rotation.z = 0.15;
}
function updateF(f, redraw) {
  const open = sp('object', f, 'gateOpen');
  let arm = f >= ev('gateOpen') ? mix(0, 1.4, open) : 0;
  // the bar shudders when Tally pushes and the card does not pass
  for (const e of ['bonkF1', 'bonkF2']) {
    const dt = since(f, e);
    if (dt > 0 && dt < 1.2) arm += 0.05 * Math.sin(dt * 40) * Math.exp(-dt * 6);
  }
  barPivot.rotation.z = arm;
  // card journey: waits left of the gate, goes to the proposal tray, then through the open gate
  let cx = -0.95;
  let cy = 0;
  let solid = false;
  for (const e of ['bonkF1', 'bonkF2']) {
    const dt = since(f, e);
    if (dt > 0 && dt < 1.2) cx += 0.04 * Math.sin(dt * 40) * Math.exp(-dt * 6);
  }
  if (f >= ev('proposeStamp') - 40) {
    const s = step('ui', since(f, 'proposeStamp') + 0.66);
    cx = mix(-0.95, -1.4, s);
    cy = 0.05;
  }
  if (f >= ev('cardGo')) {
    cx = mix(-1.4, 1.45, smooth(ev('cardGo'), ev('cardThrough'), f));
    cy = mix(0.05, 0, smooth(ev('cardGo'), ev('cardThrough'), f));
    solid = f >= ev('cardThrough') - 10;
  }
  cardF.position.set(cx, cy, cx > 1 ? -0.15 : 0.0);
  const key2 = solid ? 'solid' : 'dashed';
  if (redraw && proposedCT.key !== key2) {
    proposedCT.key = key2;
    drawProposed(solid);
  }
  const sp1 = stampPose(f, 'proposeStamp', 0, -0.05);
  stampP.visible = !!sp1 && f < ev('cardGo');
  if (sp1) {
    stampP.position.set(-1.4 + 0.0, 0.07 + 0.56 * 0.5 + 0.05 + sp1.lift, 0.07 + sp1.lift * 0.8);
    stampP.scale.setScalar(sp1.scale);
    stampP.rotation.z = sp1.rot;
  }
  // the person walks in, presses the button once
  const walk = smooth(ev('personIn'), ev('press') - 40, f);
  const px = mix(3.0, 1.55, walk);
  person.position.set(px, Math.abs(Math.sin(f * 0.22)) * 0.02 * (walk > 0 && walk < 1 ? 1 : 0), 0.55);
  person.visible = f >= ev('personIn') - 4 && f < 3300;
  const sw = walk > 0 && walk < 1 ? Math.sin(f * 0.22) * 0.5 : 0;
  person.userData.legL.rotation.x = sw;
  person.userData.legR.rotation.x = -sw;
  person.rotation.y = -0.5;
  const pressK = f >= ev('press') - 14 ? smooth(ev('press') - 14, ev('press'), f) : 0;
  personArm.rotation.z = mix(0.1, 1.5, pressK);
  personArm.rotation.x = 0;
  const released = f > ev('press') + 20 ? smooth(ev('press') + 20, ev('press') + 40, f) : 0;
  personArm.rotation.z = mix(personArm.rotation.z, 0.1, released);
  button.position.y = f >= ev('press') && f < ev('press') + 24 ? 0.4 : 0.43;
  person.position.x = px;
}

// Station 6: the sandbox. A glass box over the law; Tally's file and gear cannot get in.
const sG = stations[6];
const glassMat = new THREE.MeshStandardMaterial({
  color: col(PAL.glass),
  transparent: true,
  opacity: 0.2,
  roughness: 0.05,
  depthWrite: false,
  side: THREE.DoubleSide,
});
const glassBox = new THREE.Group();
sG.add(glassBox);
box(1.5, 1.0, 0.9, glassMat, glassBox, 0, 0.5, 0).castShadow = false;
{
  const fm = std('#8FA3AE', 0.3, { metalness: 0.5 });
  for (const [sx, sz] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ])
    box(0.04, 1.0, 0.04, fm, glassBox, sx * 0.75, 0.5, sz * 0.45);
  for (const y of [0.0, 1.0]) {
    box(1.5, 0.04, 0.04, fm, glassBox, 0, y, 0.45);
    box(1.5, 0.04, 0.04, fm, glassBox, 0, y, -0.45);
    box(0.04, 0.04, 0.9, fm, glassBox, -0.75, y, 0);
    box(0.04, 0.04, 0.9, fm, glassBox, 0.75, y, 0);
  }
}
glassBox.position.set(0.3, 0, 0);
const lawG = canvasTex(1024, 720);
const cardG = makeCard(0.9, 0.62, lawG);
cardG.position.set(0.3, 0, -0.1);
sG.add(cardG);
drawPlaque(lawG, 1024, 720, PAL.green, (g) => drawCode(g, lawLines, 42, 170, 34, 70, 9999, false));
const labelBox = canvasTex(512, 160);
{
  const g = labelBox.g;
  g.fillStyle = PAL.paper;
  g.fillRect(0, 0, 512, 160);
  g.fillStyle = PAL.ink;
  g.font = `800 92px ${SANS}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('sandbox', 256, 86);
  labelBox.tex.needsUpdate = true;
}
const signBox = makeCard(0.7, 0.22, labelBox);
signBox.position.set(0.3, 0, 0.7);
sG.add(signBox);
const progress = box(0.02, 0.05, 0.02, std(PAL.green, 0.4, { emissive: col('#1A6B3A') }), sG, 0, 0.05, 0.2);
const fileProp = new THREE.Group();
sG.add(fileProp);
box(0.2, 0.26, 0.03, std(PAL.paper, 0.6), fileProp, 0, 0, 0);
box(0.14, 0.012, 0.035, std(PAL.ink, 0.5), fileProp, 0, 0.05, 0);
box(0.14, 0.012, 0.035, std(PAL.ink, 0.5), fileProp, 0, 0.0, 0);
const gearProp = new THREE.Group();
sG.add(gearProp);
{
  const gp = mesh(
    new THREE.CylinderGeometry(0.12, 0.12, 0.05, 10),
    std(PAL.brassDark, 0.4, { metalness: 0.3 }),
    gearProp,
    0,
    0,
    0,
  );
  gp.rotation.x = Math.PI / 2;
  const hub = cyl(0.04, 0.04, 0.07, std(PAL.ink, 0.4), gearProp, 0, 0, 0, 12);
  hub.rotation.x = Math.PI / 2;
}
function updateG(f) {
  const drop = f < ev('boxDrop') ? 0 : sp('object', f, 'boxLand') > 0 ? 1 : smooth(ev('boxDrop'), ev('boxLand'), f);
  const fall = smooth(ev('boxDrop'), ev('boxLand'), f);
  const rebound = f >= ev('boxLand') ? sp('object', f, 'boxLand') : 0;
  glassBox.position.y = f < ev('boxDrop') ? 2.2 : f < ev('boxLand') ? mix(2.2, 0, fall * fall) : (1 - rebound) * 0.03;
  signBox.visible = f >= ev('boxLand');
  const t = f - ev('running');
  progress.scale.set(f >= ev('running') ? 1 + 38 * clamp(t / 40) : 1, 1, 1);
  progress.position.x = -0.1 + (f >= ev('running') ? 0.01 * 38 * clamp(t / 40) * 0.5 : 0) - 0.0;
  progress.visible = f >= ev('running');
  const s = tallyState(f);
  const inHand = f >= 3300 && f < 3440;
  fileProp.visible = inHand;
  fileProp.position.set(s.x - ev('boxDrop') * 0 - stations[6].position.x + 0.3, s.y + 0.36, s.z + 0.18);
  fileProp.rotation.y = 0.3;
  const gearIn = f >= 3440 && f < 3520;
  gearProp.visible = gearIn;
  gearProp.position.set(s.x - stations[6].position.x + 0.3, s.y + 0.36, s.z + 0.18);
  gearProp.rotation.z = f * 0.05;
}

// Station 7: three stamped laws and a happy clerk.
const sH = stations[7];
const wrapCards = [];
['proved', 'certified', 'proved'].forEach((word, i) => {
  const ct = canvasTex(1024, 720);
  drawPlaque(ct, 1024, 720, word === 'certified' ? PAL.steel : PAL.green, (g) => {
    drawCode(g, lawLines, 42, 170, 34, 70, 9999, false);
    g.save();
    g.translate(650, 560);
    g.rotate(-0.1);
    g.strokeStyle = word === 'certified' ? PAL.steel : PAL.green;
    g.fillStyle = g.strokeStyle;
    g.lineWidth = 12;
    roundRect(g, -230, -70, 460, 140, 24);
    g.stroke();
    g.font = `800 90px ${SANS}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(word, 0, 6);
    g.restore();
  });
  const c = makeCard(0.75, 0.52, ct);
  c.position.set(0.2 + i * 0.85, 0, -0.35 - i * 0.05);
  c.rotation.y = -0.12;
  sH.add(c);
  wrapCards.push(c);
});

// Station 8: the end card.
const sI = stations[8];
const endCT = canvasTex(2048, 1100);
const endCard = makeCard(2.0, 1.07, endCT);
endCard.position.set(0.5, 0, -0.2);
sI.add(endCard);
const endText = TIMING.text.end;
function drawEnd(n) {
  drawPlaque(endCT, 2048, 1100, PAL.green, (g) => {
    g.fillStyle = PAL.ink;
    g.font = `800 250px ${SANS}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(endText[0], 1024, 400);
    g.fillStyle = PAL.ink;
    roundRect(g, 330, 640, 1388, 230, 40);
    g.fill();
    g.font = `600 120px ${MONO}`;
    g.fillStyle = '#F6EBD3';
    g.textAlign = 'left';
    const str = endText[1].slice(0, n);
    g.fillText(str, 400, 770);
    const caret = n < endText[1].length || Math.floor(ev('endTypeDone') / 18) % 2 === 0;
    if (caret) {
      const w = g.measureText(str).width;
      g.fillStyle = PAL.brass;
      g.fillRect(400 + w + 8, 700, 20, 120);
    }
  });
}
function updateI(f, redraw) {
  endCard.position.set(0.5, mix(-0.8, 0, step('ui', since(f, 'endIn'))), -0.2);
  endCard.visible = f >= ev('endIn') - 2;
  if (redraw) {
    const n = Math.round(clamp((f - ev('endType')) / (ev('endTypeDone') - ev('endType'))) * endText[1].length);
    const k = `${n}`;
    if (endCT.key !== k) {
      endCT.key = k;
      drawEnd(n);
    }
  }
}
// The frame the end card shows from the first cut: type nothing yet until endType.
const UPDATERS = [updateA, updateB, updateC, updateD, updateE, updateF, updateG, () => {}, updateI];
const STATIONS = stations;

// ---------- camera, shots, render ----------
const camera = new THREE.PerspectiveCamera(30, W / H, 0.05, 200);
camera.filmGauge = 36;
const SHOTS = TIMING.shots;
function shotAt(f) {
  let s = SHOTS[0];
  for (const sh2 of SHOTS) if (f >= sh2.frame) s = sh2;
  return s;
}
function placeCamera(shot, f) {
  const u = clamp((f - shot.frame) / shot.frames);
  const e = u * u * (3 - 2 * u);
  const x = shot.x;
  camera.position.set(
    x + shot.cam[0] + shot.drift[0] * e,
    shot.cam[1] + shot.drift[1] * e,
    shot.cam[2] + shot.drift[2] * e,
  );
  camera.up.set(0, 1, 0);
  camera.setFocalLength(shot.lens);
  camera.updateProjectionMatrix();
  camera.lookAt(x + shot.look[0] + shot.drift[0] * e, shot.look[1], shot.look[2]);
  camera.updateMatrixWorld(true);
}
function applyWorld(f, shot, redraw) {
  STATIONS.forEach((g, i) => (g.visible = i === shot.station));
  const s = poseTally(f, shot.station === 8);
  UPDATERS[shot.station](f, redraw);
  const rig = shot.station === 8 ? 8 : 0;
  // key light follows the station, so shadows are sharp where the camera looks
  key.position.set(shot.x - 2.4, 4.2, 3.0);
  key.target.position.set(shot.x, 0, 0);
  rim.position.set(shot.x + 2.5, 3, -4);
  rim.target.position.set(shot.x, 0.4, 0);
  void rig;
  return s;
}
const q = new THREE.Vector3();
const right = new THREE.Vector3();
const upv = new THREE.Vector3();
function drawFrame(frame) {
  const f = Math.round(frame);
  const shot = shotAt(f);
  const end = shot.frame + shot.frames - 0.01;
  const lastEnd = TIMING.frames - 1;
  finalMat.uniforms.frame.value = f;
  renderer.setRenderTarget(accumRT);
  renderer.setClearColor(0x000000, 1);
  renderer.clear();
  const center = applyWorld(f, shot, true);
  void center;
  for (let k = 0; k < SUB; k++) {
    const ft = Math.min(Math.max(f + ((k + 0.5) / SUB - 0.5) * SHUTTER, shot.frame), Math.min(end, lastEnd));
    applyWorld(ft, shot, false);
    placeCamera(shot, ft);
    // aperture and sub-pixel jitter: fixed low-discrepancy samples, turned by a golden angle each frame
    const rot = (f * 2.399963) % (Math.PI * 2);
    const hx = halton(k + 1, 2);
    const hy = halton(k + 1, 3);
    const rr = Math.sqrt(hx);
    const ang = hy * Math.PI * 2 + rot;
    const aperture = shot.lens / shot.fstop / 2000; // metres, radius
    const tl = tallyState(ft);
    const focusPoint = q.set(tl.x, tl.y + 0.35, tl.z);
    const dist = camera.position.distanceTo(focusPoint);
    camera.getWorldDirection(upv);
    right.crossVectors(upv, camera.up).normalize();
    const up2 = new THREE.Vector3().crossVectors(right, upv).normalize();
    const off = right
      .clone()
      .multiplyScalar(Math.cos(ang) * rr * aperture)
      .add(up2.clone().multiplyScalar(Math.sin(ang) * rr * aperture));
    camera.position.add(off);
    camera.lookAt(focusPoint.clone().lerp(camera.position.clone().add(upv.clone().multiplyScalar(dist)), 0));
    // keep the optical axis fixed on the shot's aim while the eye moves on the aperture disc
    const aim = camera.position.clone().sub(off).add(upv.clone().multiplyScalar(dist));
    camera.lookAt(aim);
    camera.updateMatrixWorld(true);
    // sub-pixel jitter through the projection matrix
    const jx = ((halton(k + 1, 5) - 0.5) * 2) / W;
    const jy = ((halton(k + 1, 7) - 0.5) * 2) / H;
    camera.projectionMatrix.elements[8] += jx;
    camera.projectionMatrix.elements[9] += jy;
    renderer.shadowMap.needsUpdate = k === 0;
    renderer.setRenderTarget(sceneRT);
    renderer.render(scene, camera);
    addMat.uniforms.weight.value = 1 / SUB;
    quad.material = addMat;
    renderer.setRenderTarget(accumRT);
    renderer.autoClear = false;
    renderer.render(quadScene, quadCam);
    renderer.autoClear = true;
  }
  renderer.setRenderTarget(null);
  quad.material = finalMat;
  renderer.render(quadScene, quadCam);
}
window.renderAt = (t) => {
  drawFrame(Math.round(t * FPS));
};
// The pixel width of the mascot's body in a shot, measured from its projected bounding sphere.
window.mascotWidthPx = (t) => {
  const f = Math.round(t * FPS);
  const shot = shotAt(f);
  applyWorld(f, shot, true);
  placeCamera(shot, f);
  const m = tally.userData.bodyMesh;
  m.updateWorldMatrix(true, false);
  const c = new THREE.Vector3().setFromMatrixPosition(m.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
  const r = 0.28 * tallyBody.scale.x;
  const px = (x) => (new THREE.Vector3(x, c.y, c.z).applyMatrix4(camera.projectionMatrix).x * 0.5 + 0.5) * W;
  const left = px(c.x - r);
  const rightPx = px(c.x + r);
  return {
    px: Math.abs(rightPx - left),
    visiblePx: Math.max(0, Math.min(W, Math.max(left, rightPx)) - Math.max(0, Math.min(left, rightPx))),
  };
};
window.shotList = () => SHOTS.map((s) => ({ id: s.id, frame: s.frame, frames: s.frames }));
window.grab = (t, quality = 0.95) => {
  window.renderAt(t);
  return canvas.toDataURL('image/jpeg', quality).slice(23);
};
Promise.all([document.fonts.ready]).then(() => {
  window.__ready = true;
});
