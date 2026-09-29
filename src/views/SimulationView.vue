<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useLinkageStore } from '../stores/linkage'
import { useSimulationStore } from '../stores/simulation'
import type { SimRow } from '../linkage/types'

const linkage = useLinkageStore()
const sim = useSimulationStore()

function deviceName(id: string) {
  return linkage.devices.find((device) => device.id === id)?.name ?? id
}
function deviceType(id: string) {
  return linkage.devices.find((device) => device.id === id)?.type ?? ''
}

// ---------------------------------------------------------------------------
// 播放循环（页面层负责计时；算法与状态都在 store / engine）
// ---------------------------------------------------------------------------

let rafId = 0
let lastFrame = 0

function tick(now: number) {
  if (!sim.playing || !sim.result) return
  if (!lastFrame) lastFrame = now
  const dt = (now - lastFrame) / 1000
  lastFrame = now
  const next = sim.currentTime + dt * sim.speed
  if (next >= sim.result.horizon) {
    sim.currentTime = sim.result.horizon
    sim.stopPlayback()
  } else {
    sim.currentTime = next
  }
  rafId = requestAnimationFrame(tick)
}

function togglePlay() {
  if (!sim.result || sim.stale) return
  if (sim.playing) {
    sim.stopPlayback()
  } else {
    if (sim.currentTime >= sim.result.horizon) sim.currentTime = 0
    lastFrame = 0
    sim.playing = true
    rafId = requestAnimationFrame(tick)
  }
}

watch(() => sim.playing, (playing) => {
  if (!playing) {
    cancelAnimationFrame(rafId)
    lastFrame = 0
  }
})
onBeforeUnmount(() => cancelAnimationFrame(rafId))

const progress = computed(() => (sim.result ? (sim.currentTime / sim.result.horizon) * 100 : 0))
const ticks = computed(() => {
  if (!sim.result) return [] as number[]
  return Array.from({ length: sim.result.horizon / 2 + 1 }, (_, index) => index * 2)
})

/** 等待状态首次显现的时刻：延时到期即开始等反馈；从未点燃的规则从头等待。 */
function appearTime(row: SimRow): number {
  if (row.fireAt !== null) return row.fireAt
  if (row.armedAt !== null) return row.armedAt + row.delay
  return 0
}

function rowVisible(row: SimRow) {
  return sim.currentTime >= appearTime(row)
}

function barStart(row: SimRow) {
  return row.armedAt ?? 0
}
function barEnd(row: SimRow) {
  return row.fireAt ?? sim.result?.horizon ?? 0
}

const TICK_WIDTH = 44 // 每秒 22px
const timelineWidth = computed(() => (sim.result ? sim.result.horizon * 22 + 80 : 0))
const labelWidth = 300
const playheadLeft = computed(() => labelWidth + sim.currentTime * 22)

const reachableEnabledCount = computed(() => {
  if (!sim.result) return 0
  return sim.result.rows.length + sim.result.blocked.length
})

const statusMeta: Record<SimRow['status'], { color: string; icon: string }> = {
  成功: { color: 'success', icon: 'mdi-check-circle-outline' },
  等待: { color: 'warning', icon: 'mdi-clock-outline' },
  拒动: { color: 'error', icon: 'mdi-close-circle-outline' },
}
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div>
        <p class="eyebrow">SCENARIO REHEARSAL / 联动推演</p>
        <h1>报警后的设备动作推演</h1>
        <p class="muted">选择报警点与故障设备，按启用规则、延时与优先级排出执行序列；故障设备拒动并阻断后续路径，联锁反馈未到则停在等待。</p>
      </div>
      <div class="actions">
        <v-btn variant="outlined" prepend-icon="mdi-grid-large" @click="$router.push('/matrix')">查看因果矩阵</v-btn>
        <v-btn color="primary" prepend-icon="mdi-play" :disabled="!sim.hasSelection || sim.stale" @click="sim.run()">开始推演</v-btn>
      </div>
    </div>

    <!-- 场景配置 -->
    <div class="setup-grid panel mb-3">
      <div class="setup-col">
        <div class="setup-head">
          <v-icon icon="mdi-bell-alert-outline" color="primary" />
          <div><strong>报警点</strong><small>t=0 同时报警，可多选</small></div>
          <v-chip size="x-small" variant="tonal">{{ sim.alarmIds.length }} 个</v-chip>
        </div>
        <div class="chip-box">
          <v-chip
            v-for="device in sim.alarmCandidates"
            :key="device.id"
            :color="sim.alarmIds.includes(device.id) ? 'primary' : undefined"
            :variant="sim.alarmIds.includes(device.id) ? 'flat' : 'outlined'"
            size="small"
            class="select-chip"
            @click="sim.toggleAlarm(device.id)"
          >
            {{ device.name }}
          </v-chip>
          <span v-if="sim.alarmCandidates.length === 0" class="muted">暂无可选报警设备</span>
        </div>
      </div>
      <v-divider vertical />
      <div class="setup-col">
        <div class="setup-head">
          <v-icon icon="mdi-tools" color="warning" />
          <div><strong>故障设备（拒动）</strong><small>动作设备无法执行，后续规则停推</small></div>
          <v-chip size="x-small" color="warning" variant="tonal">{{ sim.faultyIds.length }} 个</v-chip>
        </div>
        <div class="chip-box">
          <v-chip
            v-for="device in sim.faultCandidates"
            :key="device.id"
            :color="sim.faultyIds.includes(device.id) ? 'warning' : undefined"
            :variant="sim.faultyIds.includes(device.id) ? 'flat' : 'outlined'"
            size="small"
            class="select-chip"
            @click="sim.toggleFault(device.id)"
          >
            {{ device.name }}
          </v-chip>
          <span v-if="sim.faultCandidates.length === 0" class="muted">暂无可选动作设备</span>
        </div>
      </div>
    </div>

    <v-alert
      v-if="sim.stale"
      type="error"
      variant="tonal"
      density="compact"
      class="mb-3"
      prepend-icon="mdi-alert-octagon-outline"
    >
      规则或设备配置已改动，当前时间轴是旧结果。已自动暂停，请
      <strong>重新开始推演</strong>
      后再播放。
      <template #append>
        <v-btn size="small" variant="tonal" color="primary" @click="sim.run()">重新推演</v-btn>
      </template>
    </v-alert>

    <template v-if="sim.result">
      <!-- 播放控制 -->
      <div class="player panel mb-3" :class="{ stale: sim.stale }">
        <v-btn
          :icon="sim.playing ? 'mdi-pause' : 'mdi-play'"
          :color="sim.playing ? 'warning' : 'primary'"
          variant="tonal"
          :disabled="sim.stale"
          @click="togglePlay"
        />
        <v-btn icon="mdi-stop" variant="tonal" :disabled="sim.stale" @click="sim.resetPlayhead()" />
        <div class="time-readout mono">T+{{ sim.currentTime.toFixed(1) }}s <small>/ {{ sim.result.horizon }}s</small></div>
        <v-progress-linear :model-value="progress" color="primary" height="6" rounded class="time-progress" />
        <v-select
          v-model="sim.speed"
          :items="[1, 2, 4, 8]"
          label="倍速"
          density="compact"
          hide-details
          style="max-width: 96px"
        />
        <v-divider vertical class="mx-2" />
        <v-chip size="small" color="success" variant="tonal" prepend-icon="mdi-check-circle-outline">{{ sim.result.counts.success }} 成功</v-chip>
        <v-chip size="small" color="warning" variant="tonal" prepend-icon="mdi-clock-outline">{{ sim.result.counts.waiting }} 等待</v-chip>
        <v-chip size="small" color="error" variant="tonal" prepend-icon="mdi-close-circle-outline">{{ sim.result.counts.refusal }} 拒动</v-chip>
        <v-chip size="small" color="grey" variant="tonal" prepend-icon="mdi-call-split">{{ sim.result.counts.blocked }} 阻断</v-chip>
      </div>

      <!-- 时间轴 -->
      <div class="panel mb-3 timeline-panel" :class="{ stale: sim.stale }">
        <div class="panel-head">
          <h3>执行时间轴</h3>
          <div class="legend">
            <span><i class="dot success" />成功</span>
            <span><i class="dot waiting" />等待联锁</span>
            <span><i class="dot refusal" />拒动</span>
            <span class="muted legend-hint">灰段为延时/排队中</span>
          </div>
        </div>
        <div class="timeline-scroll">
          <div class="timeline" :style="{ width: `${timelineWidth}px` }">
            <!-- 标尺 -->
            <div class="ruler" :style="{ paddingLeft: `${labelWidth}px` }">
              <span v-for="tick in ticks" :key="tick" class="ruler-tick" :style="{ left: `${tick * 22}px` }">{{ tick }}s</span>
            </div>

            <!-- 报警行 -->
            <div class="tl-row alarm-row">
              <div class="tl-label" :style="{ width: `${labelWidth}px` }">
                <v-icon size="15" icon="mdi-bell-ring-outline" color="primary" />
                <span>报警触发 · {{ sim.result.alarms.length }} 点</span>
              </div>
              <div class="tl-track">
                <div class="alarm-pills">
                  <v-chip
                    v-for="alarm in sim.result.alarms"
                    :key="alarm.deviceId"
                    size="x-small"
                    color="primary"
                    variant="flat"
                  >
                    {{ deviceName(alarm.deviceId) }}
                  </v-chip>
                </div>
              </div>
            </div>

            <v-divider />

            <!-- 规则行 -->
            <div v-for="row in sim.result.rows" :key="row.ruleId" class="tl-row" :class="['status-' + row.status, { 'hidden-event': !rowVisible(row) }]">
              <div class="tl-label" :style="{ width: `${labelWidth}px` }">
                <v-icon size="15" :icon="statusMeta[row.status].icon" :color="statusMeta[row.status].color" />
                <div class="label-text">
                  <strong>
                    <v-chip v-if="row.synthetic" size="x-small" color="error" variant="tonal" class="me-1">故障根因</v-chip>
                    <template v-else>{{ row.ruleId }} · </template>{{ deviceName(row.actionId) }}
                  </strong>
                  <small>
                    {{ deviceName(row.triggerId) }} → {{ deviceType(row.actionId) }}
                    · 延时 {{ row.delay }}s · P{{ row.priority }}
                    <template v-if="row.interlock !== '无'"> · 联锁：{{ row.interlock }}</template>
                  </small>
                </div>
              </div>
              <div class="tl-track">
                <!-- 灰段：延时 / 排队 / 等反馈区间 -->
                <div
                  v-if="barEnd(row) > barStart(row)"
                  class="seg seg-delay"
                  :class="{ 'seg-waiting': row.status === '等待' }"
                  :style="{ left: `${barStart(row) * 22}px`, width: `${(barEnd(row) - barStart(row)) * 22}px` }"
                />
                <!-- 结果标记 -->
                <div
                  class="marker"
                  :class="'marker-' + row.status"
                  :style="{ left: `${(row.fireAt ?? (row.armedAt !== null ? row.armedAt + row.delay : 0)) * 22}px` }"
                >
                  <v-icon size="13" :icon="statusMeta[row.status].icon" />
                  <span class="marker-time">{{ row.fireAt !== null ? `${row.fireAt}s` : row.armedAt !== null ? `${row.armedAt + row.delay}s 起等待` : '等待前级' }}</span>
                </div>
              </div>
            </div>

            <!-- 播放头 -->
            <div class="playhead" :style="{ left: `${playheadLeft}px` }"><span class="playhead-time">{{ sim.currentTime.toFixed(1) }}s</span></div>
          </div>
        </div>
        <div v-if="reachableEnabledCount === 0" class="empty-timeline muted">
          选中的报警点在启用规则下没有任何可达动作——检查规则是否停用，或报警点是否未配置联动。
        </div>
      </div>

      <!-- 阻断路径 -->
      <div v-if="sim.result.blocked.length" class="panel mb-3 blocked-panel">
        <div class="panel-head">
          <h3>故障阻断路径</h3>
          <v-chip size="small" color="error" variant="tonal">{{ sim.result.blocked.length }} 条规则停止推进</v-chip>
        </div>
        <div class="blocked-list">
          <article v-for="item in sim.result.blocked" :key="item.ruleId">
            <v-icon icon="mdi-call-split" color="error" />
            <div class="blocked-body">
              <strong>{{ item.ruleId }} · {{ deviceName(item.actionId) }}</strong>
              <p>{{ item.detail }}</p>
            </div>
            <v-chip size="small" color="error" variant="outlined">{{ item.reason }}</v-chip>
          </article>
        </div>
      </div>

      <!-- 执行序列明细表 -->
      <div class="panel seq-panel">
        <div class="panel-head"><h3>执行序列明细</h3><span class="muted">按动作时刻、优先级排序</span></div>
        <v-table density="compact" class="seq-table">
          <thead>
            <tr><th>时刻</th><th>规则</th><th>触发点位</th><th>动作设备</th><th>延时</th><th>优先级</th><th>联锁条件</th><th>状态</th><th>说明</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in sim.result.rows" :key="row.ruleId" :class="['row-' + row.status, { 'dim-row': !rowVisible(row) }]">
              <td class="mono">
                <template v-if="row.fireAt !== null">T+{{ row.fireAt }}s</template>
                <v-chip v-else size="x-small" color="warning" variant="tonal">∞ 等待</v-chip>
              </td>
              <td><strong>{{ row.ruleId }}</strong><v-chip v-if="row.synthetic" size="x-small" color="error" variant="tonal" class="ms-1">故障根因</v-chip></td>
              <td>{{ deviceName(row.triggerId) }}</td>
              <td>{{ deviceName(row.actionId) }}</td>
              <td>{{ row.delay }}s</td>
              <td>P{{ row.priority }}</td>
              <td>{{ row.interlock }}</td>
              <td><v-chip size="x-small" :color="statusMeta[row.status].color" variant="tonal" :prepend-icon="statusMeta[row.status].icon">{{ row.status }}</v-chip></td>
              <td class="note-cell">{{ row.note }}</td>
            </tr>
          </tbody>
        </v-table>
      </div>
    </template>

    <div v-else class="panel empty-state">
      <v-icon icon="mdi-timeline-play-outline" size="52" color="primary" />
      <h3>还没有推演结果</h3>
      <p>选择至少一个报警点（可再勾选故障设备），点击“开始推演”生成带时刻的执行序列。</p>
    </div>
  </section>
</template>

<style scoped>
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.setup-grid { display: grid; grid-template-columns: minmax(0, 1fr) 1px minmax(0, 1fr); align-items: stretch; }
.setup-col { padding: 14px 18px; }
.setup-head { display: flex; align-items: center; gap: 9px; margin-bottom: 10px; }
.setup-head strong { display: block; font-size: 13px; }
.setup-head small { display: block; color: #7c888e; font-size: 10px; margin-top: 2px; }
.chip-box { display: flex; flex-wrap: wrap; gap: 7px; }
.select-chip { cursor: pointer; }

.player { display: flex; align-items: center; gap: 10px; padding: 10px 14px; }
.player.stale { opacity: .65; }
.time-readout { min-width: 96px; font-weight: 800; color: #2b4249; }
.time-readout small { color: #8a969c; font-weight: 500; }
.time-progress { flex: 1; min-width: 110px; }

.timeline-panel.stale { opacity: .62; }
.legend { display: flex; align-items: center; gap: 14px; font-size: 11px; color: #55646b; }
.legend .dot { display: inline-block; width: 9px; height: 9px; margin-right: 5px; border-radius: 50%; }
.dot.success { background: #39785f; }
.dot.waiting { background: #d28a2d; }
.dot.refusal { background: #c53b2a; }
.legend-hint { font-size: 10px; }

.timeline-scroll { overflow-x: auto; }
.timeline { position: relative; padding: 8px 0 14px; }
.ruler { position: relative; height: 22px; margin-bottom: 4px; }
.ruler-tick { position: absolute; top: 0; color: #8a969c; font-size: 10px; transform: translateX(-50%); }
.ruler-tick::after { content: ''; position: absolute; left: 50%; top: 13px; width: 1px; height: 6px; background: #cdd5d7; }

.tl-row { display: flex; align-items: center; min-height: 42px; border-bottom: 1px solid #eef1f1; }
.tl-row.status-拒动 { background: #fdf4f2; }
.tl-row.status-等待 { background: #fdf8ef; }
.tl-label { display: flex; align-items: center; gap: 8px; padding: 0 12px; flex-shrink: 0; }
.label-text { min-width: 0; }
.label-text strong { display: block; font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.label-text small { display: block; color: #828e94; font-size: 9.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 250px; }
.tl-track { position: relative; flex: 1; height: 100%; min-height: 42px; }

.alarm-row { min-height: 36px; background: #f4f8f8; }
.alarm-row .tl-track { display: flex; align-items: center; min-height: 36px; }
.alarm-pills { position: absolute; left: 4px; display: flex; gap: 4px; flex-wrap: wrap; }

.seg { position: absolute; top: 50%; height: 6px; transform: translateY(-50%); border-radius: 3px; }
.seg-delay { background: #c4cdd0; }
.seg-waiting { background: repeating-linear-gradient(90deg, #e2aa5b 0 6px, transparent 6px 11px); }

.marker { position: absolute; top: 50%; transform: translate(-50%, -50%); display: flex; align-items: center; gap: 2px; white-space: nowrap; }
.marker .v-icon { border-radius: 50%; background: white; }
.marker-time { font-size: 9.5px; font-weight: 700; color: #55646b; }
.marker-成功 .v-icon { color: #2f7a5f; }
.marker-拒动 .v-icon { color: #c53b2a; }
.marker-等待 .v-icon { color: #d28a2d; }

.tl-row.hidden-event { opacity: .28; }
.dim-row { opacity: .35; }

.playhead { position: absolute; top: 26px; bottom: 0; width: 0; border-left: 2px solid #a33a2a; pointer-events: none; z-index: 5; }
.playhead-time { position: absolute; top: -16px; left: 3px; font-size: 9.5px; font-weight: 800; color: #a33a2a; white-space: nowrap; }

.empty-timeline { padding: 18px; text-align: center; font-size: 12px; }

.blocked-list { padding: 8px 16px 14px; }
.blocked-list article { display: grid; grid-template-columns: 24px 1fr auto; gap: 10px; align-items: center; padding: 11px 0; border-bottom: 1px solid #f1e7e4; }
.blocked-body strong { font-size: 12.5px; }
.blocked-body p { margin: 3px 0 0; color: #7a5a54; font-size: 11.5px; }

.seq-panel { overflow-x: auto; }
.seq-table :deep(table) { min-width: 980px; }
.mono { color: #267078; font-family: ui-monospace, monospace; font-weight: 700; white-space: nowrap; }
.row-拒动 { background: #fdf6f4; }
.row-等待 td { color: #8a6a35; }
.note-cell { color: #67747b; font-size: 11.5px; min-width: 240px; }

.empty-state { display: grid; justify-items: center; gap: 8px; padding: 56px 20px; text-align: center; }
.empty-state h3 { margin: 4px 0 0; }
.empty-state p { margin: 0; max-width: 420px; color: #78848a; font-size: 12.5px; }
</style>
