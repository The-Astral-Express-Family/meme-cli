/**
 * 安全备份：WAL 模式下直接 copyFileSync 主库会丢 WAL 里未合并的提交，
 * 还可能拷到撕裂页。VACUUM INTO 在单条语句内做一致性快照并顺带压实，是
 * SQLite 官方推荐的在线备份方式（无需停写）。
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

/** 对已打开的库做一致性快照到 destPath（目标文件必须不存在，防止误覆盖）。 */
export function safeBackup(db: DatabaseSync, destPath: string): void {
  mkdirSync(dirname(destPath), { recursive: true })
  db.prepare('VACUUM INTO ?').run(destPath)
}

/** 打开源库做只读快照后关闭；脚本类一次性备份用这个。 */
export function backupDatabase(dbPath: string, destPath: string, open: (path: string) => DatabaseSync): void {
  const db = open(dbPath)
  try {
    safeBackup(db, destPath)
  } finally {
    db.close()
  }
}
