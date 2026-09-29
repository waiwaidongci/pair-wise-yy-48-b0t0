// 联动推演领域模型。页面、状态仓库与推演引擎共同依赖这里的类型，
// 引擎文件只做纯计算，不引用 Pinia、Vue 或任何页面代码。

export type DeviceType =
  | '感烟探测器'
  | '感温探测器'
  | '手动报警按钮'
  | '输入模块'
  | '输出模块'
  | '排烟风机'
  | '防火卷帘'
  | '消防广播'
  | '声光警报器'
  | '电梯'

export interface Device {
  id: string
  name: string
  type: DeviceType
  floor: string
  zone: string
  address: string
}

export type Priority = 1 | 2 | 3

export interface Rule {
  id: string
  triggerId: string
  actionId: string
  /** 触发后延时（秒） */
  delay: number
  /** 联锁反馈描述，“无”表示无联锁条件 */
  interlock: string
  priority: Priority
  suppression: string
  enabled: boolean
}

export interface Validation {
  id: string
  severity: '错误' | '警告'
  ruleIds: string[]
  title: string
  detail: string
  suggestion: string
}

/** 报警点类型：能发起一次报警的触发设备 */
export const ALARM_DEVICE_TYPES: readonly DeviceType[] = [
  '感烟探测器',
  '感温探测器',
  '手动报警按钮',
  '输入模块',
]

/** 单条启用规则在推演中的最终状态 */
export type SimStatus = '成功' | '等待' | '拒动'

/** 未进入时间轴的规则：前级已停，该规则不再推进 */
export type BlockedReason = '前级拒动' | '联锁设备拒动'

export interface SimRow {
  ruleId: string
  triggerId: string
  actionId: string
  delay: number
  priority: Priority
  interlock: string
  suppression: string
  /** 规则被前级报警/动作点燃的时刻（秒），未点燃为 null */
  armedAt: number | null
  /** 排到的动作时刻（秒）；联锁未满足或设备拒动为 Infinity */
  fireAt: number | null
  status: SimStatus
  /** 等待/拒动时的说明 */
  note: string
  /** 解析出的联锁反馈设备 id；无法解析为 null；无联锁时也是 null */
  interlockDeviceId: string | null
  /** 该动作时刻真正下发的规则 id（同设备同刻按优先级只下发一条） */
  winnerRuleId: string | null
  /** 合成行：故障设备从未收到可下发指令时，为根因故障补一条拒动标记 */
  synthetic?: boolean
}

export interface AlarmEvent {
  deviceId: string
  time: number
}

export interface BlockedRule {
  ruleId: string
  triggerId: string
  actionId: string
  reason: BlockedReason
  /** 导致停下的上游规则或设备 */
  blockerId: string
  detail: string
}

export interface SimulationInput {
  devices: Device[]
  rules: Rule[]
  alarmIds: string[]
  faultyIds: string[]
}

export interface SimulationResult {
  rows: SimRow[]
  blocked: BlockedRule[]
  alarms: AlarmEvent[]
  horizon: number
  counts: { success: number; waiting: number; refusal: number; blocked: number }
  generatedAt: number
}
