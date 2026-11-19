import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // fastembed/sharp 是可选原生依赖；测试环境强制词法降级，保证离线可跑
    env: { MEME_EMBED_OFF: '1' },
  },
})
