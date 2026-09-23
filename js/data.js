// 게임 데이터: 몬스터 종류 / 월드 / 스테이지 / 미션
// 스프라이트는 blender/make_monsters.py 로 생성 (assets/monsters/<sprite>_<frame>.png)

/*
  move:
    bob      위아래로 통통
    wave     좌우로 크게 물결
    zigzag   빠르게 지그재그
    hop      깡충깡충 점프
    fade     투명해졌다 나타남 (보일 때만 맞음)
    dash     멈칫했다가 돌진
    float    아이템: 천천히 옆으로 떠감 (놓쳐도 손해 없음)
    straight 보스가 던진 투사체
    run      뒤뚱뒤뚱 달려옴 (중세 병사)
    archer   중간 거리에 멈춰 화살을 쏘고, 다 쏘면 돌격
*/
export const KINDS = {
  slime:     { name: '슬라임',   hp: 1, speed: 1.0,  move: 'bob',    score: 100, wy: [0.0, 0.22] },
  bat:       { name: '박쥐',     hp: 1, speed: 1.25, move: 'wave',   score: 120, wy: [-0.28, -0.06] },
  horn:      { name: '뿔도깨비', hp: 2, speed: 0.85, move: 'bob',    score: 180, wy: [0.02, 0.2] },
  mushroom:  { name: '버섯',     hp: 1, speed: 0.95, move: 'hop',    score: 110, wy: [0.1, 0.24] },
  bee:       { name: '꿀벌',     hp: 1, speed: 1.3,  move: 'zigzag', score: 130, wy: [-0.25, 0.0] },
  ghost:     { name: '유령',     hp: 1, speed: 1.0,  move: 'fade',   score: 140, wy: [-0.2, 0.1] },
  golem:     { name: '바위골렘', hp: 2, speed: 0.7,  move: 'bob',    score: 250, wy: [0.05, 0.2], scale: 1.2 },
  bomb:      { name: '폭탄',     hp: 1, speed: 0.95, move: 'bob',    bomb: true, wy: [-0.1, 0.2] },
  imp:       { name: '불도깨비', hp: 1, speed: 1.1,  move: 'dash',   score: 150, wy: [-0.2, 0.1] },
  snowman:   { name: '눈사람',   hp: 2, speed: 0.85, move: 'hop',    score: 170, wy: [0.05, 0.22] },
  // ── 중세 병사들 ──
  goblin:    { name: '고블린 병사', hp: 1, speed: 1.15, move: 'run',    score: 120, wy: [0.04, 0.22] },
  archer:    { name: '고블린 궁수', hp: 1, speed: 0.9,  move: 'archer', score: 180, wy: [0.02, 0.18], shots: 3, shotEvery: 2.2 },
  shield:    { name: '방패 고블린', hp: 3, speed: 0.75, move: 'run',    score: 220, wy: [0.04, 0.2], scale: 1.1 },
  skeleton:  { name: '해골 기사',   hp: 2, speed: 1.0,  move: 'run',    score: 170, wy: [0.02, 0.2] },
  darkknight: { name: '흑기사',   hp: 3, speed: 0.8,  move: 'run',    score: 260, wy: [0.02, 0.2], scale: 1.1 },
  minislime: { name: '꼬마슬라임', sprite: 'slime', hp: 1, speed: 1.2, move: 'hop', score: 60, wy: [0.0, 0.2], scale: 0.6 },

  heart:     { name: '하트', item: 'heal',  speed: 0.5,  move: 'float', wy: [-0.22, 0.02], scale: 0.85 },
  star:      { name: '별',   item: 'fever', speed: 0.55, move: 'float', wy: [-0.26, -0.02], scale: 0.85 },

  snowball:  { name: '눈덩이', hp: 1, speed: 1.6, move: 'straight', score: 50, proj: true, scale: 0.5, color: '#eaf4ff', glow: '#9fd3ff' },
  arrow:     { name: '화살',   hp: 1, speed: 2.0, move: 'straight', score: 40, proj: true, scale: 0.42, draw: 'arrow' },
  fireball:  { name: '불덩이', hp: 1, speed: 1.7, move: 'straight', score: 50, proj: true, scale: 0.5, color: '#ffb347', glow: '#ff4d1a' },

  // 보스: attack 주기(every 초)마다 행동
  kingslime: { name: '킹슬라임', boss: true, hp: 18, attack: 'summon', summon: 'minislime', every: 3.0, count: 2 },
  ghostking: { name: '유령왕',   boss: true, hp: 22, attack: 'teleport', summon: 'ghost', every: 3.4, count: 1 },
  goblinchief: { name: '고블린 대장', boss: true, hp: 20, attack: 'volley', shoot: 'arrow', summon: 'goblin', every: 2.6, count: 3 },
  yeti:      { name: '설산 예티', boss: true, hp: 24, attack: 'throw', shoot: 'snowball', every: 2.3, count: 1 },
  dragon:    { name: '드래곤',   boss: true, hp: 36, attack: 'dragon', shoot: 'fireball', summon: 'imp', every: 2.2, count: 2, fly: true },
  boss:      { name: '마왕',     boss: true, hp: 30, attack: 'mix', shoot: 'fireball', summon: 'imp', every: 2.0, count: 1 },
};

export const WORLDS = [
  {
    name: '초록 숲', emoji: '🌳', scenery: 'forest', particle: 'leaf',
    tintTop: 'rgba(40,120,60,.38)', tintBottom: 'rgba(20,70,30,.45)', rail: '120,255,150',
    music: { root: 60, scale: [0, 2, 4, 7, 9], tempo: 112 },
  },
  {
    name: '고블린 요새', emoji: '🏹', scenery: 'fort', particle: 'leaf',
    tintTop: 'rgba(140,100,40,.36)', tintBottom: 'rgba(70,45,15,.45)', rail: '255,210,120',
    music: { root: 58, scale: [0, 2, 3, 7, 9], tempo: 120 },
  },
  {
    name: '유령 성', emoji: '🏰', scenery: 'castle', particle: 'dust',
    tintTop: 'rgba(70,30,120,.45)', tintBottom: 'rgba(30,10,60,.5)', rail: '190,140,255',
    music: { root: 57, scale: [0, 3, 5, 7, 10], tempo: 104 },
  },
  {
    name: '눈꽃 설산', emoji: '⛄', scenery: 'snow', particle: 'snow',
    tintTop: 'rgba(120,170,230,.38)', tintBottom: 'rgba(60,100,170,.42)', rail: '170,220,255',
    music: { root: 62, scale: [0, 2, 4, 7, 11], tempo: 118 },
  },
  {
    name: '마왕성', emoji: '🌋', scenery: 'volcano', particle: 'ember',
    tintTop: 'rgba(150,40,20,.42)', tintBottom: 'rgba(80,15,10,.5)', rail: '255,150,90',
    music: { root: 55, scale: [0, 1, 4, 5, 7, 8], tempo: 126 },
  },
  {
    name: '용의 둥지', emoji: '🐉', scenery: 'lair', particle: 'ember',
    tintTop: 'rgba(110,30,100,.42)', tintBottom: 'rgba(40,10,40,.5)', rail: '255,130,210',
    music: { root: 53, scale: [0, 2, 3, 5, 7, 8, 10], tempo: 132 },
  },
];

/*
  미션:
    { type: 'kill',  kind: 'any' | <kind>, n }   몬스터 잡기
    { type: 'combo', n }                          콤보 n 달성
    { type: 'dodge', n }                          폭탄 건드리지 않고 n개 보내기 (치면 하트 대신 콤보·점수 감소)
  spawn: 종류별 등장 가중치
  interval: [시작, 끝] 스폰 간격(초) — 미션 진행도에 따라 줄어듦
  speed:    [시작, 끝] 접근 속도
*/
export const STAGES = [
  // ── 1. 초록 숲 ──
  { id: '1-1', world: 0, title: '숲속 모험 시작!',
    spawn: { slime: 5, bat: 1 }, interval: [1.6, 1.15], speed: [0.14, 0.18],
    missions: [{ type: 'kill', kind: 'any', n: 20 }] },
  { id: '1-2', world: 0, title: '버섯 들판',
    spawn: { slime: 4, mushroom: 3, bee: 2 }, interval: [1.4, 1.0], speed: [0.15, 0.2],
    missions: [{ type: 'kill', kind: 'mushroom', n: 15 }, { type: 'kill', kind: 'any', n: 38 }] },
  { id: '1-3', world: 0, title: '킹슬라임의 숲', boss: 'kingslime',
    spawn: { slime: 4, mushroom: 3, bee: 2, goblin: 1 }, interval: [1.3, 0.95], speed: [0.16, 0.21],
    missions: [{ type: 'kill', kind: 'any', n: 42 }] },

  // ── 2. 고블린 요새 ──
  { id: '2-1', world: 1, title: '고블린이 나타났다!',
    spawn: { goblin: 5, slime: 2, bat: 1 }, interval: [1.35, 1.0], speed: [0.16, 0.21],
    missions: [{ type: 'kill', kind: 'goblin', n: 27 }] },
  { id: '2-2', world: 1, title: '화살을 쳐내라!',
    spawn: { goblin: 4, archer: 2, bat: 1 }, interval: [1.35, 1.0], speed: [0.16, 0.21],
    missions: [{ type: 'kill', kind: 'archer', n: 9 }, { type: 'kill', kind: 'arrow', n: 12 }] },
  { id: '2-3', world: 1, title: '고블린 대장의 요새', boss: 'goblinchief',
    spawn: { goblin: 4, archer: 2, shield: 2 }, interval: [1.3, 0.95], speed: [0.17, 0.22],
    missions: [{ type: 'kill', kind: 'shield', n: 8 }, { type: 'kill', kind: 'any', n: 42 }] },

  // ── 3. 유령 성 ──
  { id: '3-1', world: 2, title: '으스스한 성문',
    spawn: { ghost: 4, bat: 3, skeleton: 2 }, interval: [1.3, 0.95], speed: [0.16, 0.21],
    missions: [{ type: 'kill', kind: 'ghost', n: 18 }, { type: 'kill', kind: 'any', n: 38 }] },
  { id: '3-2', world: 2, title: '해골 기사단',
    spawn: { skeleton: 4, ghost: 2, horn: 2, archer: 1 }, interval: [1.25, 0.9], speed: [0.17, 0.22],
    missions: [{ type: 'kill', kind: 'skeleton', n: 18 }, { type: 'combo', n: 8 }] },
  { id: '3-3', world: 2, title: '유령왕의 왕좌', boss: 'ghostking',
    spawn: { ghost: 4, skeleton: 3, bat: 2, horn: 1 }, interval: [1.2, 0.9], speed: [0.17, 0.22],
    missions: [{ type: 'kill', kind: 'any', n: 45 }] },

  // ── 4. 눈꽃 설산 ──
  { id: '4-1', world: 3, title: '눈사람 마을',
    spawn: { snowman: 4, bee: 2, bomb: 2, slime: 2 }, interval: [1.3, 0.95], speed: [0.16, 0.21],
    missions: [{ type: 'kill', kind: 'snowman', n: 15 }, { type: 'dodge', n: 5 }] },
  { id: '4-2', world: 3, title: '얼음 바위길',
    spawn: { golem: 2, snowman: 3, goblin: 3, bomb: 2 }, interval: [1.3, 0.95], speed: [0.16, 0.2],
    missions: [{ type: 'kill', kind: 'golem', n: 9 }, { type: 'kill', kind: 'any', n: 42 }] },
  { id: '4-3', world: 3, title: '예티의 봉우리', boss: 'yeti',
    spawn: { snowman: 3, golem: 2, archer: 1, bomb: 2, slime: 2 }, interval: [1.25, 0.95], speed: [0.16, 0.21],
    missions: [{ type: 'combo', n: 10 }, { type: 'kill', kind: 'any', n: 45 }] },

  // ── 5. 마왕성 ──
  { id: '5-1', world: 4, title: '뜨거운 용암길',
    spawn: { imp: 5, bomb: 2, skeleton: 2, archer: 1 }, interval: [1.2, 0.9], speed: [0.17, 0.22],
    missions: [{ type: 'kill', kind: 'imp', n: 22 }, { type: 'kill', kind: 'any', n: 42 }] },
  { id: '5-2', world: 4, title: '폭탄 골짜기',
    spawn: { imp: 3, bomb: 3, shield: 2, goblin: 3 }, interval: [1.2, 0.9], speed: [0.17, 0.22],
    missions: [{ type: 'combo', n: 10 }, { type: 'dodge', n: 8 }, { type: 'kill', kind: 'any', n: 42 }] },
  { id: '5-3', world: 4, title: '마왕과의 결전', boss: 'boss',
    spawn: { imp: 3, skeleton: 2, shield: 2, archer: 2, golem: 1, bomb: 2, darkknight: 1 }, interval: [1.15, 0.85], speed: [0.18, 0.23],
    missions: [{ type: 'kill', kind: 'any', n: 48 }] },

  // ── 6. 용의 둥지 ──
  { id: '6-1', world: 5, title: '흑기사의 다리',
    spawn: { darkknight: 3, imp: 3, archer: 2, bat: 2 }, interval: [1.2, 0.9], speed: [0.17, 0.22],
    missions: [{ type: 'kill', kind: 'darkknight', n: 10 }, { type: 'kill', kind: 'any', n: 40 }] },
  { id: '6-2', world: 5, title: '용의 알 계곡',
    spawn: { darkknight: 2, imp: 3, skeleton: 2, bomb: 3, bee: 2 }, interval: [1.2, 0.9], speed: [0.17, 0.22],
    missions: [{ type: 'combo', n: 12 }, { type: 'dodge', n: 6 }, { type: 'kill', kind: 'any', n: 40 }] },
  { id: '6-3', world: 5, title: '드래곤 둥지', boss: 'dragon',
    spawn: { darkknight: 2, imp: 3, archer: 2, shield: 2, bat: 2 }, interval: [1.15, 0.9], speed: [0.18, 0.22],
    missions: [{ type: 'kill', kind: 'any', n: 45 }] },
];

// 모든 스테이지를 깬 뒤 열리는 무한 모드
export const ENDLESS = {
  id: '∞', world: 5, title: '무한 모드', endless: true,
  spawn: { slime: 2, bat: 2, horn: 2, mushroom: 2, bee: 2, ghost: 2, golem: 2, bomb: 2, imp: 2, snowman: 2,
           goblin: 3, archer: 2, shield: 2, skeleton: 2, darkknight: 2 },
  interval: [1.2, 0.6], speed: [0.17, 0.32],
  missions: [],
  bossEvery: 25, bosses: ['kingslime', 'goblinchief', 'ghostking', 'yeti', 'boss', 'dragon'],
};

export const PRAISE = ['좋아!', '멋져!', '최고야!', '대단해!', '굉장해!', '잘한다!', '짱이야!'];
