/**
 * 图片感知哈希（pHash）：图梗发现的纯本地基座。
 *
 * 发现端不需要图片理解模型——梗图的本质是"跨视频复现"，
 * 64-bit pHash + 汉明距离足以把同源梗图/其加字变体聚成一簇；
 * 理解端（这张图在表达什么）留给 write path 归纳时的多模态判断。
 */
import sharp from 'sharp'

const DCT_N = 32
let dctMatrix: number[][] | null = null

/** 正交归一 DCT-II 基矩阵（进程级缓存）。 */
function dct(n: number): number[][] {
  if (dctMatrix && dctMatrix.length === n) return dctMatrix
  const m: number[][] = []
  for (let k = 0; k < n; k++) {
    const row: number[] = []
    for (let i = 0; i < n; i++) {
      row.push(Math.cos((Math.PI * (2 * i + 1) * k) / (2 * n)) * Math.sqrt(2 / n))
    }
    m.push(row)
  }
  for (let i = 0; i < n; i++) m[0][i] = Math.sqrt(1 / n) // k=0 行正交归一
  dctMatrix = m
  return m
}

/** 图片字节 → 64-bit pHash（16 位 hex）。解析失败返回 null（含动图取首帧由 sharp 处理）。 */
export async function phashBytes(data: Uint8Array): Promise<string | null> {
  try {
    const { data: raw, info } = await sharp(data)
      .grayscale()
      .resize(DCT_N, DCT_N, { fit: 'fill', kernel: 'cubic' })
      .raw()
      .toBuffer({ resolveWithObject: true })
    if (info.width !== DCT_N || info.height !== DCT_N) return null
    const a: number[][] = []
    for (let y = 0; y < DCT_N; y++) {
      a.push(Array.from(raw.subarray(y * DCT_N, (y + 1) * DCT_N), (v) => v as number))
    }
    const d = dct(DCT_N)
    // f = d @ a @ d^T（低频 8x8 去直流块）
    const block: number[] = []
    for (let k = 1; k <= 8; k++) {
      for (let l = 1; l <= 8; l++) {
        let sum = 0
        for (let i = 0; i < DCT_N; i++) {
          const dik = d[k][i]
          if (dik === 0) continue
          let inner = 0
          for (let j = 0; j < DCT_N; j++) inner += a[i][j] * d[l][j]
          sum += dik * inner
        }
        block.push(sum)
      }
    }
    const sorted = [...block].sort((x, y) => x - y)
    const med = (sorted[sorted.length >> 1] + sorted[(sorted.length - 1) >> 1]) / 2
    let v = 0n
    for (const x of block) v = (v << 1n) | (x > med ? 1n : 0n)
    return v.toString(16).padStart(16, '0')
  } catch {
    return null // 坏图/不支持的格式：跳过不致命
  }
}

/** 两个 pHash hex 的汉明距离。 */
export function hamming(h1: string, h2: string): number {
  try {
    let x = BigInt(`0x${h1}`) ^ BigInt(`0x${h2}`)
    let count = 0
    while (x) {
      x &= x - 1n
      count++
    }
    return count
  } catch {
    return 64
  }
}
