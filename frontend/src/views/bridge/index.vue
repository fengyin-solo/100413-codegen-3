<template>
  <section class="page" data-module="bridge">
    <header class="page-head">
      <div>
        <h2>廊桥调度管理</h2>
        <p class="page-desc">廊桥对接队列：按廊桥编号、所属机位、对接机型、调度人员锁定机位；状态只能逐格推进，对接时同步核验地面电源占用。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出对接队列清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-tip">既定环节：待对接 → 已对接 → 已脱离 → 故障停用，只能往下一格推进</span>
    </p>

    <form class="enroll-form" @submit.prevent="submitEnqueue">
      <span class="enroll-title">新增对接安排（入队即锁定机位）</span>
      <label class="filter-item">
        <span>廊桥编号 *</span>
        <input v-model="form.bridgeCode" list="bridge-code-list" placeholder="如 BRID-202" @change="prefillByBridge" />
        <datalist id="bridge-code-list">
          <option v-for="row in ledgerRows" :key="String(row.id)" :value="String(row['廊桥编号'])"></option>
        </datalist>
      </label>
      <label class="filter-item">
        <span>所属机位 *</span>
        <select v-model="form.stand">
          <option value="">请选择机位</option>
          <option v-for="row in standRows" :key="String(row.id)" :value="String(row['机位编号'])">
            {{ row['机位编号'] }}（{{ row['所属航站楼'] }}）
          </option>
        </select>
      </label>
      <label class="filter-item">
        <span>对接机型 *</span>
        <input v-model="form.aircraftType" list="aircraft-type-list" placeholder="如 A320neo" />
        <datalist id="aircraft-type-list">
          <option v-for="row in ledgerRows" :key="String(row.id) + '-type'" :value="String(row['对接机型'])"></option>
        </datalist>
      </label>
      <label class="filter-item">
        <span>调度人员 *</span>
        <input v-model="form.operator" list="operator-list" placeholder="安排人姓名" />
        <datalist id="operator-list">
          <option v-for="row in ledgerRows" :key="String(row.id) + '-op'" :value="String(row['调度人员'])"></option>
        </datalist>
      </label>
      <label class="filter-item">
        <span>关联地面电源</span>
        <input v-model="form.linkedPower" list="power-code-list" placeholder="留空则按机位自动匹配" />
        <datalist id="power-code-list">
          <option v-for="row in powerRows" :key="String(row.id)" :value="String(row['设备编号'])">
            {{ row['设备编号'] }} / {{ row['所属机位'] || '未归属机位' }}
          </option>
        </datalist>
      </label>
      <label class="filter-item">
        <span>计划对接</span>
        <input v-model="form.plannedDock" placeholder="YYYY-MM-DD HH:mm" />
      </label>
      <button class="btn primary" type="submit">入队锁定</button>
    </form>

    <h3 class="section-title">对接队列</h3>
    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in queueFilterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in queueColumns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>下一环节动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in queueRows" :key="'q' + String(row.id)">
          <td v-for="column in queueColumns" :key="column">{{ row[column] || '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-if="queueAction(row)"
              class="link"
              type="button"
              @click="runQueueAction(queueAction(row)!, row)"
            >
              {{ queueAction(row) }}
            </button>
            <span v-else class="muted-text">无</span>
          </td>
        </tr>
        <tr v-if="!queueRows.length">
          <td :colspan="queueColumns.length + 2" class="empty-state">对接队列暂无记录，可在上方入队</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">廊桥台账</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in ledgerColumns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>队列动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in ledgerRows" :key="'b' + String(row.id)">
          <td v-for="column in ledgerColumns" :key="column">{{ row[column] || '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-if="ledgerAction(row)"
              class="link"
              type="button"
              @click="runLedgerAction(ledgerAction(row)!, row)"
            >
              {{ ledgerAction(row) }}
            </button>
            <span v-else-if="String(row.status) === '故障停用'" class="muted-text">故障停用归档，保持原状态</span>
            <span v-else-if="String(row.status) === '已脱离'" class="muted-text">已脱离，可重新入队</span>
            <span v-else class="muted-text">无在队安排</span>
          </td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>队列共 {{ queueTotal }} 条安排 · 台账共 {{ ledgerRows.length }} 条廊桥</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="okMessage" class="ok-text">{{ okMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  activeQueueByBridge,
  downloadEntries,
  enqueueBridge,
  listEntries,
  moduleMeta,
  nextAction,
  runBridgeQueueAction,
} from '@/api/local-service'
import { listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('bridge')
const queueMeta = moduleMeta('bridge_queue')
const queueColumns = ['廊桥编号', '所属机位', '对接机型', '调度人员', '锁定时间', '关联电源', '计划对接', '实际对接', '脱离时间']
const ledgerColumns = ['廊桥编号', '所属机位', '对接机型', '调度人员', '关联电源', '计划对接', '实际对接', '脱离时间']
const queueFilterFields = ['廊桥编号', '所属机位', '调度人员']

const queueRows = ref<EntryRow[]>([])
const ledgerRows = ref<EntryRow[]>([])
const standRows = ref<EntryRow[]>([])
const powerRows = ref<EntryRow[]>([])
const queueTotal = ref(0)
const errorMessage = ref('')
const okMessage = ref('')
const filters = ref<Record<string, string>>({})
const form = reactive({
  bridgeCode: '',
  stand: '',
  aircraftType: '',
  operator: '',
  plannedDock: '',
  linkedPower: '',
})

const stats = computed(() => [
  { label: '待对接队列', value: countByStatus('待对接') },
  { label: '已对接队列', value: countByStatus('已对接') },
  { label: '已脱离', value: countByStatus('已脱离') },
  { label: '故障廊桥', value: countByStatus('故障停用') },
])

const statusSummary = computed(() =>
  queueMeta.statuses.map((status) => ({ status, count: countByStatus(status) })),
)

function countByStatus(status: string): number {
  return queueRows.value.filter((row) => String(row.status) === status).length
}

function queueAction(row: EntryRow): string | undefined {
  return nextAction(queueMeta, String(row.status))
}

function ledgerAction(row: EntryRow): string | undefined {
  const queued = activeQueueByBridge(String(row['廊桥编号'] ?? ''))
  return queued ? nextAction(queueMeta, String(queued.status)) : undefined
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(queueMeta.key)
}

// 选中已有廊桥时带出既有归属，减少重复录入；缺机位归属的存量记录这里不再补，按迁移补数为准。
function prefillByBridge() {
  const code = form.bridgeCode.trim()
  const row = ledgerRows.value.find((item) => String(item['廊桥编号']) === code)
  if (!row) return
  if (!form.stand && row['所属机位']) form.stand = String(row['所属机位'])
  if (!form.aircraftType && row['对接机型']) form.aircraftType = String(row['对接机型'])
  if (!form.linkedPower && row['关联电源']) form.linkedPower = String(row['关联电源'])
}

function submitEnqueue() {
  errorMessage.value = ''
  okMessage.value = ''
  const result = enqueueBridge({ ...form })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  okMessage.value = result.message
  form.bridgeCode = ''
  form.stand = ''
  form.aircraftType = ''
  form.operator = ''
  form.plannedDock = ''
  form.linkedPower = ''
  reload()
}

function runQueueAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  okMessage.value = ''
  const result = runBridgeQueueAction(Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  okMessage.value = result.message
  reload()
}

function runLedgerAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  okMessage.value = ''
  const queued = activeQueueByBridge(String(row['廊桥编号'] ?? ''))
  if (!queued) {
    errorMessage.value = '该廊桥没有在链路上的对接安排'
    return
  }
  const result = runBridgeQueueAction(Number(queued.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  okMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(queueMeta.key, filters.value)
    queueRows.value = payload.items
    queueTotal.value = payload.total
    ledgerRows.value = listEntries(meta.key).items
    standRows.value = listEntries('stand').items
    powerRows.value = listRows('ground_power')
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '廊桥调度数据读取失败'
  }
}

onMounted(reload)
</script>
