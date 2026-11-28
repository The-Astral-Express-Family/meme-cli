'use strict'
// curator run 预载：堵住任何残余出网。任何 fetch 调用直接抛错。
globalThis.fetch = function blockedFetch() {
  throw new Error('MEME_CURATOR_NET_BLOCKED: 本 run 禁止出网（fetch 已被替换为抛错函数）')
}
