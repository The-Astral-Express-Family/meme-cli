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
    // harness 运行时包走 peer 语义：保留裸导入，由宿主进程的副本解析
    // （vendor 进 lib/node_modules 会缺 package.json 且遮蔽宿主版本）
    external: [/^@deepseek-ai\//, /^@tencent-connect\//],
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
