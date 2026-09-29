import type { Device, Rule } from '../stores/linkage'

/**
 * 联动推演引擎（纯计算层）
 *
 * 输入设备台账、启用规则、报警点与故障设备集合，按“延时 + 优先级 + 联锁反馈”
 * 推进离散事件，输出每个动作带时刻的执行序列：
 *
 * - 成功：延时到期且联锁反馈具备，设备动作到位；
 * - 等待：联锁反馈设备尚未到位，规则挂起，反馈到达后自动续跑（延时不再重复计）；
 * - 拒动：动作设备本身故障；被拒动设备触发的下游规则记为路径阻断，
 *   等待其反馈的联锁规则记为联锁中断，三者都不再继续向后推进。
 *
 * 本文件不依赖 Vue / Pinia / DOM，可独立单测。
 */

export type StepStatus = '成功' | '等待' | '拒动'
export type StepKind = '动作执行' | '故障拒动' | '路径阻断' | '联锁等待' | '联锁中断'

export interface SimStep {
  ruleId: string
  triggerId: string
  actionId: string
  priority: 1 | 2 | 3
  delay: number
  /** 规则首次进入序列（尝试）的时刻，秒 */
  time: number
  /** 状态落定（成功 / 拒动）时刻；仍在等待联锁反馈为 null */
  resolvedAt: number | null
  status: StepStatus
  kind: StepKind
  /** 联锁条件文案，如“卷帘全开后启动”；无联锁为“无” */
  interlock: string
  /** 解析到的联锁反馈设备；解析不到视为外部反馈，推演中不会到达 */
  feedbackDeviceId: string | null
  detail: string
}

export interface DeviceState {
  deviceId: string
  /** 报警：初始报警点；成功：动作到位；拒动：故障或被上游阻断；未触发：不在本路径上 */
  state: '报警' | '成功' | '拒动' | '未触发'
  at: number | null
  reason: string
}

export interface SimLog {
  at: number
  level: 'info' | 'success' | 'wait' | 'error'
  text: string
}

export interface SimulationResult {
  steps: SimStep[]
  deviceStates: DeviceState[]
  logs: SimLog[]
  /** 序列最后落定时刻（仍在等待的步骤不计），秒 */
  maxTime: number
  stats: { success: number; waiting: number; rejected: number }
}

type DevState = DeviceState['state']

const KEYWORD_GROUPS: string[][] = [
  ['防火阀'],
  ['卷帘'],
  ['排烟', '风机'],
  ['轿厢', '电梯', '客梯', '梯'],
  ['广播'],
  ['阀'],
]

/** 将联锁文案解析到具体反馈设备：按关键字组在设备名中命中，未命中返回 null（外部反馈）。 */
export function resolveFeedbackDevice(interlock: string, devices: Device[]): Device | null {
  const text = interlock.trim()
  if (!text || text === '无') return null
  for (const group of KEYWORD_GROUPS) {
    const matched = group.filter((keyword) => text.includes(keyword))
    if (matched.length) {
      // 组内任一关键字命中即可；命中关键字越多越具体，同分取名称较短者
      let best: Device | null = null
      let bestScore = 0
      for (const device of devices) {
        const score = matched.reduce((sum, keyword) => sum + (device.name.includes(keyword) ? keyword.length : 0), 0)
        if (score > bestScore || (score === bestScore && best && device.name.length < best.name.length)) {
          best = device
          bestScore = score
        }
      }
      if (best) return best
    }
  }
  return null
}

export function formatClock(seconds: number): string {
  return `T+${seconds.toFixed(seconds % 1 === 0 ? 0 : 1)}s`
}

interface QueueEvent {
  at: number
  /** 同刻排序：完成事件先于新尝试，再按规则优先级、入列顺序 */
  order: 0 | 1
  priority: 1 | 2 | 3
  seq: number
  run: () => void
}

/**
 * 执行联动推演。
 * @param alarms  初始报警点设备 id（探测器 / 手报 / 输入模块）
 * @param faultIds 故障设备 id 集合；这些设备的动作一律记为拒动
 */
export function simulate(devices: Device[], allRules: Rule[], alarms: string[], faultIds: string[]): SimulationResult {
  const rules = allRules.filter((rule) => rule.enabled)
  const deviceMap = new Map(devices.map((device) => [device.id, device]))
  const faults = new Set(faultIds)

  const states = new Map<string, DevState>()
  const atTime = new Map<string, number>()
  const stateReason = new Map<string, string>()
  const steps = new Map<string, SimStep>()
  const waitIndex = new Map<string, Set<string>>() // 联锁设备 id -> 等待它的规则 id
  const logs: SimLog[] = []

  let seq = 0
  let maxTime = 0
  const queue: QueueEvent[] = []

  function setState(id: string, state: DevState, at: number | null, reason: string) {
    states.set(id, state)
    if (at !== null) atTime.set(id, at)
    stateReason.set(id, reason)
  }

  function enqueue(at: number, order: 0 | 1, priority: 1 | 2 | 3, run: () => void) {
    queue.push({ at, order, priority, seq: seq++, run })
  }

  function log(at: number, level: SimLog['level'], text: string) {
    logs.push({ at, level, text })
  }

  function rulesByTrigger(triggerId: string) {
    return rules.filter((rule) => rule.triggerId === triggerId)
  }

  /** 重新评估等待某设备反馈的规则（该设备刚到位或刚拒动）。 */
  function kickWaiters(deviceId: string, at: number) {
    const waiters = waitIndex.get(deviceId)
    if (!waiters?.size) return
    // 用快照遍历，避免回调中修改集合
    const snapshot = [...waiters]
    waiters.clear()
    for (const rule of rules.filter((item) => snapshot.includes(item.id))) {
      enqueue(at, 1, rule.priority, () => attempt(rule, at))
    }
  }

  function reject(rule: Rule, at: number, kind: StepKind, detail: string) {
    const device = deviceMap.get(rule.actionId)
    const prior = steps.get(rule.id)
    steps.set(rule.id, {
      ruleId: rule.id, triggerId: rule.triggerId, actionId: rule.actionId,
      priority: rule.priority, delay: rule.delay, time: prior?.time ?? at, resolvedAt: at,
      status: '拒动', kind, interlock: rule.interlock, feedbackDeviceId: null, detail,
    })
    if (!states.has(rule.actionId) || states.get(rule.actionId) === '未触发') {
      setState(rule.actionId, '拒动', at, detail)
    }
    log(at, 'error', `${rule.id} ${device?.name ?? rule.actionId}：${detail}`)
    // 拒动设备的下游规则全部停下
    for (const downstream of rulesByTrigger(rule.actionId)) {
      reject(downstream, at, '路径阻断', `上游 ${device?.name ?? rule.actionId} 拒动，联动路径在此中断`)
    }
    // 等它反馈的联锁规则也停下
    const waitingHere = [...(waitIndex.get(rule.actionId) ?? [])]
    waitIndex.get(rule.actionId)?.clear()
    for (const downstream of rules.filter((item) => waitingHere.includes(item.id))) {
      reject(downstream, at, '联锁中断', `联锁反馈设备 ${device?.name ?? rule.actionId} 拒动，反馈无法到达`)
    }
    if (at > maxTime) maxTime = at
  }

  function attempt(rule: Rule, at: number) {
    const action = deviceMap.get(rule.actionId)
    const trigger = deviceMap.get(rule.triggerId)

    // 路径已被上游拒动封死
    if (states.get(rule.triggerId) === '拒动') {
      reject(rule, at, '路径阻断', `触发源 ${trigger?.name ?? rule.triggerId} 已拒动`)
      return
    }

    const feedback = resolveFeedbackDevice(rule.interlock, devices)
    // 联锁指向动作设备自身（如“轿厢无人确认”）或台账中没有对应反馈设备，视为外部确认，推演内不会到达
    const externalFeedback = rule.interlock.trim() !== '无' && (!feedback || feedback.id === rule.actionId)
    const feedbackState = feedback ? states.get(feedback.id) : undefined

    // 联锁反馈设备已拒动
    if (feedback && feedback.id !== rule.actionId && feedbackState === '拒动') {
      reject(rule, at, '联锁中断', `联锁反馈设备 ${feedback.name} 拒动，反馈无法到达`)
      return
    }

    // 联锁反馈未到位 -> 等待（延时不重新计）
    if (externalFeedback || (feedback && feedback.id !== rule.actionId && feedbackState !== '成功')) {
      if (feedback && feedback.id !== rule.actionId) {
        const set = waitIndex.get(feedback.id) ?? new Set<string>()
        set.add(rule.id)
        waitIndex.set(feedback.id, set)
      }
      const prior = steps.get(rule.id)
      steps.set(rule.id, {
        ruleId: rule.id, triggerId: rule.triggerId, actionId: rule.actionId,
        priority: rule.priority, delay: rule.delay, time: prior?.time ?? at, resolvedAt: null,
        status: '等待', kind: '联锁等待', interlock: rule.interlock,
        feedbackDeviceId: feedback && feedback.id !== rule.actionId ? feedback.id : null,
        detail: externalFeedback
          ? `等待外部确认（${rule.interlock}），推演内无对应反馈设备`
          : `等待 ${feedback!.name} 反馈（${rule.interlock}）`,
      })
      if (!states.has(rule.actionId)) setState(rule.actionId, '未触发', null, '等待联锁反馈')
      log(at, 'wait', externalFeedback
        ? `${rule.id} ${action?.name ?? rule.actionId}：等待外部确认（${rule.interlock}）`
        : `${rule.id} ${action?.name ?? rule.actionId}：等待 ${feedback!.name} 反馈`)
      return
    }

    // 反馈具备（或本就无联锁 / 为外部反馈）：进入延时
    const dueAt = at + Math.max(0, rule.delay)
    const startedAt = steps.get(rule.id)?.time ?? at

    if (faults.has(rule.actionId)) {
      steps.set(rule.id, {
        ruleId: rule.id, triggerId: rule.triggerId, actionId: rule.actionId,
        priority: rule.priority, delay: rule.delay, time: startedAt, resolvedAt: dueAt,
        status: '拒动', kind: '故障拒动', interlock: rule.interlock,
        feedbackDeviceId: feedback?.id ?? null, detail: '设备故障，动作指令发出后拒动',
      })
      setState(rule.actionId, '拒动', dueAt, '设备故障拒动')
      enqueue(dueAt, 0, rule.priority, () => {
        log(dueAt, 'error', `${rule.id} ${action?.name ?? rule.actionId}：故障拒动（延时 ${rule.delay}s 已到）`)
        for (const downstream of rulesByTrigger(rule.actionId)) {
          reject(downstream, dueAt, '路径阻断', `上游 ${action?.name ?? rule.actionId} 拒动，联动路径在此中断`)
        }
        const waitingHere = [...(waitIndex.get(rule.actionId) ?? [])]
        waitIndex.get(rule.actionId)?.clear()
        for (const downstream of rules.filter((item) => waitingHere.includes(item.id))) {
          reject(downstream, dueAt, '联锁中断', `联锁反馈设备 ${action?.name ?? rule.actionId} 拒动，反馈无法到达`)
        }
        if (dueAt > maxTime) maxTime = dueAt
      })
      return
    }

    // 正常：延时到期成功
    enqueue(dueAt, 0, rule.priority, () => {
      steps.set(rule.id, {
        ruleId: rule.id, triggerId: rule.triggerId, actionId: rule.actionId,
        priority: rule.priority, delay: rule.delay, time: startedAt, resolvedAt: dueAt,
        status: '成功', kind: '动作执行', interlock: rule.interlock,
        feedbackDeviceId: feedback?.id ?? null,
        detail: feedback ? `${feedback.name} 反馈已具备` : rule.interlock && rule.interlock !== '无' ? `外部反馈条件：${rule.interlock}` : '延时到期，动作到位',
      })
      setState(rule.actionId, '成功', dueAt, '动作到位')
      log(dueAt, 'success', `${rule.id} ${action?.name ?? rule.actionId}：动作到位${rule.delay ? `（延时 ${rule.delay}s）` : ''}`)
      if (dueAt > maxTime) maxTime = dueAt
      // 动作到位可作为后续规则的触发源 / 联锁反馈
      for (const downstream of rulesByTrigger(rule.actionId)) {
        enqueue(dueAt, 1, downstream.priority, () => attempt(downstream, dueAt))
      }
      kickWaiters(rule.actionId, dueAt)
    })
  }

  // 初始报警（t=0），同刻按优先级出列
  for (const alarmId of alarms) {
    const device = deviceMap.get(alarmId)
    if (!device) continue
    setState(alarmId, '报警', 0, '初始报警点')
    log(0, 'info', `报警点 ${device.name} 动作`)
    for (const rule of rulesByTrigger(alarmId)) {
      enqueue(0, 1, rule.priority, () => attempt(rule, 0))
    }
  }

  // 离散事件主循环
  let guard = 0
  while (queue.length) {
    queue.sort((a, b) => a.at - b.at || a.order - b.order || a.priority - b.priority || a.seq - b.seq)
    const event = queue.shift()!
    event.run()
    if (++guard > 5000) {
      log(maxTime, 'error', '推演步数超限，已强制停止（请检查规则是否存在联锁环）')
      break
    }
  }

  const stepList = [...steps.values()].sort((a, b) => {
    const ta = a.resolvedAt ?? a.time
    const tb = b.resolvedAt ?? b.time
    return ta - tb || a.priority - b.priority || a.ruleId.localeCompare(b.ruleId)
  })

  const deviceStates: DeviceState[] = devices
    .filter((device) => states.has(device.id))
    .map((device) => ({
      deviceId: device.id,
      state: states.get(device.id)!,
      at: atTime.get(device.id) ?? null,
      reason: stateReason.get(device.id) ?? '',
    }))

  return {
    steps: stepList,
    deviceStates,
    logs,
    maxTime,
    stats: {
      success: stepList.filter((step) => step.status === '成功').length,
      waiting: stepList.filter((step) => step.status === '等待').length,
      rejected: stepList.filter((step) => step.status === '拒动').length,
    },
  }
}

/** 失效签名：规则、设备、报警点、故障设备任一变化都会改变。 */
export function buildSignature(devices: Device[], rules: Rule[], alarms: string[], faultIds: string[]): string {
  return JSON.stringify({
    d: devices.map(({ id, name, type }) => ({ id, name, type })),
    r: rules.map(({ id, triggerId, actionId, delay, interlock, priority, suppression, enabled }) => ({ id, triggerId, actionId, delay, interlock, priority, suppression, enabled })),
    a: [...alarms].sort(),
    f: [...faultIds].sort(),
  })
}
