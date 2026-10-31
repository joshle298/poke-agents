import { defineConfig } from 'vitest/config';

process.env['ALLURE_LABEL_epic'] ??= 'server';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10_000,
    include: ['__tests__/**/*.test.ts'],
    // No sprite downloads from tests: the Pokémon tests opt back in with
    // setPokemonSpritesEnabled(true) and a fake fetch.
    env: { POKE_AGENTS_SPRITES: 'off' },
    setupFiles: ['allure-vitest/setup'],
    reporters: [
      'default',
      [
        'allure-vitest/reporter',
        {
          resultsDir: '../allure-results/server',
        },
      ],
    ],
  },
});
