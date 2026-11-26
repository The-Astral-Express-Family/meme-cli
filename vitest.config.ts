import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // 普通用例 10s；确需慢跑的用例在 it 上显式标 timeout
    testTimeout: 10_000,
    hookTimeout: 15_000,
    // fastembed/sharp 是可选原生依赖；测试环境强制词法降级，保证离线可跑
    env: { MEME_EMBED_OFF: '1' },
  },
})
