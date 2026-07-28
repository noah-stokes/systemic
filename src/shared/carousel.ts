// Ring geometry for the option deck: three cards on a turntable, one in front.
// Pure math so it is testable without a DOM — the component only applies it.

export interface StageConfig {
  radius: number;
  drag: number; // pixels dragged per one-card step
  tilt: number; // degrees of rotateY per one-card step
  perspective: number;
}

export interface CardPose {
  x: number;
  z: number;
  rotateY: number;
  opacity: number;
  zIndex: number;
  dim: boolean;
}

// Anchors: the docked panel (2a) and the panel dragged wide (2b).
const NARROW = 372;
const WIDE = 980;
const NARROW_CFG: StageConfig = {
  radius: 176,
  drag: 190,
  tilt: 42,
  perspective: 1000,
};
const WIDE_CFG: StageConfig = {
  radius: 330,
  drag: 300,
  tilt: 34,
  perspective: 1400,
};

const FLICK_PX = 38;
const TAU = Math.PI * 2;

const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

/** Geometry for a stage of the given pixel width, interpolated between anchors. */
export function stageConfig(width: number): StageConfig {
  const u = Math.min(1, Math.max(0, (width - NARROW) / (WIDE - NARROW)));
  return {
    radius: lerp(NARROW_CFG.radius, WIDE_CFG.radius, u),
    drag: lerp(NARROW_CFG.drag, WIDE_CFG.drag, u),
    tilt: lerp(NARROW_CFG.tilt, WIDE_CFG.tilt, u),
    perspective: lerp(NARROW_CFG.perspective, WIDE_CFG.perspective, u),
  };
}

/** Signed distance in cards from the front slot, wrapped to [-count/2, count/2]. */
function offset(index: number, turn: number, count: number): number {
  let a = (((index - turn) % count) + count) % count;
  if (a > count / 2) {
    a -= count;
  }
  return a;
}

/** Where card `index` sits when the ring is at continuous position `turn`. */
export function cardPose(
  index: number,
  turn: number,
  count: number,
  config: StageConfig,
): CardPose {
  const a = offset(index, turn, count);
  const theta = a * (TAU / count);
  const cos = Math.cos(theta);
  return {
    x: Math.sin(theta) * config.radius,
    z: cos * config.radius - config.radius,
    rotateY: a * config.tilt,
    opacity: 0.3 + 0.7 * Math.pow((cos + 1) / 2, 1.5),
    zIndex: 200 + Math.round(cos * 100),
    dim: cos <= 0.86,
  };
}

/** The card currently in front. */
export function slotFromTurn(turn: number, count: number): number {
  return ((Math.round(turn) % count) + count) % count;
}

/**
 * Where the ring should settle after a drag of `dx` pixels that started at
 * `turn`. A fast short flick still advances one card rather than snapping back.
 */
export function flickTarget(
  turn: number,
  dx: number,
  config: StageConfig,
): number {
  const from = Math.round(turn);
  const target = Math.round(turn - dx / config.drag);
  return Math.abs(dx) > FLICK_PX && target === from
    ? from - Math.sign(dx)
    : target;
}
