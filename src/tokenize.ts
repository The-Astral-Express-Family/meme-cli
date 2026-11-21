/**
 * 分词门面：@node-rs/jieba 单例包装（cut 分词 / segmentTagged 词性标注）。
 * 集中在此便于全局替换与测试注入。
 */
import { Jieba } from '@node-rs/jieba'
import { dict } from '@node-rs/jieba/dict.js'

export interface TaggedToken { word: string; tag: string }

let instance: Jieba | null = null

const jieba = (): Jieba => (instance ??= Jieba.withDict(dict))

/** 精确分词（HMM 开启，等价 jieba.lcut 默认模式）。 */
export function segment(text: string): string[] {
  return jieba().cut(text, true)
}

/** 词性标注（等价 jieba.posseg.lcut）。 */
export function segmentTagged(text: string): TaggedToken[] {
  return jieba().tag(text, true)
}
