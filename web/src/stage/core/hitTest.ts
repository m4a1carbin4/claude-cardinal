import type { HitShape, HitZone, Vec2 } from './types';

export function inShape(shape: HitShape, p: Vec2): boolean {
  switch (shape.type) {
    case 'ellipse': {
      const dx = (p.x - shape.cx) / shape.rx;
      const dy = (p.y - shape.cy) / shape.ry;
      return dx * dx + dy * dy <= 1;
    }
    case 'rect':
      return p.x >= shape.x && p.x <= shape.x + shape.w && p.y >= shape.y && p.y <= shape.y + shape.h;
    case 'polygon': {
      // Ray casting.
      let inside = false;
      const pts = shape.points;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i];
        const [xj, yj] = pts[j];
        if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    }
  }
}

export function pickZone(zones: readonly HitZone[], p: Vec2): HitZone | null {
  let best: HitZone | null = null;
  for (const zone of zones) {
    if (!inShape(zone.shape, p)) continue;
    if (!best || (zone.priority ?? 0) > (best.priority ?? 0)) best = zone;
  }
  return best;
}
