import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 线性环节：待对接 → 已对接 → 已脱离 → 故障停用，只能往下一格走。
const BRIDGE_STATUS_ORDER = ['待对接', '已对接', '已脱离', '故障停用'] as const
const ARCHIVED_BRIDGE_STATUS = '故障停用'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 线性流转模块当前状态下唯一允许的动作；到了环节末端（如故障停用归档）没有可执行动作。
export function availableActions(meta: ModuleMeta, status: string): string[] {
  if (meta.linearFlow) {
    const order = meta.key === 'bridge' ? [...BRIDGE_STATUS_ORDER] : meta.statuses
    const index = order.indexOf(status)
    const nextStatus = index >= 0 ? order[index + 1] : undefined
    return meta.actions.filter((action) => meta.actionTargets[action] === nextStatus)
  }
  return meta.actions
}

function isPending(meta: ModuleMeta, status: string): boolean {
  if (meta.pendingStatuses) {
    return meta.pendingStatuses.includes(status)
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  return status !== lastStatus
}

function assertLinearAdvance(meta: ModuleMeta, current: string, target: string): ActionResult | null {
  if (!meta.linearFlow) {
    return null
  }
  const order = meta.key === 'bridge' ? [...BRIDGE_STATUS_ORDER] : meta.statuses
  const currentIndex = order.indexOf(current)
  const targetIndex = order.indexOf(target)
  if (currentIndex < 0 || targetIndex < 0) {
    return { ok: false, message: `当前状态「${current}」不在既定环节里，不能流转` }
  }
  if (targetIndex <= currentIndex) {
    return { ok: false, message: `状态只能顺着既定环节往下走，不能从「${current}」倒回「${target}」` }
  }
  if (targetIndex > currentIndex + 1) {
    return { ok: false, message: `每次只能推进到下一环节，不能从「${current}」越过中间环节直接到「${target}」` }
  }
  return null
}

function stamp(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

// 同一机位的地面电源台账：返回设备行及其在列表中的位置，找不到返回 null。
function findPowerAtStand(stand: string): { rows: EntryRow[]; index: number } | null {
  const rows = listRows('ground_power')
  const index = rows.findIndex((row) => String(row['所属机位'] ?? '').trim() === stand)
  return index >= 0 ? { rows, index } : null
}

// 安排对接前的地面电源占用核验：无台账 / 故障停用 / 已被占用都不予受理。
function verifyPowerForDock(bridge: EntryRow): ActionResult | null {
  const stand = String(bridge['所属机位'] ?? '').trim()
  if (!stand) {
    return { ok: false, message: '该廊桥缺少机位归属，无法核验地面电源台账，请先补全所属机位' }
  }
  const located = findPowerAtStand(stand)
  if (!located) {
    return { ok: false, message: `机位 ${stand} 在地面电源台账里没有对应设备，占用核验不通过，对接不予受理` }
  }
  const power = located.rows[located.index]
  const powerStatus = String(power.status)
  if (powerStatus === '故障停用') {
    return { ok: false, message: `机位 ${stand} 的地面电源 ${power['设备编号']} 已故障停用，占用核验不通过` }
  }
  const occupier = String(power['占用廊桥'] ?? '').trim()
  if (powerStatus === '供电中' && occupier && occupier !== String(bridge['廊桥编号'] ?? '')) {
    return { ok: false, message: `机位 ${stand} 的地面电源已被廊桥 ${occupier} 占用，占用核验不通过` }
  }
  return null
}

// 对接成功后同步电源台账：置为供电中并登记占用廊桥、供电开始时间。
function markPowerOccupied(bridge: EntryRow, time: string): string {
  const stand = String(bridge['所属机位'] ?? '').trim()
  const located = findPowerAtStand(stand)
  if (!located) {
    return '未核验（无台账）'
  }
  const power = located.rows[located.index]
  const nextPower: EntryRow = {
    ...power,
    status: '供电中',
    pending: true,
    abnormal: false,
    '供电开始': String(power['供电开始'] ?? '').trim() || time,
    '供电结束': '',
    '占用廊桥': String(bridge['廊桥编号'] ?? ''),
    '设备状态': '供电中',
  }
  const nextRows = [...located.rows]
  nextRows[located.index] = nextPower
  saveRows('ground_power', nextRows)
  return `已核验通过·${nextPower['设备编号']}`
}

// 廊桥脱离后同步电源台账：结束供电、解除占用。
function releasePower(bridge: EntryRow, time: string): void {
  const stand = String(bridge['所属机位'] ?? '').trim()
  const located = findPowerAtStand(stand)
  if (!located) {
    return
  }
  const power = located.rows[located.index]
  if (String(power['占用廊桥'] ?? '').trim() !== String(bridge['廊桥编号'] ?? '')) {
    return
  }
  const nextPower: EntryRow = {
    ...power,
    status: '已断电',
    pending: false,
    abnormal: false,
    '供电结束': time,
    '占用廊桥': '',
    '设备状态': '已断电',
  }
  const nextRows = [...located.rows]
  nextRows[located.index] = nextPower
  saveRows('ground_power', nextRows)
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const linearError = assertLinearAdvance(meta, current, target)
  if (linearError) {
    return linearError
  }
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: isPending(meta, target),
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 廊桥调度专属动作：在线性流转之外，叠加机位锁定归属与地面电源台账占用核验。
export function runBridgeAction(id: number, action: string): ActionResult {
  const meta = moduleMeta('bridge')
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `廊桥没有登记「${action}」这个动作` }
  }
  const rows = listRows('bridge')
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的廊桥` }
  }
  const bridge = rows[index]
  const current = String(bridge.status)
  if (current === target) {
    return { ok: false, message: `廊桥已经是「${target}」，不用重复操作` }
  }
  const linearError = assertLinearAdvance(meta, current, target)
  if (linearError) {
    return linearError
  }

  const time = stamp()
  const updated: EntryRow = { ...bridge }
  let message: string

  if (action === '安排对接') {
    const stand = String(bridge['所属机位'] ?? '').trim()
    const code = String(bridge['廊桥编号'] ?? '').trim()
    // 归属冲突：同一廊桥被两人同时安排时，以先锁定机位的一方为准。
    const lockHolder = rows.find(
      (row) =>
        Number(row.id) !== Number(bridge.id) &&
        String(row.status) === '已对接' &&
        (String(row['廊桥编号'] ?? '').trim() === code ||
          (stand !== '' && String(row['所属机位'] ?? '').trim() === stand)),
    )
    if (lockHolder) {
      return {
        ok: false,
        message: `廊桥 ${code}（机位 ${stand || '未归属'}）已由调度人员 ${lockHolder['调度人员']} 于 ${lockHolder['锁定时间'] || '此前'} 先锁定机位，本次安排不予受理`,
      }
    }
    // 调度后其余链路中的地面电源台账要同步占用核验。
    const powerError = verifyPowerForDock(bridge)
    if (powerError) {
      return powerError
    }
    updated['锁定时间'] = time
    updated['实际对接'] = String(bridge['实际对接'] ?? '').trim() || time
    const verification = markPowerOccupied(bridge, time)
    updated['电源核验'] = verification
    message = `廊桥 ${code} 已对接，机位 ${stand} 锁定归属 ${bridge['调度人员']}，地面电源台账${verification}`
  } else if (action === '确认脱离') {
    const timeShort = time
    updated['脱离时间'] = String(bridge['脱离时间'] ?? '').trim() || timeShort
    releasePower(bridge, timeShort)
    const previousCheck = String(bridge['电源核验'] ?? '').trim()
    updated['电源核验'] = previousCheck ? `${previousCheck}；已脱离释放` : '脱离时已释放'
    message = `廊桥 ${bridge['廊桥编号']} 已脱离，机位 ${bridge['所属机位']} 的地面电源已同步断电并解除占用`
  } else {
    // 停用报修 → 故障停用：进入历史停用归档，状态定格、不再流转。
    updated['廊桥状态'] = '故障停用（历史停用归档）'
    message = `廊桥 ${bridge['廊桥编号']} 已停用报修，状态定格为「故障停用」归档`
  }

  updated.status = target
  updated.pending = isPending(meta, target)
  updated.abnormal = target === ARCHIVED_BRIDGE_STATUS ? true : bridge.abnormal

  const next = [...rows]
  next[index] = updated
  saveRows('bridge', next)
  return { ok: true, message }
}

// 新增对接队列记录：按廊桥编号、所属机位、对接机型和调度人员入队，统一从「待对接」起步。
export function enqueueBridge(input: {
  廊桥编号: string
  所属机位: string
  对接机型: string
  调度人员: string
  计划对接: string
}): ActionResult {
  const required: [string, string][] = [
    ['廊桥编号', input.廊桥编号],
    ['所属机位', input.所属机位],
    ['对接机型', input.对接机型],
    ['调度人员', input.调度人员],
  ]
  const missing = required.find(([, value]) => value.trim() === '')
  if (missing) {
    return { ok: false, message: `${missing[0]}不能为空，无法进入对接队列` }
  }
  const rows = listRows('bridge')
  const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const row: EntryRow = {
    id: nextId,
    status: '待对接',
    pending: true,
    abnormal: false,
    '廊桥编号': input.廊桥编号.trim(),
    '所属机位': input.所属机位.trim(),
    '对接机型': input.对接机型.trim(),
    '调度人员': input.调度人员.trim(),
    '计划对接': input.计划对接.trim(),
    '锁定时间': '',
    '实际对接': '',
    '脱离时间': '',
    '电源核验': '',
    '廊桥状态': '待对接',
  }
  saveRows('bridge', [...rows, row])
  return { ok: true, message: `廊桥 ${row['廊桥编号']} 已进入对接队列（队尾，编号 ${nextId}）` }
}

// 对接队列：待对接记录按入队先后排列；已对接的记录显示锁定时间，代表已锁定机位、占用链路。
export function bridgeQueue(): { waiting: EntryRow[]; locked: EntryRow[] } {
  const rows = listRows('bridge')
  return {
    waiting: rows.filter((row) => String(row.status) === '待对接'),
    locked: rows.filter((row) => String(row.status) === '已对接'),
  }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
