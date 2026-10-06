import type { EntryRow } from './types'

// 存量数据迁移：只做补数与字段对齐，不改任何记录的既有状态。
// v1 -> v2：
//   1. 廊桥/地面电源缺机位归属的存量记录，按机位台账（stand）既有数据迁移补数；
//   2. 廊桥补「锁定时间 / 电源核验」两个队列新字段；
//   3. 地面电源补「占用廊桥」联动字段；
//   4. 历史停用归档（故障停用）保持原状态，只补归属与字段。
export const SCHEMA_VERSION = 2

type MigrationResult = {
  rows: Record<string, EntryRow[]>
  bridgeBackfilled: number
  powerBackfilled: number
}

function isMissingStand(value: unknown): boolean {
  const text = String(value ?? '').trim()
  if (text === '') {
    return true
  }
  // 仓库初始化时播种的占位数据（如「廊桥调度样例1」「地面电源样例2」）不算真实机位归属。
  return /样例\d*$/.test(text)
}

export function migrate(rows: Record<string, EntryRow[]>): MigrationResult {
  const stands = rows.stand ?? []
  const standCodes = stands.map((row) => String(row['机位编号'] ?? '').trim()).filter(Boolean)

  const resolveStand = (row: EntryRow, index: number): string => {
    // 优先按编号尾号（如 BRID-0001 / GROU-0002）对号机位台账，尾号超出台账范围时按顺序兜底。
    const code = String(row[Object.keys(row).find((key) => /编号$/.test(key)) ?? ''] ?? '')
    const tail = code.match(/(\d+)\s*$/)
    if (tail) {
      const ordinal = Number(tail[1])
      const byIndex = standCodes[(ordinal - 1) % Math.max(standCodes.length, 1)]
      if (byIndex) {
        return byIndex
      }
    }
    return standCodes[index % Math.max(standCodes.length, 1)] ?? ''
  }

  let bridgeBackfilled = 0
  let powerBackfilled = 0

  const next: Record<string, EntryRow[]> = { ...rows }

  next.bridge = (rows.bridge ?? []).map((row, index) => {
    const migrated: EntryRow = { ...row }
    if (isMissingStand(migrated['所属机位'])) {
      const stand = resolveStand(migrated, index)
      if (stand) {
        migrated['所属机位'] = stand
        bridgeBackfilled += 1
      }
    }
    if (migrated['锁定时间'] === undefined) {
      // 历史已对接记录视为在实际对接时锁定；其余待对接记录尚未锁定。
      migrated['锁定时间'] = String(migrated.status) === '已对接' ? String(migrated['实际对接'] ?? '') : ''
    }
    if (migrated['电源核验'] === undefined) {
      migrated['电源核验'] = ''
    }
    // 历史停用归档保持原状态，迁移过程中不触碰 status / pending / abnormal。
    return migrated
  })

  next.ground_power = (rows.ground_power ?? []).map((row, index) => {
    const migrated: EntryRow = { ...row }
    if (isMissingStand(migrated['所属机位'])) {
      const stand = resolveStand(migrated, index)
      if (stand) {
        migrated['所属机位'] = stand
        powerBackfilled += 1
      }
    }
    if (migrated['占用廊桥'] === undefined) {
      migrated['占用廊桥'] = String(migrated.status) === '供电中' ? '迁移补录' : ''
    }
    return migrated
  })

  return { rows: next, bridgeBackfilled, powerBackfilled }
}
