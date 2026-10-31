import { defineConfig } from 'vitest/config';

process.env['ALLURE_LABEL_epic'] ??= 'server';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10_000,
    include: ['__tests__/**/*.test.ts'],
    // No sprite or radio downloads from tests: the Pokémon tests opt back in
    // with setPokemonSpritesEnabled(true) and a fake fetch; radio tests give
    // their RadioCache a fake fetch (and turn the switch on where they test it).
    env: { POKE_AGENTS_SPRITES: 'off', POKE_AGENTS_RADIO: 'off' },
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
