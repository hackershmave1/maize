// Adaptive intensity derived from the session score: the SAME thresholds as the backend
// (moqesh/detection.py intensity_for). 0 = real finite site (stealth); 1..3 = lure + tarpit.

export function intensityFromScore(score: number): number {
  if (score >= 0.8) return 3;
  if (score >= 0.6) return 2;
  if (score >= 0.4) return 1;
  return 0;
}

export const INTENSITY_LABELS = ['Passive', 'Watched', 'Lure', 'Tarpit'] as const;

export const INTENSITY_HINTS = [
  'Real finite site: max stealth',
  'Mild suspicion: coherent vocabulary',
  'Dense coherent lure: more to read',
  'Tarpit: growing delay that burns tokens',
] as const;

export function intensityBadge(level: number): string {
  switch (level) {
    case 3:
      return 'bg-red/20 text-red border-red/30';
    case 2:
      return 'bg-amber/20 text-amber border-amber/30';
    case 1:
      return 'bg-blue/20 text-blue border-blue/30';
    default:
      return 'bg-surface-alt text-fg-muted border-border';
  }
}
