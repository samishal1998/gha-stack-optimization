import { describe, expect, it } from 'vitest';
// Temporary: makes the head PR's CI fail, to prove failure propagates down the
// segment. Removed immediately after.
describe('dogfood', () => {
  it('deliberately fails', () => {
    expect(1).toBe(2);
  });
});
