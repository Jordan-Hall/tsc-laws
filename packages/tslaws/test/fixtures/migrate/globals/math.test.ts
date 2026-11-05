describe('globals', () => {
  it('uses the global expect', () => {
    expect(2 + 2).toBe(4);
  });

  const label = 'shared';

  it('shares set-up', () => {
    expect(label).toBe('shared');
  });
});
