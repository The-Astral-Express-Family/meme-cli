import { defineTool } from '@deepseek-ai/dsh-tools'
type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

// A: 无 properties 的开放对象
const a = defineTool({
  name: 'a', description: 'x',
  parameters: { q: { type: 'string', required: true } },
  output: { schema: { type: 'object', additionalProperties: true }, render: (_x, v) => [{ type: 'text' as const, text: String(v) }] },
  async execute() {
    return { result: 'hit', hits: [{ a: 1 }], human: 'x' } as Record<string, Json>
  },
})

// B: 有 properties + 显式返回类型注解（联合分支）
const b = defineTool({
  name: 'b', description: 'x',
  parameters: { q: { type: 'string', required: true } },
  output: {
    schema: { type: 'object', properties: { result: { type: 'string' }, hits: { type: 'json' } }, additionalProperties: true },
    render: (_x, v) => [{ type: 'text' as const, text: String(v) }],
  },
  async execute(): Promise<Record<string, Json>> {
    if (Math.random() > 0.5) return { result: 'hit', hits: [1], human: 'a' }
    return { result: 'miss', human: 'b' }
  },
})
export { a, b }
