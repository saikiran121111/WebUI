import { describe, expect, it } from "vitest";
import { layoutRoomTags, raycastRoomRect, type RoomTagSeed, type WallSeg } from "../../lib/cad/cadBlocks";

describe("raycastRoomRect", () => {
  const segs: WallSeg[] = [
    { a: [0, 0], b: [8, 0], half: 0.1 },
    { a: [8, 0], b: [8, 6], half: 0.1 },
    { a: [8, 6], b: [0, 6], half: 0.1 },
    { a: [0, 6], b: [0, 0], half: 0.1 },
  ];
  it("derives the interior room rect from wall centerlines (inset by half thickness)", () => {
    const r = raycastRoomRect([4, 3], segs, 10);
    expect(r).not.toBeNull();
    expect(r!.x).toBeCloseTo(0.1);
    expect(r!.y).toBeCloseTo(0.1);
    expect(r!.w).toBeCloseTo(7.8);
    expect(r!.h).toBeCloseTo(5.8);
  });
  it("returns null when the point is not enclosed within maxReach", () => {
    expect(raycastRoomRect([-1, 3], segs, 10)).toBeNull(); // outside the plan
    expect(raycastRoomRect([4, 3], segs, 2)).toBeNull(); // walls beyond reach
  });
});

describe("layoutRoomTags", () => {
  const ppm = 20;
  it("wraps a long name to two balanced lines and keeps textContent intact", () => {
    const seed: RoomTagSeed = {
      x: 2, y: 3, name: "CUSTOMER SEATING AREA", area: 8, dx: 2, dy: 4,
      room: { x: 1, y: 1, w: 2, h: 4 },
    };
    const [tag] = layoutRoomTags([seed], [], ppm);
    expect(tag.lines.length).toBe(2);
    expect(tag.lines.join("")).toBe("CUSTOMER SEATING AREA");
    expect(tag.fontScale).toBeGreaterThanOrEqual(0.8);
    // pill must never render text wider than itself at the chosen scale
    expect(tag.w * ppm).toBeGreaterThanOrEqual(tag.lines[1].length * 9 * 0.62 * tag.fontScale);
  });
  it("keeps short labels single-line at full scale in a wide room", () => {
    const seed: RoomTagSeed = {
      x: 4, y: 3, name: "BAR", area: 24, dx: 8, dy: 3,
      room: { x: 0, y: 1.5, w: 8, h: 3 },
    };
    const [tag] = layoutRoomTags([seed], [], ppm);
    expect(tag.lines.length).toBe(1);
    expect(tag.fontScale).toBe(1);
    // placement stays fully inside the room rect
    expect(tag.cx - tag.w / 2).toBeGreaterThanOrEqual(0);
    expect(tag.cx + tag.w / 2).toBeLessThanOrEqual(8);
  });
  it("nudges pills off wall obstacles via the ring search", () => {
    const seed: RoomTagSeed = { x: 4, y: 3, name: "BAR", area: 24, dx: 8, dy: 3 };
    const obstacle = { x: 3.5, y: 2.5, w: 1.5, h: 1 }; // sits on the seed
    const [tag] = layoutRoomTags([seed], [obstacle], ppm);
    const box = { x: tag.cx - tag.w / 2, y: tag.cy - tag.h / 2, w: tag.w, h: tag.h };
    const overlaps = box.x < obstacle.x + obstacle.w && obstacle.x < box.x + box.w &&
      box.y < obstacle.y + obstacle.h && obstacle.y < box.y + box.h;
    expect(overlaps).toBe(false);
  });
});
