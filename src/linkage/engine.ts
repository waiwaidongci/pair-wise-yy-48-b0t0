// 联动推演引擎：无副作用的纯计算。
// 输入设备、启用规则、报警点与故障设备，输出带时刻的执行序列。
//
// 推演语义（与调试现场口径一致）：
// 1. 报警点在 t=0 进入报警（视为已触发成功），只沿“启用”的规则向下传播。
// 2. 规则被前级点燃后按 delay 排队；带联锁反馈的规则要等到反馈设备动作，
//    实际动作时刻 = max(点燃时刻 + 延时, 反馈设备动作时刻)。
// 3. 同一设备、同一可下发时刻按优先级（1 > 2 > 3）只下发一条，规则号兜底排序。
// 4. 故障设备上的动作记为“拒动”，设备永不激活；以它为前级的后续规则停下。
// 5. 联锁反馈来自故障设备 → 规则停（联锁设备拒动）；反馈迟迟不到 → 停在等待。
import type {
  Device,
  Rule,
  SimRow,
  BlockedRule,
  SimulationInput,
  SimulationResult,
  Priority,
} from './types'

const INF = Number.POSITIVE_INFINITY

// ---------------------------------------------------------------------------
// 联锁反馈解析：把规则里中文描述的联锁条件映射到具体反馈设备。
// ---------------------------------------------------------------------------

const INTERLOCK_KEYWORDS: Array<{ keywords: string[]; types: Device['type'][] }> = [
  { keywords: ['防火阀', '风阀', '阀门'], types: ['输入模块'] },
  { keywords: ['风机'], types: ['排烟风机'] },
  { keywords: ['卷帘'], types: ['防火卷帘'] },
  { keywords: ['广播'], types: ['消防广播'] },
  { keywords: ['声光'], types: ['声光警报器'] },
  { keywords: ['电梯', '轿厢'], types: ['电梯'] },
]

export function resolveInterlock(rule: Pick<Rule, 'interlock' | 'actionId'>, devices: Device[]): Device | null {
  const text = rule.interlock.trim()
  if (!text || text === '无') return null
  for (const { keywords, types } of INTERLOCK_KEYWORDS) {
    const hit = keywords.find((keyword) => text.includes(keyword))
    if (!hit) continue
    const candidates = devices.filter((device) => types.includes(device.type))
    const named = candidates.find((device) => device.name.includes(hit) && device.id !== rule.actionId)
    if (named) return named
    const other = candidates.find((device) => device.id !== rule.actionId)
    if (other) return other
  }
  return null
}

// ---------------------------------------------------------------------------
// 输入签名：配置或选择改动后旧推演结果即失效。
// ---------------------------------------------------------------------------

export function buildSimulationSignature(input: SimulationInput): string {
  const payload = JSON.stringify({
    d: input.devices.map((d) => [d.id, d.name, d.type]),
    r: input.rules.map((r) => [r.id, r.triggerId, r.actionId, r.delay, r.interlock, r.priority, r.suppression, r.enabled]),
    a: [...input.alarmIds].sort(),
    f: [...input.faultyIds].sort(),
  })
  // djb2，仅用于变化检测，不参与安全场景。
  let hash = 5381
  for (let i = 0; i < payload.length; i += 1) hash = ((hash << 5) + hash + payload.charCodeAt(i)) | 0
  return `sim-${(hash >>> 0).toString(36)}-${payload.length}`
}

// ---------------------------------------------------------------------------
// 推演主流程
// ---------------------------------------------------------------------------

interface RuleNode extends Rule {
  armedAt: number
  fireAt: number
  fbId: string | null
  winner: boolean
}

type Trace =
  | { kind: 'refusal'; blockerId: string; blockerRuleId: string }
  | { kind: 'waiting'; blockerId: string; blockerRuleId: string; detail: string }
  | null

export function runSimulation(input: SimulationInput): SimulationResult {
  const deviceMap = new Map(input.devices.map((device) => [device.id, device]))
  const alarms = input.alarmIds.filter((id) => deviceMap.has(id))
  const alarmSet = new Set(alarms)
  // 同一设备既报警又故障时，以报警为准（它能发出报警，但不再作为反馈/动作设备参与后续）。
  const faulty = new Set(input.faultyIds.filter((id) => deviceMap.has(id) && !alarmSet.has(id)))

  const enabled = input.rules.filter(
    (rule) => rule.enabled && deviceMap.has(rule.triggerId) && deviceMap.has(rule.actionId),
  )
  const outgoing = new Map<string, Rule[]>()
  for (const rule of enabled) {
    const list = outgoing.get(rule.triggerId) ?? []
    list.push(rule)
    outgoing.set(rule.triggerId, list)
  }

  // 可达性：从报警点沿启用规则能走到的规则才属于本次推演。
  const reachable = new Set<string>()
  {
    const queue = [...alarms]
    const seen = new Set(queue)
    while (queue.length) {
      const id = queue.shift()!
      for (const rule of outgoing.get(id) ?? []) {
        reachable.add(rule.id)
        if (!seen.has(rule.actionId)) {
          seen.add(rule.actionId)
          queue.push(rule.actionId)
        }
      }
    }
  }
  const rel = enabled.filter((rule) => reachable.has(rule.id))

  // 联锁反馈设备解析（一次算清，与迭代无关）。
  const fbOf = new Map<string, string | null>()
  for (const rule of rel) fbOf.set(rule.id, resolveInterlock(rule, input.devices)?.id ?? null)

  // 动作时刻不动点：activatedAt 为设备“确认动作”的最早时刻；报警点在 t=0。
  const activatedAt = new Map<string, number>()
  for (const id of alarms) activatedAt.set(id, 0)

  const nodes = new Map<string, RuleNode>()
  for (const rule of rel) {
    nodes.set(rule.id, { ...rule, armedAt: INF, fireAt: INF, fbId: fbOf.get(rule.id) ?? null, winner: false })
  }

  for (let iter = 0; iter <= rel.length + 2; iter += 1) {
    let changed = false
    for (const node of nodes.values()) {
      const armed = activatedAt.get(node.triggerId)
      const nextArmed = armed ?? INF
      if (nextArmed !== node.armedAt) {
        node.armedAt = nextArmed
        changed = true
      }
      let nextFire = INF
      if (Number.isFinite(nextArmed)) {
        const base = nextArmed + Math.max(0, Number(node.delay) || 0)
        const interlock = node.interlock.trim()
        if (!interlock || interlock === '无') {
          nextFire = base
        } else if (node.fbId) {
          const fb = activatedAt.get(node.fbId)
          if (fb !== undefined && Number.isFinite(fb)) nextFire = Math.max(base, fb)
        }
        // fbId 为 null（无法识别反馈设备）或反馈未到：保持 Infinity，停在等待。
      }
      if (nextFire !== node.fireAt) {
        node.fireAt = nextFire
        changed = true
      }
    }

    // 同设备同时刻排队：取时刻最早、优先级最高（数字小）、规则号最小的一条下发。
    for (const node of nodes.values()) node.winner = false
    const byAction = new Map<string, RuleNode[]>()
    for (const node of nodes.values()) {
      if (!Number.isFinite(node.fireAt)) continue
      const list = byAction.get(node.actionId) ?? []
      list.push(node)
      byAction.set(node.actionId, list)
    }
    for (const list of byAction.values()) {
      list.sort(
        (a, b) =>
          a.fireAt - b.fireAt ||
          (a.priority as number) - (b.priority as number) ||
          a.id.localeCompare(b.id),
      )
      const winner = list[0]
      winner.winner = true
      if (!faulty.has(winner.actionId)) {
        const prev = activatedAt.get(winner.actionId)
        if (prev === undefined || winner.fireAt < prev) {
          activatedAt.set(winner.actionId, winner.fireAt)
          changed = true
        }
      }
    }
    if (!changed) break
  }

  const deviceName = (id: string) => deviceMap.get(id)?.name ?? id

  // 联锁回路提示：反馈设备本身也在等联锁（候选时刻为无穷）时，反馈无法到达。
  function loopNote(node: RuleNode): string {
    if (!node.fbId) return ''
    const waiting = [...nodes.values()].some(
      (other) =>
        other.actionId === node.fbId &&
        Number.isFinite(other.armedAt) &&
        !Number.isFinite(other.fireAt),
    )
    return waiting ? '（联锁回路未闭合，反馈无法到达）' : ''
  }

  // 找到某设备“真正下发动作”的胜出规则。
  const winnerForAction = (id: string) =>
    [...nodes.values()].find((other) => other.actionId === id && other.winner) ?? null

  const rows: SimRow[] = []
  const blocked: BlockedRule[] = []

  // 先落已点燃规则的结果。
  for (const node of [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!Number.isFinite(node.armedAt)) continue // 未点燃，随后回溯根因
    const baseRow = {
      ruleId: node.id,
      triggerId: node.triggerId,
      actionId: node.actionId,
      delay: node.delay,
      priority: node.priority as Priority,
      interlock: node.interlock,
      suppression: node.suppression,
      armedAt: node.armedAt,
      interlockDeviceId: node.fbId,
      winnerRuleId: null as string | null,
    }

    if (Number.isFinite(node.fireAt)) {
      if (faulty.has(node.actionId)) {
        rows.push({
          ...baseRow,
          fireAt: node.fireAt,
          status: '拒动',
          note: `故障设备 ${deviceName(node.actionId)} 未执行，动作拒动`,
        })
      } else if (node.winner) {
        rows.push({
          ...baseRow,
          fireAt: node.fireAt,
          status: '成功',
          note:
            node.suppression && node.suppression !== '无'
              ? `抑制条件：${node.suppression}`
              : '动作成功执行',
        })
      } else {
        const winner = winnerForAction(node.actionId)
        rows.push({
          ...baseRow,
          fireAt: node.fireAt,
          winnerRuleId: winner?.id ?? null,
          status: '成功',
          note: winner
            ? `设备已由 ${winner.id} 于 ${winner.fireAt}s 按更高优先级动作，本指令不再下发`
            : '设备已处于动作状态',
        })
      }
    } else if (node.fbId && faulty.has(node.fbId)) {
      blocked.push({
        ruleId: node.id,
        triggerId: node.triggerId,
        actionId: node.actionId,
        reason: '联锁设备拒动',
        blockerId: node.fbId,
        detail: `等待联锁反馈设备 ${deviceName(node.fbId)} 动作，该设备故障拒动，${node.id} 停止下发`,
      })
    } else {
      const interlock = node.interlock.trim()
      const reason = !interlock || interlock === '无'
        ? '联锁条件异常，等待反馈'
        : !node.fbId
          ? `联锁条件“${interlock}”无法识别到反馈设备，持续等待反馈`
          : `等待 ${deviceName(node.fbId)} 的联锁反馈“${interlock}” ${loopNote(node)}`
      rows.push({ ...baseRow, fireAt: null, status: '等待', note: reason.trim() })
    }
  }

  // 未点燃规则回溯：沿触发链找根因。故障/拒动 → 阻断；否则 → 等待级联。
  const traceCache = new Map<string, Trace>()

  function traceDevice(id: string, guard: Set<string>): Trace {
    if (faulty.has(id)) {
      // 故障设备只有被规则驱动才有“拒动动作”，找到排上时刻的那条规则。
      const rule = [...nodes.values()]
        .filter((node) => node.actionId === id && Number.isFinite(node.fireAt))
        .sort((a, b) => a.fireAt - b.fireAt || (a.priority as number) - (b.priority as number))[0]
      return rule ? { kind: 'refusal', blockerId: id, blockerRuleId: rule.id } : { kind: 'refusal', blockerId: id, blockerRuleId: '' }
    }
    if (alarmSet.has(id) || activatedAt.has(id)) return null
    if (guard.has(id)) return null
    guard.add(id)

    if (traceCache.has(id)) return traceCache.get(id)!
    const incomings = rel.filter((rule) => rule.actionId === id)
    let result: Trace = null
    for (const rule of incomings) {
      const node = nodes.get(rule.id)!
      if (Number.isFinite(node.fireAt)) {
        // 正常情况设备应已激活；落到这里说明被故障/排队挡掉，继续追该规则的触发端。
        result = traceDevice(rule.triggerId, new Set(guard)) ?? result
      } else {
        // 驱动本设备的规则停在等待（或联锁设备拒动）。
        if (node.fbId && faulty.has(node.fbId)) {
          result = { kind: 'refusal', blockerId: node.fbId, blockerRuleId: rule.id }
        } else {
          const upstream = traceDevice(rule.triggerId, new Set(guard))
          if (upstream?.kind === 'refusal') {
            result = upstream
          } else {
            const interlock = node.interlock.trim()
            const detail =
              !interlock || interlock === '无'
                ? '驱动规则停在等待'
                : !node.fbId
                  ? `联锁条件“${interlock}”无反馈设备`
                  : `等待 ${deviceName(node.fbId)} 的联锁反馈“${interlock}” ${loopNote(node)}`.trim()
            result = { kind: 'waiting', blockerId: rule.triggerId, blockerRuleId: rule.id, detail }
          }
        }
      }
      if (result?.kind === 'refusal') break
    }
    traceCache.set(id, result)
    return result
  }

  for (const node of nodes.values()) {
    if (Number.isFinite(node.armedAt)) continue
    const trace = traceDevice(node.triggerId, new Set())
    if (trace?.kind === 'refusal') {
      blocked.push({
        ruleId: node.id,
        triggerId: node.triggerId,
        actionId: node.actionId,
        reason: '前级拒动',
        blockerId: trace.blockerId,
        detail: trace.blockerRuleId
          ? `前级设备 ${deviceName(trace.blockerId)} 在 ${trace.blockerRuleId} 中拒动，后续规则 ${node.id} 不再推进`
          : `前级设备 ${deviceName(trace.blockerId)} 故障，后续规则 ${node.id} 不再推进`,
      })
    } else if (trace?.kind === 'waiting') {
      rows.push({
        ruleId: node.id,
        triggerId: node.triggerId,
        actionId: node.actionId,
        delay: node.delay,
        priority: node.priority as Priority,
        interlock: node.interlock,
        suppression: node.suppression,
        armedAt: null,
        fireAt: null,
        status: '等待',
        note: `前级 ${trace.blockerRuleId} 未动作：${trace.detail}`,
        interlockDeviceId: node.fbId,
        winnerRuleId: null,
      })
    }
  }

  // 终判：停在等待的规则，若其联锁反馈设备沿触发链回溯到故障/拒动根因，
  // 说明反馈永远不会到达——从“等待”改判为“联锁设备拒动”阻断。
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (row.status !== '等待' || !row.interlockDeviceId) continue
    const trace = traceDevice(row.interlockDeviceId, new Set())
    if (trace?.kind !== 'refusal') continue
    rows.splice(index, 1)
    blocked.push({
      ruleId: row.ruleId,
      triggerId: row.triggerId,
      actionId: row.actionId,
      reason: '联锁设备拒动',
      blockerId: trace.blockerId,
      detail: trace.blockerRuleId
        ? `等待联锁反馈 ${deviceName(row.interlockDeviceId)}，其动作链在 ${trace.blockerRuleId} 处被故障设备 ${deviceName(trace.blockerId)} 拒动，${row.ruleId} 停止下发`
        : `等待联锁反馈 ${deviceName(row.interlockDeviceId)}，反馈设备 ${deviceName(trace.blockerId)} 故障，${row.ruleId} 停止下发`,
    })
  }

  // 故障设备从未收到可下发指令（只出现在阻断链根因上）时，
  // 为其补一条合成拒动标记，保证时间轴能看到“哪个设备拒动、哪条路径因此而断”。
  const refusalActionIds = new Set(rows.filter((row) => row.status === '拒动').map((row) => row.actionId))
  const blockedRootFaults = new Set(blocked.map((item) => item.blockerId).filter((id) => faulty.has(id)))
  for (const faultId of blockedRootFaults) {
    if (refusalActionIds.has(faultId)) continue
    const incoming = rel
      .map((rule) => nodes.get(rule.id)!)
      .filter((node) => node.actionId === faultId)
    const candidates = incoming
      .map((node) => (Number.isFinite(node.fireAt) ? node.fireAt : Number.isFinite(node.armedAt) ? node.armedAt + node.delay : INF))
      .filter((time) => Number.isFinite(time))
    const time = candidates.length ? Math.min(...candidates) : 0
    rows.push({
      ruleId: `FAULT-${faultId}`,
      triggerId: incoming.length ? incoming[0].triggerId : faultId,
      actionId: faultId,
      delay: incoming.length ? incoming[0].delay : 0,
      priority: (incoming.length ? incoming[0].priority : 3) as Priority,
      interlock: incoming.length ? incoming[0].interlock : '无',
      suppression: incoming.length ? incoming[0].suppression : '无',
      armedAt: time,
      fireAt: time,
      status: '拒动',
      note: `故障设备 ${deviceName(faultId)} 拒动：${incoming.length ? `${incoming.length} 条规则的驱动条件就绪但设备无法执行，相关路径停止推进` : '无指令可下发，依赖它的联锁路径全部阻断'}`,
      interlockDeviceId: null,
      winnerRuleId: null,
      synthetic: true,
    })
  }

  // 排序：按动作时刻，等待沉底，同时刻按优先级与规则号。
  rows.sort(
    (a, b) =>
      (a.fireAt ?? INF) - (b.fireAt ?? INF) ||
      (a.armedAt ?? INF) - (b.armedAt ?? INF) ||
      a.priority - b.priority ||
      a.ruleId.localeCompare(b.ruleId),
  )
  blocked.sort((a, b) => a.ruleId.localeCompare(b.ruleId))

  const finiteTimes = rows.map((row) => row.fireAt).filter((time): time is number => time !== null)
  const maxTime = finiteTimes.length ? Math.max(...finiteTimes) : 0
  const horizon = Math.max(10, Math.ceil(maxTime / 2) * 2 + 2)

  return {
    rows,
    blocked,
    alarms: alarms.map((deviceId) => ({ deviceId, time: 0 })),
    horizon,
    counts: {
      success: rows.filter((row) => row.status === '成功').length,
      waiting: rows.filter((row) => row.status === '等待').length,
      refusal: rows.filter((row) => row.status === '拒动').length,
      blocked: blocked.length,
    },
    generatedAt: Date.now(),
  }
}
