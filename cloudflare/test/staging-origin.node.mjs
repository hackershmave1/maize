import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as engine from "../staging-origin/site/game-engine.js";
import {
  advance,
  consumeFrameTime,
  createGameState,
  intersects,
  jump,
} from "../staging-origin/site/game-engine.js";

test("a new game starts grounded, stopped, and at score zero", () => {
  assert.deepEqual(createGameState(), {
    y: 0,
    velocityY: 0,
    elapsedMs: 0,
    score: 0,
    running: false,
    gameOver: false,
  });
});

test("jump starts the run and moves the player upward", () => {
  const jumping = jump(createGameState());
  const airborne = advance(jumping, 16);
  assert.equal(jumping.running, true);
  assert.ok(airborne.y < 0);
});

test("a second jump is ignored while airborne", () => {
  const airborne = advance(jump(createGameState()), 16);
  assert.deepEqual(jump(airborne), airborne);
});

test("the player returns to ground after the jump", () => {
  let state = jump(createGameState());
  for (let frame = 0; frame < 60; frame += 1) state = advance(state, 16);
  assert.equal(state.y, 0);
  assert.equal(state.velocityY, 0);
});

test("game-over state stops advancing", () => {
  const state = { ...createGameState(), running: true, gameOver: true };
  assert.deepEqual(advance(state, 16), state);
});

test("reduced motion batches small frame deltas into discrete updates", () => {
  assert.deepEqual(consumeFrameTime(16, true), {
    shouldUpdate: false,
    deltaMs: 0,
    accumulatedMs: 16,
  });
  assert.deepEqual(consumeFrameTime(18, true, 32), {
    shouldUpdate: true,
    deltaMs: 50,
    accumulatedMs: 0,
  });
});

test("normal motion continues updating on every frame", () => {
  assert.deepEqual(consumeFrameTime(16, false, 32), {
    shouldUpdate: true,
    deltaMs: 16,
    accumulatedMs: 0,
  });
});

test("rectangle intersection detects only overlapping bounds", () => {
  assert.equal(
    intersects({ x: 0, y: 0, width: 10, height: 10 }, { x: 8, y: 8, width: 10, height: 10 }),
    true,
  );
  assert.equal(
    intersects({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 }),
    false,
  );
});

function openGame(reducedMotion) {
  const callbacks = new Map();
  const collisionChecks = [];
  const drawing = [];
  const context = new Proxy({}, {
    get: (_, method) => (...args) => drawing.push([method, ...args]),
    set: () => true,
  });
  const elements = Object.fromEntries(
    ["game", "score", "best-score", "status", "restart"].map((id) => [id, {
      textContent: "",
      listeners: {},
      addEventListener(type, listener) { this.listeners[type] = listener; },
    }]),
  );
  const document = {
    activeElement: null,
    querySelector: (selector) => elements[selector.slice(1)],
  };
  Object.assign(elements.game, {
    width: 800,
    height: 280,
    getContext: () => context,
    focus() { document.activeElement = this; },
  });
  let preferenceListener;
  let nextFrame = 0;
  let scheduledFrames = 0;
  const preference = {
    matches: reducedMotion,
    addEventListener: (_, listener) => { preferenceListener = listener; },
  };
  const source = readFileSync(new URL("../staging-origin/site/game.js", import.meta.url), "utf8")
    .replace(/^import\s*\{[^}]+\}\s*from\s*"\.\/game-engine\.js";/m, "");
  vm.runInNewContext(source, {
    ...engine,
    intersects(player, obstacle) {
      const collided = engine.intersects(player, obstacle);
      collisionChecks.push({ player, obstacle, collided });
      return collided;
    },
    document,
    console,
    window: {
      matchMedia: () => preference,
      localStorage: { getItem: () => null, setItem() {} },
      requestAnimationFrame(callback) {
        scheduledFrames += 1;
        callbacks.set(++nextFrame, callback);
        return nextFrame;
      },
      cancelAnimationFrame: (id) => callbacks.delete(id),
    },
  });
  return {
    elements,
    callbacks,
    collisionChecks,
    drawing,
    get scheduledFrames() { return scheduledFrames; },
    start: () => elements.restart.listeners.click(),
    key(overrides = {}) {
      elements.game.listeners.keydown({
        code: "Space", key: " ", repeat: false, preventDefault() {}, ...overrides,
      });
    },
    tap(overrides = {}) {
      elements.game.listeners.pointerdown({ isPrimary: true, button: 0, ...overrides });
    },
    setReducedMotion(matches) {
      preference.matches = matches;
      preferenceListener?.({ matches });
    },
    frame(timestamp) {
      const [id, callback] = callbacks.entries().next().value;
      callbacks.delete(id);
      callback(timestamp);
    },
  };
}

test("reduced motion starts a static obstacle turn without scheduling animation", () => {
  const game = openGame(true);
  game.start();
  assert.equal(game.scheduledFrames, 0);
  assert.equal(game.callbacks.size, 0);
  assert.equal(game.elements.score.textContent, "0");
  assert.match(game.elements.status.textContent, /turn|motion/i);
  assert.ok(game.drawing.some(([method]) => method === "fill"));
});

test("each reduced-motion jump clears exactly one obstacle without moving the robot", () => {
  const game = openGame(true);
  game.start();
  game.drawing.length = 0;
  game.key();
  assert.equal(game.elements.score.textContent, "1");
  assert.match(game.elements.status.textContent, /cleared/i);
  game.key({ repeat: true });
  game.key({ key: "x", code: "KeyX" });
  game.tap({ isPrimary: false });
  game.tap({ button: 2 });
  assert.equal(game.elements.score.textContent, "1");
  game.key({ key: "ArrowUp", code: "ArrowUp" });
  game.tap();
  assert.equal(game.elements.score.textContent, "3");
  assert.equal(game.scheduledFrames, 0);
  assert.deepEqual(game.collisionChecks.map(({ obstacle }) => obstacle.width), [34, 26, 39]);
  assert.ok(game.collisionChecks.every(({ collided }) => !collided));
  const robotBodies = game.drawing.filter(([method, x, , width, height]) =>
    method === "fillRect" && x === 113 && width === 34 && height === 24);
  assert.equal(robotBodies.length, 3);
  assert.ok(robotBodies.every(([, , y]) => y === 188));
  game.start();
  assert.equal(game.elements.score.textContent, "0");
  assert.equal(game.elements["best-score"].textContent, "3");
  assert.equal(game.scheduledFrames, 0);
});

test("standard gameplay keeps its continuous frames and jump physics", () => {
  const game = openGame(false);
  game.start();
  assert.equal(game.callbacks.size, 1);
  game.key();
  game.frame(0);
  game.drawing.length = 0;
  game.frame(16);
  assert.equal(game.callbacks.size, 1);
  assert.ok(game.drawing.some(([method, x, y, width, height]) =>
    method === "fillRect" && x === 113 && y < 188 && width === 34 && height === 24));
});

test("enabling reduced motion cancels animation and ignores an already queued frame", () => {
  const game = openGame(false);
  game.start();
  game.key();
  game.frame(0);
  game.frame(16);
  const queuedFrame = [...game.callbacks.values()][0];
  game.setReducedMotion(true);
  assert.equal(game.callbacks.size, 0);
  const scheduledFrames = game.scheduledFrames;
  const drawingCount = game.drawing.length;
  queuedFrame(32);
  assert.equal(game.scheduledFrames, scheduledFrames);
  assert.equal(game.drawing.length, drawingCount);
  game.key();
  assert.equal(game.elements.score.textContent, "1");
  game.setReducedMotion(false);
  assert.equal(game.callbacks.size, 1);
  game.frame(48);
  game.frame(64);
  assert.equal(game.elements.score.textContent, "1");
});
