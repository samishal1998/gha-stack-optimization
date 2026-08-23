import { describe, expect, it } from 'vitest';
// Temporary: makes the TOP of the stack fail, to show failure confined to
// segment A while the checkpointed bottom half stays mergeable.
describe('dogfood top of stack', () => {
  it('deliberately fails', () => {
    expect('top').toBe('broken');
  });
});
