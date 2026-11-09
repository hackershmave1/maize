const GRAVITY = 1800;
const JUMP_VELOCITY = -620;
const MAX_FRAME_MS = 50;
const REDUCED_MOTION_FRAME_MS = 50;

export function consumeFrameTime(deltaMs, reducedMotion, accumulatedMs = 0) {
  const frameDeltaMs = Math.max(deltaMs, 0);
  const elapsedMs = accumulatedMs + frameDeltaMs;

  if (reducedMotion && elapsedMs < REDUCED_MOTION_FRAME_MS) {
    return { shouldUpdate: false, deltaMs: 0, accumulatedMs: elapsedMs };
  }

  return {
    shouldUpdate: true,
    deltaMs: reducedMotion ? elapsedMs : frameDeltaMs,
    accumulatedMs: 0,
  };
}

export function createGameState() {
  return {
    y: 0,
    velocityY: 0,
    elapsedMs: 0,
    score: 0,
    running: false,
    gameOver: false,
  };
}

export function jump(state) {
  if (state.gameOver || state.y !== 0) return state;
  return { ...state, velocityY: JUMP_VELOCITY, running: true };
}

export function advance(state, deltaMs) {
  if (!state.running || state.gameOver) return state;
  const dt = Math.min(Math.max(deltaMs, 0), MAX_FRAME_MS) / 1000;
  const velocityY = state.velocityY + GRAVITY * dt;
  const nextY = state.y + velocityY * dt;
  const landed = nextY >= 0;
  const elapsedMs = state.elapsedMs + dt * 1000;

  return {
    ...state,
    y: landed ? 0 : nextY,
    velocityY: landed ? 0 : velocityY,
    elapsedMs,
    score: Math.floor(elapsedMs / 100),
  };
}

export function intersects(a, b) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}
