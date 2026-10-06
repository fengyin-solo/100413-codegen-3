<template>
  <section class="page" data-module="bridge">
    <header class="page-head">
      <div>
        <h2>廊桥调度管理</h2>
        <p class="page-desc">对接队列按廊桥编号、所属机位、对接机型、调度人员管理；待对接→已对接→已脱离→故障停用只能逐格推进。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="showCreate = !showCreate">
          {{ showCreate ? '收起登记' : '排入对接队列' }}
        </button>
        <button class="btn" type="button" @click="exportRows">导出廊桥调度清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <form v-if="showCreate" class="create-panel" @submit.prevent="submitCreate">
      <template v-for="field in createFields" :key="field">
        <label v-if="field === '所属机位'" class="filter-item">
          <span>{{ field }}</span>
          <input v-model="createForm[field]" list="stand-options" placeholder="从机位台账选择或直接输入" />
        </label>
        <label v-else class="filter-item">
          <span>{{ field }}</span>
          <input v-model="createForm[field]" :placeholder="`请输入${field}`" />
        </label>
      </template>
      <button class="btn primary" type="submit">确认入队</button>
    </form>
    <datalist id="stand-options">
      <option v-for="code in standOptions" :key="code" :value="code" />
    </datalist>

    <section class="queue-panel">
      <h3>对接队列</h3>
      <div class="queue-cols">
        <div class="queue-col">
          <h4>待对接（{{ queue.waiting.length }}）· 按入队先后安排</h4>
          <ol v-if="queue.waiting.length" class="queue-list">
            <li v-for="row in queue.waiting" :key="`w-${String(row.id)}`">
              <span class="queue-no">#{{ row.id }} {{ row['廊桥编号'] }}</span>
              <span class="queue-meta">{{ row['所属机位'] }} · {{ row['对接机型'] }} · {{ row['调度人员'] }}</span>
              <span class="queue-time">计划 {{ row['计划对接'] || '未定' }}</span>
            </li>
          </ol>
          <p v-else class="queue-empty">队列暂无待对接廊桥</p>
        </div>
        <div class="queue-col">
          <h4>已对接 / 机位已锁定（{{ queue.locked.length }}）</h4>
          <ol v-if="queue.locked.length" class="queue-list">
            <li v-for="row in queue.locked" :key="`l-${String(row.id)}`">
              <span class="queue-no">{{ row['廊桥编号'] }}</span>
              <span class="queue-meta">{{ row['所属机位'] }} · {{ row['调度人员'] }}</span>
              <span class="queue-time">锁定于 {{ row['锁定时间'] || '—' }}</span>
            </li>
          </ol>
          <p v-else class="queue-empty">当前没有已对接廊桥</p>
        </div>
      </div>
    </section>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] === '' ? '—' : (row[column] ?? '—') }}</td>
          <td>
            {{ row.status }}
            <span v-if="row.abnormal" class="tag-abnormal">异常</span>
          </td>
          <td class="row-actions">
            <template v-if="actionsFor(row).length">
              <button
                v-for="action in actionsFor(row)"
                :key="action"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </template>
            <span v-else class="text-muted">无（环节已收尾）</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无廊桥调度数据，可先排入对接队列</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条廊桥调度记录 · 对接时同步核验同机位地面电源台账占用</span>
      <span v-if="message" :class="messageOk ? 'success-text' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  availableActions,
  bridgeQueue,
  downloadEntries,
  enqueueBridge,
  listEntries,
  moduleMeta,
  runBridgeAction,
} from '@/api/local-service'
import { listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('bridge')
const columns = ["廊桥编号", "所属机位", "对接机型", "调度人员", "计划对接", "锁定时间", "实际对接", "脱离时间", "电源核验", "廊桥状态"]
const filterFields = ["廊桥编号", "所属机位", "对接机型", "调度人员"]
const createFields = ["廊桥编号", "所属机位", "对接机型", "调度人员", "计划对接"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const message = ref('')
const messageOk = ref(false)
const filters = ref<Record<string, string>>({})
const showCreate = ref(false)
const createForm = reactive<Record<string, string>>(
  Object.fromEntries(createFields.map((field) => [field, ''])),
)
const queue = ref<{ waiting: EntryRow[]; locked: EntryRow[] }>({ waiting: [], locked: [] })
// 机位归属从机位分配台账取候选，避免录入与台账对不上的机位编号。
const standOptions = listRows('stand')
  .map((row) => String(row['机位编号'] ?? '').trim())
  .filter(Boolean)

const stats = computed(() => [
  { label: '待对接廊桥', value: rows.value.filter((row) => String(row.status) === '待对接').length },
  { label: '已对接廊桥', value: rows.value.filter((row) => String(row.status) === '已对接').length },
  { label: '故障廊桥', value: rows.value.filter((row) => String(row.status) === '故障停用').length },
])
const statusSummary = computed(() =>
  meta.statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function actionsFor(row: EntryRow): string[] {
  return availableActions(meta, String(row.status))
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function submitCreate() {
  const result = enqueueBridge({
    廊桥编号: createForm['廊桥编号'],
    所属机位: createForm['所属机位'],
    对接机型: createForm['对接机型'],
    调度人员: createForm['调度人员'],
    计划对接: createForm['计划对接'],
  })
  message.value = result.message
  messageOk.value = result.ok
  if (result.ok) {
    for (const field of createFields) {
      createForm[field] = ''
    }
    showCreate.value = false
    reload()
  }
}

function runAction(action: string, row: EntryRow) {
  message.value = ''
  const result = runBridgeAction(Number(row.id), action)
  message.value = result.message
  messageOk.value = result.ok
  if (result.ok) {
    reload()
  }
}

function reload() {
  message.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    queue.value = bridgeQueue()
  } catch (error) {
    message.value = error instanceof Error ? error.message : '廊桥调度列表读取失败'
    messageOk.value = false
  }
}

onMounted(reload)
</script>

<style scoped>
.create-panel {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: flex-end;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 12px;
}
.queue-panel {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
}
.queue-panel h3 { margin: 0 0 8px; font-size: 14px; }
.queue-cols { display: flex; gap: 12px; }
.queue-col { flex: 1; min-width: 0; }
.queue-col h4 { margin: 0 0 6px; font-size: 12px; color: var(--muted); font-weight: normal; }
.queue-list { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; }
.queue-list li { font-size: 13px; display: flex; gap: 8px; align-items: baseline; }
.queue-no { font-weight: 600; white-space: nowrap; }
.queue-meta { color: var(--muted); }
.queue-time { margin-left: auto; color: var(--muted); font-size: 12px; white-space: nowrap; }
.queue-empty { margin: 0; font-size: 12px; color: var(--muted); }
.tag-abnormal { background: #fef3f2; color: #b42318; border-radius: 4px; padding: 0 6px; font-size: 12px; margin-left: 4px; }
.text-muted { color: var(--muted); font-size: 12px; }
.success-text { color: #067647; }
</style>
