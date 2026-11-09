import assert from "node:assert/strict";
import { test } from "node:test";
import {
  advance,
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
