import { defineConfig } from 'tsdown'

// 两个独立入口：插件主体（harness 加载）与 meme login CLI（bin）。
export default defineConfig([
  {
    entry: ['src/index.ts'],
    outDir: 'lib',
    dts: { sourcemap: true },
    platform: 'node',
    format: 'esm',
    target: 'node22',
    unbundle: true,
    publint: false,
  },
  {
    entry: ['src/cli.ts'],
    outDir: 'lib',
    platform: 'node',
    format: 'esm',
    target: 'node22',
    unbundle: true,
    publint: false,
  },
])
