import { describe, expect, it } from 'vitest';
// Temporary: makes the CHECKPOINT fail, so we can watch what happens when its
// label is then removed.
describe('dogfood checkpoint', () => {
  it('deliberately fails', () => {
    expect('checkpoint').toBe('broken');
  });
});
