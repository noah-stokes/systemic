// Run: npm test
import assert from "node:assert/strict";
import test from "node:test";

import {
  cardPose,
  flickTarget,
  slotFromTurn,
  stageConfig,
} from "./carousel.ts";

const near = (actual: number, expected: number, tolerance = 0.5) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} not within ${tolerance} of ${expected}`,
  );

test("stage geometry hits both design anchors and clamps outside them", () => {
  const narrow = stageConfig(372);
  assert.deepEqual(narrow, {
    radius: 176,
    drag: 190,
    tilt: 42,
    perspective: 1000,
  });
  const wide = stageConfig(980);
  assert.deepEqual(wide, {
    radius: 330,
    drag: 300,
    tilt: 34,
    perspective: 1400,
  });
  assert.deepEqual(stageConfig(120), narrow);
  assert.deepEqual(stageConfig(2400), wide);
  // and moves monotonically between them
  assert.ok(stageConfig(676).radius > narrow.radius);
  assert.ok(stageConfig(676).radius < wide.radius);
});

test("front card is centred and the other two sit behind it, mirrored", () => {
  const config = stageConfig(372);
  const front = cardPose(0, 0, 3, config);
  near(front.x, 0);
  near(front.z, 0);
  near(front.opacity, 1, 0.01);
  assert.equal(front.rotateY, 0);
  assert.equal(front.dim, false);

  const right = cardPose(1, 0, 3, config);
  const left = cardPose(2, 0, 3, config);
  assert.ok(right.z < front.z, "rear card is further away");
  near(right.x, -left.x);
  near(right.z, left.z);
  assert.ok(right.opacity < front.opacity);
  assert.ok(right.zIndex < front.zIndex);
  assert.equal(right.dim, true);
});

test("rotating one step brings the next card to the front", () => {
  const config = stageConfig(372);
  const pose = cardPose(1, 1, 3, config);
  near(pose.x, 0);
  near(pose.z, 0);
  assert.equal(pose.dim, false);
});

test("focused slot wraps in both directions", () => {
  assert.equal(slotFromTurn(0, 3), 0);
  assert.equal(slotFromTurn(3, 3), 0);
  assert.equal(slotFromTurn(4, 3), 1);
  assert.equal(slotFromTurn(-1, 3), 2);
  assert.equal(slotFromTurn(-4, 3), 2);
  assert.equal(slotFromTurn(1.4, 3), 1);
});

test("a flick advances one card, a nudge snaps back", () => {
  const config = stageConfig(372); // 190px per step
  assert.equal(flickTarget(0, -40, config), 1, "short left flick advances");
  assert.equal(flickTarget(0, 40, config), -1, "short right flick goes back");
  assert.equal(flickTarget(0, -10, config), 0, "nudge snaps back");
  assert.equal(flickTarget(0, -200, config), 1, "full drag lands one over");
  assert.equal(flickTarget(2, -400, config), 4, "drag is relative to the turn");
});
