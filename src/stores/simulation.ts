import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { buildSimulationSignature, runSimulation } from '../linkage/engine'
import type { SimulationResult } from '../linkage/types'
import { ALARM_DEVICE_TYPES } from '../linkage/types'
import { useLinkageStore } from './linkage'

// 推演状态仓库：只保存“选择 / 结果 / 播放时刻”，不含任何推演算法（算法在 src/linkage/engine.ts）。
export const useSimulationStore = defineStore('simulation', () => {
  const linkage = useLinkageStore()

  const alarmIds = ref<string[]>([])
  const faultyIds = ref<string[]>([])
  const result = ref<SimulationResult | null>(null)
  const resultSignature = ref<string | null>(null)

  // 播放状态
  const playing = ref(false)
  const currentTime = ref(0)
  const speed = ref(1)

  const alarmCandidates = computed(() =>
    linkage.devices.filter((device) => ALARM_DEVICE_TYPES.includes(device.type)),
  )
  // 故障设备可选动作设备；已选为报警点的设备不再参与故障选择。
  const faultCandidates = computed(() =>
    linkage.devices.filter(
      (device) => !ALARM_DEVICE_TYPES.includes(device.type) && !alarmIds.value.includes(device.id),
    ),
  )

  const currentSignature = computed(() =>
    buildSimulationSignature({
      devices: linkage.devices,
      rules: linkage.rules,
      alarmIds: alarmIds.value,
      faultyIds: faultyIds.value,
    }),
  )

  // 配置（设备/规则）或选择（报警点/故障设备）改动后，旧结果立即失效。
  const stale = computed(() => result.value !== null && resultSignature.value !== currentSignature.value)

  const hasSelection = computed(() => alarmIds.value.length > 0)

  function toggleAlarm(id: string) {
    alarmIds.value = alarmIds.value.includes(id)
      ? alarmIds.value.filter((item) => item !== id)
      : [...alarmIds.value, id]
    // 报警点优先：从故障列表移除。
    faultyIds.value = faultyIds.value.filter((item) => item !== id)
  }

  function toggleFault(id: string) {
    faultyIds.value = faultyIds.value.includes(id)
      ? faultyIds.value.filter((item) => item !== id)
      : [...faultyIds.value.filter((item) => item !== id), id]
  }

  function clearSelection() {
    alarmIds.value = []
    faultyIds.value = []
  }

  function run() {
    if (!hasSelection.value) return
    result.value = runSimulation({
      devices: linkage.devices,
      rules: linkage.rules,
      alarmIds: alarmIds.value,
      faultyIds: faultyIds.value,
    })
    resultSignature.value = currentSignature.value
    currentTime.value = 0
    playing.value = false
  }

  function stopPlayback() {
    playing.value = false
  }

  function resetPlayhead() {
    playing.value = false
    currentTime.value = 0
  }

  function clearResult() {
    result.value = null
    resultSignature.value = null
    currentTime.value = 0
    playing.value = false
  }

  // 规则或设备变化导致签名变动时，自动暂停播放，页面提示重新推演。
  watch(stale, (isStale) => {
    if (isStale) playing.value = false
  })

  return {
    alarmIds,
    faultyIds,
    result,
    playing,
    currentTime,
    speed,
    alarmCandidates,
    faultCandidates,
    stale,
    hasSelection,
    toggleAlarm,
    toggleFault,
    clearSelection,
    run,
    stopPlayback,
    resetPlayhead,
    clearResult,
  }
})
