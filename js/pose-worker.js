// 몸/손 인식 전용 워커: 메인 스레드(화면 그리기)를 막지 않도록 여기서 MediaPipe 실행
// 모듈 워커에는 importScripts가 없음 → MediaPipe가 WASM 로더를 불러올 수 있게 동기 요청 + 전역 eval로 대체
self.importScripts = (...urls) => {
  for (const u of urls) {
    const x = new XMLHttpRequest();
    x.open('GET', u, false); x.send();
    (0, eval)(x.responseText);
  }
};
import { FilesetResolver, HandLandmarker, PoseLandmarker }
  from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

let landmarker = null, delegate = '';

async function create(opts, force) {
  const fileset = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
  const make = (d) => opts.mode === 'pose'
    ? PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${opts.poseModel}/float16/1/pose_landmarker_${opts.poseModel}.task`, delegate: d },
        runningMode: "VIDEO", numPoses: opts.maxPlayers,
        minPoseDetectionConfidence: 0.3, minPosePresenceConfidence: 0.3, minTrackingConfidence: 0.3,
      })
    : HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task", delegate: d },
        runningMode: "VIDEO", numHands: 2 * opts.maxPlayers,
        minHandDetectionConfidence: 0.35, minHandPresenceConfidence: 0.35, minTrackingConfidence: 0.35,
      });
  if (landmarker) { landmarker.close(); landmarker = null; }
  if (force) { landmarker = await make(force); delegate = force; return; }
  try { landmarker = await make('GPU'); delegate = 'GPU'; }
  catch { landmarker = await make('CPU'); delegate = 'CPU'; }
}

let errors = 0, lastTs = 0;
self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    try { await create(msg.opts, msg.force); self.postMessage({ type: 'ready', delegate }); }
    catch (err) { self.postMessage({ type: 'error', message: String(err && err.message || err) }); }
    return;
  }
  if (msg.type === 'frame') {
    const bmp = msg.bitmap;
    if (!landmarker) { bmp.close(); self.postMessage({ type: 'result', landmarks: null, id: msg.id }); return; }
    const ts = Math.max(msg.ts, lastTs + 1); lastTs = ts;
    const t0 = performance.now();
    let landmarks = null;
    try { landmarks = landmarker.detectForVideo(bmp, ts).landmarks || []; errors = 0; }
    catch (err) {
      if (++errors === 30 && delegate === 'GPU') {       // GPU 인식이 계속 실패 → CPU로 재생성
        try { await create(msg.opts, 'CPU'); self.postMessage({ type: 'ready', delegate }); } catch { /* 무시 */ }
      }
    }
    bmp.close();
    // 필요한 값만 평탄하게 전달
    const out = landmarks && landmarks.map(b => b.map(p => ({ x: p.x, y: p.y, visibility: p.visibility ?? 1 })));
    self.postMessage({ type: 'result', landmarks: out, ms: performance.now() - t0, id: msg.id, vt: msg.vt });
  }
};
