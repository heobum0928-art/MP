import { FilesetResolver, HandLandmarker, PoseLandmarker }
  from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
import { KINDS, WORLDS, STAGES, ENDLESS, PRAISE } from './data.js';

/* ═══════════════ 설정 ═══════════════ */
const CFG = {
  focal: 0.34, near: 0.32,        // 원근 투영
  baseRadius: 0.42,               // 화면 짧은변 대비 z=0 시 반지름 (가로 화면은 ×0.7)
  bossScale: 1.55,
  playerHp: 5,
  swipeSpeed: 0.55,               // 초당 (화면 짧은변 × 이 값) 이상 움직여야 타격 (아이 기준으로 넉넉하게)
  hitCooldown: 0.18,
  maxMonsters: 7,
  bossHoldZ: 0.46,                // 보스가 멈춰 싸우는 거리
  bossRageTime: 26,               // 이 시간 동안 못 잡으면 돌진
  feverTime: 7,
  heartChance: 0.08, starChance: 0.035,
  healEvery: 15,                  // 이만큼 잡을 때마다 하트 1 회복
  assistMin: 0.62,                // 자동 난이도: 가장 쉬울 때 속도 배율
  maxPlayers: 3,                  // 몸 인식 동시 인원 (왼쪽부터 1P·2P·3P)
  propSpeed: 0.32,                // 길가 소품 흐르는 속도 (전진감)
};

const TRACK = {
  pose: {
    hitIds: [15, 16, 19, 20],                   // 손목, 검지 끝 (새끼는 먼 거리에서 흔들림 심함)
    glowIds: [19, 20],
    edges: [[11,12],[11,13],[13,15],[12,14],[14,16],[15,17],[15,19],[17,19],[16,18],[16,20],[18,20],
            [11,23],[12,24],[23,24]],
    hitPad: 1.4, minVis: 0.45,
  },
  hand: {
    hitIds: [4, 8, 12, 16, 20, 9],
    glowIds: [4, 8, 12, 16, 20],
    edges: [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],
            [9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]],
    hitPad: 1.2, minVis: 0,
  },
};

/* ═══════════════ DOM ═══════════════ */
const $ = (id) => document.getElementById(id);
const video = $('cam'), canvas = $('game'), ctx = canvas.getContext('2d');
const UI = {
  hud: $('hud'), hearts: $('hearts'), stageLabel: $('stageLabel'), missions: $('missions'),
  handState: $('handState'), score: $('score'), combo: $('combo'), fever: $('fever'),
  bossBar: $('bossBar'), bossName: $('bossName'), bossFill: $('bossFill'),
  pauseBtn: $('pauseBtn'), dbgBtn: $('dbgBtn'),
  banner: $('banner'), bKicker: $('bKicker'), bTitle: $('bTitle'), bStars: $('bStars'), bBody: $('bBody'),
  bMissions: $('bMissions'), bGesture: $('bGesture'), bGestureText: $('bGestureText'), bGestureFill: $('bGestureFill'),
  bButtons: $('bButtons'),
  menu: $('menu'), map: $('map'), worlds: $('worlds'), loadState: $('loadState'), startErr: $('startErr'),
  mascots: $('mascots'), players: $('players'),
  trans: $('trans'), tEmoji: $('tEmoji'), tKicker: $('tKicker'), tTitle: $('tTitle'), tMobs: $('tMobs'),
};
const PLAYER_HEX = ['#6ee7ff', '#ff7eb6', '#c6ff5e'];

/* ═══════════════ 유틸 ═══════════════ */
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const tri = (x) => 1 - 4 * Math.abs(((x % 1) + 1) % 1 - 0.5);   // -1..1 삼각파

/* ═══════════════ 캔버스 / 투영 ═══════════════ */
let W = 0, H = 0, DPR = 1, lowQuality = false, slowFpsT = 0;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, lowQuality ? 1 : 1.5);
  W = canvas.clientWidth; H = canvas.clientHeight;
  canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener('resize', resize);
new ResizeObserver(resize).observe(canvas);
resize();

const shortSide = () => Math.min(W, H);
const landscape = () => W > H;
const spreadX = () => W * (landscape() ? 1.35 : 1.9);
const spreadY = () => H * (landscape() ? 1.25 : 1.5);
const project = (z) => CFG.focal / (Math.max(z, -0.2) + CFG.near);
const horizonY = () => H * 0.46;
function toScreen(wx, wy, z) {
  const p = project(z);
  return { x: W / 2 + wx * p * spreadX(), y: horizonY() + wy * p * spreadY(), p };
}
const baseR = () => CFG.baseRadius * (landscape() ? 0.7 : 1) * shortSide();
const swipeMin = () => CFG.swipeSpeed * shortSide();

// 카메라 cover 채움 + 좌우 미러를 반영한 랜드마크 → 화면 좌표
function lmToScreen(lm) {
  const vw = video.videoWidth || W, vh = video.videoHeight || H;
  const sc = Math.max(W / vw, H / vh);
  const dw = vw * sc, dh = vh * sc;
  return { x: W - ((W - dw) / 2 + lm.x * dw), y: (H - dh) / 2 + lm.y * dh };
}

/* ═══════════════ 저장 (이 기기 브라우저에만) ═══════════════ */
const SAVE_KEY = 'motion-monster-hunter-v1';
const SAVE = (() => {
  const def = { unlocked: 1, stars: {}, best: 0, music: true, voice: true, mode: 'pose', god: false };
  try { return { ...def, ...JSON.parse(localStorage.getItem(SAVE_KEY) || '{}') }; } catch { return def; }
})();
function persist() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(SAVE)); } catch { /* 저장 불가 환경 */ } }

/* ═══════════════ 오디오: 효과음 · 배경음악 · 음성 안내 ═══════════════ */
const AU = { ctx: null, sfx: null, bgm: null, timer: null };
function initAudio() {
  if (AU.ctx) { AU.ctx.resume?.(); return; }
  try {
    AU.ctx = new (window.AudioContext || window.webkitAudioContext)();
    AU.sfx = AU.ctx.createGain(); AU.sfx.gain.value = 0.9; AU.sfx.connect(AU.ctx.destination);
    AU.bgm = AU.ctx.createGain(); AU.bgm.gain.value = 0.55; AU.bgm.connect(AU.ctx.destination);
  } catch { /* 무음 */ }
}
function tone(freq, dur = 0.1, type = 'square', vol = 0.06, slide = 1, when = 0, dest = AU.sfx) {
  if (!AU.ctx) return;
  const t = AU.ctx.currentTime + when;
  const o = AU.ctx.createOscillator(), g = AU.ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (slide !== 1) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(dest); o.start(t); o.stop(t + dur + 0.02);
}
function noise(dur = 0.3, vol = 0.2, freq = 900) {
  if (!AU.ctx) return;
  const len = Math.floor(AU.ctx.sampleRate * dur);
  const buf = AU.ctx.createBuffer(1, len, AU.ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
  const src = AU.ctx.createBufferSource(); src.buffer = buf;
  const f = AU.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq;
  const g = AU.ctx.createGain(); g.gain.value = vol;
  src.connect(f); f.connect(g); g.connect(AU.sfx); src.start();
}
const SFX = {
  hit: (c = 0) => { tone(420 + c * 30, 0.07, 'triangle', 0.08, 1.8); },
  kill: (c = 0) => { const b = 520 + Math.min(c, 20) * 25; tone(b, 0.08, 'square', 0.05); tone(b * 1.25, 0.08, 'square', 0.05, 1, 0.06); tone(b * 1.5, 0.14, 'square', 0.05, 1, 0.12); },
  parry: () => { tone(1400, 0.06, 'square', 0.05, 0.6); tone(900, 0.1, 'triangle', 0.06, 1, 0.04); },
  bomb: () => { noise(0.6, 0.35, 700); tone(90, 0.5, 'sawtooth', 0.12, 0.4); },
  hurt: () => { tone(220, 0.25, 'sawtooth', 0.09, 0.35); },
  heal: () => { [660, 880, 1100].forEach((f, i) => tone(f, 0.14, 'sine', 0.08, 1, i * 0.08)); },
  star: () => { [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.12, 'square', 0.05, 1, i * 0.06)); },
  bossHit: () => { tone(160, 0.12, 'square', 0.1, 0.6); noise(0.08, 0.12, 1800); },
  roar: () => { tone(110, 0.8, 'sawtooth', 0.12, 0.55); tone(82, 0.9, 'square', 0.06, 0.6, 0.05); noise(0.5, 0.12, 500); },
  shoot: () => { tone(900, 0.12, 'triangle', 0.035, 0.5); },
  count: () => tone(520, 0.12, 'triangle', 0.09),
  go: () => { tone(880, 0.2, 'triangle', 0.1); tone(1320, 0.25, 'triangle', 0.06, 1, 0.05); },
  clear: () => { [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => tone(f, 0.18, 'square', 0.06, 1, i * 0.11)); },
  fail: () => { [392, 330, 262, 196].forEach((f, i) => tone(f, 0.25, 'triangle', 0.08, 1, i * 0.18)); },
  pop: () => { tone(300, 0.06, 'sine', 0.06, 2.4); },
  whoosh: () => { noise(0.45, 0.12, 2200); tone(260, 0.4, 'sine', 0.05, 2.2); },
};

// 중세 유럽풍 배경음악: 6/8 지그 리듬 · 탬버 북 · 백파이프식 5도 드론 · 류트 아르페지오 · 리코더 멜로디
// 월드별 중세 선법 (반음 간격)
const MODES = {
  dorian: [0, 2, 3, 5, 7, 9, 10], mixolydian: [0, 2, 4, 5, 7, 9, 10], aeolian: [0, 2, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11], phrygian: [0, 1, 3, 5, 7, 8, 10], ionian: [0, 2, 4, 5, 7, 9, 11],
};
const TUNES = {
  forest:  { root: 62, mode: 'mixolydian', bpm: 118 },   // 밝은 시골 축제
  fort:    { root: 55, mode: 'dorian',     bpm: 128 },   // 씩씩한 행진
  castle:  { root: 57, mode: 'aeolian',    bpm: 100 },   // 으스스한 성
  snow:    { root: 65, mode: 'lydian',     bpm: 110 },   // 반짝이는 설원
  volcano: { root: 52, mode: 'phrygian',   bpm: 132 },   // 긴박한 결전
  lair:    { root: 50, mode: 'dorian',     bpm: 138 },   // 용과의 전투
  title:   { root: 62, mode: 'ionian',     bpm: 96 },
};

function drum(kind, when) {
  if (!AU.ctx) return;
  const t = AU.ctx.currentTime + when;
  if (kind === 'tabor') {       // 가죽 북: 낮은 통 소리 + 짧은 잡음
    const o = AU.ctx.createOscillator(), g = AU.ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(190, t); o.frequency.exponentialRampToValueAtTime(90, t + 0.1);
    g.gain.setValueAtTime(0.2, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    o.connect(g); g.connect(AU.bgm); o.start(t); o.stop(t + 0.25);
  }
  const dur = kind === 'tabor' ? 0.05 : 0.09;
  const len = Math.floor(AU.ctx.sampleRate * dur);
  const buf = AU.ctx.createBuffer(1, len, AU.ctx.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
  const src = AU.ctx.createBufferSource(); src.buffer = buf;
  const f = AU.ctx.createBiquadFilter();
  f.type = kind === 'tabor' ? 'lowpass' : 'highpass'; f.frequency.value = kind === 'tabor' ? 900 : 6500;   // jingle = 탬버린 방울
  const g = AU.ctx.createGain(); g.gain.value = kind === 'tabor' ? 0.12 : 0.04;
  src.connect(f); f.connect(g); g.connect(AU.bgm); src.start(t);
}

// 류트: 짧게 뜯는 소리 (삼각파 + 살짝 어긋난 사각파, 빠른 감쇠)
function lute(freq, when, vol = 0.05) {
  tone(freq, 0.35, 'triangle', vol, 1, when, AU.bgm);
  tone(freq * 1.003, 0.12, 'square', vol * 0.25, 1, when, AU.bgm);
}
// 리코더: 사인파 + 떨림(비브라토)
function recorder(freq, dur, when, vol = 0.05) {
  if (!AU.ctx) return;
  const t = AU.ctx.currentTime + when;
  const o = AU.ctx.createOscillator(), g = AU.ctx.createGain();
  const lfo = AU.ctx.createOscillator(), lg = AU.ctx.createGain();
  o.type = 'sine'; o.frequency.setValueAtTime(freq, t);
  lfo.frequency.value = 5.5; lg.gain.value = freq * 0.012;
  lfo.connect(lg); lg.connect(o.frequency);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.04);
  g.gain.setValueAtTime(vol, t + dur * 0.7);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(AU.bgm);
  o.start(t); lfo.start(t); o.stop(t + dur + 0.02); lfo.stop(t + dur + 0.02);
}
// 백파이프식 드론: 근음 + 5도를 길게
function drone(freq, dur, when) {
  tone(freq, dur, 'sawtooth', 0.012, 1, when, AU.bgm);
  tone(freq * 1.5, dur, 'triangle', 0.02, 1, when, AU.bgm);
}

function makeTune(seed) {
  // 2마디(6/8 × 2 = 12 스텝) 멜로디 두 개 — 계단식으로 오르내리는 민요풍
  let x = seed * 7919 + 17;
  const rnd = () => (x = (x * 9301 + 49297) % 233280) / 233280;
  const phrase = () => {
    const out = []; let deg = 4;
    for (let i = 0; i < 12; i++) {
      const long = i % 3 === 0 && rnd() < 0.45;        // 강박에 긴 음
      deg = clamp(deg + [-2, -1, -1, 1, 1, 2][Math.floor(rnd() * 6)], 0, 9);
      if (i === 11) deg = 0;                              // 으뜸음으로 마침
      out.push({ deg, len: long ? 2 : 1 });
      if (long) { out.push(null); i++; }
    }
    return out.slice(0, 12);
  };
  return [phrase(), phrase()];
}

function startMusic(worldIdx, title = false) {
  stopMusic();
  if (!AU.ctx || !SAVE.music) return;
  const tune = title ? TUNES.title : (TUNES[WORLDS[worldIdx].scenery] || TUNES.forest);
  const mode = MODES[tune.mode];
  const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
  const note = (deg) => mode[((deg % 7) + 7) % 7] + 12 * Math.floor(deg / 7);
  const [melA, melB] = makeTune(worldIdx + (title ? 50 : 1));
  const chords = [0, 3, 4, 0, 5, 3, 4, 0];               // 도수 진행 (8마디)
  let step = 0, next = AU.ctx.currentTime + 0.1;
  AU.timer = setInterval(() => {
    const sp8 = 60 / tune.bpm / 2 * (S.fever > 0 ? 0.82 : 1);   // 8분음표
    while (next < AU.ctx.currentTime + 0.3) {
      const when = next - AU.ctx.currentTime;
      const s6 = step % 6, bar = Math.floor(step / 6);
      const chordDeg = chords[bar % 8];
      const croot = tune.root - 12 + note(chordDeg);
      // 탬버 북 (쿵-짝 6/8)
      if (!title || s6 === 0) {
        if (s6 === 0 || s6 === 3) drum('tabor', when);
        if (!title && (s6 === 5 || S.fever > 0 && s6 % 2)) drum('jingle', when);
      }
      // 드론 (2마디마다 새로)
      if (step % 12 === 0) drone(midi(tune.root - 24), sp8 * 12.5, when);
      // 류트: 근음-5도-옥타브-5도-3도-5도
      const arp = [0, 4, 7, 4, 2, 4][s6];
      lute(midi(croot + note(chordDeg + arp) - note(chordDeg)), when, title ? 0.04 : 0.05);
      // 리코더 멜로디: A A B A (8마디)
      const phrase = (Math.floor(bar / 2) % 4 === 2) ? melB : melA;
      const n = phrase[(bar % 2) * 6 + s6];
      if (n) recorder(midi(tune.root + 12 + note(n.deg)), sp8 * n.len * 0.95, when, title ? 0.04 : 0.05);
      step++; next += sp8;
    }
  }, 50);
}
function stopMusic() { if (AU.timer) { clearInterval(AU.timer); AU.timer = null; } }

let koVoice = null;
function pickVoice() {
  try { koVoice = speechSynthesis.getVoices().find(v => v.lang && v.lang.toLowerCase().startsWith('ko')) || null; } catch { /* 없음 */ }
}
if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
let speechUnlocked = false;
function unlockSpeech() {
  if (speechUnlocked || !('speechSynthesis' in window)) return;
  speechUnlocked = true;
  try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } catch { /* 무시 */ }
}
function say(text, interrupt = true) {
  if (!SAVE.voice || !('speechSynthesis' in window)) return;
  try {
    if (interrupt) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ko-KR'; u.rate = 1.05; u.pitch = 1.25;
    if (koVoice) u.voice = koVoice;
    setTimeout(() => speechSynthesis.speak(u), interrupt ? 60 : 0);   // cancel 직후 바로 말하면 크롬에서 씹힘
  } catch { /* 미지원 */ }
}

/* ═══════════════ 스프라이트 ═══════════════ */
const SPR = { ready: false, meta: {}, img: {}, white: {} };
function whiteSilhouette(img) {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  return c;
}
async function loadSprites() {
  try {
    const man = await (await fetch('assets/monsters/manifest.json')).json();
    const jobs = [];
    for (const name of Object.keys(man.monsters)) {
      SPR.meta[name] = man.monsters[name];
      SPR.img[name] = []; SPR.white[name] = [];
      man.frames.forEach((f, i) => {
        const img = new Image();
        jobs.push(new Promise((res) => {
          img.onload = () => { SPR.img[name][i] = img; res(); };
          img.onerror = () => res();   // 개별 실패는 도형으로 대체
        }));
        img.src = `assets/monsters/${name}_${f}.png`;
      });
    }
    await Promise.all(jobs);
    SPR.ready = true;
  } catch (e) { console.warn('스프라이트 로드 실패 → 도형으로 대체', e); }
}
function whiteOf(name, i) {
  const w = SPR.white[name];
  if (!w[i] && SPR.img[name][i]) w[i] = whiteSilhouette(SPR.img[name][i]);
  return w[i];
}
const spriteURL = (kind) => `assets/monsters/${(KINDS[kind] && KINDS[kind].sprite) || kind}_0.png`;

/* ═══════════════ 게임 상태 ═══════════════ */
const S = {
  state: 'menu', stateT: 0,
  useCam: false, camReady: false, trackMode: SAVE.mode, loadedMode: null, delegate: '', debug: false,
  poseModel: 'full', slowT: 0,
  stageIdx: 0, stage: null, world: 0,
  hp: CFG.playerHp, maxHp: CFG.playerHp, score: 0, combo: 0, maxCombo: 0,
  kills: {}, killsAny: 0, dodged: 0, hurtCount: 0, missionsComplete: false,
  monsters: [], dying: [], fx: [], texts: [], trails: [], ambient: [], props: [],
  spawnT: 0, boss: null, nextBossAt: 0, bossCycle: 0, fever: 0, shake: 0, flashRed: 0,
  stageT: 0, clearDelay: 0, toastT: 0, toastText: '',
  assist: 1, failStreak: {},
  points: [], pointerPts: [], landmarks: [],
  noBodyT: 0, bodyT: 0, confirmT: 0, autoT: 0,
  bannerAction: null,
  fps: 60, detectMs: 0, lastTs: 0,
};

/* ═══════════════ 미션 ═══════════════ */
function missionCount(m) {
  if (m.type === 'kill') return m.kind === 'any' ? S.killsAny : (S.kills[m.kind] || 0);
  if (m.type === 'combo') return S.maxCombo;
  if (m.type === 'dodge') return S.dodged;
  return 0;
}
const missionDone = (m) => missionCount(m) >= m.n;
function missionText(m) {
  if (m.type === 'kill') return m.kind === 'any' ? `몬스터 ${m.n}마리 물리치기`
    : m.kind === 'arrow' ? `화살 ${m.n}개 쳐내기` : `${KINDS[m.kind].name} ${m.n}마리 물리치기`;
  if (m.type === 'combo') return `${m.n}콤보 만들기`;
  if (m.type === 'dodge') return `폭탄 ${m.n}개 피하기 (치면 안 돼요!)`;
  return '';
}
function missionIcon(m) {
  if (m.type === 'kill' && m.kind !== 'any') return `<img src="${spriteURL(m.kind === 'arrow' ? 'archer' : m.kind)}" alt="">`;
  if (m.type === 'dodge') return `<img src="${spriteURL('bomb')}" alt="">`;
  return `<span class="ic">${m.type === 'combo' ? '🔥' : '⚔️'}</span>`;
}
function missionProgress() {
  const ms = S.stage.missions;
  if (!ms.length) return 0;
  return ms.reduce((a, m) => a + Math.min(1, missionCount(m) / m.n), 0) / ms.length;
}
function missionHTML(m, withCount) {
  const done = missionDone(m);
  const cnt = withCount ? ` <b>${Math.min(missionCount(m), m.n)}/${m.n}</b>` : '';
  return `<div class="mission${done ? ' done' : ''}">${missionIcon(m)}<span>${missionText(m)}${cnt}${done ? ' ✓' : ''}</span></div>`;
}

/* ═══════════════ HUD ═══════════════ */
let hudCache = '';
function updateHud() {
  const hearts = SAVE.god ? '🛡️ 무적' : '❤️'.repeat(Math.max(0, S.hp)) + '🤍'.repeat(Math.max(0, S.maxHp - S.hp));
  const st = S.stage;
  const missions = st ? st.missions.map(m => missionHTML(m, true)).join('') : '';
  const players = S.multi ? S.players.map((p, i) => `<span style="color:${PLAYER_HEX[i]}">${i + 1}P ${p.kills}</span>`).join('') : '';
  const key = hearts + '|' + missions + '|' + S.score + '|' + players;
  if (key === hudCache) return;
  hudCache = key;
  UI.players.innerHTML = players;
  UI.players.classList.toggle('hidden', !S.multi);
  UI.hearts.textContent = hearts;
  UI.missions.innerHTML = missions;
  UI.score.textContent = S.score.toLocaleString();
}
let comboShown = 0;
function updateComboHud() {
  if (S.combo === comboShown) return;
  comboShown = S.combo;
  UI.combo.textContent = S.combo >= 3 ? `${S.combo} 콤보!` : '';
  UI.combo.classList.add('pop');
  setTimeout(() => UI.combo.classList.remove('pop'), 90);
}
function updateBossHud() {
  const b = S.boss;
  UI.bossBar.classList.toggle('hidden', !b);
  if (b) { UI.bossName.textContent = `👑 ${b.K.name}`; UI.bossFill.style.width = `${(b.hp / b.maxHp) * 100}%`; }
}
function toast(text, dur = 1.2) { S.toastText = text; S.toastT = dur; }

/* ═══════════════ 배너 ═══════════════ */
function showBanner({ kicker = '', title = '', stars = null, body = '', missions = null, gesture = null, buttons = [], action = null, auto = 0 }) {
  UI.bKicker.textContent = kicker;
  UI.bTitle.textContent = title;
  UI.bStars.innerHTML = stars == null ? '' : [1, 2, 3].map(i => `<span class="${i <= stars ? '' : 'off'}">★</span>`).join('');
  UI.bBody.innerHTML = body;
  UI.bMissions.innerHTML = missions ? missions.map(m => missionHTML(m, false)).join('') : '';
  UI.bGesture.classList.toggle('hidden', !gesture);
  UI.bGestureText.textContent = gesture || '';
  UI.bGestureFill.style.width = '0%';
  UI.bButtons.innerHTML = '';
  for (const b of buttons) {
    const el = document.createElement('button');
    el.className = 'btn' + (b.cls ? ' ' + b.cls : '');
    el.textContent = b.label;
    el.addEventListener('click', (e) => { e.stopPropagation(); initAudio(); b.onClick(); });
    UI.bButtons.appendChild(el);
  }
  S.bannerAction = action;
  S.confirmT = 0;
  S.autoT = auto; S.autoTotal = auto;
  UI.banner.classList.remove('hidden');
}
function hideBanner() { UI.banner.classList.add('hidden'); S.bannerAction = null; }

// 양손 번쩍 = 확인 (멀리 서 있는 아이가 화면을 누르지 않아도 되게)
function gestureOk() {
  if (!S.useCam) return false;
  const T = TRACK[S.trackMode];
  if (S.trackMode === 'pose') {
    return S.landmarks.some(b => {
      const v = (i) => (b[i].visibility ?? 1) >= T.minVis;
      return v(0) && v(15) && v(16) && b[15].y < b[0].y && b[16].y < b[0].y;
    });
  }
  return S.landmarks.length >= 2 && S.landmarks.filter(h => h[0].y < 0.5).length >= 2;
}
function updateBannerGesture(dt) {
  if (!S.bannerAction || S.transitioning) return;
  const ok = gestureOk();
  S.confirmT = ok ? S.confirmT + dt : Math.max(0, S.confirmT - dt * 2);
  let frac = S.confirmT / 1.5;
  if (S.autoT > 0) {
    S.autoT -= dt;
    frac = Math.max(frac, 1 - S.autoT / S.autoTotal);
    if (S.autoT <= 0) frac = 1;
  }
  UI.bGestureFill.style.width = `${clamp(frac, 0, 1) * 100}%`;
  if (frac >= 1) { const a = S.bannerAction; S.bannerAction = null; SFX.go(); a(); }
}

/* ═══════════════ 흐름: 메뉴 → 인트로 → 준비 → 카운트 → 플레이 → 클리어/실패 ═══════════════ */
function setState(st) { S.state = st; S.stateT = 0; }

function showMenu() {
  stopMusic(); hideBanner();
  if (AU.ctx) startMusic(0, true);
  setState('menu');
  document.body.classList.remove('playing');
  UI.hud.classList.add('hidden'); UI.bossBar.classList.add('hidden');
  UI.pauseBtn.classList.add('hidden'); UI.dbgBtn.classList.add('hidden');
  UI.map.classList.add('hidden'); UI.menu.classList.remove('hidden');
  S.monsters = []; S.dying = []; S.boss = null;
}

function showMap() {
  UI.menu.classList.add('hidden');
  UI.map.classList.remove('hidden');
  const html = WORLDS.map((w, wi) => {
    const stages = STAGES.map((s, i) => ({ s, i })).filter(o => o.s.world === wi).map(({ s, i }) => {
      const locked = i >= SAVE.unlocked;
      const stars = SAVE.stars[s.id] || 0;
      const cls = ['stageBtn', s.boss ? 'boss' : '', i === SAVE.unlocked - 1 ? 'next' : ''].join(' ');
      return `<button class="${cls}" data-stage="${i}" ${locked ? 'disabled' : ''}>
        <b>${locked ? '🔒' : (s.boss ? '👑 ' : '') + s.id}</b><i>${s.title}</i>
        <span class="stars">${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}</span></button>`;
    }).join('');
    return `<div class="world"><div class="wname"><span>${w.emoji}</span>${w.name}</div><div class="stages">${stages}</div></div>`;
  }).join('');
  const endless = SAVE.unlocked > STAGES.length
    ? `<div class="world"><div class="wname"><span>♾️</span>무한 모드</div><div class="stages">
        <button class="stageBtn next" data-stage="endless"><b>도전!</b><i>최고 ${SAVE.best.toLocaleString()}점</i></button></div></div>` : '';
  UI.worlds.innerHTML = html + endless;
  UI.worlds.querySelectorAll('.stageBtn:not(:disabled)').forEach(b => b.addEventListener('click', () => {
    const v = b.dataset.stage;
    beginStage(v === 'endless' ? 'endless' : Number(v));
  }));
}

/* ── 화면 전환: 원형으로 닫힘 → (새 월드면 타이틀 카드) → 장면 교체 → 열림 ── */
const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function transitionTo(mid, card = null) {
  if (S.transitioning) return;
  S.transitioning = true;
  S.bannerAction = null;
  const el = UI.trans;
  if (card) {
    const w = WORLDS[card.world];
    el.style.setProperty('--tc1', w.tintTop.replace(/[\d.]+\)$/, '1)'));
    UI.tEmoji.textContent = card.emoji || w.emoji;
    UI.tKicker.textContent = card.kicker || '';
    UI.tTitle.textContent = card.title || '';
    UI.tMobs.innerHTML = (card.mobs || []).map(k => `<img src="${spriteURL(k)}" alt="">`).join('');
  } else {
    el.style.removeProperty('--tc1');
    UI.tEmoji.textContent = ''; UI.tKicker.textContent = ''; UI.tTitle.textContent = ''; UI.tMobs.innerHTML = '';
  }
  SFX.whoosh();
  el.classList.add('cover');
  await wait(520);
  if (card) { el.classList.add('show'); await wait(card.hold || 1300); }
  try { mid(); } catch (e) { console.error(e); }
  await wait(120);
  el.classList.remove('show', 'cover');
  S.transitioning = false;
}

// 다음 장면이 새 월드면 큰 월드 카드, 아니면 스테이지 카드
function stageCard(idx) {
  const st = idx === 'endless' ? ENDLESS : STAGES[idx];
  const w = WORLDS[st.world];
  const newWorld = !S.stage || S.stage.world !== st.world || S.state === 'menu';
  const mobs = Object.keys(st.spawn).slice(0, 4).concat(st.boss ? [st.boss] : []);
  return newWorld
    ? { world: st.world, emoji: w.emoji, kicker: st.endless ? '♾️ 무한 모드' : `WORLD ${st.world + 1}`, title: w.name, mobs, hold: 1600 }
    : { world: st.world, emoji: st.boss ? '👑' : '⚔️', kicker: st.id, title: st.title, mobs, hold: 900 };
}
function goStage(idx) {
  transitionTo(() => { hideBanner(); UI.menu.classList.add('hidden'); UI.map.classList.add('hidden'); startStage(idx); }, stageCard(idx));
}
function goMap() {
  transitionTo(() => { hideBanner(); showMenu(); showMap(); });
}

async function beginStage(idx) {
  initAudio();
  keepAwake();
  unlockSpeech();
  goLandscape();
  if (S.useCam && !S.camReady) {
    UI.map.classList.add('hidden'); UI.menu.classList.remove('hidden');   // 로딩 문구가 보이게
    const ok = await initInput();
    if (!ok) return;
  }
  goStage(idx);
}

function startStage(idx) {
  const st = idx === 'endless' ? ENDLESS : STAGES[idx];
  Object.assign(S, {
    stageIdx: idx, stage: st, world: st.world,
    hp: CFG.playerHp, maxHp: CFG.playerHp, score: 0, combo: 0, maxCombo: 0,
    kills: {}, killsAny: 0, dodged: 0, hurtCount: 0, missionsComplete: false,
    monsters: [], dying: [], fx: [], texts: [], trails: [], ally: null,
    spawnT: 1.2, boss: null, nextBossAt: st.bossEvery || 0, bossCycle: 0, fever: 0, stageT: 0, clearDelay: 0,
    noBodyT: 0, bodyT: 0,
    players: [0, 1, 2].map(() => ({ score: 0, kills: 0 })), multi: false,
    swarmT: 12, pace: 1, event: null, eventT: rand(28, 36),
    assist: Math.max(CFG.assistMin + 0.06, 1 - 0.1 * (S.failStreak[st.id] || 0)),
  });
  hudCache = ''; comboShown = -1; updateComboHud();
  UI.fever.classList.add('hidden');
  initAmbient(); initProps();
  document.body.classList.add('playing');
  UI.hud.classList.remove('hidden');
  UI.pauseBtn.classList.remove('hidden'); UI.dbgBtn.classList.remove('hidden');
  UI.stageLabel.textContent = `${WORLDS[st.world].emoji} ${st.id} ${st.title}`;
  updateHud(); updateBossHud();
  startMusic(st.world);
  setState('intro');

  const body = st.endless
    ? '끝없이 몰려오는 몬스터! 얼마나 버틸 수 있을까?'
    : (st.boss ? '미션을 끝내면 <b>보스</b>가 나타나요! 👑' : '미션을 모두 끝내면 클리어!');
  showBanner({
    kicker: `${WORLDS[st.world].emoji} ${WORLDS[st.world].name}  ·  ${st.id}`,
    title: st.title, body, missions: st.missions,
    gesture: S.useCam ? '🙌 양손을 번쩍 들면 바로 시작!' : '잠시 후 시작해요',
    buttons: [{ label: '시작!', cls: 'gold', onClick: () => afterIntro() }],
    action: () => afterIntro(), auto: 6,
  });
  const spoken = st.missions.map(missionText).join(', 그리고 ');
  say(`${st.title}! ${spoken || '최대한 많이 물리쳐요'}${st.boss ? '. 마지막엔 보스가 나와요!' : ''}`);
}

function afterIntro() {
  hideBanner();
  if (S.useCam && !S.landmarks.length) { setState('ready'); S.bodyT = 0; }
  else { setState('count'); S.countT = 3; SFX.count(); }
}

function stageClear() {
  setState('clear');
  const st = S.stage;
  S.failStreak[st.id] = 0;
  const stars = S.hurtCount <= 1 ? 3 : S.hurtCount <= 3 ? 2 : 1;
  const idx = S.stageIdx;
  SAVE.stars[st.id] = Math.max(SAVE.stars[st.id] || 0, stars);
  SAVE.unlocked = Math.max(SAVE.unlocked, idx + 2);
  persist();
  for (const m of S.monsters) poof(m);
  S.monsters = []; S.boss = null; updateBossHud();
  SFX.clear();
  confettiRain(90);
  const last = idx === STAGES.length - 1;
  if (last) {
    say('축하해요! 드래곤을 물리치고 모든 모험을 끝냈어요! 무한 모드가 열렸어요!');
    showBanner({
      kicker: '🎉 모든 모험 완료! 🎉', title: '진정한 몬스터 헌터!', stars,
      body: `점수 <b>${S.score.toLocaleString()}</b> · 최고 콤보 <b>${S.maxCombo}</b><br>♾️ 무한 모드가 열렸어요!`,
      gesture: S.useCam ? '🙌 양손을 들면 지도로!' : null,
      buttons: [{ label: '🗺 지도로', cls: 'gold', onClick: goMap }],
      action: goMap,
    });
    return;
  }
  const res = playerResults();
  say(res.speech || pick(['스테이지 클리어! 정말 잘했어요!', '클리어! 최고예요!', '해냈어요! 다음 모험으로 가요!']));
  showBanner({
    kicker: `${st.id} ${st.title}`, title: '스테이지 클리어!', stars,
    body: `<img src="${spriteURL('knight')}" alt="" style="height:clamp(60px,12vw,100px);display:block;margin:0 auto 4px;animation:bob 1s ease-in-out infinite">`
      + `점수 <b>${S.score.toLocaleString()}</b> · 최고 콤보 <b>${S.maxCombo}</b>${res.html}`,
    gesture: S.useCam ? '🙌 양손을 번쩍 들면 다음 스테이지!' : '잠시 후 다음 스테이지로!',
    buttons: [
      { label: '다음 스테이지 ▶', cls: 'gold', onClick: () => goStage(idx + 1) },
      { label: '🗺 지도', cls: 'ghost', onClick: goMap },
    ],
    action: () => goStage(idx + 1), auto: 9,
  });
}

// 여러 명이 했으면 아이별 처치 수 + 메달 (모두 칭찬)
function playerResults() {
  if (!S.multi) return { html: '', speech: '' };
  const medals = ['🥇', '🥈', '🥉'];
  const ranked = S.players.map((p, i) => ({ ...p, i })).filter(p => p.kills > 0).sort((a, b) => b.kills - a.kills);
  if (ranked.length < 2) return { html: '', speech: '' };
  const html = '<div class="pres">' + ranked.map((p, r) =>
    `<div style="color:${PLAYER_HEX[p.i]}">${medals[r] || '🏅'} ${p.i + 1}P · ${p.kills}마리</div>`).join('') + '</div>';
  return { html, speech: `클리어! ${ranked[0].i + 1}P가 제일 많이 잡았어요! 모두 정말 잘했어요!` };
}

function stageFail() {
  setState('fail');
  S.failStreak[S.stage.id] = (S.failStreak[S.stage.id] || 0) + 1;
  SFX.fail();
  const idx = S.stageIdx;
  if (S.stage.endless) {
    SAVE.best = Math.max(SAVE.best, S.score); persist();
    say(`수고했어요! ${S.score}점!`);
  } else say('아쉬워요! 다시 한 번 해봐요!');
  showBanner({
    kicker: `${S.stage.id} ${S.stage.title}`,
    title: S.stage.endless ? `${S.score.toLocaleString()}점!` : '아쉬워요! 😢',
    body: S.stage.endless ? `최고 기록 ${SAVE.best.toLocaleString()}점 · 처치 ${S.killsAny}마리`
      : `조금만 더 하면 할 수 있어요!<br>물리친 몬스터 <b>${S.killsAny}</b>마리`,
    gesture: S.useCam ? '🙌 양손을 들면 다시 도전!' : null,
    buttons: [
      { label: '다시 도전 🔁', cls: 'gold', onClick: () => goStage(idx) },
      { label: '🗺 지도', cls: 'ghost', onClick: goMap },
    ],
    action: () => goStage(idx),
  });
}

function pauseGame(reason) {
  if (!['play', 'count', 'ready'].includes(S.state)) return;
  S.pausedFrom = S.state === 'ready' ? 'ready' : 'count';
  setState('paused');
  S.bodyT = 0;
  const auto = reason === 'body';
  S.manualPause = !auto;
  if (auto) say('화면 안으로 돌아와요!');
  showBanner({
    kicker: '⏸ 잠깐 멈춤', title: auto ? '화면 안으로 돌아와요!' : '일시정지',
    body: auto ? '카메라에 몸이 보이면 다시 시작해요' : '',
    gesture: null,
    buttons: [
      { label: '계속하기 ▶', cls: 'gold', onClick: resumeGame },
      { label: '🗺 지도', cls: 'ghost', onClick: goMap },
    ],
    action: null,
  });
}
function resumeGame() { AU.ctx?.resume?.(); S.manualPause = false; hideBanner(); setState('count'); S.countT = 3; SFX.count(); }

/* ═══════════════ 스폰 ═══════════════ */
function pickWeighted(table) {
  const entries = Object.entries(table);
  let t = Math.random() * entries.reduce((a, [, w]) => a + w, 0);
  for (const [k, w] of entries) { if ((t -= w) <= 0) return k; }
  return entries[0][0];
}

function spawn(kind, o = {}) {
  const K = KINDS[kind];
  const m = {
    kind, K, sprite: K.sprite || kind,
    hp: o.hp ?? K.hp ?? 1, maxHp: o.hp ?? K.hp ?? 1,
    z: o.z ?? 1.0, wx: o.wx ?? rand(-0.46, 0.46), wy: o.wy ?? (K.wy ? rand(K.wy[0], K.wy[1]) : 0.1),
    ox: 0, oy: 0, t: rand(0, 10), phase: rand(0, Math.PI * 2),
    cd: 0, flash: 0, blinkAt: rand(1, 4), blinkT: 0, alpha: 1, scale: K.scale || 1,
    sx: 0, sy: 0, r: 0, dead: false, boss: !!K.boss,
    mode: 'approach', shots: K.shots || 0, shotT: 0.6,
    age: 0,
    entry: K.item || K.proj ? 'pop' : (['wave', 'zigzag', 'fade', 'dash'].includes(K.move) ? 'fly'
      : (['run', 'hop', 'archer', 'bob'].includes(K.move) && !K.boss ? 'ground' : 'pop')),
  };
  m.baseWx = m.wx;
  if (K.move === 'float') { m.dir = Math.random() < 0.5 ? -1 : 1; m.wx = m.baseWx = -m.dir * 0.5; m.z = 0.75; }
  if (K.move === 'archer') m.stopZ = rand(0.5, 0.62);
  S.monsters.push(m);
  return m;
}

function spawnProj(kind, from, tx = rand(-0.28, 0.28), ty = rand(-0.05, 0.18)) {
  const m = spawn(kind, { z: from.z - 0.04, wx: from.wx, wy: from.wy - 0.05 });
  m.startZ = m.z; m.startWx = m.wx; m.startWy = m.wy; m.tx = tx; m.ty = ty;
  SFX.shoot();
  return m;
}

function spawnBoss(kind) {
  const K = KINDS[kind];
  const hpMul = S.stage.endless ? 1 + S.bossCycle * 0.2 : 1;
  const m = spawn(kind, { z: 1.15, wx: 0, wy: 0.04, hp: Math.round(K.hp * hpMul) });
  m.mode = 'enter'; m.atkT = K.every; m.rage = 0; m.warned = false; m.atkN = 0;
  S.boss = m;
  updateBossHud();
  SFX.roar();
  S.shake = 0.6;
  toast(`⚠️ ${K.name} 등장! ⚠️`, 2.2);
  say(`${K.name} 등장! 여러 번 때려서 물리쳐요!`);
}

/* ═══════════════ 업데이트 ═══════════════ */
function updatePlay(dt) {
  const st = S.stage;
  S.stageT += dt;
  if (S.fever > 0) { S.fever -= dt; if (S.fever <= 0) UI.fever.classList.add('hidden'); }

  const prog = st.endless ? clamp(S.stageT / 240, 0, 1) : missionProgress();
  // 스테이지가 뒤로 갈수록 빠르고 촘촘하게 (무한 모드는 시간에 따라)
  const tier = st.endless ? 10 + S.stageT / 30 : S.stageIdx;
  S.pace = 1.12 + tier * 0.028;
  const interval = lerp(st.interval[0], st.interval[1], prog) * (S.boss ? 2.2 : 1) / S.assist / (1 + tier * 0.03);
  const speed = lerp(st.speed[0], st.speed[1], prog) * S.assist * S.pace;

  // 깜짝 이벤트
  updateEvent(dt);
  if (S.event && S.event.pauseSpawns) S.spawnT = Math.max(S.spawnT, 0.5);

  // 몬스터 떼: 주기적으로 3~4마리가 한꺼번에
  S.swarmT = (S.swarmT ?? 14) - dt;
  if (S.swarmT <= 0 && !S.boss && !S.clearDelay) {
    S.swarmT = rand(13, 18) - Math.min(5, tier * 0.3);
    const n = tier > 8 ? 4 : 3;
    for (let i = 0; i < n; i++) {
      const k = pickWeighted(st.spawn);
      if (KINDS[k].bomb) continue;
      spawn(k, { wx: -0.4 + (0.8 * i) / (n - 1) + rand(-0.05, 0.05), z: 1.0 + i * 0.04 });
    }
    toast('⚡ 몬스터 떼다! ⚡', 1.3); SFX.roar();
  }

  // 스폰
  S.spawnT -= dt;
  if (S.spawnT <= 0 && !S.clearDelay) {
    S.spawnT = interval * rand(0.75, 1.25);
    const live = S.monsters.filter(m => !m.K.item && !m.boss && !m.K.proj).length;
    if (live < CFG.maxMonsters) {
      const r = Math.random();
      if (r < CFG.heartChance && S.hp < S.maxHp) spawn('heart');
      else if (r < CFG.heartChance + CFG.starChance && S.fever <= 0) spawn('star');
      else spawn(pickWeighted(st.spawn));
    }
  }
  if (st.endless && !S.boss && S.killsAny >= S.nextBossAt) {
    S.nextBossAt += st.bossEvery;
    spawnBoss(st.bosses[S.bossCycle % st.bosses.length]);
    S.bossCycle++;
  }

  updateMonsters(dt, speed);
  if (S.state !== 'play') return;
  updateAlly(dt);
  resolveHits();
  if (S.state !== 'play') return;

  // 미션 완료 → 보스 or 클리어
  if (!st.endless && !S.missionsComplete && st.missions.every(missionDone)) {
    S.missionsComplete = true;
    if (st.boss) spawnBoss(st.boss);
    else { S.clearDelay = 1.2; toast('미션 완료! 🎉', 1.2); SFX.star(); }
  }
  if (S.clearDelay) { S.clearDelay -= dt; if (S.clearDelay <= 0) { S.clearDelay = 0; stageClear(); } }

  // 몸이 화면 밖으로 → 자동 일시정지
  if (S.useCam) {
    S.noBodyT = S.landmarks.length ? 0 : S.noBodyT + dt;
    if (S.noBodyT > 2.5) pauseGame('body');
  }
}

function updateMonsters(dt, baseSpeed) {
  const slow = S.fever > 0 ? 0.55 : 1;
  for (const m of S.monsters) {
    if (m.dead) continue;
    const K = m.K;
    m.t += dt;
    m.age += dt;
    m.cd = Math.max(0, m.cd - dt);
    m.flash = Math.max(0, m.flash - dt * 5);
    m.blinkAt -= dt;
    if (m.blinkAt <= 0) { m.blinkT = 0.13; m.blinkAt = rand(1.5, 4.5); }
    m.blinkT = Math.max(0, m.blinkT - dt);
    m.ox = 0; m.oy = 0;

    if (m.boss) { updateBoss(m, dt); project1(m); continue; }

    let spd = baseSpeed * (K.speed || 1) * slow;
    switch (K.move) {
      case 'bob': m.oy = Math.sin(m.t * 3 + m.phase) * 0.02; break;
      case 'wave': m.wx = m.baseWx * 0.5 + Math.sin(m.t * 1.6 + m.phase) * 0.34; break;
      case 'zigzag': m.wx = m.baseWx * 0.6 + tri(m.t * 0.9 + m.phase) * 0.3; m.oy = Math.sin(m.t * 12) * 0.01; break;
      case 'hop': m.oy = -Math.abs(Math.sin(m.t * 4 + m.phase)) * 0.13; break;
      case 'fade': m.alpha = 0.12 + 0.88 * (0.5 + 0.5 * Math.sin(m.t * 2.1 + m.phase)); break;
      case 'dash': spd *= ((m.t + m.phase) % 1.6) < 0.9 ? 0.25 : 2.6; break;
      case 'run':
        m.ox = Math.sin(m.t * 9 + m.phase) * 0.012;
        m.oy = -Math.abs(Math.sin(m.t * 9 + m.phase)) * 0.035;
        break;
      case 'archer':
        m.ox = Math.sin(m.t * 9 + m.phase) * 0.01;
        if (m.mode === 'approach') {
          m.oy = -Math.abs(Math.sin(m.t * 9 + m.phase)) * 0.03;
          if (m.z <= m.stopZ) { m.mode = 'shoot'; m.shotT = 0.8; }
        } else if (m.mode === 'shoot') {
          spd = 0; m.ox = 0;
          m.shotT -= dt;
          if (m.shotT <= 0) {
            spawnProj('arrow', m);
            m.shots--; m.shotT = K.shotEvery * (S.fever > 0 ? 1.5 : 1);
            if (m.shots <= 0) m.mode = 'charge';
          }
        } else { spd *= 1.7; m.oy = -Math.abs(Math.sin(m.t * 12)) * 0.04; }
        break;
      case 'float':
        spd = 0.12; m.wx += m.dir * dt * 0.16; m.oy = Math.sin(m.t * 2.4) * 0.03;
        break;
      case 'arc':
        spd = 0; m.wx += m.vx * dt; m.wy += m.vy * dt; m.vy += 1.1 * dt;
        if (m.wy > 0.5 || Math.abs(m.wx) > 0.95) { m.dead = true; }
        break;
      case 'fall':
        spd = 0; m.wx += m.vx * dt; m.wy += m.vy * dt;
        if (m.wy > 0.45) { m.dead = true; }
        break;
      case 'straight': {
        spd = (K.speed || 1.6) * 0.27 * slow * (0.5 + 0.5 * S.assist);
        const f = clamp(m.z / m.startZ, 0, 1);
        m.wx = lerp(m.tx, m.startWx, f); m.wy = lerp(m.ty, m.startWy, f);
        break;
      }
    }
    m.z -= spd * dt;
    project1(m);

    if (K.move === 'float' && Math.abs(m.wx) > 0.75) { m.dead = true; continue; }
    if (K.gold && m.t > 7) { m.dead = true; poof(m); continue; }         // 7초 지나면 도망
    if (K.treasure) continue;
    if (m.z <= 0) reach(m);
  }
  S.monsters = S.monsters.filter(m => !m.dead);
  S.monsters.sort((a, b) => b.z - a.z);
}

const ENTRY_T = 0.55;
const easeOutBack = (x) => 1 + 2.7 * Math.pow(x - 1, 3) + 1.7 * Math.pow(x - 1, 2);
function project1(m) {
  let oy = m.oy;
  const e = clamp(m.age / ENTRY_T, 0, 1);
  if (e < 1) {
    if (m.entry === 'ground') oy += (1 - e) * (1 - e) * 0.3;        // 땅에서 솟아오름
    else if (m.entry === 'fly') oy -= (1 - e) * (1 - e) * 0.7;      // 하늘에서 내려옴
  }
  const P = toScreen(m.wx + m.ox, m.wy + oy, m.z);
  m.sx = P.x; m.sy = P.y;
  m.r = baseR() * P.p * m.scale * (m.boss ? CFG.bossScale : 1);
  m.pop = m.entry === 'pop' ? Math.max(0.05, easeOutBack(e)) : 1;
  if (!m.puffed) { m.puffed = true; entryPuff(m); }
}
function entryPuff(m) {
  if (m.K.proj || m.K.treasure) return;
  const ground = m.entry === 'ground';
  const baseY = ground ? m.sy + m.r : m.sy;
  for (let i = 0; i < (m.boss ? 26 : 12); i++) {
    const a = ground ? rand(Math.PI * 1.05, Math.PI * 1.95) : rand(0, Math.PI * 2);
    const sp = rand(0.5, 1.4) * m.r * 2.2;
    S.fx.push({ x: m.sx + rand(-m.r, m.r) * 0.6, y: baseY, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      life: rand(0.5, 0.8), size: m.r * rand(0.18, 0.32), hue: ground ? 30 : 0, rect: false, rot: 0, vr: 0,
      smoke: true, gentle: true });
  }
  if (m.entry === 'pop') SFX.pop();
}

function reach(m) {
  m.dead = true;
  if (m.K.item) return;
  if (m.K.bomb) {
    S.dodged++; S.score += 50;
    addText(m.sx, Math.min(m.sy, H * 0.8), '피했다! 👍', '#8affc1', 0.9);
    SFX.pop();
    return;
  }
  addText(W / 2, H * 0.7, '아야!', '#ff8fa3', 1.1);
  hurt(1);
}

function hurt(n) {
  if (S.state !== 'play' || S.clearDelay) return;   // 미션 완료 직후엔 안 다침
  if (!SAVE.god) S.hp -= n;       // 무적 모드: 하트는 안 줄고 반응만
  S.hurtCount += n; S.combo = 0;
  S.assist = Math.max(CFG.assistMin, S.assist - 0.09);
  S.flashRed = 1; S.shake = Math.max(S.shake, 0.4);
  SFX.hurt();
  navigator.vibrate?.(120);
  if (S.hp <= 0) { S.hp = 0; updateHud(); stageFail(); }
}

/* ── 보스 ── */
function updateBoss(m, dt) {
  const K = m.K;
  const hold = CFG.bossHoldZ;
  if (m.tele > 0) {       // 유령왕 순간이동
    m.tele -= dt;
    m.alpha = clamp(Math.abs(m.tele - 0.35) / 0.35, 0, 1);
    if (m.tele < 0.35 && !m.teleDone) { m.teleDone = true; m.wxBase = rand(-0.38, 0.38); }
    if (m.tele <= 0) m.alpha = 1;
  }
  switch (m.mode) {
    case 'enter':
      m.z -= 0.28 * dt;
      m.oy = -Math.abs(Math.sin(m.t * 5)) * 0.03;
      if (m.z <= hold) { m.mode = 'fight'; m.wxBase = 0; }
      break;
    case 'fight':
      if (K.fly) {
        m.wx = Math.sin(m.t * 0.55) * 0.32;
        m.wy = -0.14 + Math.sin(m.t * 1.1) * 0.07;
      } else {
        m.wx = (m.wxBase || 0) + Math.sin(m.t * 0.7) * 0.22;
        m.wy = 0.04 + Math.sin(m.t * 1.3) * 0.03;
      }
      m.z = lerp(m.z, hold, dt * 1.5);
      m.atkT -= dt;
      if (m.atkT <= 0) { bossAttack(m); m.atkT = K.every * (S.fever > 0 ? 1.6 : 1) / S.assist; }
      m.rage += dt;
      if (m.rage > CFG.bossRageTime - 4 && !m.warned) {
        m.warned = true; toast('😡 보스가 화났다! 빨리 때려!', 2); say('보스가 화났어요! 빨리 때려요!');
      }
      if (m.rage >= CFG.bossRageTime) { m.mode = 'lunge'; SFX.roar(); }
      break;
    case 'lunge':
      m.z -= 0.75 * dt * (S.fever > 0 ? 0.6 : 1);
      m.oy = -Math.abs(Math.sin(m.t * 10)) * 0.04;
      if (m.z <= 0.03) { hurt(1); m.mode = 'retreat'; m.rage = 0; m.warned = false; S.shake = 0.8; }
      break;
    case 'retreat':
      m.z += 0.6 * dt;
      if (m.z >= hold) m.mode = 'fight';
      break;
    case 'dive':      // 드래곤 급강하: 가까이 왔다가 돌아감 (피해 없음, 때릴 기회!)
      m.diveT += dt;
      m.z = hold - Math.sin(clamp(m.diveT / 2.2, 0, 1) * Math.PI) * 0.26;
      m.wy = lerp(m.wy, 0.05, dt * 3);
      if (m.diveT >= 2.2) m.mode = 'fight';
      break;
  }
}

function bossAttack(m) {
  const K = m.K;
  m.atkN++;
  const summon = (kind, n) => {
    for (let i = 0; i < n; i++) {
      const s = spawn(kind, { z: m.z + 0.04, wx: clamp(m.wx + rand(-0.25, 0.25), -0.46, 0.46), wy: m.wy + 0.12 });
      s.baseWx = s.wx;
    }
  };
  switch (K.attack) {
    case 'summon': summon(K.summon, K.count); toast('꼬마들을 불렀다!', 1); break;
    case 'teleport': m.tele = 0.7; m.teleDone = false; summon(K.summon, K.count); break;
    case 'throw': spawnProj(K.shoot, m); break;
    case 'volley':
      if (m.atkN % 3 === 0) { summon(K.summon, 2); toast('고블린 부하 출동!', 1); }
      else { const c = rand(-0.1, 0.1); [-0.24, 0, 0.24].forEach(dx => spawnProj(K.shoot, m, clamp(c + dx, -0.35, 0.35))); }
      break;
    case 'dragon':
      if (m.atkN % 3 === 1) {
        const c = rand(-0.12, 0.12);
        [-0.3, 0, 0.3].forEach(dx => spawnProj(K.shoot, m, clamp(c + dx, -0.38, 0.38)));
        toast('🔥 불을 뿜는다! 쳐내요!', 1.1);
      } else if (m.atkN % 3 === 2) summon(K.summon, K.count);
      else { m.mode = 'dive'; m.diveT = 0; toast('🐉 급강하! 지금이야!', 1.1); SFX.roar(); }
      break;
    case 'mix':
      if (m.atkN % 2) spawnProj(K.shoot, m);
      else summon(K.summon, K.count);
      if (m.atkN % 5 === 0) { [-0.25, 0.25].forEach(dx => spawnProj(K.shoot, m, dx)); }
      break;
  }
}

/* ═══════════════ 깜짝 이벤트 (지루하지 않게) ═══════════════ */
const EVENTS = ['treasure', 'gold', 'giant', 'meteor', 'duck', 'shield', 'jump'];
const POSE_EVENTS = ['duck', 'shield', 'jump'];
function updateEvent(dt) {
  if (S.boss || S.clearDelay) return;
  const ev = S.event;
  if (!ev) {
    S.eventT -= dt;
    if (S.eventT <= 0) {
      let pool = EVENTS.filter(e => e !== S.lastEvent);
      if (!(S.useCam && S.trackMode === 'pose')) pool = pool.filter(e => !POSE_EVENTS.includes(e));   // 자세 이벤트는 몸 인식에서만
      startEvent(pick(pool));
    }
    return;
  }
  ev.t += dt;
  switch (ev.type) {
    case 'treasure':
      ev.spawnT -= dt;
      if (ev.spawnT <= 0 && ev.t < 7) {
        ev.spawnT = 0.28;
        const side = Math.random() < 0.5 ? -1 : 1;
        const c = spawn('coin', { z: rand(0.3, 0.55), wx: side * 0.75, wy: 0.25 });
        c.vx = -side * rand(0.3, 0.55); c.vy = -rand(0.75, 1.05);
      }
      if (ev.t > 9) endEvent(`금화 ${ev.got}개! 💰`);
      break;
    case 'meteor':
      ev.spawnT -= dt;
      if (ev.spawnT <= 0 && ev.t < 7) {
        ev.spawnT = 0.35;
        const mt = spawn('meteor', { z: rand(0.3, 0.55), wx: rand(-0.55, 0.55), wy: -0.6 });
        mt.vx = rand(-0.1, 0.1); mt.vy = rand(0.45, 0.65);
      }
      if (ev.t > 9) endEvent(`별똥별 ${ev.got}개! 🌠`);
      break;
    case 'gold':
      if (ev.t > 0.3 && !S.monsters.some(m => m.kind === 'goldgoblin')) endEvent(ev.got ? null : '황금 고블린이 도망갔다! 💨');
      break;
    case 'giant':
      if (ev.t > 0.3 && !S.monsters.some(m => m.kind === 'giantslime')) endEvent(null);
      break;
    case 'duck': case 'shield': case 'jump': updatePose(ev, dt); break;
  }
}
function startEvent(type) {
  S.event = { type, t: 0, got: 0, spawnT: 0.6, pauseSpawns: ['treasure', 'meteor'].includes(type) || POSE_EVENTS.includes(type) };
  S.lastEvent = type;
  SFX.star();
  switch (type) {
    case 'treasure': toast('💰 보물 러시! 금화를 모아요!', 2); say('보물 러시! 금화를 마구 모아요!'); break;
    case 'meteor': toast('🌠 별똥별 비! 쳐서 모아요!', 2); say('별똥별이 떨어져요! 쳐서 모아요!'); break;
    case 'gold': { spawn('goldgoblin', { z: 1.0 }); toast('✨ 황금 고블린 등장! 잡으면 1000점!', 2); say('황금 고블린이다! 빨리 잡아요!'); break; }
    case 'giant': { spawn('giantslime', { z: 1.05, wx: 0 }); toast('🟢 왕슬라임이 굴러온다! 여러 번 때려요!', 2); say('왕슬라임이 굴러와요! 여러 번 때려요!'); break; }
    case 'duck': case 'shield': case 'jump': startPose(S.event); break;
  }
}
function endEvent(msg) {
  if (msg) { toast(msg, 1.6); SFX.clear(); }
  S.event = null;
  S.eventT = rand(34, 44);
}

// 자세 이벤트: 경고(2.2초) → 장애물이 지나가는 순간(판정 구간)에 자세를 취하면 성공. 실패해도 하트는 안 깎임
//   duck   통나무가 머리 높이로 → 쪼그려 앉기 (코가 내려감)
//   shield 불 파도가 몰려옴     → 두 팔을 양옆으로 쫙 (손목 간격 > 어깨 폭 × 2.2)
//   jump   가시 통나무가 발밑으로 → 제자리 점프 (코가 올라감)
const POSES = {
  duck:   { warn: '🙇 통나무가 온다! 앉아!', speak: '통나무가 날아와요! 모두 앉아요!', ok: '모두 피했다!',
            test: (b, base) => base.nose != null && b[0].y - base.nose > 0.1 },
  shield: { warn: '🛡️ 불 파도다! 팔을 쫙 벌려 방패!', speak: '불 파도가 와요! 팔을 쫙 벌려서 막아요!', ok: '방패로 막았다!',
            test: (b) => Math.abs(b[15].x - b[16].x) > Math.abs(b[11].x - b[12].x) * 2.2 && (b[15].visibility ?? 1) > 0.5 && (b[16].visibility ?? 1) > 0.5 },
  jump:   { warn: '🦘 가시 통나무! 점프!', speak: '가시 통나무가 굴러와요! 점프해요!', ok: '모두 뛰어넘었다!',
            test: (b, base) => base.nose != null && base.nose - b[0].y > 0.05 },
};
function bodyBySlot() {
  const out = {};
  for (const b of S.landmarks) if ((b[0].visibility ?? 1) > 0.5) out[b.slot] = b;
  return out;
}
function startPose(ev) {
  const cfg = POSES[ev.type];
  ev.base = {}; ev.passed = new Set(); ev.phase = 'warn';
  toast(cfg.warn, 2.2); say(cfg.speak);
}
function updatePose(ev, dt) {
  const cfg = POSES[ev.type];
  const bodies = bodyBySlot();
  // 경고 초반 1.2초: 서 있을 때 기준 코 높이 기록 (평균)
  if (ev.t < 1.2) {
    for (const k in bodies) {
      const B = ev.base[k] || (ev.base[k] = { sum: 0, n: 0 });
      B.sum += bodies[k][0].y; B.n++; B.nose = B.sum / B.n;
    }
  }
  ev.obsX = ev.t < 2.2 ? null : lerp(-0.3, 1.3, (ev.t - 2.2) / 1.4);
  // 판정 구간: 장애물이 화면 가운데를 지나는 동안 한 번이라도 자세를 취하면 성공
  if (ev.t >= 2.5 && ev.t <= 3.3) {
    for (const k in bodies) if (ev.base[k] && cfg.test(bodies[k], ev.base[k])) ev.passed.add(k);
  }
  if (ev.phase === 'warn' && ev.t > 3.3) {
    ev.phase = 'done';
    const total = Object.keys(ev.base).length, ok = ev.passed.size;
    if (total && ok >= total) {
      S.score += 500 * total; confettiRain(60); SFX.clear();
      addText(W / 2, H * 0.4, `${cfg.ok} +${500 * total}`, '#8affc1', 1.6); say('잘했어요!', false);
    } else {
      SFX.pop(); addText(W / 2, H * 0.4, ok ? `${ok}명 성공! 😅` : '아이쿠! 😵', '#ffd166', 1.4);
      if (ok) S.score += 300 * ok;
    }
    // 성공한 아이 머리 위에 표시
    for (const k of ev.passed) {
      const b = bodies[k]; if (!b) continue;
      const P = lmToScreen(b[0]); addText(P.x, P.y - shortSide() * 0.12, '⭐', PLAYER_HEX[k] || '#fff', 1.2);
    }
  }
  if (ev.t > 4.1) endEvent(null);
}
function drawDuckLog() {
  const ev = S.event;
  if (!ev || !POSES[ev.type]) return;
  const ss = shortSide();
  const y = ev.type === 'duck' ? H * 0.24 : ev.type === 'jump' ? H * 0.88 : H * 0.5;
  const hgt = ev.type === 'shield' ? H * 0.5 : ss * 0.12;
  if (ev.obsX == null) {      // 경고 띠 + 안내 문구
    ctx.save(); ctx.globalAlpha = 0.3 + 0.3 * Math.sin(ev.t * 14);
    ctx.fillStyle = ev.type === 'shield' ? '#ff7a1a' : '#ff4d4d'; ctx.fillRect(0, y - hgt / 2, W, hgt);
    ctx.globalAlpha = 1; ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `${Math.round(ss * 0.09)}px Jua, sans-serif`;
    ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(0,0,0,.6)';
    const label = { duck: '⬇ 앉아! ⬇', shield: '⬅ 팔 쫙! ➡', jump: '⬆ 점프! ⬆' }[ev.type];
    const ly = ev.type === 'duck' ? y + hgt * 1.2 : ev.type === 'jump' ? y - hgt * 1.4 : y;
    ctx.strokeText(label, W / 2, ly); ctx.fillText(label, W / 2, ly);
    ctx.restore();
    return;
  }
  const x = ev.obsX * W;
  ctx.save();
  if (ev.type === 'shield') {           // 불 파도: 세로로 넘실대는 불꽃 벽
    for (let i = 0; i < 14; i++) {
      const yy = H * 0.2 + i * H * 0.05, wob = Math.sin(performance.now() / 90 + i) * ss * 0.03;
      const g = ctx.createRadialGradient(x + wob, yy, 0, x + wob, yy, ss * 0.12);
      g.addColorStop(0, 'rgba(255,240,150,.95)'); g.addColorStop(0.5, 'rgba(255,120,30,.8)'); g.addColorStop(1, 'rgba(255,60,20,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x + wob, yy, ss * 0.12, 0, Math.PI * 2); ctx.fill();
    }
  } else {                               // 통나무 (점프용은 가시 달림, 굴러감)
    const len = W * (ev.type === 'jump' ? 0.35 : 0.5);
    ctx.translate(x, y);
    ctx.fillStyle = '#8a5a2b'; ctx.fillRect(-len / 2, -hgt / 2, len, hgt);
    ctx.fillStyle = '#6b4424';
    for (let i = -2; i <= 2; i++) ctx.fillRect(i * len / 5 - 2, -hgt / 2, 4, hgt);
    if (ev.type === 'jump') {
      ctx.fillStyle = '#d8dee9';
      for (let i = -4; i <= 4; i++) {
        const sx = i * len / 9 + (performance.now() / 20 % (len / 9));
        ctx.beginPath(); ctx.moveTo(sx - hgt * 0.15, -hgt / 2); ctx.lineTo(sx, -hgt); ctx.lineTo(sx + hgt * 0.15, -hgt / 2); ctx.fill();
      }
    }
    ctx.fillStyle = '#c99a5b';
    ctx.beginPath(); ctx.ellipse(len / 2, 0, hgt * 0.3, hgt / 2, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

/* ═══════════════ 꼬마 기사 (아군) ═══════════════ */
function spawnAlly() {
  S.ally = { t: 0, dur: 2.6, dir: Math.random() < 0.5 ? 1 : -1, bossHit: false };
  toast('🛡️ 꼬마 기사 출동!', 1.4);
  SFX.go();
}
function updateAlly(dt) {
  const a = S.ally;
  if (!a) return;
  a.t += dt;
  const k = a.t / a.dur;
  const P = toScreen(0, 0.16, 0.3);
  a.r = baseR() * P.p * 1.05;
  a.x = a.dir > 0 ? lerp(-a.r * 2, W + a.r * 2, k) : lerp(W + a.r * 2, -a.r * 2, k);
  a.y = P.y - Math.abs(Math.sin(a.t * 14)) * a.r * 0.18;
  for (const m of S.monsters) {
    if (m.dead || m.K.bomb || m.K.item || m.z > 0.95) continue;
    const near = Math.abs(m.sx - a.x) < a.r * 0.9 + m.r * 0.6 && Math.abs(m.sy - a.y) < a.r * 1.8 + m.r;
    if (!near) continue;
    if (m.boss) {
      if (!a.bossHit) { a.bossHit = true; for (let i = 0; i < 3 && m.hp > 1; i++) m.hp--; m.flash = 1; SFX.bossHit(); updateBossHud(); addText(m.sx, m.sy, '기사의 일격! ⚔️', '#8affc1', 1.2); }
      continue;
    }
    m.hp = 0; m.flash = 1;
    kill(m, a.dir, -1);
  }
  if (Math.random() < 0.5) S.fx.push({ x: a.x - a.dir * a.r * 0.6, y: a.y + a.r * 0.9, vx: -a.dir * rand(40, 120), vy: rand(-80, -20),
    life: 0.6, size: rand(3, 7), hue: 40, rect: false, rot: 0, vr: 0 });
  if (k >= 1) S.ally = null;
}
function drawAlly() {
  const a = S.ally;
  if (!a || a.x == null) return;
  const imgs = SPR.img.knight, meta = SPR.meta.knight;
  if (!imgs || !imgs[0] || !meta) return;
  const size = a.r * meta.sizePerRadius;
  const frame = Math.sin(a.t * 18) > 0 ? 4 : 5;
  ctx.save();
  drawGlow(a.x, a.y, a.r * 1.8, '255,230,120', 0.45);
  ctx.translate(a.x, a.y);
  if (a.dir < 0) ctx.scale(-1, 1);
  ctx.rotate(0.12);
  ctx.drawImage(imgs[frame] || imgs[0], -size / 2, -size / 2 + size * meta.centerOffsetY, size, size);
  ctx.restore();
}

/* ═══════════════ 타격 판정 ═══════════════ */
function segHitsCircle(x0, y0, x1, y1, cx, cy, r) {
  const dx = x1 - x0, dy = y1 - y0, fx = x0 - cx, fy = y0 - cy;
  const a = dx * dx + dy * dy;
  if (a < 1e-6) return fx * fx + fy * fy <= r * r;
  const t = clamp(-(fx * dx + fy * dy) / a, 0, 1);
  const px = x0 + dx * t - cx, py = y0 + dy * t - cy;
  return px * px + py * py <= r * r;
}

function resolveHits() {
  if (!S.points.length) return;
  const minSp = swipeMin();
  const pad = S.useCam ? TRACK[S.trackMode].hitPad : 1.05;
  for (const m of S.monsters) {
    if (m.dead || m.z > 1.05) continue;
    if (m.alpha < 0.45) continue;                          // 투명한 유령 / 순간이동 중
    const item = !!m.K.item || !!m.K.treasure;
    for (const p of S.points) {
      if (m.cd > 0 && (!S.multi || m.lastPl === (p.pl || 0))) continue;   // 같은 아이 연타 방지, 다른 아이는 통과(합체)
      if (p.speed < (item ? minSp * 0.25 : minSp)) continue;   // 아이템은 스치기만 해도 획득
      if (!segHitsCircle(p.px, p.py, p.x, p.y, m.sx, m.sy, m.r * pad)) continue;
      onHit(m, p);
      break;
    }
  }
}

function onHit(m, p) {
  const K = m.K;
  const dir = Math.sign(p.x - p.px) || 1;
  if (K.treasure) {
    m.dead = true;
    if (S.event) S.event.got++;
    const g = K.score * (S.fever > 0 ? 2 : 1);
    S.score += g;
    const P = S.players[p.pl || 0]; if (P) P.score += g;
    SFX.pop(); tone(1200 + Math.random() * 400, 0.08, 'square', 0.04);
    burst(m.sx, m.sy, m.r, K.draw === 'coin' ? 48 : 200, 10, true);
    addText(m.sx, m.sy, `+${g}`, '#ffd166', 0.7);
    return;
  }
  if (K.item) {
    m.dead = true;
    if (K.item === 'heal') {
      S.hp = Math.min(S.maxHp, S.hp + 1);
      SFX.heal(); addText(m.sx, m.sy, '+❤️', '#ff8fb8', 1.2); burst(m.sx, m.sy, m.r, 340, 24);
    } else {
      S.fever = CFG.feverTime; UI.fever.classList.remove('hidden');
      SFX.star(); addText(m.sx, m.sy, '피버 타임! ⭐', '#ffd166', 1.4); burst(m.sx, m.sy, m.r, 48, 40);
      spawnAlly();
      say('피버 타임! 꼬마 기사가 도와주러 왔어요!');
    }
    return;
  }
  if (K.bomb) {
    // 아이들이 자주 칠 수밖에 없으니 하트는 안 깎고, 우스꽝스러운 그을음 + 콤보·점수 감소
    m.dead = true;
    SFX.bomb(); S.shake = 0.8; S.soot = 1.4;
    S.combo = 0; S.score = Math.max(0, S.score - 200);
    burst(m.sx, m.sy, m.r * 1.6, 25, 50, true);
    addText(m.sx, m.sy, '펑! 앗 뜨거! 🔥', '#ffb347', 1.4);
    navigator.vibrate?.(200);
    return;
  }
  // 합체 공격 판정
  const now = S.stageT, pl = p.pl || 0;
  m.lastPl = pl;
  m.hitBy = m.hitBy || {};
  m.hitBy[pl] = now;
  const team = Object.keys(m.hitBy).filter(k => now - m.hitBy[k] < 0.4).length;
  if (S.multi && team >= 2 && !m.teamed) {
    m.teamed = true;
    const dmg = m.boss ? 3 : m.hp;
    m.hp = Math.max(m.boss ? 1 : 0, m.hp - dmg + 1);
    S.score += 300 * team; S.shake = Math.max(S.shake, 0.6);
    burst(m.sx, m.sy, m.r * 1.4, 50, 60, true);
    addText(m.sx, m.sy - m.r * 1.2, `💥 ${team}명 합체 공격! +${300 * team}`, '#fff3a0', 1.6);
    SFX.star(); SFX.bossHit();
    if (Math.random() < 0.5) say('합체 공격!', false);
    setTimeout(() => { m.teamed = false; }, 800);
  }
  m.hp -= 1; m.cd = m.boss ? 0.22 : CFG.hitCooldown; m.flash = 1;
  m.z = Math.min(1.0, m.z + (m.boss ? (m.mode === 'lunge' ? 0.07 : 0.015) : 0.05));    // 넉백
  burst(p.x, p.y, m.r * 0.5, hueOf(m), m.boss ? 10 : 6);
  if (m.boss) {
    SFX.bossHit(); S.shake = Math.max(S.shake, 0.18);
    m.rage = Math.max(0, m.rage - 0.6);                   // 때릴수록 화가 가라앉음
    if (m.mode === 'lunge' && m.z > 0.35) { m.mode = 'retreat'; m.rage = 0; m.warned = false; }
    updateBossHud();
  }
  if (m.hp <= 0) kill(m, dir, p.pl || 0);
  else SFX.hit(S.combo);
}

function kill(m, dir, pl = 0) {
  m.dead = true;
  const K = m.K;
  if (pl >= 0) { S.combo++; S.maxCombo = Math.max(S.maxCombo, S.combo); }
  const mult = 1 + Math.min(3, Math.floor(S.combo / 5) * 0.5);
  const gain = Math.round((m.boss ? 3000 : (K.score || 100)) * mult * (S.fever > 0 ? 2 : 1));
  S.score += gain;
  const P = S.players[pl];
  if (P) { P.score += gain; if (!K.proj) P.kills++; }
  S.kills[m.kind] = (S.kills[m.kind] || 0) + 1;
  if (!K.proj && !K.treasure) {
    S.killsAny++;
    S.assist = Math.min(1, S.assist + 0.012);
    if (S.killsAny % CFG.healEvery === 0 && S.hp < S.maxHp) {
      S.hp++; SFX.heal(); addText(W / 2, H * 0.62, '❤️ 회복!', '#ff8fb8', 1.2);
    }
  }
  // 빙글빙글 날아가는 퇴장
  S.dying.push({ sprite: m.sprite, K, x: m.sx, y: m.sy, r: m.r, vx: dir * W * rand(0.7, 1.1), vy: -H * rand(0.6, 0.9),
    rot: 0, vr: dir * rand(8, 14), life: 0.8 });
  burst(m.sx, m.sy, m.r, hueOf(m), m.boss ? 80 : 22, true);
  const who = pl < 0 ? '🛡️ ' : (S.multi ? `${pl + 1}P ` : '');
  addText(m.sx, m.sy - m.r, K.proj ? `${who}막았다! +${gain}` : `${who}+${gain}`,
    pl < 0 ? '#fff3a0' : S.multi ? PLAYER_HEX[pl] : (K.proj ? '#8affc1' : '#ffd166'), 1.0);
  if (K.proj) SFX.parry(); else SFX.kill(S.combo);
  if (pl >= 0 && S.combo > 0 && S.combo % 5 === 0) {
    const pr = pick(PRAISE);
    toast(`${S.combo} 콤보! ${pr}`, 1.1);
    if (S.combo % 10 === 0) say(`${S.combo} 콤보! ${pr}`, false);
  }
  if (K.gold) { confettiRain(80); say('황금 고블린을 잡았어요! 천 점!', false); if (S.event) S.event.got = 1; }
  if (K.split) {       // 왕슬라임 → 꼬마 슬라임 4마리로 분열
    for (let i = 0; i < 4; i++) { const c = spawn(K.split, { z: Math.min(1, m.z + 0.08), wx: clamp(m.wx + (i - 1.5) * 0.14, -0.5, 0.5), wy: m.wy }); c.baseWx = c.wx; }
    toast('💥 뿅! 꼬마들로 갈라졌다!', 1.3);
  }
  if (m.boss) {
    S.boss = null; updateBossHud();
    S.shake = 1.2; confettiRain(120);
    say(`${K.name}를 물리쳤어요! 대단해요!`);
    for (const o of S.monsters) if (!o.dead && !o.K.item) { o.dead = true; poof(o); }
    if (!S.stage.endless) S.clearDelay = 1.6;
    else toast(`👑 ${K.name} 격파! +${gain}`, 2);
  }
}

function hueOf(m) {
  return { slime: 150, bat: 262, horn: 25, mushroom: 0, bee: 50, ghost: 220, golem: 200, imp: 15, snowman: 200,
    goblin: 100, archer: 100, shield: 30, skeleton: 190, arrow: 40, snowball: 200, fireball: 20,
    kingslime: 170, ghostking: 265, goblinchief: 100, yeti: 205, boss: 350, minislime: 150,
    darkknight: 285, dragon: 155 }[m.kind] ?? 50;
}

/* ═══════════════ 이펙트 ═══════════════ */
function burst(x, y, r, hue, n = 16, confetti = false) {
  for (let i = 0; i < n; i++) {
    const a = rand(0, Math.PI * 2), sp = rand(0.8, 3) * Math.max(r, 20);
    S.fx.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - (confetti ? r * 1.5 : 0),
      life: 1, size: rand(3, 7) * (r / 70 + 0.6), hue: confetti && Math.random() < 0.5 ? rand(0, 360) : hue,
      rect: confetti && Math.random() < 0.6, rot: rand(0, 6), vr: rand(-10, 10) });
  }
  const cap = lowQuality ? 250 : 600;
  if (S.fx.length > cap) S.fx.splice(0, S.fx.length - cap);
}
function confettiRain(n) {
  for (let i = 0; i < n; i++) {
    S.fx.push({ x: rand(0, W), y: rand(-H * 0.3, 0), vx: rand(-60, 60), vy: rand(80, 260), life: rand(1.6, 2.6),
      size: rand(5, 10), hue: rand(0, 360), rect: true, rot: rand(0, 6), vr: rand(-8, 8), gentle: true });
  }
}
function poof(m) { burst(m.sx, m.sy, m.r * 0.6, 0, 10); }
function addText(x, y, text, color, life = 1) {
  S.texts.push({ x, y, text, color, life, max: life, size: clamp(shortSide() * 0.055, 18, 40) });
}

/* ═══════════════ 배경: 월드 분위기 ═══════════════ */
function initAmbient() {
  S.ambient = [];
  for (let i = 0; i < 44; i++) S.ambient.push(newAmbient(true));
}
function newAmbient(anywhere) {
  const type = WORLDS[S.world].particle;
  const a = { x: rand(0, 1), y: anywhere ? rand(0, 1) : -0.05, s: rand(0.5, 1.4), ph: rand(0, 6), type };
  if (type === 'ember') a.y = anywhere ? rand(0, 1) : 1.05;
  return a;
}
function updateAmbient(dt) {
  for (const a of S.ambient) {
    a.ph += dt;
    switch (a.type) {
      case 'leaf': a.y += dt * 0.06 * a.s; a.x += Math.sin(a.ph * 1.3) * dt * 0.03; break;
      case 'snow': a.y += dt * 0.08 * a.s; a.x += Math.sin(a.ph) * dt * 0.02; break;
      case 'dust': a.y -= dt * 0.015 * a.s; a.x += Math.sin(a.ph * 0.7) * dt * 0.02; break;
      case 'ember': a.y -= dt * 0.09 * a.s; a.x += Math.sin(a.ph * 2) * dt * 0.02; break;
    }
    if (a.y > 1.08 || a.y < -0.08) Object.assign(a, newAmbient(false));
  }
}
function drawAmbient() {
  for (const a of S.ambient) {
    const x = a.x * W, y = a.y * H, s = a.s * shortSide() * 0.009;
    ctx.save();
    ctx.translate(x, y);
    switch (a.type) {
      case 'leaf':
        ctx.rotate(a.ph * 2); ctx.fillStyle = `rgba(${a.s > 1 ? '140,220,90' : '230,190,80'},.75)`;
        ctx.beginPath(); ctx.ellipse(0, 0, s * 1.6, s * 0.7, 0, 0, Math.PI * 2); ctx.fill(); break;
      case 'snow':
        ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.beginPath(); ctx.arc(0, 0, s, 0, Math.PI * 2); ctx.fill(); break;
      case 'dust':
        ctx.fillStyle = `rgba(200,160,255,${0.35 + 0.35 * Math.sin(a.ph * 3)})`;
        ctx.beginPath(); ctx.arc(0, 0, s * 0.8, 0, Math.PI * 2); ctx.fill(); break;
      case 'ember':
        ctx.fillStyle = `rgba(255,${140 + 80 * Math.sin(a.ph * 5) | 0},60,.85)`;
        ctx.beginPath(); ctx.arc(0, 0, s * 0.7, 0, Math.PI * 2); ctx.fill(); break;
    }
    ctx.restore();
  }
}

// 길가 소품: 양옆에서 앞으로 흘러와 전진하는 느낌
function initProps() {
  S.props = [];
  for (let z = 1.2; z > 0; z -= 0.22) for (const side of [-1, 1]) S.props.push({ side, z: z + rand(-0.05, 0.05), v: Math.random() });
}
function updateProps(dt, moving) {
  const sp = CFG.propSpeed * (moving ? 1.9 * (S.pace || 1) : 0.4) * (S.fever > 0 ? 1.4 : 1);
  for (const p of S.props) {
    p.z -= sp * dt;
    if (p.z < -0.15) { p.z += 1.35; p.v = Math.random(); }
  }
}
function drawProps() {
  const sc = WORLDS[S.world].scenery;
  const list = [...S.props].sort((a, b) => b.z - a.z);
  for (const pr of list) {
    const P = toScreen(pr.side * (0.95 + pr.v * 0.2), 0.34, pr.z);
    const h = baseR() * P.p * 2.6;
    if (P.x < -h * 2 || P.x > W + h * 2) continue;
    ctx.save();
    ctx.globalAlpha = clamp((1.25 - pr.z) * 1.5, 0, 0.85);
    ctx.translate(P.x, P.y);
    drawProp(sc, h, pr);
    ctx.restore();
  }
}
function drawProp(sc, h, pr) {
  switch (sc) {
    case 'forest':
    case 'snow': {
      ctx.fillStyle = '#5b3a1e'; ctx.fillRect(-h * 0.06, -h * 0.25, h * 0.12, h * 0.25);
      const green = sc === 'snow' ? '#2f6b4f' : (pr.v > 0.5 ? '#2f8a3e' : '#3c9a48');
      for (let i = 0; i < 3; i++) {
        const y = -h * (0.2 + i * 0.26), w = h * (0.42 - i * 0.1);
        ctx.fillStyle = green;
        ctx.beginPath(); ctx.moveTo(0, y - h * 0.38); ctx.lineTo(w, y); ctx.lineTo(-w, y); ctx.closePath(); ctx.fill();
        if (sc === 'snow') {
          ctx.fillStyle = '#f2f7ff';
          ctx.beginPath(); ctx.moveTo(0, y - h * 0.38); ctx.lineTo(w * 0.45, y - h * 0.2); ctx.lineTo(-w * 0.45, y - h * 0.2); ctx.closePath(); ctx.fill();
        }
      }
      break;
    }
    case 'fort': {
      for (let i = -1; i <= 1; i++) {
        ctx.fillStyle = i ? '#8a5a2b' : '#9c6a36';
        const x = i * h * 0.16;
        ctx.fillRect(x - h * 0.07, -h * 0.9, h * 0.14, h * 0.9);
        ctx.beginPath(); ctx.moveTo(x - h * 0.07, -h * 0.9); ctx.lineTo(x, -h * 1.05); ctx.lineTo(x + h * 0.07, -h * 0.9); ctx.fill();
      }
      if (pr.v > 0.6) {     // 깃발
        ctx.fillStyle = '#5b3a1e'; ctx.fillRect(-h * 0.02, -h * 1.5, h * 0.04, h * 0.6);
        ctx.fillStyle = '#e63946';
        ctx.beginPath(); ctx.moveTo(h * 0.02, -h * 1.5); ctx.lineTo(h * 0.32, -h * 1.4); ctx.lineTo(h * 0.02, -h * 1.3); ctx.fill();
      }
      break;
    }
    case 'castle': {
      ctx.fillStyle = '#4a4560'; ctx.fillRect(-h * 0.14, -h * 1.1, h * 0.28, h * 1.1);
      ctx.fillStyle = '#5a5474';
      for (let i = 0; i < 3; i++) ctx.fillRect(-h * 0.14 + i * h * 0.1, -h * 1.2, h * 0.07, h * 0.1);
      const fl = 0.8 + 0.2 * Math.sin(performance.now() / 90 + pr.v * 10);
      const g = ctx.createRadialGradient(0, -h * 0.8, 0, 0, -h * 0.8, h * 0.4);
      g.addColorStop(0, `rgba(255,190,90,${0.9 * fl})`); g.addColorStop(1, 'rgba(255,120,40,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, -h * 0.8, h * 0.4, 0, Math.PI * 2); ctx.fill();
      break;
    }
    case 'lair': {
      // 보랏빛으로 빛나는 수정 기둥
      const glow = 0.6 + 0.4 * Math.sin(performance.now() / 300 + pr.v * 8);
      ctx.fillStyle = '#2a1a3a';
      ctx.beginPath(); ctx.moveTo(-h * 0.3, 0); ctx.lineTo(-h * 0.1, -h * 0.9); ctx.lineTo(h * 0.05, -h * 1.15); ctx.lineTo(h * 0.3, 0); ctx.fill();
      ctx.fillStyle = `rgba(210,120,255,${0.75 * glow})`;
      ctx.beginPath(); ctx.moveTo(-h * 0.02, -h * 0.2); ctx.lineTo(h * 0.04, -h * 0.95); ctx.lineTo(h * 0.14, -h * 0.25); ctx.fill();
      break;
    }
    case 'volcano': {
      ctx.fillStyle = '#2b2226';
      ctx.beginPath(); ctx.moveTo(-h * 0.4, 0); ctx.lineTo(-h * 0.25, -h * 0.55); ctx.lineTo(h * 0.1, -h * 0.7); ctx.lineTo(h * 0.4, 0); ctx.fill();
      ctx.strokeStyle = `rgba(255,${120 + 60 * Math.sin(performance.now() / 200 + pr.v * 6) | 0},40,.9)`;
      ctx.lineWidth = Math.max(1, h * 0.03);
      ctx.beginPath(); ctx.moveTo(-h * 0.1, -h * 0.05); ctx.lineTo(0, -h * 0.35); ctx.lineTo(h * 0.12, -h * 0.5); ctx.stroke();
      break;
    }
  }
}

// 지평선 실루엣
function drawHorizon() {
  const sc = WORLDS[S.world].scenery;
  const y = toScreen(0, 0.34, 1.25).y;
  const t = performance.now() / 1000;
  ctx.save();
  ctx.globalAlpha = 0.6;
  switch (sc) {
    case 'forest':
      ctx.fillStyle = '#1f5a2e';
      ctx.beginPath(); ctx.moveTo(0, y);
      for (let x = 0; x <= W; x += W / 12) ctx.lineTo(x, y - H * (0.04 + 0.03 * Math.sin(x * 0.02)));
      ctx.lineTo(W, y); ctx.closePath(); ctx.fill();
      break;
    case 'fort': {
      ctx.fillStyle = '#6b4424';
      const w = W * 0.5, x0 = W / 2 - w / 2, top = y - H * 0.08;
      ctx.fillRect(x0, top, w, y - top);
      for (let x = x0; x < x0 + w; x += W * 0.02) { ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x + W * 0.01, top - H * 0.015); ctx.lineTo(x + W * 0.02, top); ctx.fill(); }
      for (const tx of [x0, x0 + w - W * 0.05]) {
        ctx.fillRect(tx, top - H * 0.08, W * 0.05, H * 0.08);
        ctx.fillStyle = '#8a3a2a';
        ctx.beginPath(); ctx.moveTo(tx - W * 0.008, top - H * 0.08); ctx.lineTo(tx + W * 0.025, top - H * 0.14); ctx.lineTo(tx + W * 0.058, top - H * 0.08); ctx.fill();
        ctx.fillStyle = '#6b4424';
      }
      break;
    }
    case 'castle': {
      ctx.fillStyle = 'rgba(255,245,210,.8)';
      ctx.beginPath(); ctx.arc(W * 0.78, H * 0.14, shortSide() * 0.06, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#2a2140';
      const cx = W / 2, base = y;
      ctx.fillRect(cx - W * 0.16, base - H * 0.1, W * 0.32, H * 0.1);
      for (const [dx, hh] of [[-0.16, 0.2], [-0.05, 0.26], [0.05, 0.22], [0.14, 0.18]]) {
        const tx = cx + dx * W;
        ctx.fillRect(tx, base - H * hh, W * 0.035, H * hh);
        ctx.beginPath(); ctx.moveTo(tx - W * 0.006, base - H * hh); ctx.lineTo(tx + W * 0.0175, base - H * (hh + 0.06)); ctx.lineTo(tx + W * 0.041, base - H * hh); ctx.fill();
      }
      ctx.fillStyle = 'rgba(255,220,120,.8)';
      for (let i = 0; i < 5; i++) ctx.fillRect(cx - W * 0.12 + i * W * 0.055, base - H * 0.06, W * 0.008, H * 0.014);
      break;
    }
    case 'snow':
      for (const [x, w, h] of [[0.2, 0.3, 0.2], [0.5, 0.36, 0.26], [0.82, 0.3, 0.18]]) {
        const px = W * x, ph = H * h;
        ctx.fillStyle = '#4d6b93';
        ctx.beginPath(); ctx.moveTo(px - W * w / 2, y); ctx.lineTo(px, y - ph); ctx.lineTo(px + W * w / 2, y); ctx.fill();
        ctx.fillStyle = '#eef5ff';
        ctx.beginPath(); ctx.moveTo(px - W * w * 0.13, y - ph * 0.74); ctx.lineTo(px, y - ph); ctx.lineTo(px + W * w * 0.13, y - ph * 0.74); ctx.fill();
      }
      break;
    case 'lair': {
      // 붉은 달 + 뾰족한 바위산 + 용의 둥지
      ctx.fillStyle = 'rgba(255,120,140,.8)';
      ctx.beginPath(); ctx.arc(W * 0.24, H * 0.15, shortSide() * 0.07, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#261536';
      ctx.beginPath(); ctx.moveTo(0, y);
      const peaks = [[0.08, 0.16], [0.18, 0.3], [0.3, 0.2], [0.42, 0.34], [0.55, 0.22], [0.66, 0.38], [0.8, 0.24], [0.92, 0.3]];
      for (const [px, ph] of peaks) { ctx.lineTo(W * (px - 0.05), y - H * ph * 0.3); ctx.lineTo(W * px, y - H * ph); }
      ctx.lineTo(W, y - H * 0.1); ctx.lineTo(W, y); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = `rgba(255,90,60,${0.5 + 0.3 * Math.sin(t * 2)})`; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.ellipse(W * 0.66, y - H * 0.36, W * 0.05, H * 0.02, 0, 0, Math.PI * 2); ctx.stroke();
      break;
    }
    case 'volcano': {
      const px = W * 0.5, ph = H * 0.24;
      ctx.fillStyle = '#3a1f1f';
      ctx.beginPath(); ctx.moveTo(px - W * 0.28, y); ctx.lineTo(px - W * 0.05, y - ph); ctx.lineTo(px + W * 0.05, y - ph); ctx.lineTo(px + W * 0.28, y); ctx.fill();
      const g = ctx.createRadialGradient(px, y - ph, 0, px, y - ph, W * 0.12);
      g.addColorStop(0, `rgba(255,140,40,${0.8 + 0.2 * Math.sin(t * 3)})`); g.addColorStop(1, 'rgba(255,60,20,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(px, y - ph, W * 0.12, 0, Math.PI * 2); ctx.fill();
      break;
    }
  }
  ctx.restore();
}

/* ═══════════════ 렌더 ═══════════════ */
function drawCam() {
  if (S.useCam && video.readyState >= 2) {
    const vw = video.videoWidth, vh = video.videoHeight;
    const sc = Math.max(W / vw, H / vh), dw = vw * sc, dh = vh * sc;
    ctx.save(); ctx.translate(W, 0); ctx.scale(-1, 1);
    ctx.drawImage(video, (W - dw) / 2, (H - dh) / 2, dw, dh);
    ctx.restore();
  } else {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#141a33'); g.addColorStop(1, '#070a14');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }
  if (S.stage) {
    const w = WORLDS[S.world];
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, w.tintTop); g.addColorStop(0.55, 'rgba(0,0,0,.05)'); g.addColorStop(1, w.tintBottom);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }
}

// 월드별 길: 불투명한 바닥 + 발밑으로 흘러오는 타일 → 앞으로 달리는 느낌
const GROUND = {
  forest:  { road: ['#c49a62', '#bb9159'], side: ['#4fa046', '#48963f'], edge: '#6f9e3a', lines: 'rgba(90,60,30,.35)' },
  fort:    { road: ['#a06c38', '#8d5d2e'], side: ['#6e913b', '#628435'], edge: '#5b3a1e', lines: 'rgba(40,20,5,.55)', planks: true },
  castle:  { road: ['#716a86', '#625c77'], side: ['#2e2940', '#28233a'], edge: '#9a93b3', lines: 'rgba(20,15,35,.5)', tiles: true },
  snow:    { road: ['#cfe6fb', '#c6e0f8'], side: ['#f7fbff', '#f1f6fd'], edge: '#ffffff', lines: 'rgba(120,150,190,.3)' },
  volcano: { road: ['#3d2c2b', '#352524'], side: ['#1f1515', '#261919'], edge: '#ff6a2a', lines: 'rgba(255,110,40,.35)', lava: true },
  lair:    { road: ['#3c2549', '#331f40'], side: ['#1d1227', '#231630'], edge: '#d27bff', lines: 'rgba(210,123,255,.3)', lava: true },
};
const ROAD_W = 0.62, GROUND_Y = 0.34, BAND = 0.09;

// 월드별 바닥 장식 (띠마다 고정된 난수로 배치 → 길과 함께 흘러옴)
function groundDeco(sc, band, zc, bh) {
  if (zc < -0.15 || bh < 1.5) return;
  const rr = (k) => { const v = Math.sin(band * 127.1 + k * 311.7) * 43758.5; return v - Math.floor(v); };
  const at = (wx) => toScreen(wx, GROUND_Y, zc);
  const P = project(zc), u = baseR() * P;   // 이 거리의 크기 단위
  const t = performance.now() / 1000;
  switch (sc) {
    case 'forest': {
      // 길 위 조약돌 + 길옆 풀·꽃
      for (let i = 0; i < 2; i++) {
        const q = at((rr(i) * 2 - 1) * ROAD_W * 0.85);
        ctx.fillStyle = rr(i + 5) > 0.5 ? '#9c8b78' : '#b3a390';
        ctx.beginPath(); ctx.ellipse(q.x, q.y, u * 0.09, u * 0.04, 0, 0, Math.PI * 2); ctx.fill();
      }
      for (const side of [-1, 1]) {
        const q = at(side * (ROAD_W + 0.12 + rr(side + 9) * 0.5));
        ctx.fillStyle = '#2f7a30';
        for (let k = -1; k <= 1; k++) {
          ctx.beginPath(); ctx.moveTo(q.x + k * u * 0.05, q.y); ctx.lineTo(q.x + k * u * 0.09, q.y - u * 0.18); ctx.lineTo(q.x + k * u * 0.05 + u * 0.03, q.y); ctx.fill();
        }
        if (rr(side + 3) > 0.55) {
          ctx.fillStyle = ['#ff7eb6', '#ffd23d', '#ffffff', '#b58cff'][Math.floor(rr(side + 4) * 4)];
          ctx.beginPath(); ctx.arc(q.x + u * 0.12, q.y - u * 0.08, u * 0.045, 0, Math.PI * 2); ctx.fill();
        }
      }
      break;
    }
    case 'fort': {
      // 판자 못
      ctx.fillStyle = 'rgba(40,30,20,.6)';
      for (const wx of [-ROAD_W * 0.85, ROAD_W * 0.85]) { const q = at(wx); ctx.beginPath(); ctx.arc(q.x, q.y, Math.max(1, u * 0.025), 0, Math.PI * 2); ctx.fill(); }
      break;
    }
    case 'castle': {
      // 가운데 붉은 융단 + 금테
      const a = toScreen(-0.22, GROUND_Y, zc + BAND / 2), b = toScreen(0.22, GROUND_Y, zc + BAND / 2);
      const c = toScreen(-0.22, GROUND_Y, zc - BAND / 2), d = toScreen(0.22, GROUND_Y, zc - BAND / 2);
      ctx.fillStyle = band % 2 ? '#a3243a' : '#b12a42';
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(d.x, d.y); ctx.lineTo(c.x, c.y); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#e8b84a'; ctx.lineWidth = Math.max(1, u * 0.03);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); ctx.moveTo(b.x, b.y); ctx.lineTo(d.x, d.y); ctx.stroke();
      break;
    }
    case 'snow': {
      // 발자국 + 얼음 반짝임
      if (band % 2 === 0) {
        for (const s_ of [-1, 1]) {
          const q = at(s_ * 0.08 + (rr(1) - 0.5) * 0.1);
          ctx.fillStyle = 'rgba(120,160,210,.55)';
          ctx.beginPath(); ctx.ellipse(q.x, q.y + (s_ > 0 ? bh * 0.3 : 0), u * 0.04, u * 0.022, 0, 0, Math.PI * 2); ctx.fill();
        }
      }
      if (rr(7) > 0.6) {
        const q = at((rr(8) * 2 - 1) * ROAD_W);
        const tw = 0.5 + 0.5 * Math.sin(t * 6 + band);
        ctx.fillStyle = `rgba(255,255,255,${0.9 * tw})`;
        ctx.fillRect(q.x - u * 0.05, q.y - 1, u * 0.1, 2); ctx.fillRect(q.x - 1, q.y - u * 0.05, 2, u * 0.1);
      }
      break;
    }
    case 'volcano': {
      // 빛나는 용암 금
      const q = at((rr(2) * 2 - 1) * ROAD_W * 0.8);
      ctx.strokeStyle = `rgba(255,${120 + 60 * Math.sin(t * 4 + band) | 0},40,.85)`; ctx.lineWidth = Math.max(1, u * 0.025);
      ctx.beginPath(); ctx.moveTo(q.x - u * 0.2, q.y); ctx.lineTo(q.x - u * 0.05, q.y - bh * 0.3); ctx.lineTo(q.x + u * 0.08, q.y + bh * 0.2); ctx.lineTo(q.x + u * 0.22, q.y - bh * 0.1); ctx.stroke();
      for (const side of [-1, 1]) if (rr(side + 11) > 0.6) {
        const p2 = at(side * (ROAD_W + 0.25 + rr(side + 12) * 0.4));
        ctx.fillStyle = `rgba(255,${90 + 50 * Math.sin(t * 3 + band) | 0},30,.8)`;
        ctx.beginPath(); ctx.ellipse(p2.x, p2.y, u * 0.2, u * 0.05, 0, 0, Math.PI * 2); ctx.fill();
      }
      break;
    }
    case 'lair': {
      // 빛나는 마법진 조각 + 작은 수정
      if (band % 3 === 0) {
        const q = at(0);
        ctx.strokeStyle = `rgba(210,123,255,${0.5 + 0.3 * Math.sin(t * 3 + band)})`; ctx.lineWidth = Math.max(1, u * 0.02);
        ctx.beginPath(); ctx.ellipse(q.x, q.y, u * 0.35, u * 0.08, 0, 0, Math.PI * 2); ctx.stroke();
      }
      for (const side of [-1, 1]) if (rr(side + 21) > 0.5) {
        const p2 = at(side * (ROAD_W + 0.2 + rr(side + 22) * 0.4));
        ctx.fillStyle = 'rgba(190,110,255,.85)';
        ctx.beginPath(); ctx.moveTo(p2.x - u * 0.04, p2.y); ctx.lineTo(p2.x, p2.y - u * 0.2); ctx.lineTo(p2.x + u * 0.04, p2.y); ctx.fill();
      }
      break;
    }
  }
}

// 카메라를 가리지 않는 반투명 레일: 가장자리 선 + 발밑으로 흘러오는 가로선
function drawFlowLines() {
  const rail = WORLDS[S.world].rail;
  ctx.save();
  ctx.lineCap = 'round';
  for (const wx of [-ROAD_W, ROAD_W]) {
    const a = toScreen(wx, GROUND_Y, 1.25), b = toScreen(wx, GROUND_Y, -0.1);
    ctx.strokeStyle = `rgba(${rail},.55)`; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  const off = S.roadZ % 0.18;
  for (let z = 1.25 + off; z > -0.1; z -= 0.18) {
    if (z > 1.25) continue;
    const a = toScreen(-ROAD_W, GROUND_Y, z), b = toScreen(ROAD_W, GROUND_Y, z);
    ctx.strokeStyle = `rgba(${rail},${clamp(1.25 - z, 0.08, 0.45)})`;
    ctx.lineWidth = Math.max(1.5, 5 * project(z) / project(0));
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  ctx.restore();
}

function drawGround() {
  const g = GROUND[WORLDS[S.world].scenery] || GROUND.forest;
  const off = S.roadZ % (BAND * 2);
  const zFar = 1.25;
  ctx.save();
  ctx.globalAlpha = 0.92;
  // 먼 곳 → 가까운 곳 순으로 띠를 그림
  for (let z = zFar + off; z > -0.25; z -= BAND) {
    const z0 = Math.min(z, zFar), z1 = Math.max(z - BAND, -0.25);
    if (z0 <= z1) continue;
    const a = toScreen(0, GROUND_Y, z0), b = toScreen(0, GROUND_Y, z1);
    if (a.y > H) break;
    const even = Math.floor((z + S.roadZ) / BAND + 1000) % 2 === 0;
    const yb = Math.min(b.y, H + 2);
    // 양옆 들판
    ctx.fillStyle = g.side[even ? 0 : 1];
    ctx.fillRect(0, a.y, W, yb - a.y + 1);
    // 길
    const L0 = toScreen(-ROAD_W, GROUND_Y, z0).x, R0 = toScreen(ROAD_W, GROUND_Y, z0).x;
    const L1 = toScreen(-ROAD_W, GROUND_Y, z1).x, R1 = toScreen(ROAD_W, GROUND_Y, z1).x;
    ctx.fillStyle = g.road[even ? 0 : 1];
    ctx.beginPath(); ctx.moveTo(L0, a.y); ctx.lineTo(R0, a.y); ctx.lineTo(R1, b.y); ctx.lineTo(L1, b.y); ctx.closePath(); ctx.fill();
    // 가로 줄눈 (판자·돌 타일)
    ctx.strokeStyle = g.lines; ctx.lineWidth = Math.max(1, (b.y - a.y) * 0.08);
    if (g.planks || g.tiles) { ctx.beginPath(); ctx.moveTo(L0, a.y); ctx.lineTo(R0, a.y); ctx.stroke(); }
    if (g.planks || g.tiles) {       // 세로 줄눈
      const n = g.planks ? 1 : 4;
      for (let i = 1; i < n + 1; i++) {
        const t = i / (n + 1) * 2 - 1 + (g.tiles && even ? 0.12 : 0);
        const x0 = toScreen(t * ROAD_W, GROUND_Y, z0).x, x1 = toScreen(t * ROAD_W, GROUND_Y, z1).x;
        ctx.beginPath(); ctx.moveTo(x0, a.y); ctx.lineTo(x1, b.y); ctx.stroke();
      }
    }
    // 길 가장자리
    const EW = 0.07;
    const eL0 = toScreen(-ROAD_W - EW, GROUND_Y, z0).x, eL1 = toScreen(-ROAD_W - EW, GROUND_Y, z1).x;
    const eR0 = toScreen(ROAD_W + EW, GROUND_Y, z0).x, eR1 = toScreen(ROAD_W + EW, GROUND_Y, z1).x;
    ctx.fillStyle = g.lava ? `rgba(255,${even ? 120 : 80},40,${0.75 + 0.25 * Math.sin(performance.now() / 250 + z * 20)})` : g.edge;
    if (g.lava && WORLDS[S.world].scenery === 'lair') ctx.fillStyle = `rgba(210,${even ? 123 : 90},255,${0.7 + 0.3 * Math.sin(performance.now() / 250 + z * 20)})`;
    ctx.beginPath(); ctx.moveTo(eL0, a.y); ctx.lineTo(L0, a.y); ctx.lineTo(L1, b.y); ctx.lineTo(eL1, b.y); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(R0, a.y); ctx.lineTo(eR0, a.y); ctx.lineTo(eR1, b.y); ctx.lineTo(R1, b.y); ctx.closePath(); ctx.fill();
    groundDeco(WORLDS[S.world].scenery, Math.floor((z + S.roadZ) / BAND + 1000), (z0 + z1) / 2, b.y - a.y);
  }
  ctx.restore();
  // 지평선 안개 (먼 곳이 부드럽게 사라짐)
  const yh = toScreen(0, GROUND_Y, zFar).y;
  const fog = ctx.createLinearGradient(0, yh - 2, 0, yh + H * 0.08);
  fog.addColorStop(0, 'rgba(10,12,24,.55)'); fog.addColorStop(1, 'rgba(10,12,24,0)');
  ctx.fillStyle = fog; ctx.fillRect(0, yh - 2, W, H * 0.08 + 2);
}

// 방사형 빛(오라)을 색마다 한 번만 만들어 재사용
const glowCache = {};
function glowImg(rgb, a0) {
  const key = rgb + a0;
  if (glowCache[key]) return glowCache[key];
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 16, 64, 64, 64);
  gr.addColorStop(0, `rgba(${rgb},${a0})`); gr.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  return (glowCache[key] = c);
}
function drawGlow(x, y, r, rgb, a0 = 0.35, alpha = 1) {
  const pa = ctx.globalAlpha; ctx.globalAlpha = pa * alpha;
  ctx.drawImage(glowImg(rgb, a0), x - r, y - r, r * 2, r * 2);
  ctx.globalAlpha = pa;
}

function drawMonster(m) {
  if (m.sx + m.r * 3 < 0 || m.sx - m.r * 3 > W) return;
  ctx.save();
  ctx.globalAlpha = m.alpha;
  // 그림자
  if (!m.K.proj && !m.K.item && !m.K.treasure) {
    ctx.save(); ctx.globalAlpha = 0.25 * m.alpha; ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.ellipse(m.sx, m.sy + m.r * 1.15, m.r * 0.8, m.r * 0.16, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  // 오라: 보스 / 아이템 / 폭탄 경고
  const aura = m.boss ? '255,60,90' : m.K.item ? (m.K.item === 'heal' ? '255,110,170' : '255,220,90') : m.K.bomb ? '255,90,40' : null;
  if (aura) drawGlow(m.sx, m.sy, m.r * 1.9, aura, 0.45, m.K.bomb ? 0.55 + 0.45 * Math.sin(m.t * 10) : 0.8);

  if (m.K.draw === 'coin' || m.K.draw === 'meteor') { drawTreasure(m); ctx.restore(); return; }
  if (m.K.gold) {
    drawGlow(m.sx, m.sy, m.r * 2, '255,215,80', 0.6);
    ctx.filter = 'sepia(1) saturate(4) hue-rotate(-12deg) brightness(1.15)';
  }
  if (m.K.proj) drawProjectile(m);
  else {
    const imgs = SPR.img[m.sprite], meta = SPR.meta[m.sprite];
    if (imgs && imgs[0] && meta) {
      // 프레임: 0 기본 · 1 찌그러짐 · 2 눈감음 · 3 맞음(X눈) · 4/5 달리기
      const running = m.K.move === 'run' || (m.K.move === 'archer' && m.mode !== 'shoot') || m.K.move === 'dash' || (m.boss && m.mode !== 'fight');
      let frame;
      if (m.flash > 0.25 && imgs[3]) frame = 3;
      else if (m.blinkT > 0) frame = 2;
      else if (running && imgs[4]) frame = Math.sin(m.t * (m.boss ? 7 : 11) + m.phase) > 0 ? 4 : 5;
      else frame = Math.sin(m.t * 6) > 0.55 ? 1 : 0;
      // 공격 준비: 보스 공격 직전 / 궁수 발사 직전 → 입 벌리고 팔 번쩍 + 부르르
      const windup = imgs[6] && ((m.boss && m.mode === 'fight' && m.atkT < 0.8) || (m.K.move === 'archer' && m.mode === 'shoot' && m.shotT < 0.6));
      if (windup && frame !== 3) { frame = 6; ctx.translate(Math.sin(m.t * 60) * m.r * 0.04, 0); }
      const img = imgs[frame] || imgs[0];
      const size = m.r * meta.sizePerRadius * (m.pop || 1);
      const x = m.sx - size / 2, y = m.sy - size / 2 + size * meta.centerOffsetY;
      // 달리는 병사는 좌우로 기우뚱
      if (m.K.move === 'run' || (m.K.move === 'archer' && m.mode !== 'shoot')) {
        ctx.translate(m.sx, m.sy); ctx.rotate(Math.sin(m.t * 9 + m.phase) * 0.06); ctx.translate(-m.sx, -m.sy);
      }
      ctx.drawImage(img, x, y, size, size);
      if (m.flash > 0) {
        ctx.globalAlpha = m.alpha * Math.min(1, m.flash) * 0.85;
        const wimg = whiteOf(m.sprite, frame) || whiteOf(m.sprite, 0);
        if (wimg) ctx.drawImage(wimg, x, y, size, size);
      }
    } else {
      ctx.fillStyle = `hsl(${hueOf(m)},80%,60%)`;
      ctx.beginPath(); ctx.arc(m.sx, m.sy, m.r, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.restore();

  // 궁수 조준 / 보스 공격 직전 경고
  if ((m.K.move === 'archer' && m.mode === 'shoot' && m.shotT < 0.6) || (m.boss && m.mode === 'fight' && m.atkT < 0.8)) {
    ctx.save(); ctx.fillStyle = '#ff4d4d'; ctx.font = `${Math.round(m.r * 0.9)}px Jua, sans-serif`;
    ctx.textAlign = 'center'; ctx.globalAlpha = 0.5 + 0.5 * Math.sin(m.t * 20);
    ctx.fillText('!', m.sx, m.sy - m.r * 1.3); ctx.restore();
  }
  // 체력바 (여러 번 맞는 몬스터, 보스는 상단 바)
  if (m.maxHp > 1 && !m.boss && m.hp < m.maxHp) {
    const bw = m.r * 1.4, bh = Math.max(5, m.r * 0.1), by = m.sy - m.r * 1.35;
    ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(m.sx - bw / 2, by, bw, bh);
    ctx.fillStyle = '#ffd166'; ctx.fillRect(m.sx - bw / 2, by, bw * (m.hp / m.maxHp), bh);
  }
}

function drawTreasure(m) {
  const r = m.r, t = m.t;
  if (m.K.draw === 'coin') {
    const sq = Math.abs(Math.cos(t * 8));           // 빙글빙글 도는 금화
    ctx.fillStyle = '#e8a91e'; ctx.beginPath(); ctx.ellipse(m.sx, m.sy, r * Math.max(0.15, sq), r, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffd84a'; ctx.beginPath(); ctx.ellipse(m.sx, m.sy, r * 0.78 * Math.max(0.12, sq), r * 0.78, 0, 0, Math.PI * 2); ctx.fill();
    if (sq > 0.5) { ctx.fillStyle = '#e8a91e'; ctx.font = `${Math.round(r)}px Jua, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('★', m.sx, m.sy + r * 0.05); }
  } else {
    const tail = ctx.createLinearGradient(m.sx, m.sy - r * 4, m.sx, m.sy);
    tail.addColorStop(0, 'rgba(255,255,255,0)'); tail.addColorStop(1, 'rgba(180,220,255,.8)');
    ctx.fillStyle = tail; ctx.beginPath(); ctx.moveTo(m.sx - r * 0.5, m.sy); ctx.lineTo(m.sx, m.sy - r * 4); ctx.lineTo(m.sx + r * 0.5, m.sy); ctx.fill();
    ctx.fillStyle = '#fff6b0'; ctx.font = `${Math.round(r * 2.2)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('⭐', m.sx, m.sy);
  }
}

function drawProjectile(m) {
  const K = m.K, r = m.r;
  if (K.draw === 'arrow') {
    // 정면으로 날아오는 화살: 화살촉 + 깃털 + 흔들림
    ctx.save(); ctx.translate(m.sx, m.sy); ctx.rotate(m.t * 6);
    ctx.fillStyle = '#9a6232'; ctx.beginPath(); ctx.arc(0, 0, r * 0.28, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#e63946';
    for (let i = 0; i < 3; i++) {
      ctx.rotate(Math.PI * 2 / 3);
      ctx.beginPath(); ctx.moveTo(0, -r * 0.2); ctx.lineTo(r * 0.35, -r * 0.95); ctx.lineTo(-r * 0.35, -r * 0.95); ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = '#d8dee9';
    ctx.beginPath(); ctx.moveTo(0, -r * 0.42); ctx.lineTo(r * 0.36, 0); ctx.lineTo(0, r * 0.42); ctx.lineTo(-r * 0.36, 0); ctx.closePath(); ctx.fill();
    ctx.restore();
    return;
  }
  const g = ctx.createRadialGradient(m.sx - r * 0.3, m.sy - r * 0.3, r * 0.1, m.sx, m.sy, r);
  g.addColorStop(0, '#ffffff'); g.addColorStop(0.4, K.color); g.addColorStop(1, K.glow);
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(m.sx, m.sy, r, 0, Math.PI * 2); ctx.fill();
}

function drawDying(dt) {
  for (const d of S.dying) {
    d.life -= dt; d.x += d.vx * dt; d.y += d.vy * dt; d.vy += H * 2.2 * dt; d.rot += d.vr * dt;
    const imgs = SPR.img[d.sprite], meta = SPR.meta[d.sprite];
    if (!imgs || !imgs[0] || !meta) continue;
    const size = d.r * meta.sizePerRadius * (0.6 + 0.4 * clamp(d.life / 0.8, 0, 1));
    ctx.save(); ctx.globalAlpha = clamp(d.life / 0.4, 0, 1);
    ctx.translate(d.x, d.y); ctx.rotate(d.rot);
    ctx.drawImage(imgs[3] || imgs[2] || imgs[0], -size / 2, -size / 2, size, size);   // X눈 = 기절
    ctx.restore();
  }
  S.dying = S.dying.filter(d => d.life > 0);
}

function drawFx(dt) {
  for (const f of S.fx) {
    f.x += f.vx * dt; f.y += f.vy * dt;
    f.vy += (f.gentle ? 60 : 520) * dt;
    if (f.gentle) f.vx *= 0.99;
    f.rot += f.vr * dt; f.life -= dt * (f.gentle ? 0.5 : 1.6);
    ctx.globalAlpha = clamp(f.life, 0, 1);
    ctx.fillStyle = f.smoke ? `hsla(${f.hue},15%,${f.hue ? 62 : 85}%,${0.55 * clamp(f.life * 2, 0, 1)})` : `hsl(${f.hue},95%,65%)`;
    if (f.rect) {
      ctx.save(); ctx.translate(f.x, f.y); ctx.rotate(f.rot);
      ctx.fillRect(-f.size / 2, -f.size / 4, f.size, f.size / 2); ctx.restore();
    } else { ctx.beginPath(); ctx.arc(f.x, f.y, f.size, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.globalAlpha = 1;
  S.fx = S.fx.filter(f => f.life > 0 && f.y < H + 40);
}

function drawTexts(dt) {
  ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const t of S.texts) {
    t.life -= dt; t.y -= dt * shortSide() * 0.12;
    const k = 1 - t.life / t.max;
    ctx.globalAlpha = clamp(t.life / (t.max * 0.4), 0, 1);
    ctx.font = `${Math.round(t.size * (1 + (k < 0.15 ? (0.15 - k) * 3 : 0)))}px Jua, sans-serif`;
    ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(0,0,0,.65)'; ctx.strokeText(t.text, t.x, t.y);
    ctx.fillStyle = t.color; ctx.fillText(t.text, t.x, t.y);
  }
  ctx.restore();
  S.texts = S.texts.filter(t => t.life > 0);
}

const PLAYER_COLORS = ['rgba(110,231,255,.85)', 'rgba(255,126,182,.85)', 'rgba(198,255,94,.85)'];
// 만화풍 장갑 손: (x,y) 위치, ang 방향(손가락이 향하는 쪽), 크기 r, 플레이어 색
function drawGlove(x, y, ang, r, color, mirror) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(ang + Math.PI / 2);
  if (mirror) ctx.scale(-1, 1);
  ctx.lineWidth = Math.max(2, r * 0.12); ctx.strokeStyle = '#1b1330'; ctx.fillStyle = color;
  // 손가락 4개
  for (let i = 0; i < 4; i++) {
    const fx = (i - 1.5) * r * 0.36, fl = r * (i === 1 || i === 2 ? 0.95 : 0.8);
    ctx.beginPath(); ctx.ellipse(fx, -r * 0.35 - fl * 0.45, r * 0.19, fl * 0.5, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  // 엄지
  ctx.beginPath(); ctx.ellipse(-r * 0.72, r * 0.02, r * 0.2, r * 0.36, -0.7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  // 손바닥
  ctx.beginPath(); ctx.ellipse(0, r * 0.05, r * 0.66, r * 0.58, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  // 하이라이트 + 흰 소매
  ctx.fillStyle = 'rgba(255,255,255,.45)';
  ctx.beginPath(); ctx.ellipse(-r * 0.22, -r * 0.12, r * 0.18, r * 0.12, -0.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.roundRect ? ctx.roundRect(-r * 0.62, r * 0.55, r * 1.24, r * 0.38, r * 0.14) : ctx.rect(-r * 0.62, r * 0.55, r * 1.24, r * 0.38);
  ctx.fill(); ctx.stroke();
  ctx.restore();
}

function drawBodies() {
  const T = TRACK[S.trackMode];
  const pose = S.trackMode === 'pose';
  const r = shortSide() * (pose ? 0.06 : 0.05);
  S.landmarks.forEach((body) => {
    const bi = body.slot ?? 0;
    const color = PLAYER_HEX[(pose ? bi : Math.floor(bi / 2)) % 3];
    const vis = (i) => !T.minVis || (body[i].visibility ?? 1) >= T.minVis;
    const P = (i) => lmToScreen(body[i]);
    ctx.globalAlpha = body.held ? 0.5 : 1;
    if (pose) {
      // 양손: 손목·검지·새끼 평균 위치, 팔꿈치→손목 방향
      for (const [el, wr, pi, ix, mirror] of [[13, 15, 17, 19, false], [14, 16, 18, 20, true]]) {
        if (!vis(wr)) continue;
        const w = P(wr), e = P(el), a = P(pi), b = P(ix);
        const x = (w.x * 2 + a.x + b.x) / 4, y = (w.y * 2 + a.y + b.y) / 4;
        const ang = vis(el) ? Math.atan2(w.y - e.y, w.x - e.x) : -Math.PI / 2;
        drawGlove(x + Math.cos(ang) * r * 0.4, y + Math.sin(ang) * r * 0.4, ang, r, color, mirror);
      }
      if (vis(0) && (S.landmarks.length > 1 || S.multi)) {
        const n = P(0);
        ctx.font = `${Math.round(shortSide() * 0.06)}px Jua, sans-serif`; ctx.textAlign = 'center';
        ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.strokeText(`${bi + 1}P`, n.x, n.y - shortSide() * 0.1);
        ctx.fillStyle = color; ctx.fillText(`${bi + 1}P`, n.x, n.y - shortSide() * 0.1);
      }
    } else {
      // 손 모드: 손바닥 중심(9), 손목(0)→중지 뿌리(9) 방향
      const w = P(0), m = P(9);
      drawGlove(m.x, m.y, Math.atan2(m.y - w.y, m.x - w.x), r, color, (body[0].x > body[9].x));
    }
  });
  ctx.globalAlpha = 1;
  // 휘두른 궤적 (노랑 = 타격 속도, 하늘색 = 부족)
  ctx.save(); ctx.lineCap = 'round';
  for (const t of S.trails) {
    const a = clamp(t.life / 0.22, 0, 1);
    ctx.strokeStyle = t.hot ? `rgba(255,209,102,${0.9 * a})` : `rgba(110,231,255,${0.4 * a})`;
    ctx.lineWidth = (t.hot ? 14 : 4) * (0.4 + 0.6 * a);
    ctx.beginPath(); ctx.moveTo(t.px, t.py); ctx.lineTo(t.x, t.y); ctx.stroke();
  }
  ctx.restore();
}

function drawOverlayText() {
  const cx = W / 2, cy = H / 2, ss = shortSide();
  ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,.8)'; ctx.shadowBlur = 16;
  if (S.state === 'ready') {
    const R = ss * 0.16;
    ctx.lineWidth = 9; ctx.strokeStyle = 'rgba(255,255,255,.18)';
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = '#8affc1';
    ctx.beginPath(); ctx.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp(S.bodyT, 0, 1)); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = `${Math.round(R * 0.8)}px sans-serif`;
    ctx.fillText(S.trackMode === 'pose' ? '🧍' : '✋', cx, cy);
    ctx.font = `${Math.round(ss * 0.065)}px Jua, sans-serif`;
    ctx.fillText(S.landmarks.length ? (S.trackMode === 'pose' && S.landmarks.length > 1 ? `${S.landmarks.length}명 준비 완료! 그대로!` : '좋아요! 그대로!') : (S.trackMode === 'pose' ? '뒤로 물러나 상체가 다 나오게 서주세요' : '카메라에 손을 보여주세요'),
      cx, cy + R + ss * 0.1);
  } else if (S.state === 'count') {
    const n = Math.ceil(S.countT), k = S.countT - Math.floor(S.countT);
    ctx.fillStyle = '#ffd166'; ctx.globalAlpha = clamp(k * 1.4, 0, 1);
    ctx.font = `${Math.round(ss * (0.3 + (1 - k) * 0.1))}px Jua, sans-serif`;
    ctx.fillText(n > 0 ? String(n) : '', cx, cy);
  } else if (S.state === 'play' && S.stateT < 0.8) {
    ctx.fillStyle = '#8affc1'; ctx.globalAlpha = clamp(1 - S.stateT / 0.8, 0, 1);
    ctx.font = `${Math.round(ss * 0.22)}px Jua, sans-serif`;
    ctx.fillText('시작!', cx, cy);
  }
  if (S.toastT > 0 && ['play', 'count'].includes(S.state)) {
    ctx.globalAlpha = clamp(S.toastT * 3, 0, 1);
    ctx.font = `${Math.round(ss * 0.08)}px Jua, sans-serif`;
    ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(0,0,0,.7)';
    ctx.strokeText(S.toastText, cx, H * 0.3);
    ctx.fillStyle = '#ffd166'; ctx.fillText(S.toastText, cx, H * 0.3);
  }
  ctx.restore();
}

// 속도선: 지평선 중심에서 가장자리로 스쳐 지나감
const SPEED_LINES = Array.from({ length: 26 }, () => ({ a: Math.random() * Math.PI * 2, d: Math.random(), v: 0.6 + Math.random() }));
function drawSpeedLines() {
  const cx = W / 2, cy = horizonY(), R = Math.hypot(W, H) * 0.6;
  const k = clamp(((S.pace || 1) - 1.05) * 2.2 + (S.fever > 0 ? 0.6 : 0), 0.15, 1);
  ctx.save();
  ctx.lineCap = 'round';
  for (const l of SPEED_LINES) {
    l.d += 0.035 * l.v * (S.pace || 1) * (S.fever > 0 ? 1.5 : 1);
    if (l.d > 1) { l.d = 0.35; l.a = Math.random() * Math.PI * 2; }
    const r0 = R * l.d, r1 = R * (l.d + 0.12);
    ctx.strokeStyle = `rgba(255,255,255,${0.35 * k * l.d})`;
    ctx.lineWidth = 2 + 3 * l.d;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(l.a) * r0, cy + Math.sin(l.a) * r0 * 0.7);
    ctx.lineTo(cx + Math.cos(l.a) * r1, cy + Math.sin(l.a) * r1 * 0.7);
    ctx.stroke();
  }
  ctx.restore();
}

function drawFeverBorder() {
  if (S.fever <= 0) return;
  const t = performance.now() / 300;
  const g = ctx.createLinearGradient(0, 0, W, H);
  for (let i = 0; i <= 4; i++) g.addColorStop(i / 4, `hsla(${(t * 60 + i * 90) % 360},100%,65%,.9)`);
  ctx.save(); ctx.strokeStyle = g; ctx.lineWidth = 10 + 4 * Math.sin(t * 4);
  ctx.strokeRect(5, 5, W - 10, H - 10); ctx.restore();
}

// 폭탄 맞았을 때 화면 가장자리 그을음 (점점 걷힘)
const SOOT = Array.from({ length: 14 }, () => ({ x: Math.random(), y: Math.random(), r: 0.12 + Math.random() * 0.14 }));
function drawSoot() {
  const a = clamp(S.soot / 1.4, 0, 1);
  ctx.save();
  for (const s of SOOT) drawGlow(s.x * W, s.y * H, s.r * shortSide(), '20,16,14', 0.85, a);
  ctx.restore();
}

function drawDebug() {
  if (!S.debug) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,77,109,.7)'; ctx.lineWidth = 1.5;
  const pad = S.useCam ? TRACK[S.trackMode].hitPad : 1;
  for (const m of S.monsters) { ctx.beginPath(); ctx.arc(m.sx, m.sy, m.r * pad, 0, Math.PI * 2); ctx.stroke(); }
  ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(8, H - 84, 250, 74);
  ctx.fillStyle = '#8affc1'; ctx.font = '12px ui-monospace, monospace';
  ctx.fillText(`fps ${S.fps.toFixed(0)}  detect ${S.detectMs.toFixed(1)}ms  ${S.trackMode}-${S.poseModel}/${S.delegate}${S.worker ? "/W" : ""}${lowQuality ? "/LQ" : ""}`, 16, H - 64);
  ctx.fillText(`bodies ${S.landmarks.length}  pts ${S.points.length}  swipe>${swipeMin().toFixed(0)}px/s`, 16, H - 48);
  ctx.fillText(`mobs ${S.monsters.length}  state ${S.state}  hp ${S.hp}`, 16, H - 32);
  ctx.restore();
}

function render(dt) {
  ctx.save();
  if (S.shake > 0) {
    const a = S.shake * shortSide() * 0.02;
    ctx.translate(rand(-a, a), rand(-a, a));
  }
  drawCam();
  if (S.stage && S.state === 'play') {   // 달리는 발걸음에 맞춰 살짝 출렁
    const tt = performance.now() / 1000 * 2.4 * (S.pace || 1);
    ctx.translate(Math.sin(tt) * H * 0.003, Math.abs(Math.sin(tt)) * H * 0.006);
  }
  if (S.stage) {
    drawHorizon();
    drawFlowLines();
    drawProps();
    drawAmbient();
    for (const m of S.monsters) drawMonster(m);
    drawAlly();
    drawDying(dt);
    drawFx(dt);
    drawTexts(dt);
  }
  if (S.stage && S.state === 'play') drawSpeedLines();
  if (S.stage) drawDuckLog();
  drawBodies();
  drawOverlayText();
  drawFeverBorder();
  if (S.soot > 0) drawSoot();
  if (S.flashRed > 0) { ctx.fillStyle = `rgba(255,40,80,${S.flashRed * 0.35})`; ctx.fillRect(-50, -50, W + 100, H + 100); }
  drawDebug();
  ctx.restore();
}

/* ═══════════════ 입력: 카메라 + 인식 ═══════════════ */
let landmarker = null;
let lastVideoTime = -1;
let lastFrameAt = 0, detectErrors = 0, lastBodyCount = 0;
const prevPts = new Map();

// 인식: 워커가 있으면 워커로(화면 안 막힘), 없으면 메인 스레드에서
let worker = null, workerBusy = false, workerResult = null, lastResultVT = -1;
function track(nowMs, dt) {
  S.points = [];
  if (video.readyState < 2 || (!landmarker && !worker)) { S.landmarks = []; return; }
  if (worker) {
    if (workerResult) { const r = workerResult; workerResult = null; applyResult(r.landmarks, r.vdt, r.ms); }
    else if (performance.now() - lastFrameAt > 800) { S.landmarks = []; prevPts.clear(); }
    if (!workerBusy && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      workerBusy = true;
      const vt = video.currentTime;
      const crop = currentCrop();
      makeFrame(crop)
        .then(bmp => worker.postMessage({ type: 'frame', bitmap: bmp, ts: performance.now(), vt, crop }, [bmp]))
        .catch(() => { workerBusy = false; });
    }
    return;
  }
  if (video.currentTime === lastVideoTime) {
    // 카메라가 멈추면(백그라운드·잠금 후) 옛 뼈대를 지워 자동 일시정지가 걸리게
    if (performance.now() - lastFrameAt > 600) { S.landmarks = []; prevPts.clear(); }
    return;
  }
  const vdt = lastVideoTime < 0 ? dt : clamp(video.currentTime - lastVideoTime, 0.012, 0.25);
  lastVideoTime = video.currentTime;
  const t0 = performance.now();
  let res;
  try { res = landmarker.detectForVideo(video, nowMs); detectErrors = 0; }
  catch (e) {
    if (++detectErrors === 30 && S.delegate === 'GPU') {
      console.warn('detect 실패 반복 → CPU로 전환', e);
      landmarker.close(); landmarker = null;
      initTracker(S.trackMode, 'CPU').catch(err => console.error(err));
    }
    return;
  }
  applyResult(res.landmarks || [], vdt, performance.now() - t0);
}

/* ── 인식률 향상: 스마트 크롭 + 어두운 방 밝기 보정 ── */
// 최근 2초 동안 사람이 있던 영역(정규화 좌표)을 넉넉히 잘라 확대 → 멀리 있는 작은 사람도 크게 보임
const cropBox = { x0: 1, y0: 1, x1: 0, y1: 0, t: 0 };
function updateCropBox(landmarks) {
  const now = performance.now();
  if (now - cropBox.t > 2000) Object.assign(cropBox, { x0: 1, y0: 1, x1: 0, y1: 0 });
  for (const b of landmarks) for (const i of [0, 11, 12, 15, 16, 19, 20, 23, 24]) {
    const p = b[i]; if (!p || (p.visibility ?? 1) < 0.3) continue;
    cropBox.x0 = Math.min(cropBox.x0, p.x); cropBox.x1 = Math.max(cropBox.x1, p.x);
    cropBox.y0 = Math.min(cropBox.y0, p.y); cropBox.y1 = Math.max(cropBox.y1, p.y);
    cropBox.t = now;
  }
}
function currentCrop() {
  const full = { x: 0, y: 0, w: 1, h: 1 };
  if (S.trackMode !== 'pose' || performance.now() - cropBox.t > 1200 || cropBox.x1 <= cropBox.x0) return full;
  // 팔을 뻗을 여유 + 새로 들어올 사람을 위해 넉넉히 (최소 화면의 60%)
  let w = (cropBox.x1 - cropBox.x0) * 1.9 + 0.2, h = (cropBox.y1 - cropBox.y0) * 1.6 + 0.25;
  w = clamp(w, 0.6, 1); h = clamp(Math.max(h, w * 0.75), 0.6, 1);
  const cx = (cropBox.x0 + cropBox.x1) / 2, cy = (cropBox.y0 + cropBox.y1) / 2;
  return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h };
}
let frameCanvas = null, frameCtx = null, boost = 1, lumaT = 0;
const lumaCanvas = document.createElement('canvas'); lumaCanvas.width = 32; lumaCanvas.height = 18;
const lumaCtx = lumaCanvas.getContext('2d', { willReadFrequently: true });
function measureLuma() {      // 1초마다 화면 밝기 측정 → 어두우면 보정
  if (performance.now() - lumaT < 1000) return;
  lumaT = performance.now();
  try {
    lumaCtx.drawImage(video, 0, 0, 32, 18);
    const d = lumaCtx.getImageData(0, 0, 32, 18).data;
    let sum = 0; for (let i = 0; i < d.length; i += 4) sum += d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
    S.luma = sum / (d.length / 4);
    boost = S.luma < 60 ? 1.6 : S.luma < 90 ? 1.3 : 1;
  } catch { /* 무시 */ }
}
async function makeFrame(c) {
  measureLuma();
  const vw = video.videoWidth || 960, vh = video.videoHeight || 540;
  const sx = c.x * vw, sy = c.y * vh, sw = c.w * vw, sh = c.h * vh;
  const rw = Math.round(Math.min(960, sw)), rh = Math.round(rw * sh / sw);
  if (boost > 1 && typeof OffscreenCanvas !== 'undefined') {
    if (!frameCanvas || frameCanvas.width !== rw || frameCanvas.height !== rh) {
      frameCanvas = new OffscreenCanvas(rw, rh); frameCtx = frameCanvas.getContext('2d');
    }
    frameCtx.filter = `brightness(${boost}) contrast(1.15)`;
    frameCtx.drawImage(video, sx, sy, sw, sh, 0, 0, rw, rh);
    return frameCanvas.transferToImageBitmap();
  }
  return createImageBitmap(video, sx, sy, sw, sh, { resizeWidth: rw, resizeHeight: rh, resizeQuality: 'medium' });
}
// 잘라낸 영역 좌표 → 전체 영상 좌표
function uncrop(landmarks, c) {
  if (!c || (c.w === 1 && c.h === 1)) return landmarks;
  return landmarks.map(b => b.map(p => ({ x: c.x + p.x * c.w, y: c.y + p.y * c.h, visibility: p.visibility })));
}

function plausibleBody(b) {
  const v = (i) => (b[i].visibility ?? 1);
  if (v(0) < 0.5 || v(11) < 0.5 || v(12) < 0.5) return false;
  const sw = Math.hypot(b[11].x - b[12].x, b[11].y - b[12].y);
  if (sw < 0.02 || sw > 0.6) return false;
  const shoulderY = (b[11].y + b[12].y) / 2;
  if (b[0].y > shoulderY) return false;                        // 코가 어깨보다 아래면 이상함
  return shoulderY - b[0].y < sw * 2.5;                        // 목이 비정상적으로 길면 버림
}

function onWorkerMessage(e) {
  const m = e.data;
  if (m.type === 'ready') { S.delegate = m.delegate; return; }
  if (m.type !== 'result') return;
  workerBusy = false;
  if (!m.landmarks) return;
  const vdt = lastResultVT < 0 ? 1 / 30 : clamp(m.vt - lastResultVT, 0.012, 0.25);
  lastResultVT = m.vt;
  const lms = uncrop(m.landmarks, m.crop);
  updateCropBox(lms);
  workerResult = { landmarks: lms, vdt, ms: m.ms };
}

function applyResult(landmarks, vdt, ms) {
  lastFrameAt = performance.now();
  S.detectMs = S.detectMs * 0.8 + ms * 0.2;
  // 사람마다 번호(slot)를 고정: 앞 프레임 위치와 가장 가까운 사람에게 같은 번호
  // 헛인식 거르기: 코·양어깨가 확실하고, 어깨 폭·몸 비율이 사람다운 것만
  if (S.trackMode === 'pose') landmarks = landmarks.filter(plausibleBody);
  S.landmarks = holdLost(assignSlots(landmarks));
  // full 모델이 이 폰에 너무 무거우면(평균 70ms 초과가 3초) 가벼운 모델로 교체
  if (S.trackMode === 'pose' && S.poseModel === 'full') {
    S.slowT = S.detectMs > 70 ? (S.slowT || 0) + vdt : 0;
    if (S.slowT > 3) {
      S.poseModel = 'lite'; S.slowT = 0;
      console.warn('full 모델이 느려서 lite로 전환');
      if (worker) worker.postMessage({ type: 'init', opts: trackerOpts('pose'), force: S.delegate });
      else { const old = landmarker; landmarker = null; old.close(); initTracker('pose', S.delegate).catch(err => console.error(err)); }
    }
  }
  if (S.trackMode === 'pose' && S.landmarks.length > 1 && S.stage) S.multi = true;
  lastBodyCount = S.landmarks.length;
  const maxJump = shortSide() * 0.35;
  const T = TRACK[S.trackMode];
  const seen = new Set();
  S.landmarks.forEach((body) => {
    if (body.held) return;
    const bi = body.slot;
    for (const id of T.hitIds) {
      const lm = body[id];
      if (T.minVis && (lm.visibility ?? 1) < T.minVis) continue;
      const raw = lmToScreen(lm);
      const key = `${bi}-${id}`;
      seen.add(key);
      const prev = prevPts.get(key);
      // 가벼운 평활화 (먼 거리 떨림 억제)
      const x = prev ? prev.x + (raw.x - prev.x) * 0.65 : raw.x;
      const y = prev ? prev.y + (raw.y - prev.y) * 0.65 : raw.y;
      if (prev && Math.hypot(x - prev.x, y - prev.y) > maxJump) { prevPts.set(key, { x, y }); continue; }   // 순간이동 = 인식 뒤바뀜
      const pl = S.trackMode === 'pose' ? bi : Math.floor(bi / 2);   // 손 모드: 두 손 = 한 사람
      if (prev) S.points.push({ x, y, px: prev.x, py: prev.y, speed: Math.hypot(x - prev.x, y - prev.y) / vdt, pl });
      prevPts.set(key, { x, y });
    }
  });
  for (const k of [...prevPts.keys()]) if (!seen.has(k)) prevPts.delete(k);
}

// 잠깐(0.4초) 인식이 끊긴 사람은 마지막 뼈대를 유지 (타격 점은 만들지 않음)
const lastSeenBody = {};
function holdLost(bodies) {
  const now = performance.now(), have = new Set(bodies.map(b => b.slot));
  for (const b of bodies) lastSeenBody[b.slot] = { b, t: now };
  const out = bodies.slice();
  for (const k in lastSeenBody) {
    const e = lastSeenBody[k];
    if (have.has(Number(k))) continue;
    if (now - e.t < 400) { const c = e.b.slice(); c.slot = e.b.slot; c.held = true; out.push(c); }
    else delete lastSeenBody[k];
  }
  return out.sort((a, b) => a.slot - b.slot);
}

// 번호 고정 추적: 어깨(손 모드는 손목) 중심을 앞 프레임 기록과 매칭
const tracks = [];   // { slot, x, y, seen }
function assignSlots(bodies) {
  const now = performance.now();
  const maxSlots = S.trackMode === 'pose' ? CFG.maxPlayers : CFG.maxPlayers * 2;
  const center = (b) => {
    const pts = S.trackMode === 'pose' ? [b[11], b[12]] : [b[0], b[9]];
    const P = pts.map(lmToScreen);
    return { x: (P[0].x + P[1].x) / 2, y: (P[0].y + P[1].y) / 2 };
  };
  const cs = bodies.map(center);
  const used = new Set(), taken = new Set();
  // 가까운 쌍부터 연결
  const pairs = [];
  cs.forEach((c, bi) => tracks.forEach((t, ti) => pairs.push({ bi, ti, d: Math.hypot(c.x - t.x, c.y - t.y) })));
  pairs.sort((a, b) => a.d - b.d);
  const slotOf = new Array(bodies.length).fill(-1);
  for (const p of pairs) {
    if (used.has(p.bi) || taken.has(p.ti) || p.d > W * 0.3) continue;
    used.add(p.bi); taken.add(p.ti);
    slotOf[p.bi] = tracks[p.ti].slot;
    Object.assign(tracks[p.ti], cs[p.bi], { seen: now });
  }
  // 오래 안 보인 기록은 번호 반납 (2초)
  for (let i = tracks.length - 1; i >= 0; i--) if (!taken.has(i) && now - tracks[i].seen > 2000) tracks.splice(i, 1);
  // 새로 들어온 사람 = 비어 있는 가장 작은 번호
  bodies.forEach((b, bi) => {
    if (slotOf[bi] >= 0) return;
    const busy = new Set(tracks.map(t => t.slot));
    let slot = 0; while (busy.has(slot) && slot < maxSlots) slot++;
    if (slot >= maxSlots) slot = bi;
    slotOf[bi] = slot;
    tracks.push({ slot, ...cs[bi], seen: now });
    // 새 사람은 이전 손 위치가 없어야 가짜 궤적이 안 생김
    for (const k of [...prevPts.keys()]) if (k.startsWith(slot + '-')) prevPts.delete(k);
  });
  bodies.forEach((b, bi) => { b.slot = slotOf[bi]; });
  return bodies.slice().sort((a, b) => a.slot - b.slot);
}

async function initCamera() {
  if (video.srcObject) return;
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  await new Promise(r => { if (video.readyState >= 2) r(); else video.onloadeddata = r; });
}

const trackerOpts = (mode) => ({ mode, poseModel: S.poseModel, maxPlayers: CFG.maxPlayers });
async function initWorker(mode) {
  if (typeof Worker === 'undefined' || typeof createImageBitmap === 'undefined') return false;
  try {
    const w = new Worker('js/pose-worker.js', { type: 'module' });
    const ok = await new Promise((res) => {
      const to = setTimeout(() => res(false), 25000);
      w.onmessage = (e) => {
        if (e.data.type === 'ready') { clearTimeout(to); S.delegate = e.data.delegate; res(true); }
        if (e.data.type === 'error') { clearTimeout(to); console.warn('워커 초기화 실패:', e.data.message); res(false); }
      };
      w.onerror = (ev) => { clearTimeout(to); console.warn('워커 오류:', ev.message); res(false); };
      w.postMessage({ type: 'init', opts: trackerOpts(mode) });
    });
    if (!ok) { w.terminate(); return false; }
    w.onmessage = onWorkerMessage;
    worker = w; workerBusy = false; workerResult = null; lastResultVT = -1;
    S.worker = true;
    return true;
  } catch (e) { console.warn('워커 사용 불가 → 메인 스레드', e); return false; }
}

async function initTracker(mode, force = null) {
  if (!force) {
    if (worker) { worker.terminate(); worker = null; }
    if (await initWorker(mode)) return;
    S.worker = false;
  }
  const fileset = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
  const make = (delegate) => mode === 'pose'
    ? PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${S.poseModel}/float16/1/pose_landmarker_${S.poseModel}.task`, delegate },
        runningMode: "VIDEO", numPoses: CFG.maxPlayers,
        minPoseDetectionConfidence: 0.3, minPosePresenceConfidence: 0.3, minTrackingConfidence: 0.3,
      })
    : HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task", delegate },
        runningMode: "VIDEO", numHands: 2 * CFG.maxPlayers,
        minHandDetectionConfidence: 0.35, minHandPresenceConfidence: 0.35, minTrackingConfidence: 0.35,
      });
  if (force === 'CPU' || force === 'GPU') { landmarker = await make(force); S.delegate = force; return; }
  try { landmarker = await make("GPU"); S.delegate = 'GPU'; }
  catch (e) { console.warn('GPU 실패 → CPU', e); landmarker = await make("CPU"); S.delegate = 'CPU'; }
}

async function initInput() {
  UI.startErr.textContent = '';
  try {
    UI.loadState.textContent = '📷 카메라 권한을 허용해 주세요…';
    await initCamera();
    if ((landmarker || worker) && S.loadedMode !== S.trackMode) {
      if (landmarker) { landmarker.close(); landmarker = null; }
      if (worker) { worker.terminate(); worker = null; }
    }
    if (!landmarker && !worker) {
      UI.loadState.textContent = '🧠 인식 모델 불러오는 중… (처음 한 번, 몇 초 걸려요)';
      await initTracker(S.trackMode);
      S.loadedMode = S.trackMode;
    }
    UI.loadState.textContent = '';
    S.camReady = true;
    return true;
  } catch (err) {
    console.error(err);
    UI.loadState.textContent = '';
    UI.startErr.innerHTML = `준비 실패: ${String(err && err.message || err)}<br>`
      + `카메라는 <b>https</b> 또는 <b>localhost</b> 주소에서만 켜져요. "카메라 없이" 버튼으로 터치 플레이도 할 수 있어요.`;
    UI.menu.classList.remove('hidden'); UI.map.classList.add('hidden');
    return false;
  }
}

// 포인터 (카메라 없이 / 데스크톱 테스트)
let ptr = null;
function pointerMove(e) {
  const r = canvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top, now = performance.now();
  if (ptr) {
    const dt = Math.max(0.008, (now - ptr.t) / 1000);
    S.pointerPts.push({ x, y, px: ptr.x, py: ptr.y, speed: Math.hypot(x - ptr.x, y - ptr.y) / dt });
  }
  ptr = { x, y, t: now };
}
canvas.addEventListener('pointermove', pointerMove);
canvas.addEventListener('pointerdown', pointerMove);
canvas.addEventListener('pointerleave', () => { ptr = null; });
canvas.addEventListener('pointerup', () => { ptr = null; });

let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* 미지원·거부 → 무시 */ }
}

async function recoverCamera() {
  const tr = video.srcObject && video.srcObject.getVideoTracks()[0];
  if (S.useCam && S.camReady && (!tr || tr.readyState === 'ended')) {
    video.srcObject = null;
    try { await initCamera(); } catch (e) { console.error(e); }
  } else if (video.paused && video.srcObject) { video.play().catch(() => {}); }
}

async function goLandscape() {
  try {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    }
    await screen.orientation?.lock?.('landscape');
  } catch { /* iOS 등 미지원 → 회전 안내로 대체 */ }
}

/* ═══════════════ 메인 루프 ═══════════════ */
function loop(ts) {
  requestAnimationFrame(loop);
  frame(ts);
}
function frame(ts) {
  if (canvas.clientWidth !== W || canvas.clientHeight !== H) resize();   // 회전·창 크기 변화 즉시 반영
  const dt = Math.min(0.05, (ts - S.lastTs) / 1000 || 0.016);
  S.lastTs = ts;
  S.fps = S.fps * 0.9 + (1 / dt) * 0.1;
  // 3초 넘게 40fps 미만이면 해상도·파티클을 낮춤
  if (!lowQuality && S.state === 'play') {
    slowFpsT = S.fps < 40 ? slowFpsT + dt : 0;
    if (slowFpsT > 3) { lowQuality = true; resize(); console.warn('저사양 모드로 전환'); }
  }

  if (S.useCam && S.camReady) track(ts, dt); else S.points = [];
  if (S.pointerPts.length) { S.points.push(...S.pointerPts); S.pointerPts = []; }
  for (const p of S.points) S.trails.push({ ...p, hot: p.speed >= swipeMin(), life: 0.22 });
  for (const t of S.trails) t.life -= dt;
  S.trails = S.trails.filter(t => t.life > 0);
  if (S.trails.length > 240) S.trails.splice(0, S.trails.length - 240);

  // 인식 상태 표시 + 환경 안내 (어두움 / 너무 멀거나 가까움)
  if (S.useCam && S.stage) {
    const n = S.landmarks.length;
    let hint = '';
    if (S.luma != null && S.luma < 45) hint = '방이 어두워요 🔦 불을 켜 주세요';
    else if (n && S.trackMode === 'pose') {
      const sw = S.landmarks.reduce((a, b) => a + Math.abs(b[11].x - b[12].x), 0) / n;   // 평균 어깨 폭(화면 비율)
      if (sw < 0.045) hint = '조금 더 가까이 와 주세요 👣';
      else if (sw > 0.3) hint = '한 걸음 뒤로 가 주세요 👣';
    }
    if (hint !== S._hint) { S._hint = hint; toast(hint, hint ? 2.5 : 0); }
    if (n !== S._lastN) {
      S._lastN = n;
      UI.handState.className = n ? 'on' : 'off';
      UI.handState.textContent = n ? (S.trackMode === 'pose' ? `🧍 ${n}명 인식 중` : `✋ 손 ${n}개 인식 중`)
        : (S.trackMode === 'pose' ? '몸이 안 보여요' : '손이 안 보여요');
    }
  } else if (UI.handState.textContent) UI.handState.textContent = '';

  S.stateT += dt;
  S.shake = Math.max(0, S.shake - dt * 2.5);
  S.flashRed = Math.max(0, S.flashRed - dt * 3);
  S.soot = Math.max(0, (S.soot || 0) - dt);
  S.toastT = Math.max(0, S.toastT - dt);
  if (S.stage) {
    updateAmbient(dt); updateProps(dt, S.state === 'play');
    const run = S.state === 'play' ? 1.9 * (S.pace || 1) : 0.4;
    S.roadZ = (S.roadZ || 0) + CFG.propSpeed * dt * run * (S.fever > 0 ? 1.4 : 1);
  }

  switch (S.state) {
    case 'ready':
      S.bodyT = S.landmarks.length ? S.bodyT + dt : Math.max(0, S.bodyT - dt * 2);
      if (S.bodyT >= 1) { setState('count'); S.countT = 3; SFX.count(); }
      break;
    case 'count': {
      const before = Math.ceil(S.countT);
      S.countT -= dt;
      if (Math.ceil(S.countT) !== before && S.countT > 0) SFX.count();
      if (S.countT <= 0) { setState('play'); SFX.go(); }
      break;
    }
    case 'play':
      updatePlay(dt);
      break;
    case 'paused':
      if (S.useCam && S.landmarks.length) { S.bodyT += dt; if (S.bodyT > 1.0 && !S.manualPause) resumeGame(); }
      break;
  }
  updateBannerGesture(dt);
  if (S.stage) { updateHud(); updateComboHud(); }
  render(dt);
}

/* ═══════════════ 메뉴 연결 ═══════════════ */
function setMode(mode) {
  S.trackMode = mode; SAVE.mode = mode; persist();
  document.querySelectorAll('.modeBtn').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  if (S.camReady && S.loadedMode !== mode) S.camReady = false;   // 다음 시작 때 모델 교체
}
document.querySelectorAll('.modeBtn').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
setMode(S.trackMode);

$('playBtn').addEventListener('click', () => {
  S.useCam = true;
  beginStage(Math.min(SAVE.unlocked - 1, STAGES.length - 1));
});
$('mapBtn').addEventListener('click', () => { initAudio(); S.useCam = true; showMap(); });
$('noCamBtn').addEventListener('click', () => { initAudio(); S.useCam = false; showMap(); });
$('mapBack').addEventListener('click', showMenu);

const musicBtn = $('musicBtn'), voiceBtn = $('voiceBtn'), godBtn = $('godBtn');
function syncToggles() { musicBtn.classList.toggle('on', SAVE.music); voiceBtn.classList.toggle('on', SAVE.voice); godBtn.classList.toggle('on', SAVE.god); }
godBtn.addEventListener('click', () => { SAVE.god = !SAVE.god; persist(); syncToggles(); if (SAVE.god) say('무적 모드! 절대 지지 않아요!'); });
musicBtn.addEventListener('click', () => {
  SAVE.music = !SAVE.music; persist(); syncToggles();
  if (SAVE.music && S.state === 'menu') startMusic(0, true); else if (!SAVE.music) stopMusic();
});
voiceBtn.addEventListener('click', () => { SAVE.voice = !SAVE.voice; persist(); syncToggles(); if (SAVE.voice) say('음성 안내를 켰어요'); });
syncToggles();

UI.pauseBtn.addEventListener('click', () => { if (S.state !== 'paused') pauseGame('manual'); });
UI.dbgBtn.addEventListener('click', () => { S.debug = !S.debug; UI.dbgBtn.textContent = S.debug ? 'DEBUG ON' : 'DEBUG'; });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (['play', 'count', 'ready'].includes(S.state)) pauseGame('body'); return; }
  AU.ctx?.resume?.();
  if (S.stage) keepAwake();
  recoverCamera();
});

// 타이틀 마스코트
UI.mascots.innerHTML = ['slime', 'goblin', 'knight', 'archer', 'dragon'].map(k => `<img src="${spriteURL(k)}" alt="">`).join('');

// 첫 터치에 오디오 잠금 해제 → 타이틀 음악
document.addEventListener('pointerdown', () => {
  const first = !AU.ctx;
  initAudio();
  if (first && S.state === 'menu') startMusic(0, true);
}, { once: false, capture: true });

loadSprites();
requestAnimationFrame((t) => { S.lastTs = t; loop(t); });

// 디버그용 (콘솔에서 상태 확인)
window.__game = { S, SAVE, SPR, startStage, showMap, frame, spawn, spawnBoss, assignSlots, startMusic, initAudio, startEvent };
