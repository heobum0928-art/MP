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
    hitPad: 1.4, minVis: 0.6,
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
let W = 0, H = 0, DPR = 1;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 1.5);
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
  const def = { unlocked: 1, stars: {}, best: 0, music: true, voice: true, mode: 'pose' };
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

// 월드별 간단한 칩튠 루프 (베이스 + 아르페지오)
function startMusic(worldIdx) {
  stopMusic();
  if (!AU.ctx || !SAVE.music) return;
  const m = WORLDS[worldIdx].music;
  const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
  const prog = [0, 3, 1, 4];       // 4마디 진행 (스케일 도수 이동)
  const arp = [0, 2, 4, 2, 3, 4, 2, 1];
  let step = 0, next = AU.ctx.currentTime + 0.1;
  AU.timer = setInterval(() => {
    const spb = 60 / m.tempo / 2 * (S.fever > 0 ? 0.8 : 1);
    while (next < AU.ctx.currentTime + 0.25) {
      const bar = Math.floor(step / 8) % prog.length;
      const deg = (i) => { const k = i + prog[bar]; return m.scale[k % m.scale.length] + 12 * Math.floor(k / m.scale.length); };
      const when = next - AU.ctx.currentTime;
      if (step % 4 === 0) tone(midi(m.root - 24 + deg(0)), spb * 3.2, 'triangle', 0.07, 1, when, AU.bgm);
      if (step % 2 === 0 || S.fever > 0) tone(midi(m.root + deg(arp[step % 8])), spb * 0.8, 'square', 0.022, 1, when, AU.bgm);
      if (step % 8 === 4) tone(midi(m.root + 12 + deg(4)), spb * 1.5, 'sine', 0.02, 1, when, AU.bgm);
      step++; next += spb;
    }
  }, 60);
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
  const hearts = '❤️'.repeat(Math.max(0, S.hp)) + '🤍'.repeat(Math.max(0, S.maxHp - S.hp));
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
  const interval = lerp(st.interval[0], st.interval[1], prog) * (S.boss ? 2.2 : 1) / S.assist;
  const speed = lerp(st.speed[0], st.speed[1], prog) * S.assist;

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
  if (m.K.proj) return;
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
  S.hp -= n; S.hurtCount += n; S.combo = 0;
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
  const g = ctx.createRadialGradient(a.x, a.y, a.r * 0.3, a.x, a.y, a.r * 1.8);
  g.addColorStop(0, 'rgba(255,230,120,.45)'); g.addColorStop(1, 'rgba(255,230,120,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(a.x, a.y, a.r * 1.8, 0, Math.PI * 2); ctx.fill();
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
    if (m.dead || m.cd > 0 || m.z > 1.05) continue;
    if (m.alpha < 0.45) continue;                          // 투명한 유령 / 순간이동 중
    const item = !!m.K.item;
    for (const p of S.points) {
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
  if (!K.proj) {
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
  if (S.fx.length > 600) S.fx.splice(0, S.fx.length - 600);
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
  const sp = CFG.propSpeed * (moving ? 1 : 0.3);
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

function drawRail() {
  const rail = S.stage ? WORLDS[S.world].rail : '110,231,255';
  ctx.save();
  ctx.strokeStyle = `rgba(${rail},.22)`; ctx.lineWidth = 1.5;
  for (let i = -4; i <= 4; i++) {
    const a = toScreen(i * 0.2, 0.34, 1.2), b = toScreen(i * 0.2, 0.34, 0);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  const flow = (S.stageT * 0.45) % 0.2;
  for (let k = 0; k < 7; k++) {
    const z = 1.2 - (k * 0.2 + flow);
    if (z <= 0.01) continue;
    const a = toScreen(-0.8, 0.34, z), b = toScreen(0.8, 0.34, z);
    ctx.globalAlpha = clamp(1.1 - z, 0.1, 0.7);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  ctx.restore();
}

function drawMonster(m) {
  if (m.sx + m.r * 3 < 0 || m.sx - m.r * 3 > W) return;
  ctx.save();
  ctx.globalAlpha = m.alpha;
  // 그림자
  if (!m.K.proj && !m.K.item) {
    ctx.save(); ctx.globalAlpha = 0.25 * m.alpha; ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.ellipse(m.sx, m.sy + m.r * 1.15, m.r * 0.8, m.r * 0.16, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  // 오라: 보스 / 아이템 / 폭탄 경고
  const aura = m.boss ? 'rgba(255,60,90,' : m.K.item ? (m.K.item === 'heal' ? 'rgba(255,110,170,' : 'rgba(255,220,90,') : m.K.bomb ? 'rgba(255,90,40,' : null;
  if (aura) {
    const pulse = m.K.bomb ? 0.25 + 0.2 * Math.sin(m.t * 10) : 0.35;
    const g = ctx.createRadialGradient(m.sx, m.sy, m.r * 0.5, m.sx, m.sy, m.r * 1.9);
    g.addColorStop(0, aura + pulse + ')'); g.addColorStop(1, aura + '0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(m.sx, m.sy, m.r * 1.9, 0, Math.PI * 2); ctx.fill();
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
function drawBodies() {
  const T = TRACK[S.trackMode];
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  S.landmarks.forEach((body, bi) => {
    const P = body.map(lmToScreen);
    const vis = (i) => !T.minVis || (body[i].visibility ?? 1) >= T.minVis;
    ctx.strokeStyle = PLAYER_COLORS[bi % PLAYER_COLORS.length];
    ctx.lineWidth = S.trackMode === 'pose' ? 7 : 4;
    ctx.beginPath();
    for (const [a, b] of T.edges) { if (vis(a) && vis(b)) { ctx.moveTo(P[a].x, P[a].y); ctx.lineTo(P[b].x, P[b].y); } }
    ctx.stroke();
    const gr = S.trackMode === 'pose' ? shortSide() * 0.045 : 7;
    ctx.fillStyle = S.trackMode === 'pose' ? PLAYER_HEX[bi % 3] : 'rgba(255,209,102,.95)';
    for (const id of T.glowIds) if (vis(id)) { ctx.beginPath(); ctx.arc(P[id].x, P[id].y, gr, 0, Math.PI * 2); ctx.fill(); }
    if (S.trackMode === 'pose' && vis(0) && (S.landmarks.length > 1 || S.multi)) {
      ctx.fillStyle = PLAYER_COLORS[bi % PLAYER_COLORS.length];
      ctx.font = `${Math.round(shortSide() * 0.06)}px Jua, sans-serif`; ctx.textAlign = 'center';
      ctx.fillText(`${bi + 1}P`, P[0].x, P[0].y - shortSide() * 0.13);
    }
  });
  ctx.restore();
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
  for (const s of SOOT) {
    const x = s.x * W, y = s.y * H, r = s.r * shortSide();
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(20,16,14,${0.85 * a})`); g.addColorStop(1, 'rgba(20,16,14,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
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
  ctx.fillText(`fps ${S.fps.toFixed(0)}  detect ${S.detectMs.toFixed(1)}ms  ${S.trackMode}/${S.delegate}`, 16, H - 64);
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
  if (S.stage) {
    drawHorizon();
    drawRail();
    drawProps();
    drawAmbient();
    for (const m of S.monsters) drawMonster(m);
    drawAlly();
    drawDying(dt);
    drawFx(dt);
    drawTexts(dt);
  }
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

function track(nowMs, dt) {
  S.points = [];
  if (!landmarker || video.readyState < 2) { S.landmarks = []; return; }
  if (video.currentTime === lastVideoTime) {
    // 카메라가 멈추면(백그라운드·잠금 후) 옛 뼈대를 지워 자동 일시정지가 걸리게
    if (performance.now() - lastFrameAt > 600) { S.landmarks = []; prevPts.clear(); }
    return;
  }
  lastFrameAt = performance.now();
  const vdt = lastVideoTime < 0 ? dt : clamp(video.currentTime - lastVideoTime, 0.012, 0.25);
  lastVideoTime = video.currentTime;
  const t0 = performance.now();
  let res;
  try { res = landmarker.detectForVideo(video, nowMs); detectErrors = 0; }
  catch (e) {
    // GPU 인식이 실행 중에 계속 실패하면 CPU로 다시 만듦
    if (++detectErrors === 30 && S.delegate === 'GPU') {
      console.warn('detect 실패 반복 → CPU로 전환', e);
      landmarker.close(); landmarker = null;
      initTracker(S.trackMode, 'CPU').catch(err => console.error(err));
    }
    return;
  }
  S.detectMs = S.detectMs * 0.8 + (performance.now() - t0) * 0.2;
  // 서 있는 위치(화면 왼쪽→오른쪽) 순으로 정렬해 1P·2P·3P를 고정
  const anchor = S.trackMode === 'pose' ? 0 : 0;
  S.landmarks = (res.landmarks || []).slice().sort((a, b) => lmToScreen(a[anchor]).x - lmToScreen(b[anchor]).x);
  if (S.trackMode === 'pose' && S.landmarks.length > 1 && S.stage) S.multi = true;
  // 인원이 바뀌면 이전 위치 기록을 버림 (다른 아이 손으로 이어진 가짜 궤적 방지)
  if (S.landmarks.length !== lastBodyCount) { prevPts.clear(); lastBodyCount = S.landmarks.length; }
  const maxJump = shortSide() * 0.35;
  const T = TRACK[S.trackMode];
  const seen = new Set();
  S.landmarks.forEach((body, bi) => {
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
      const pl = S.trackMode === 'pose' ? bi : Math.floor(bi / 2);
      if (prev) S.points.push({ x, y, px: prev.x, py: prev.y, speed: Math.hypot(x - prev.x, y - prev.y) / vdt, pl });
      prevPts.set(key, { x, y });
    }
  });
  for (const k of [...prevPts.keys()]) if (!seen.has(k)) prevPts.delete(k);
}

async function initCamera() {
  if (video.srcObject) return;
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 30 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  await new Promise(r => { if (video.readyState >= 2) r(); else video.onloadeddata = r; });
}

async function initTracker(mode, force = null) {
  const fileset = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
  const make = (delegate) => mode === 'pose'
    ? PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task", delegate },
        runningMode: "VIDEO", numPoses: CFG.maxPlayers,
        minPoseDetectionConfidence: 0.4, minPosePresenceConfidence: 0.4, minTrackingConfidence: 0.4,
      })
    : HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task", delegate },
        runningMode: "VIDEO", numHands: 2 * CFG.maxPlayers,
        minHandDetectionConfidence: 0.35, minHandPresenceConfidence: 0.35, minTrackingConfidence: 0.35,
      });
  if (force === 'CPU') { landmarker = await make("CPU"); S.delegate = 'CPU'; return; }
  try { landmarker = await make("GPU"); S.delegate = 'GPU'; }
  catch (e) { console.warn('GPU 실패 → CPU', e); landmarker = await make("CPU"); S.delegate = 'CPU'; }
}

async function initInput() {
  UI.startErr.textContent = '';
  try {
    UI.loadState.textContent = '📷 카메라 권한을 허용해 주세요…';
    await initCamera();
    if (landmarker && S.loadedMode !== S.trackMode) { landmarker.close(); landmarker = null; }
    if (!landmarker) {
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

  if (S.useCam && S.camReady) track(ts, dt); else S.points = [];
  if (S.pointerPts.length) { S.points.push(...S.pointerPts); S.pointerPts = []; }
  for (const p of S.points) S.trails.push({ ...p, hot: p.speed >= swipeMin(), life: 0.22 });
  for (const t of S.trails) t.life -= dt;
  S.trails = S.trails.filter(t => t.life > 0);
  if (S.trails.length > 240) S.trails.splice(0, S.trails.length - 240);

  // 인식 상태 표시
  if (S.useCam && S.stage) {
    const n = S.landmarks.length;
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
  if (S.stage) { updateAmbient(dt); updateProps(dt, S.state === 'play'); }

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

const musicBtn = $('musicBtn'), voiceBtn = $('voiceBtn');
function syncToggles() { musicBtn.classList.toggle('on', SAVE.music); voiceBtn.classList.toggle('on', SAVE.voice); }
musicBtn.addEventListener('click', () => { SAVE.music = !SAVE.music; persist(); syncToggles(); });
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

loadSprites();
requestAnimationFrame((t) => { S.lastTs = t; loop(t); });

// 디버그용 (콘솔에서 상태 확인)
window.__game = { S, SAVE, SPR, startStage, showMap, frame, spawn, spawnBoss };
