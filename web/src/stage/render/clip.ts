export interface LayerTransform {
  x: number;
  y: number;
  /** Degrees. */
  rot: number;
  sx: number;
  sy: number;
  alpha: number;
}

export type Ease = 'linear' | 'in' | 'out' | 'inOut';

/**
 * Keyframe values are offsets applied on top of a layer's base transform:
 * x / y / rot / alpha add, sx / sy multiply. Omitted values are the identity.
 */
export interface Keyframe extends Partial<LayerTransform> {
  /** Milliseconds from clip start. */
  t: number;
  /** Swap the layer's image to this named state from this keyframe on. */
  state?: string;
  /** Easing used when interpolating from this keyframe to the next. */
  ease?: Ease;
}

export const IDENTITY: Readonly<LayerTransform> = { x: 0, y: 0, rot: 0, sx: 1, sy: 1, alpha: 0 };

const EASES: Record<Ease, (u: number) => number> = {
  linear: (u) => u,
  in: (u) => u * u,
  out: (u) => 1 - (1 - u) * (1 - u),
  inOut: (u) => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2),
};

const PROPS = ['x', 'y', 'rot', 'sx', 'sy', 'alpha'] as const;

function resolve(key: Keyframe): LayerTransform {
  const tf = { ...IDENTITY };
  for (const p of PROPS) if (key[p] !== undefined) tf[p] = key[p];
  return tf;
}

/** Samples a track (keyframes sorted by t) at time t. */
export function sampleTrack(keys: readonly Keyframe[], t: number): { tf: LayerTransform; state?: string } {
  if (!keys.length) return { tf: { ...IDENTITY } };

  let state: string | undefined;
  for (const key of keys) if (key.t <= t && key.state !== undefined) state = key.state;

  if (t <= keys[0].t) return { tf: resolve(keys[0]), state };
  const last = keys[keys.length - 1];
  if (t >= last.t) return { tf: resolve(last), state };

  let i = 0;
  while (keys[i + 1].t <= t) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const u = EASES[a.ease ?? 'inOut']((t - a.t) / (b.t - a.t));
  const ta = resolve(a);
  const tb = resolve(b);
  const tf = { ...IDENTITY };
  for (const p of PROPS) tf[p] = ta[p] + (tb[p] - ta[p]) * u;
  return { tf, state };
}
