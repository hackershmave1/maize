import {
  advance,
  createGameState,
  intersects,
  jump,
} from "./game-engine.js";

const canvas = document.querySelector("#game");
const context = canvas.getContext("2d");
const scoreOutput = document.querySelector("#score");
const bestScoreOutput = document.querySelector("#best-score");
const statusMessage = document.querySelector("#status");
const restartButton = document.querySelector("#restart");

const FIELD_WIDTH = canvas.width;
const FIELD_HEIGHT = canvas.height;
const GROUND_Y = 230;
const ROBOT_X = 108;
const ROBOT_WIDTH = 44;
const ROBOT_HEIGHT = 50;
const MAX_FRAME_MS = 50;
const BEST_SCORE_KEY = "signal-sprint-best";
const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
const debrisPatterns = [
  { width: 34, height: 31, shape: "shard" },
  { width: 26, height: 40, shape: "pulse" },
  { width: 39, height: 27, shape: "orbit" },
];

let gameState = createGameState();
let debris = [];
let animationFrameId = null;
let previousFrameTime = null;
let spawnElapsedMs = 0;
let debrisSequence = 0;
let bestScore = 0;
let bestScoreAvailable = true;
let storageWarningShown = false;

function showStorageUnavailable() {
  bestScoreAvailable = false;
  bestScoreOutput.textContent = "Unavailable";

  if (!storageWarningShown) {
    console.warn("Signal Sprint: best score storage unavailable.");
    storageWarningShown = true;
  }
}

function loadBestScore() {
  try {
    const savedScore = window.localStorage.getItem(BEST_SCORE_KEY);
    const parsedScore = Number(savedScore);
    if (savedScore !== null && Number.isSafeInteger(parsedScore) && parsedScore >= 0) {
      bestScore = parsedScore;
    }
    bestScoreOutput.textContent = String(bestScore);
  } catch {
    showStorageUnavailable();
  }
}

function updateScoreDisplay() {
  scoreOutput.textContent = String(gameState.score);
  if (bestScoreAvailable) {
    bestScoreOutput.textContent = String(Math.max(bestScore, gameState.score));
  }
}

function saveBestScore() {
  if (!bestScoreAvailable || gameState.score <= bestScore) return;

  try {
    window.localStorage.setItem(BEST_SCORE_KEY, String(gameState.score));
    bestScore = gameState.score;
    bestScoreOutput.textContent = String(bestScore);
  } catch {
    showStorageUnavailable();
  }
}

function drawBackground() {
  context.fillStyle = "#07111d";
  context.fillRect(0, 0, FIELD_WIDTH, FIELD_HEIGHT);

  context.fillStyle = "#24435a";
  for (const [x, y, size] of [
    [42, 48, 2], [110, 82, 2], [198, 35, 3], [280, 69, 2],
    [386, 40, 2], [477, 94, 2], [590, 45, 3], [704, 75, 2],
    [764, 31, 2], [338, 121, 2], [650, 132, 2],
  ]) {
    context.fillRect(x, y, size, size);
  }

  context.strokeStyle = "#18364b";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(0, GROUND_Y + 0.5);
  context.lineTo(FIELD_WIDTH, GROUND_Y + 0.5);
  context.stroke();

  context.fillStyle = "#355a70";
  for (let x = 18; x < FIELD_WIDTH; x += 42) {
    context.fillRect(x, GROUND_Y + 9, 15, 2);
  }

  context.fillStyle = "#0e2435";
  context.fillRect(0, GROUND_Y + 18, FIELD_WIDTH, FIELD_HEIGHT - GROUND_Y - 18);
}

function drawRobot() {
  const top = GROUND_Y - ROBOT_HEIGHT + gameState.y;
  const stride = !reducedMotionQuery.matches && gameState.running && !gameState.gameOver
    ? Math.floor(gameState.elapsedMs / 90) % 2
    : 0;

  context.fillStyle = "#43d7d2";
  context.fillRect(ROBOT_X + 5, top + 8, 34, 24);
  context.fillRect(ROBOT_X + 8, top + 33, 28, 12);
  context.fillRect(ROBOT_X + 11, top + 45, 7, 5 + stride * 2);
  context.fillRect(ROBOT_X + 27, top + 45, 7, 7 - stride * 2);

  context.strokeStyle = "#d4fffa";
  context.lineWidth = 2;
  context.strokeRect(ROBOT_X + 5, top + 8, 34, 24);

  context.fillStyle = "#102a3a";
  context.fillRect(ROBOT_X + 12, top + 15, 20, 9);
  context.fillStyle = "#fff2a6";
  context.fillRect(ROBOT_X + 16, top + 18, 4, 3);
  context.fillRect(ROBOT_X + 25, top + 18, 4, 3);

  context.strokeStyle = "#43d7d2";
  context.beginPath();
  context.moveTo(ROBOT_X + 22, top + 8);
  context.lineTo(ROBOT_X + 22, top + 1);
  context.stroke();
  context.fillStyle = "#ffb36b";
  context.fillRect(ROBOT_X + 19, top - 3, 6, 5);
}

function drawShard(item) {
  context.beginPath();
  context.moveTo(item.x + item.width * 0.08, item.y + item.height);
  context.lineTo(item.x + item.width * 0.18, item.y + item.height * 0.43);
  context.lineTo(item.x + item.width * 0.49, item.y);
  context.lineTo(item.x + item.width * 0.88, item.y + item.height * 0.31);
  context.lineTo(item.x + item.width * 0.72, item.y + item.height);
  context.closePath();
  context.fillStyle = "#ff8c70";
  context.fill();
  context.strokeStyle = "#ffd1a6";
  context.lineWidth = 2;
  context.stroke();
  context.fillStyle = "#5b3340";
  context.fillRect(item.x + item.width * 0.36, item.y + item.height * 0.55, 7, 3);
}

function drawPulse(item) {
  context.fillStyle = "#f4bf62";
  context.fillRect(item.x + 2, item.y + 8, 7, item.height - 8);
  context.fillRect(item.x + item.width - 9, item.y, 7, item.height);
  context.fillStyle = "#ffe4a0";
  context.fillRect(item.x, item.y + 5, item.width, 5);
  context.strokeStyle = "#fff0c4";
  context.lineWidth = 2;
  context.strokeRect(item.x, item.y + 5, item.width, item.height - 5);
}

function drawOrbit(item) {
  context.beginPath();
  context.moveTo(item.x + item.width / 2, item.y);
  context.lineTo(item.x + item.width, item.y + item.height / 2);
  context.lineTo(item.x + item.width / 2, item.y + item.height);
  context.lineTo(item.x, item.y + item.height / 2);
  context.closePath();
  context.fillStyle = "#b99cff";
  context.fill();
  context.strokeStyle = "#e2d7ff";
  context.lineWidth = 2;
  context.stroke();
  context.fillStyle = "#302b50";
  context.fillRect(item.x + item.width / 2 - 3, item.y + item.height / 2 - 3, 6, 6);
}

function drawDebris() {
  for (const item of debris) {
    if (item.shape === "shard") drawShard(item);
    if (item.shape === "pulse") drawPulse(item);
    if (item.shape === "orbit") drawOrbit(item);
  }
}

function drawGame() {
  drawBackground();
  drawDebris();
  drawRobot();
}

function spawnDebris() {
  const pattern = debrisPatterns[debrisSequence % debrisPatterns.length];
  debrisSequence += 1;
  debris.push({
    ...pattern,
    x: FIELD_WIDTH + 12,
    y: GROUND_Y - pattern.height,
  });
}

function prepareTurn() {
  debris = [];
  spawnDebris();
  debris[0].x = ROBOT_X + ROBOT_WIDTH + 40;
  statusMessage.textContent = "Reduced-motion turn mode. Press Space, Arrow Up, or tap to clear one obstacle.";
}

function playTurn() {
  // Resolve the jump at its clearance height without moving or animating the robot.
  const jumpingBounds = { ...playerBounds(), y: GROUND_Y - ROBOT_HEIGHT - 90 };
  const obstacleBounds = { ...debris[0], x: ROBOT_X };
  if (intersects(jumpingBounds, obstacleBounds)) {
    finishRun();
    return;
  }

  gameState = {
    ...gameState,
    elapsedMs: gameState.elapsedMs + 100,
    score: gameState.score + 1,
  };
  prepareTurn();
  statusMessage.textContent = `Obstacle cleared. Score ${gameState.score}. Jump to advance one turn.`;
  updateScoreDisplay();
  drawGame();
}

function playerBounds() {
  return {
    x: ROBOT_X,
    y: GROUND_Y - ROBOT_HEIGHT + gameState.y,
    width: ROBOT_WIDTH,
    height: ROBOT_HEIGHT,
  };
}

function finishRun() {
  gameState = { ...gameState, gameOver: true };
  updateScoreDisplay();
  saveBestScore();
  statusMessage.textContent = `Signal debris hit. Score ${gameState.score}. Select Restart game to try again.`;
  restartButton.textContent = "Restart game";
  drawGame();
}

function frame(timestamp) {
  if (reducedMotionQuery.matches || !gameState.running || gameState.gameOver) return;

  if (previousFrameTime === null) {
    previousFrameTime = timestamp;
    drawGame();
    animationFrameId = window.requestAnimationFrame(frame);
    return;
  }

  const rawDeltaMs = timestamp - previousFrameTime;
  previousFrameTime = timestamp;
  const deltaMs = Math.min(Math.max(rawDeltaMs, 0), MAX_FRAME_MS);
  gameState = advance(gameState, rawDeltaMs);

  spawnElapsedMs += deltaMs;
  const spawnIntervalMs = Math.max(820, 1400 - gameState.score * 3);
  if (spawnElapsedMs >= spawnIntervalMs) {
    spawnElapsedMs -= spawnIntervalMs;
    spawnDebris();
  }

  const speed = 300 + Math.min(gameState.score * 3, 220);
  for (const item of debris) item.x -= speed * deltaMs / 1000;
  debris = debris.filter((item) => item.x + item.width >= 0);

  updateScoreDisplay();
  if (debris.some((item) => intersects(playerBounds(), item))) {
    finishRun();
    animationFrameId = null;
    return;
  }

  drawGame();
  animationFrameId = window.requestAnimationFrame(frame);
}

function startGame() {
  saveBestScore();

  if (animationFrameId !== null) {
    window.cancelAnimationFrame(animationFrameId);
  }
  animationFrameId = null;

  gameState = { ...createGameState(), running: true };
  debris = [];
  previousFrameTime = null;
  spawnElapsedMs = 0;
  debrisSequence = 0;
  restartButton.textContent = "Restart game";
  statusMessage.textContent = "Run started. Jump the signal debris.";
  if (reducedMotionQuery.matches) prepareTurn();
  updateScoreDisplay();
  drawGame();
  canvas.focus();
  if (!reducedMotionQuery.matches) {
    animationFrameId = window.requestAnimationFrame(frame);
  }
}

function tryJump() {
  if (!gameState.running || gameState.gameOver) return;
  if (reducedMotionQuery.matches) {
    playTurn();
    return;
  }
  gameState = jump(gameState);
}

reducedMotionQuery.addEventListener("change", () => {
  if (!gameState.running || gameState.gameOver) return;
  if (animationFrameId !== null) window.cancelAnimationFrame(animationFrameId);
  animationFrameId = null;
  previousFrameTime = null;
  spawnElapsedMs = 0;
  gameState = { ...gameState, y: 0, velocityY: 0 };
  debris = [];
  if (reducedMotionQuery.matches) {
    prepareTurn();
  } else {
    statusMessage.textContent = "Run started. Jump the signal debris.";
    animationFrameId = window.requestAnimationFrame(frame);
  }
  drawGame();
});

canvas.addEventListener("keydown", (event) => {
  if (document.activeElement !== canvas) return;
  if (event.code !== "Space" && event.key !== " " && event.key !== "ArrowUp") return;

  event.preventDefault();
  if (event.repeat) return;
  tryJump();
});

canvas.addEventListener("pointerdown", (event) => {
  if (event.isPrimary === false || event.button !== 0) return;
  canvas.focus();
  tryJump();
});

restartButton.addEventListener("click", startGame);

loadBestScore();
drawGame();
