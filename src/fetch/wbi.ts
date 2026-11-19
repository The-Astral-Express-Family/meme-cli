/** wbi 签名：mixin key 重排 + md5（B站 web 接口通行证）。 */
import { createHash } from 'node:crypto'
import type { BiliSession } from './http.ts'

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
]

/** 懒加载 nav 的 wbi_img 密钥并签名参数。 */
export class WbiSigner {
  private mixin: string | null = null

  constructor(private readonly session: BiliSession) {}

  private async load(): Promise<void> {
    if (this.mixin !== null) return
    const data = await this.session.getJson<{
      wbi_img?: { img_url?: string; sub_url?: string }
    }>('https://api.bilibili.com/x/web-interface/nav')
    const img = data.wbi_img?.img_url ?? ''
    const sub = data.wbi_img?.sub_url ?? ''
    const stem = (u: string) => u.split('/').pop()?.split('.')[0] ?? ''
    const raw = stem(img) + stem(sub)
    this.mixin = MIXIN_TAB.filter((i) => i < raw.length).map((i) => raw[i]).join('').slice(0, 32)
  }

  async sign(params: Record<string, unknown>): Promise<Record<string, string | number>> {
    await this.load()
    const cleaned: Record<string, string> = {}
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue
      // wbi 规范：值中的 !'()* 字符参与签名前必须剔除
      cleaned[k] = String(v).replace(/[!'()*]/g, '')
    }
    cleaned.wts = String(Math.floor(Date.now() / 1000))
    const qs = new URLSearchParams(
      Object.entries(cleaned).sort(([a], [b]) => (a < b ? -1 : 1)),
    ).toString()
    const wRid = createHash('md5').update(qs + this.mixin).digest('hex')
    return { ...cleaned, w_rid: wRid }
  }
}
