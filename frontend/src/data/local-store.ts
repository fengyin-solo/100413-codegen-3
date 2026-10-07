import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'airport-ground-handling:entries'
// 数据层版本：老版本存档读出来先逐级迁移再使用。
const STORE_VERSION = 2

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

const ACTIVE_STATUSES = ['待对接', '已对接']
const ARCHIVE_STATUS = '故障停用'

function text(row: EntryRow | undefined, field: string): string {
  return String(row?.[field] ?? '').trim()
}

// 缺机位归属的存量记录按既有数据补数：廊桥台账 / 对接队列 / 地面电源三方互相推导，
// 只能补空、不能覆盖既有值；故障停用归档一律不碰。
function backfillStandOwnership(entries: Record<string, EntryRow[]>): void {
  for (let pass = 0; pass < 3; pass += 1) {
    const bridges = entries.bridge ?? []
    const queue = entries.bridge_queue ?? []
    const powers = entries.ground_power ?? []
    let changed = false

    const bridgeByCode = new Map(bridges.map((row) => [text(row, '廊桥编号'), row]))
    const queueByCode = new Map(queue.map((row) => [text(row, '廊桥编号'), row]))
    const powerByCode = new Map(powers.map((row) => [text(row, '设备编号'), row]))

    const standOfBridge = (code: string): string => {
      const bridge = bridgeByCode.get(code)
      if (bridge && text(bridge, '所属机位')) return text(bridge, '所属机位')
      const queued = queueByCode.get(code)
      if (queued && text(queued, '所属机位')) return text(queued, '所属机位')
      const linkedCode =
        (bridge && text(bridge, '关联电源')) || (queued && text(queued, '关联电源')) || ''
      const linked = linkedCode ? powerByCode.get(linkedCode) : undefined
      return linked ? text(linked, '所属机位') : ''
    }

    const fillBridgeRow = (row: EntryRow) => {
      if (String(row.status) === ARCHIVE_STATUS) return
      const code = text(row, '廊桥编号')
      if (!text(row, '所属机位')) {
        const derived = standOfBridge(code)
        if (derived) {
          row.所属机位 = derived
          changed = true
        }
      }
      if (!text(row, '关联电源')) {
        const queued = queueByCode.get(code)
        const linked = queued ? text(queued, '关联电源') : ''
        const occupied = powers.find((item) => text(item, '占用廊桥') === code)
        const derived = linked || (occupied ? text(occupied, '设备编号') : '')
        if (derived) {
          row.关联电源 = derived
          changed = true
        }
      }
    }

    bridges.forEach(fillBridgeRow)
    queue.forEach((row) => {
      if (String(row.status) === ARCHIVE_STATUS) return
      if (!text(row, '所属机位')) {
        const derived = standOfBridge(text(row, '廊桥编号'))
        if (derived) {
          row.所属机位 = derived
          changed = true
        }
      }
    })

    powers.forEach((row) => {
      if (String(row.status) === ARCHIVE_STATUS) return
      if (text(row, '所属机位')) return
      const occupant = text(row, '占用廊桥')
      let derived = occupant ? standOfBridge(occupant) : ''
      if (!derived) {
        const linkedBridge = bridges.find(
          (item) =>
            String(item.status) !== ARCHIVE_STATUS && text(item, '关联电源') === text(row, '设备编号'),
        )
        const linkedQueue = queue.find(
          (item) =>
            String(item.status) !== ARCHIVE_STATUS && text(item, '关联电源') === text(row, '设备编号'),
        )
        const code = text(linkedBridge, '廊桥编号') || text(linkedQueue, '廊桥编号')
        derived = code ? standOfBridge(code) : ''
      }
      if (derived) {
        row.所属机位 = derived
        changed = true
      }
    })

    if (!changed) break
  }
}

// v1 -> v2：廊桥调度新增对接队列，把台账里仍在链路上（待对接、已对接）的存量记录排入队列；
// 故障停用归档也随迁并保持原状态（终态可见、不可再推进），已脱离的完成周期不补排。
function migrateV1ToV2(raw: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const entries = clone(raw)
    ; (entries.bridge ?? []).forEach((row) => {
    if (text(row, '关联电源') === '') row.关联电源 = ''
  })
  if (!entries.bridge_queue) {
    const QUEUE_STATUSES = [...ACTIVE_STATUSES, ARCHIVE_STATUS]
    entries.bridge_queue = (entries.bridge ?? [])
      .filter((row) => QUEUE_STATUSES.includes(String(row.status)))
      .map((row) => ({
        id: Number(row.id),
        status: row.status,
        pending: row.pending,
        abnormal: row.abnormal,
        廊桥编号: row.廊桥编号 ?? '',
        所属机位: row.所属机位 ?? '',
        对接机型: row.对接机型 ?? '',
        调度人员: row.调度人员 ?? '',
        锁定时间: text(row, '计划对接') || '存量迁移',
        关联电源: row.关联电源 ?? '',
        计划对接: row.计划对接 ?? '',
        实际对接: row.实际对接 ?? '',
        脱离时间: row.脱离时间 ?? '',
      }))
  }
  if (!Array.isArray(entries.ground_power)) {
    entries.ground_power = clone(SEED_ROWS.ground_power ?? [])
  } else {
    entries.ground_power.forEach((row) => {
      if (text(row, '占用廊桥') === '') row.占用廊桥 = ''
    })
  }
  backfillStandOwnership(entries)
  return entries
}

type PersistedShape = {
  __storeVersion__: number
  entries: Record<string, EntryRow[]>
}

function isPersistedShape(value: unknown): value is PersistedShape {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PersistedShape).__storeVersion__ === 'number' &&
    typeof (value as PersistedShape).entries === 'object'
  )
}

// 旧档（v1，直接以模块为键）与新档（带版本号包一层）都收：解析完逐级迁移，
// 再用示例数据兜底补齐全新模块。
function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    persist(STORE_VERSION, fallback)
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    let version = 1
    let stored: Record<string, EntryRow[]>
    if (isPersistedShape(parsed)) {
      version = parsed.__storeVersion__
      stored = parsed.entries
    } else {
      stored = parsed as Record<string, EntryRow[]>
    }
    if (version < 2) {
      stored = migrateV1ToV2(stored)
      version = 2
    }
    const merged = { ...fallback, ...stored }
    persist(version, merged)
    return merged
  } catch {
    persist(STORE_VERSION, fallback)
    return fallback
  }
}

function persist(version: number, entries: Record<string, EntryRow[]>): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ __storeVersion__: version, entries }),
    )
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  persist(STORE_VERSION, next)
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
