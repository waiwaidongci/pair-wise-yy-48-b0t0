<script setup lang="ts">
import { computed, onUnmounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useLinkageStore } from '../stores/linkage'
import { useSimulationStore } from '../stores/simulation'
import { formatClock, type SimStep } from '../linkage/engine'

const linkage = useLinkageStore()
const sim = useSimulationStore()
const { alarmIds, faultIds, result, cursor, playing, speed, stale } = storeToRefs(sim)

onUnmounted(() => sim.stop())

const deviceMap = computed(() => new Map(linkage.devices.map((device) => [device.id, device])))
function deviceName(id: string) {
  return deviceMap.value.get(id)?.name ?? id
}

/** 播放游标下步骤呈现的状态：未到 / 延时中 / 联锁等待 / 最终态 */
type Phase = '未到' | '延时中' | '等待' | '成功' | '拒动'
function phaseAt(step: SimStep): Phase {
  const t = cursor.value
  if (step.resolvedAt !== null && t >= step.resolvedAt) return step.status
  if (step.time > t) return '未到'
  if (step.resolvedAt === null && step.status === '等待') return '等待'
  return '延时中'
}

const phaseMeta: Record<Phase, { color: string; icon: string; label: string }> = {
  未到: { color: '#9aa7ac', icon: 'mdi-clock-outline', label: '未到时刻' },
  延时中: { color: '#3f6f8f', icon: 'mdi-timer-sand', label: '延时中' },
  等待: { color: '#c98a1e', icon: 'mdi-pause-circle-outline', label: '等待联锁反馈' },
  成功: { color: '#2f8f5b', icon: 'mdi-check-circle-outline', label: '动作成功' },
  拒动: { color: '#c1452f', icon: 'mdi-alert-octagon-outline', label: '拒动 / 阻断' },
}

const visibleLogs = computed(() => result.value?.logs.filter((item) => item.at <= cursor.value) ?? [])

const tickMarks = computed(() => {
  const total = sim.duration
  if (!total) return [0]
  const marks: number[] = []
  for (let t = 0; t <= total; t += 1) marks.push(t)
  return marks
})

function leftPct(at: number) {
  const total = sim.duration || 0
  return total ? Math.min(100, (at / total) * 100) : 0
}

function devicePhaseAt(deviceId: string) {
  const state = result.value?.deviceStates.find((item) => item.deviceId === deviceId)
  if (!state) return null
  if (state.at !== null && state.at > cursor.value) return { ...state, shown: '未到' as const }
  return { ...state, shown: state.state }
}
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div>
        <p class="eyebrow">SCENARIO REHEARSAL / 联动推演</p>
        <h1>报警之后，设备会怎样动作</h1>
        <p class="muted">选报警点和故障设备，按启用规则排出带时刻的执行序列；故障记拒动、下游规则停摆，等联锁反馈的挂起等待，其余按延时和优先级推进。</p>
      </div>
      <v-chip variant="tonal" prepend-icon="mdi-play-circle-outline">时间轴推演</v-chip>
    </div>

    <div class="setup-grid">
      <!-- 情景配置 -->
      <section class="panel setup-panel">
        <div class="panel-head"><h3>① 设定推演情景</h3><span class="muted">仅取启用规则</span></div>
        <div class="setup-body">
          <div class="pick-group">
            <div class="pick-title"><v-icon size="16" icon="mdi-fire" />报警点（可多选）</div>
            <div class="chip-row">
              <v-chip
                v-for="device in sim.alarmCandidates" :key="device.id"
                size="small" :color="alarmIds.includes(device.id) ? 'error' : undefined"
                :variant="alarmIds.includes(device.id) ? 'flat' : 'outlined'"
                @click="sim.toggleAlarm(device.id)"
              >{{ device.name }}</v-chip>
            </div>
          </div>
          <div class="pick-group">
            <div class="pick-title"><v-icon size="16" icon="mdi-tools" />故障 / 离线设备（动作记拒动）</div>
            <div class="chip-row">
              <v-chip
                v-for="device in sim.faultCandidates" :key="device.id"
                size="small" :color="faultIds.includes(device.id) ? 'warning' : undefined"
                :variant="faultIds.includes(device.id) ? 'flat' : 'outlined'"
                @click="sim.toggleFault(device.id)"
              >{{ device.name }}</v-chip>
            </div>
          </div>
          <div class="setup-actions">
            <v-btn color="primary" prepend-icon="mdi-play" :disabled="!alarmIds.length" @click="sim.run">开始推演</v-btn>
            <v-btn variant="text" prepend-icon="mdi-refresh" @click="sim.resetSelection">清空情景</v-btn>
          </div>
        </div>
      </section>

      <!-- 结果概览 -->
      <section class="panel stats-panel">
        <div class="panel-head"><h3>② 推演结果</h3><span v-if="result" class="muted">序列止于 {{ formatClock(sim.duration) }}</span></div>
        <div v-if="!result" class="empty-hint">
          <v-icon size="30" icon="mdi-clipboard-play-outline" />
          <p>选择报警点后开始推演，执行序列将显示在这里</p>
        </div>
        <div v-else class="stat-grid">
          <div class="stat success"><strong>{{ result.stats.success }}</strong><span>成功到位</span></div>
          <div class="stat waiting"><strong>{{ result.stats.waiting }}</strong><span>等待反馈</span></div>
          <div class="stat rejected"><strong>{{ result.stats.rejected }}</strong><span>拒动 / 阻断</span></div>
        </div>
      </section>
    </div>

    <v-alert v-if="stale" type="warning" variant="tonal" density="comfortable" class="mb-3" border="start">
      <strong>规则或台账已改动，当前时间轴是旧结果。</strong>
      延时、互锁、优先级、启停或设备变化都会使旧推演失效，请重新推演。
      <template #append>
        <v-btn size="small" color="warning" variant="tonal" @click="sim.run">重新推演</v-btn>
      </template>
    </v-alert>

    <template v-if="result">
      <!-- 播放器 -->
      <section class="panel player">
        <div class="player-controls">
          <v-btn :icon="playing ? 'mdi-pause' : 'mdi-play'" :color="stale ? undefined : 'primary'" variant="tonal" :disabled="stale" @click="playing ? sim.stop() : sim.play()" />
          <v-btn icon="mdi-stop" variant="text" @click="sim.stop(); sim.seek(0)" />
          <span class="clock">{{ formatClock(cursor) }}</span>
          <v-slider :model-value="cursor" min="0" :max="sim.duration || 0.01" step="0.1" color="primary" hide-details class="timeline-slider" @update:model-value="sim.seek(Number($event))" @start="sim.stop" />
          <v-btn-group variant="outlined" density="compact" divided>
            <v-btn v-for="option in [1, 2, 5]" :key="option" :variant="speed === option ? 'tonal' : 'outlined'" @click="speed = option">{{ option }}x</v-btn>
          </v-btn-group>
        </div>

        <div class="legend">
          <span v-for="meta in [phaseMeta['成功'], phaseMeta['等待'], phaseMeta['延时中'], phaseMeta['拒动']]" :key="meta.label">
            <i :style="{ background: meta.color }" />{{ meta.label }}
          </span>
        </div>

        <!-- 时间轴泳道 -->
        <div class="lanes" v-if="result.steps.length">
          <div class="lane-axis">
            <span v-for="tick in tickMarks" :key="tick" :style="{ left: `${leftPct(tick)}%` }">{{ tick }}s</span>
          </div>
          <div v-for="step in result.steps" :key="step.ruleId" class="lane" :class="{ dimmed: phaseAt(step) === '未到' }">
            <div class="lane-label">
              <strong>{{ step.ruleId }}</strong>
              <small>{{ deviceName(step.actionId) }}</small>
            </div>
            <div class="lane-track">
              <!-- 等待挂起段（斜纹，延伸到时间轴末端） -->
              <div
                v-if="step.status === '等待' && step.resolvedAt === null && cursor >= step.time"
                class="bar wait-open"
                :style="{ left: `${leftPct(step.time)}%`, width: `${100 - leftPct(step.time)}%` }"
              />
              <!-- 延时 / 推进段 -->
              <div
                v-if="step.resolvedAt !== null"
                class="bar"
                :class="phaseAt(step) === '成功' ? 'ok' : phaseAt(step) === '拒动' ? 'bad' : 'pending'"
                :style="{ left: `${leftPct(step.time)}%`, width: `${Math.max(1.2, leftPct(step.resolvedAt) - leftPct(step.time))}%` }"
              />
              <!-- 等待后成功的挂起段 -->
              <div
                v-if="step.status === '成功' && step.resolvedAt !== null && cursor < step.resolvedAt && cursor >= step.time"
                class="bar wait-open"
                :style="{ left: `${leftPct(step.time)}%`, width: `${Math.max(1.2, leftPct(Math.min(cursor, step.resolvedAt)) - leftPct(step.time))}%` }"
              />
              <span
                v-if="step.resolvedAt !== null && cursor >= step.resolvedAt"
                class="lane-dot"
                :class="step.status === '成功' ? 'ok' : 'bad'"
                :style="{ left: `calc(${leftPct(step.resolvedAt)}% - 5px)` }"
              />
              <span
                v-if="step.status === '等待' && step.resolvedAt === null"
                class="lane-dot waiting"
                :style="{ left: `calc(${leftPct(step.time)}% - 5px)` }"
              />
              <v-icon
                v-if="phaseAt(step) !== '未到'"
                size="13"
                class="lane-icon"
                :style="{ color: phaseMeta[phaseAt(step)].color, left: `${leftPct(step.resolvedAt ?? (step.status === '等待' ? step.time : cursor))}%` }"
              >{{ phaseMeta[phaseAt(step)].icon }}</v-icon>
            </div>
          </div>
          <!-- 播放头 -->
          <div class="playhead" :style="{ left: `calc(170px + (100% - 170px) * ${sim.duration ? cursor / sim.duration : 0})` }" />
        </div>
        <v-alert v-else type="info" variant="tonal" density="compact" class="m-3">该报警点当前没有启用的联动规则，推演序列为空。</v-alert>
      </section>

      <div class="detail-grid">
        <!-- 执行序列表 -->
        <section class="panel">
          <div class="panel-head"><h3>③ 带时刻执行序列</h3><span class="muted">同刻按优先级 1 → 3 推进</span></div>
          <v-table density="compact" class="seq-table">
            <thead><tr><th>时刻</th><th>规则</th><th>触发 → 动作</th><th>延时</th><th>联锁反馈</th><th>状态</th></tr></thead>
            <tbody>
              <tr v-for="step in result.steps" :key="step.ruleId" :class="['phase-row', `is-${phaseAt(step)}`]">
                <td class="mono">{{ step.resolvedAt !== null && cursor >= step.resolvedAt ? formatClock(step.resolvedAt) : step.time <= cursor ? `${formatClock(step.time)} →` : '—' }}</td>
                <td><strong>{{ step.ruleId }}</strong><small class="prio">P{{ step.priority }}</small></td>
                <td>
                  <span class="muted">{{ deviceName(step.triggerId) }}</span>
                  <v-icon size="12" icon="mdi-arrow-right" />
                  <strong>{{ deviceName(step.actionId) }}</strong>
                </td>
                <td>{{ step.delay }}s</td>
                <td class="interlock-cell">
                  <v-icon v-if="step.interlock !== '无'" size="13" icon="mdi-link-variant" />
                  {{ step.interlock === '无' ? '—' : step.interlock }}
                </td>
                <td>
                  <v-chip size="small" density="compact" :color="phaseMeta[phaseAt(step)].color.includes('#') ? undefined : phaseMeta[phaseAt(step)].color" :style="{ background: `${phaseMeta[phaseAt(step)].color}1f`, color: phaseMeta[phaseAt(step)].color }" :prepend-icon="phaseMeta[phaseAt(step)].icon">
                    {{ phaseAt(step) }}
                  </v-chip>
                  <small class="detail-line">{{ step.detail }}</small>
                </td>
              </tr>
            </tbody>
          </v-table>
        </section>

        <!-- 设备终态 + 事件日志 -->
        <aside class="side-col">
          <section class="panel">
            <div class="panel-head"><h3>设备状态（当前播放时刻）</h3></div>
            <div class="device-state-list">
              <div v-for="ds in result.deviceStates" :key="ds.deviceId" class="ds-row" :class="{ future: devicePhaseAt(ds.deviceId)?.shown === '未到' }">
                <span class="ds-dot" :class="devicePhaseAt(ds.deviceId)?.shown" />
                <div>
                  <strong>{{ deviceName(ds.deviceId) }}</strong>
                  <small>{{ ds.reason }}<template v-if="ds.at !== null"> · {{ formatClock(ds.at) }}</template></small>
                </div>
              </div>
            </div>
          </section>
          <section class="panel">
            <div class="panel-head"><h3>事件日志</h3><span class="muted">{{ visibleLogs.length }} 条</span></div>
            <div class="log-list">
              <div v-for="(entry, index) in visibleLogs" :key="index" class="log-line" :class="entry.level">
                <span class="mono">{{ formatClock(entry.at) }}</span>{{ entry.text }}
              </div>
              <p v-if="!visibleLogs.length" class="muted log-empty">按播放后查看事件</p>
            </div>
          </section>
        </aside>
      </div>
    </template>
  </section>
</template>

<style scoped>
.setup-grid { display: grid; grid-template-columns: minmax(0,1.4fr) minmax(0,1fr); gap: 14px; margin-bottom: 14px; }
.setup-body { padding: 14px 16px 16px; display: grid; gap: 14px; }
.pick-title { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; font-size: 12px; font-weight: 700; color: #45545a; }
.chip-row { display: flex; flex-wrap: wrap; gap: 6px; }
.setup-actions { display: flex; gap: 8px; padding-top: 4px; border-top: 1px solid #eef1f1; }
.stats-panel .empty-hint { display: grid; place-items: center; padding: 26px 16px; color: #93a2a8; text-align: center; }
.empty-hint p { margin: 8px 0 0; font-size: 12px; }
.stat-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 10px; padding: 16px; }
.stat { padding: 14px 10px; border-radius: 9px; text-align: center; border: 1px solid; }
.stat strong { display: block; font-size: 26px; }
.stat span { font-size: 11px; color: #6d7a80; }
.stat.success { background: #eef8f2; border-color: #bfe2cd; } .stat.success strong { color: #2f8f5b; }
.stat.waiting { background: #fdf6e8; border-color: #ecd4a4; } .stat.waiting strong { color: #b97f16; }
.stat.rejected { background: #fdf0ed; border-color: #efc3ba; } .stat.rejected strong { color: #c1452f; }

.player { margin-bottom: 14px; }
.player-controls { display: flex; align-items: center; gap: 12px; padding: 12px 16px 4px; }
.clock { min-width: 64px; font-family: ui-monospace,monospace; font-weight: 700; color: #2d5f66; }
.timeline-slider { flex: 1; }
.legend { display: flex; gap: 16px; padding: 0 16px 8px; font-size: 11px; color: #66747a; }
.legend i { display: inline-block; width: 9px; height: 9px; margin-right: 5px; border-radius: 2px; }

.lanes { position: relative; margin: 4px 16px 16px; border: 1px solid #e6eaea; border-radius: 8px; background: #fbfcfc; overflow: hidden; }
.lane-axis { position: relative; height: 20px; margin-left: 170px; border-bottom: 1px solid #e6eaea; }
.lane-axis span { position: absolute; top: 3px; transform: translateX(-50%); font-size: 9px; color: #93a1a7; }
.lane { display: grid; grid-template-columns: 170px 1fr; align-items: center; min-height: 34px; border-bottom: 1px solid #f0f3f3; }
.lane:last-child { border-bottom: none; }
.lane.dimmed { opacity: .45; }
.lane-label { padding: 4px 10px; border-right: 1px solid #e6eaea; }
.lane-label strong { display: block; font-size: 11px; color: #34474e; }
.lane-label small { display: block; font-size: 9px; color: #8a979c; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lane-track { position: relative; height: 100%; min-height: 34px; }
.bar { position: absolute; top: 11px; height: 8px; border-radius: 4px; min-width: 3px; }
.bar.ok { background: #2f8f5b; }
.bar.bad { background: #c1452f; }
.bar.pending { background: #8fb6c9; }
.bar.wait-open { background: repeating-linear-gradient(-45deg, #e6b765 0 5px, #fdf6e8 5px 10px); border: 1px dashed #d39a3e; border-radius: 4px; }
.lane-dot { position: absolute; top: 9px; width: 12px; height: 12px; border-radius: 50%; border: 2px solid white; box-shadow: 0 0 0 1px #c5cfd2; }
.lane-dot.ok { background: #2f8f5b; } .lane-dot.bad { background: #c1452f; } .lane-dot.waiting { background: #d39a3e; }
.lane-icon { position: absolute; top: 10px; transform: translateX(-50%); }
.playhead { position: absolute; top: 0; bottom: 0; width: 2px; background: #2d5f66; opacity: .55; pointer-events: none; }

.detail-grid { display: grid; grid-template-columns: minmax(0,1.5fr) minmax(300px,1fr); gap: 14px; align-items: start; }
.seq-table td { vertical-align: top; }
.prio { margin-left: 6px; padding: 1px 5px; border-radius: 4px; background: #e8eef0; color: #5a6b72; font-size: 9px; }
.interlock-cell { font-size: 11px; color: #8a5c1e; white-space: nowrap; }
.detail-line { display: block; margin-top: 3px; color: #849096; font-size: 10px; max-width: 280px; }
.phase-row.is-未到 { opacity: .42; }
.phase-row.is-延时中 td { background: #f3f8fb; }
.phase-row.is-等待 td { background: #fdf8ee; }
.phase-row.is-拒动 td { background: #fdf1ee; }
.mono { font-family: ui-monospace,monospace; }

.side-col { display: grid; gap: 14px; }
.device-state-list { padding: 8px 14px 12px; }
.ds-row { display: flex; gap: 10px; align-items: flex-start; padding: 9px 0; border-bottom: 1px solid #f0f3f3; }
.ds-row:last-child { border-bottom: none; }
.ds-row.future { opacity: .45; }
.ds-dot { width: 10px; height: 10px; margin-top: 5px; border-radius: 50%; flex: none; }
.ds-dot.报警 { background: #d1443a; } .ds-dot.成功 { background: #2f8f5b; }
.ds-dot.拒动 { background: #c1452f; } .ds-dot.未触发 { background: #c3cccf; }
.ds-row strong { display: block; font-size: 12px; }
.ds-row small { display: block; color: #849096; font-size: 10px; margin-top: 2px; }
.log-list { max-height: 260px; overflow: auto; padding: 10px 14px 14px; display: grid; gap: 6px; }
.log-line { display: flex; gap: 8px; font-size: 11px; padding-left: 8px; border-left: 2px solid #d7e0e2; color: #45545a; }
.log-line .mono { color: #7d8b91; min-width: 44px; }
.log-line.success { border-color: #2f8f5b; } .log-line.wait { border-color: #d39a3e; }
.log-line.error { border-color: #c1452f; color: #a63624; }
.log-empty { margin: 6px 0; font-size: 11px; }

@media (max-width: 1100px) { .setup-grid, .detail-grid { grid-template-columns: 1fr; } }
</style>
