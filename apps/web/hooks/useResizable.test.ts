import { describe, expect, it } from 'vitest';
import { clampWidth, nextWidth } from './useResizable';

describe('clampWidth', () => {
  it('clamps to [min, max] and rounds', () => {
    expect(clampWidth(250.6, 180, 360)).toBe(251);
    expect(clampWidth(100, 180, 360)).toBe(180);
    expect(clampWidth(999, 180, 360)).toBe(360);
  });
});

describe('nextWidth', () => {
  it('right-edge handle: drag right widens, drag left narrows', () => {
    expect(nextWidth(300, 40, 'right', 180, 560)).toBe(340);
    expect(nextWidth(300, -40, 'right', 180, 560)).toBe(260);
  });

  it('left-edge handle: drag right narrows, drag left widens', () => {
    // handle on the panel's left edge → moving it right shrinks the panel
    expect(nextWidth(420, 40, 'left', 320, 640)).toBe(380);
    expect(nextWidth(420, -40, 'left', 320, 640)).toBe(460);
  });

  it('never escapes the clamp regardless of drag distance', () => {
    expect(nextWidth(300, 5000, 'right', 180, 360)).toBe(360);
    expect(nextWidth(300, -5000, 'right', 180, 360)).toBe(180);
    expect(nextWidth(420, 5000, 'left', 320, 640)).toBe(320);
  });
});
