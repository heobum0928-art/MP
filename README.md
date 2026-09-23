# 모션 몬스터 헌터

폰을 가로로 세워 두고 1~2m 떨어져서 팔을 휘둘러 몬스터를 물리치는 웹 게임. 빌드 없음.

## 실행

```bash
npx http-server -p 8080 -c-1
```

- PC: http://localhost:8080
- 폰: 카메라는 https에서만 켜짐 → `cloudflared tunnel --protocol http2 --url http://localhost:8080`

## 구조

| 파일 | 내용 |
|---|---|
| `index.html` | 화면 구성(HUD, 배너, 메뉴, 지도) + CSS |
| `js/data.js` | 몬스터 종류, 월드 5개, 스테이지 15개, 미션 — **밸런스 조정은 여기서** |
| `js/game.js` | 인식(MediaPipe Pose/Hand), 게임 루프, 보스 패턴, 렌더링, 사운드·음성 |
| `blender/make_monsters.py` | 몬스터 3D 모델 → 스프라이트 PNG 생성 |
| `assets/monsters/` | 생성된 스프라이트 (`<이름>_<0|1|2>.png`, 0 기본 · 1 찌그러짐 · 2 눈감음) + `manifest.json` |

## 스프라이트 다시 만들기

```bash
"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" -b --factory-startup -P blender/make_monsters.py -- assets/monsters
```

일부만: 마지막에 `EEVEE goblin,archer` 처럼 이름을 쉼표로.

## 테스트 도구 (브라우저 콘솔)

`window.__game` — `startStage(i)`, `frame(ts)`(한 프레임 진행), `spawn(kind)`, `S`(상태), `SAVE`(진행 저장).
화면 오른쪽 아래 **DEBUG** 버튼: 히트박스, fps, 인식 지연, 인식 인원.
