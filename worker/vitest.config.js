import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

// Тести працюють у справжньому середовищі Workers (Miniflare) з локальною D1.
// ENV=dev + DEV_AUTH=1 вмикають тестовий вхід «dev:пошта» — лише тут, не в робочому розгортанні.
export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        bindings: {
          ENV: 'dev', DEV_AUTH: '1', ADMINS: 'admin@ubchurch.lviv.ua',
          ORDER_CONTACT: '{"telegram":"test"}', TEST_MIGRATIONS: migrations,
        },
      },
    })],
    test: { setupFiles: ['./test/setup.js'] },
  };
});
