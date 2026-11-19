/**
 * 向量层：fastembed 本地小模型（无 torch 级依赖）+ 暴力余弦。
 * 模型不可用（离线/下载失败）时优雅降级为纯词法，向量层返回不可用标记。
 */
import type { UsageSample } from '../models.ts'

/** 归一化向量（L2）矩阵；不可用时返回 null。 */
export type EmbedMatrix = number[][]

export interface Embedder {
  readonly available: boolean
  readonly dim: number | null
  embed(texts: string[]): Promise<EmbedMatrix | null>
}

class FastembedEmbedder implements Embedder {
  private model: { passageEmbed: (t: string[], b?: number) => AsyncIterable<number[][]>; queryEmbed: (t: string) => Promise<number[]> } | null = null
  private failed = false
  private loading: Promise<boolean> | null = null
  readonly dim: number | null = null

  constructor(private readonly modelSpec: string) {}

  get available(): boolean {
    return !this.failed && this.loading !== null
  }

  private async load(): Promise<boolean> {
    if (this.model) return true
    if (this.failed) return false
    if (!this.loading) {
      this.loading = (async () => {
        try {
          const mod = await import('fastembed')
          const spec = resolveModel(mod.EmbeddingModel, this.modelSpec)
          // 枚举值为字符串字面量联合；经名字解析后的 string 直接透传
          const m = await mod.FlagEmbedding.init({ model: spec as never })
          this.model = m as unknown as NonNullable<typeof this.model>
          return true
        } catch {
          this.failed = true
          return false
        }
      })()
    }
    return this.loading
  }

  async embed(texts: string[]): Promise<EmbedMatrix | null> {
    if (!texts.length) return []
    if (!(await this.load())) return null
    try {
      const out: number[][] = []
      for await (const batch of this.model!.passageEmbed(texts, 64)) out.push(...batch)
      return out.map(normalize)
    } catch {
      this.failed = true
      return null
    }
  }
}

class NullEmbedder implements Embedder {
  readonly available = false
  readonly dim: number | null = null
  async embed(): Promise<EmbedMatrix | null> {
    return null
  }
}

function normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((a, x) => a + x * x, 0)) || 1
  return vec.map((x) => x / norm)
}

function resolveModel(enumObj: Record<string, string>, spec: string): string {
  // 模型 spec 允许 huggingface id（BAAI/bge-small-zh-v1.5）或枚举名；包内值带 fast- 前缀
  const wanted = spec.toLowerCase().split('/').pop()!
  const hit = Object.entries(enumObj).find(([k, v]) => {
    const val = String(v).toLowerCase()
    return val.split('/').pop()!.endsWith(wanted) || k.toLowerCase() === wanted
  })
  if (hit) return hit[1]
  throw new Error(`unknown embed model: ${spec}`)
}

// ---------- 进程级单例（模型加载一次） ----------

let instance: Embedder | null = null
let warned = false

/** MEME_EMBED_OFF=1 强制关闭向量层（测试与离线环境）。 */
export function getEmbedder(modelName = 'BAAI/bge-small-zh-v1.5'): Embedder {
  if (process.env.MEME_EMBED_OFF === '1') return new NullEmbedder()
  if (!instance) {
    if (warned === false && process.env.MEME_EMBED_VERBOSE === '1') {
      warned = true
      console.error(`meme: 向量模型 ${modelName} 首次使用时加载；失败则降级纯词法`)
    }
    instance = new FastembedEmbedder(modelName)
  }
  return instance
}

/** 余弦相似度（双方均已 L2 归一化 → 点积）。 */
export function cosine(a: number[], b: number[]): number {
  let s = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i]
  return s
}

/** float32 向量 ↔ 存储 blob。 */
export function vecToBlob(v: number[]): Uint8Array {
  const f = new Float32Array(v)
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength)
}

export function blobToVec(blob: Uint8Array): number[] {
  return Array.from(new Float32Array(blob.slice().buffer))
}

export type { UsageSample }
