import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

const BRIDGE_KEY = 'bridge'
const QUEUE_KEY = 'bridge_queue'
const POWER_KEY = 'ground_power'
const STAND_KEY = 'stand'
const ACTIVE_QUEUE_STATUSES = ['待对接', '已对接']
const POWER_READY_STATUSES = ['待机', '已断电']

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

function field(row: EntryRow, name: string): string {
  return String(row[name] ?? '').trim()
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function timestamp(withSeconds = false): string {
  const now = new Date()
  const base = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(
    now.getHours(),
  )}:${pad(now.getMinutes())}`
  return withSeconds ? `${base}:${pad(now.getSeconds())}` : base
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

// 严格状态机：只允许从当前环节推进到紧邻的下一格，越过环节或倒走都不予受理。
function assertStrictStep(meta: ModuleMeta, current: string, target: string): ActionResult | null {
  if (!meta.strictStep) {
    return null
  }
  const currentIndex = meta.statuses.indexOf(current)
  const expected = currentIndex >= 0 ? meta.statuses[currentIndex + 1] : undefined
  if (target === expected) {
    return null
  }
  if (currentIndex < 0) {
    return { ok: false, message: `当前状态「${current}」不在${meta.entity}的既定环节里，不能流转` }
  }
  if (!expected) {
    return { ok: false, message: `${meta.entity}已是终态「${current}」，没有下一环节可推进` }
  }
  return {
    ok: false,
    message: `${meta.entity}只能从「${current}」推进到「${expected}」，不能越过环节或倒走到「${target}」，该操作不予受理`,
  }
}

// 页面只渲染当前状态对应的「下一格」动作，业务判断仍以服务层为准。
export function nextAction(meta: ModuleMeta, status: string): string | undefined {
  const index = meta.statuses.indexOf(status)
  if (index < 0 || index >= meta.statuses.length - 1) {
    return undefined
  }
  const target = meta.statuses[index + 1]
  return meta.actions.find((action) => meta.actionTargets[action] === target)
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
  const stepError = assertStrictStep(meta, current, target)
  if (stepError) {
    return stepError
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export type BridgeEnqueueInput = {
  bridgeCode: string
  stand: string
  aircraftType: string
  operator: string
  plannedDock: string
  linkedPower: string
}

// 廊桥入队：按廊桥编号、所属机位、对接机型、调度人员锁定机位。
// 同一廊桥被两人同时安排、或同一机位已有在先锁定时，以先锁定机位为准，后到的不予受理。
export function enqueueBridge(input: BridgeEnqueueInput): ActionResult {
  const bridgeCode = input.bridgeCode.trim()
  const stand = input.stand.trim()
  const aircraftType = input.aircraftType.trim()
  const operator = input.operator.trim()
  const plannedDock = input.plannedDock.trim()
  const linkedPower = input.linkedPower.trim()
  if (!bridgeCode || !stand || !aircraftType || !operator) {
    return { ok: false, message: '廊桥编号、所属机位、对接机型、调度人员都为必填，缺一项不能入队' }
  }

  const stands = listRows(STAND_KEY)
  if (!stands.some((row) => field(row, '机位编号') === stand)) {
    return { ok: false, message: `所属机位「${stand}」未在机位分配里登记，无法锁定机位` }
  }

  const bridgeLedger = listRows(BRIDGE_KEY)
  const ledgerRow = bridgeLedger.find((row) => field(row, '廊桥编号') === bridgeCode)
  if (ledgerRow && String(ledgerRow.status) === '故障停用') {
    return { ok: false, message: `廊桥「${bridgeCode}」已故障停用归档，保持原状态，不能再安排对接` }
  }

  const queue = listRows(QUEUE_KEY)
  const active = queue.filter((row) => ACTIVE_QUEUE_STATUSES.includes(String(row.status)))
  const sameBridge = active.find((row) => field(row, '廊桥编号') === bridgeCode)
  if (sameBridge) {
    return {
      ok: false,
      message: `廊桥「${bridgeCode}」已由调度人员「${field(sameBridge, '调度人员')}」于 ${field(
        sameBridge,
        '锁定时间',
      )} 锁定机位「${field(sameBridge, '所属机位')}」，归属冲突以先锁定机位为准，本次安排不予受理`,
    }
  }
  const sameStand = active.find((row) => field(row, '所属机位') === stand)
  if (sameStand) {
    return {
      ok: false,
      message: `机位「${stand}」已被廊桥「${field(sameStand, '廊桥编号')}」（调度人员「${field(
        sameStand,
        '调度人员',
      )}」）先锁定，以先锁定机位为准，本次安排不予受理`,
    }
  }

  const powers = listRows(POWER_KEY)
  if (linkedPower) {
    const linked = powers.find((row) => field(row, '设备编号') === linkedPower)
    if (!linked) {
      return { ok: false, message: `关联电源「${linkedPower}」未在地面电源台账登记` }
    }
    if (field(linked, '所属机位') && field(linked, '所属机位') !== stand) {
      return {
        ok: false,
        message: `关联电源「${linkedPower}」归属机位「${field(
          linked,
          '所属机位',
        )}」，与安排机位「${stand}」不一致`,
      }
    }
  }

  const lockedAt = timestamp(true)
  const queueRow: EntryRow = {
    id: nextId(queue),
    status: '待对接',
    pending: true,
    abnormal: false,
    廊桥编号: bridgeCode,
    所属机位: stand,
    对接机型: aircraftType,
    调度人员: operator,
    锁定时间: lockedAt,
    关联电源: linkedPower,
    计划对接: plannedDock,
    实际对接: '',
    脱离时间: '',
  }
  saveRows(QUEUE_KEY, [...queue, queueRow])

  // 同步廊桥台账：已存在则带着新队列回到「待对接」开启新一轮保障，不存在则补登记。
  // 跨队列周期的复位只允许由入队触发；故障停用归档不允许复位。
  if (ledgerRow) {
    const index = bridgeLedger.indexOf(ledgerRow)
    const nextLedger = [...bridgeLedger]
    nextLedger[index] = {
      ...ledgerRow,
      status: '待对接',
      pending: true,
      abnormal: false,
      所属机位: stand,
      对接机型: aircraftType,
      调度人员: operator,
      关联电源: linkedPower,
      计划对接: plannedDock,
      实际对接: '',
      脱离时间: '',
      廊桥状态: '待对接',
    }
    saveRows(BRIDGE_KEY, nextLedger)
  } else {
    const newBridge: EntryRow = {
      id: nextId(bridgeLedger),
      status: '待对接',
      pending: true,
      abnormal: false,
      廊桥编号: bridgeCode,
      所属机位: stand,
      对接机型: aircraftType,
      调度人员: operator,
      关联电源: linkedPower,
      计划对接: plannedDock,
      实际对接: '',
      脱离时间: '',
      廊桥状态: '待对接',
    }
    saveRows(BRIDGE_KEY, [...bridgeLedger, newBridge])
  }

  return { ok: true, message: `廊桥「${bridgeCode}」已入队并锁定机位「${stand}」，锁定时间 ${lockedAt}` }
}

// 安排对接时的地面电源占用核验：返回可占用的那台电源；不通过时给出拒绝原因。
function claimPower(
  powers: EntryRow[],
  stand: string,
  bridgeCode: string,
  linkedCode: string,
): { index: number; power: EntryRow } | ActionResult {
  const atStand = powers.filter((row) => field(row, '所属机位') === stand)
  if (atStand.length === 0) {
    return {
      ok: false,
      message: `机位「${stand}」没有归属的地面电源台账，占用核验不通过，不能安排对接`,
    }
  }
  if (linkedCode) {
    const linked = powers.find((row) => field(row, '设备编号') === linkedCode)
    if (!linked || field(linked, '所属机位') !== stand) {
      return { ok: false, message: `关联电源「${linkedCode}」不在机位「${stand}」，占用核验不通过` }
    }
    const status = String(linked.status)
    if (status === '故障停用') {
      return { ok: false, message: `机位「${stand}」关联电源「${linkedCode}」故障停用，占用核验不通过` }
    }
    if (status === '供电中' && field(linked, '占用廊桥') !== bridgeCode) {
      return {
        ok: false,
        message: `关联电源「${linkedCode}」已被廊桥「${field(linked, '占用廊桥')}」占用，占用核验不通过`,
      }
    }
    if (!POWER_READY_STATUSES.includes(status) && status !== '供电中') {
      return { ok: false, message: `关联电源「${linkedCode}」当前为「${status}」，暂不可占用` }
    }
    return { index: powers.indexOf(linked), power: linked }
  }
  const occupant = atStand.find(
    (row) => String(row.status) === '供电中' && field(row, '占用廊桥') !== bridgeCode,
  )
  if (occupant) {
    return {
      ok: false,
      message: `机位「${stand}」的地面电源已被廊桥「${field(occupant, '占用廊桥')}」占用，占用核验不通过`,
    }
  }
  const ready = atStand.find((row) => POWER_READY_STATUSES.includes(String(row.status)))
  if (!ready) {
    return {
      ok: false,
      message: `机位「${stand}」没有可占用的地面电源（均在故障停用等不可用状态），占用核验不通过`,
    }
  }
  return { index: powers.indexOf(ready), power: ready }
}

// 对接队列专用动作入口：逐格推进的同时，同步廊桥台账与地面电源台账的占用核验。
export function runBridgeQueueAction(id: number, action: string): ActionResult {
  const meta = moduleMeta(QUEUE_KEY)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const queue = listRows(QUEUE_KEY)
  const index = queue.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const row = queue[index]
  const current = String(row.status)
  if (current === target) {
    return { ok: false, message: `廊桥对接安排已经是「${target}」，不用重复操作` }
  }
  const stepError = assertStrictStep(meta, current, target)
  if (stepError) {
    return stepError
  }

  const bridgeCode = field(row, '廊桥编号')
  const stand = field(row, '所属机位')
  const bridgeLedger = listRows(BRIDGE_KEY)
  const ledgerIndex = bridgeLedger.findIndex((item) => field(item, '廊桥编号') === bridgeCode)
  const powers = listRows(POWER_KEY)

  let linkedPowerCode = field(row, '关联电源')
  let dockedAt = field(row, '实际对接')
  let releasedAt = field(row, '脱离时间')
  const powerUpdates: number[] = []

  if (target === '已对接') {
    if (!stand) {
      return { ok: false, message: `廊桥「${bridgeCode}」缺机位归属，占用核验无法进行，请先补齐机位` }
    }
    const claim = claimPower(powers, stand, bridgeCode, linkedPowerCode)
    if ('ok' in claim) {
      return claim
    }
    const claimed = powers[claim.index]
    linkedPowerCode = field(claimed, '设备编号')
    dockedAt = timestamp(false)
    powerUpdates.push(claim.index)
    powers[claim.index] = {
      ...claimed,
      status: '供电中',
      pending: true,
      占用廊桥: bridgeCode,
      供电开始: dockedAt,
      供电结束: '',
      设备状态: '供电中',
    }
  } else if (target === '已脱离') {
    releasedAt = timestamp(false)
    if (linkedPowerCode) {
      const powerIndex = powers.findIndex((item) => field(item, '设备编号') === linkedPowerCode)
      if (powerIndex >= 0 && String(powers[powerIndex].status) === '供电中') {
        powerUpdates.push(powerIndex)
        powers[powerIndex] = {
          ...powers[powerIndex],
          status: '已断电',
          pending: false,
          占用廊桥: '',
          供电结束: releasedAt,
          设备状态: '已断电',
        }
      }
    }
  }

  const updatedQueueRow: EntryRow = {
    ...row,
    status: target,
    pending: target !== meta.statuses[meta.statuses.length - 1],
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
    关联电源: linkedPowerCode,
    实际对接: dockedAt,
    脱离时间: releasedAt,
  }
  const nextQueue = [...queue]
  nextQueue[index] = updatedQueueRow

  const nextLedger = [...bridgeLedger]
  if (ledgerIndex >= 0) {
    const ledgerRow = bridgeLedger[ledgerIndex]
    nextLedger[ledgerIndex] = {
      ...ledgerRow,
      status: target,
      pending: updatedQueueRow.pending,
      abnormal: updatedQueueRow.abnormal,
      所属机位: stand || field(ledgerRow, '所属机位'),
      对接机型: field(row, '对接机型') || field(ledgerRow, '对接机型'),
      调度人员: field(row, '调度人员') || field(ledgerRow, '调度人员'),
      关联电源: linkedPowerCode,
      计划对接: field(row, '计划对接'),
      实际对接: dockedAt,
      脱离时间: releasedAt,
      廊桥状态: target,
    }
  }

  saveRows(QUEUE_KEY, nextQueue)
  if (ledgerIndex >= 0) {
    saveRows(BRIDGE_KEY, nextLedger)
  }
  if (powerUpdates.length > 0) {
    saveRows(POWER_KEY, powers)
  }

  const suffix =
    target === '已对接'
      ? `，已同步占用地面电源「${linkedPowerCode}」`
      : target === '已脱离'
        ? linkedPowerCode
          ? `，地面电源「${linkedPowerCode}」已同步断电释放`
          : ''
        : ''
  return { ok: true, message: `廊桥「${bridgeCode}」已${action}，当前状态「${target}」${suffix}` }
}

// 台账页按廊桥编号找到在链路上的队列安排，动作都从队列发起。
export function activeQueueByBridge(bridgeCode: string): EntryRow | undefined {
  return listRows(QUEUE_KEY).find(
    (row) =>
      field(row, '廊桥编号') === bridgeCode &&
      ACTIVE_QUEUE_STATUSES.includes(String(row.status)),
  )
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
    lines.push([row.id, ...meta.fields.map((fieldName) => row[fieldName] ?? ''), row.status].join(','))
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
