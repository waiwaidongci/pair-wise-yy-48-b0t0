import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useLinkageStore } from './linkage'
import { buildSignature, simulate, type SimulationResult } from '../linkage/engine'

/**
 * 联动推演状态层：只保存“选了什么、算出什么、播到哪一帧”，
 * 推演算法全部在 src/linkage/engine.ts，展示全部在视图层。
 */
export const useSimulationStore = defineStore('simulation', () => {
  const linkage = useLinkageStore()

  const alarmIds = ref<string[]>(['D-01-01'])
  const faultIds = ref<string[]>([])

  const result = ref<SimulationResult | null>(null)
  /** 结果生成时的签名；与当前配置签名不一致即表示旧结果已失效 */
  const resultSignature = ref<string | null>(null)

  // 播放游标
  const cursor = ref(0)
  const playing = ref(false)
  const speed = ref(1) // 1x = 每秒推进 1 个仿真秒
  let timer: number | null = null

  const currentSignature = computed(() => buildSignature(linkage.devices, linkage.rules, alarmIds.value, faultIds.value))
  const stale = computed(() => result.value !== null && resultSignature.value !== currentSignature.value)
  const duration = computed(() => result.value?.maxTime ?? 0)
  const hasRun = computed(() => result.value !== null)

  const alarmCandidates = computed(() =>
    linkage.devices.filter((device) => ['感烟探测器', '感温探测器', '手动报警按钮', '输入模块'].includes(device.type)),
  )
  /** 可选故障设备：不允许把报警点本身设为故障（推演时报警点故障没有意义） */
  const faultCandidates = computed(() => linkage.devices.filter((device) => !alarmIds.value.includes(device.id)))

  function toggleAlarm(id: string) {
    stop()
    alarmIds.value = alarmIds.value.includes(id) ? alarmIds.value.filter((item) => item !== id) : [...alarmIds.value, id]
  }

  function toggleFault(id: string) {
    stop()
    faultIds.value = faultIds.value.includes(id) ? faultIds.value.filter((item) => item !== id) : [...faultIds.value, id]
  }

  function run() {
    stop()
    result.value = simulate(linkage.devices, linkage.rules, alarmIds.value, faultIds.value)
    resultSignature.value = currentSignature.value
    cursor.value = 0
  }

  function resetSelection() {
    stop()
    alarmIds.value = []
    faultIds.value = []
    result.value = null
    resultSignature.value = null
    cursor.value = 0
  }

  function seek(seconds: number) {
    cursor.value = Math.max(0, Math.min(duration.value, Number(seconds.toFixed(2))))
  }

  function stop() {
    playing.value = false
    if (timer !== null) {
      window.clearInterval(timer)
      timer = null
    }
  }

  function play() {
    if (!result.value || stale.value) return
    if (cursor.value >= duration.value) cursor.value = 0
    playing.value = true
    timer = window.setInterval(() => {
      const next = cursor.value + 0.1 * speed.value
      if (next >= duration.value) {
        cursor.value = duration.value
        stop()
      } else {
        cursor.value = Number(next.toFixed(2))
      }
    }, 100)
  }

  return {
    alarmIds, faultIds, result, resultSignature, cursor, playing, speed, duration,
    stale, hasRun, alarmCandidates, faultCandidates,
    currentSignature, toggleAlarm, toggleFault, run, resetSelection, seek, play, stop,
  }
})
