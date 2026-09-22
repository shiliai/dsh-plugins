/**
 * Pure routing decision over one jev verdict. jev only judges; this function
 * owns the flow. Every guard falls back to the leader — never block the task.
 * @module @dsh-plugins/dsh-agent-team/router
 */

import type { Worker } from './config.ts'
import type { JevVerdict } from './jev-client.ts'

export type Decision =
  | { route: 'leader'; reason: string }
  | { route: 'worker'; worker: Worker; reason: string }

export interface RouterThresholds {
  minConfidence: number
  complexityThreshold: number
}

/**
 * Branch order (first match wins):
 * 1. jev picked 'leader' explicitly;
 * 2. confidence below the minimum;
 * 3. complexity at or above the threshold;
 * 4. executor names no configured worker (hallucination guard);
 * 5. otherwise route to the named worker.
 */
export function decide(verdict: JevVerdict, workers: Worker[], thresholds: RouterThresholds): Decision {
  if (verdict.executor === 'leader') {
    return { route: 'leader', reason: `jev 判断该任务应由 leader(当前会话模型)执行(complexity=${verdict.complexity.toFixed(2)}, confidence=${verdict.confidence.toFixed(2)})` }
  }
  if (verdict.confidence < thresholds.minConfidence) {
    return { route: 'leader', reason: `jev 对执行者判断的信心不足(confidence=${verdict.confidence.toFixed(2)} < ${thresholds.minConfidence}),交还 leader` }
  }
  if (verdict.complexity >= thresholds.complexityThreshold) {
    return { route: 'leader', reason: `任务复杂度 ${verdict.complexity.toFixed(2)} 达到阈值 ${thresholds.complexityThreshold},交还 leader` }
  }
  const worker = workers.find(candidate => candidate.name === verdict.executor)
  if (worker === undefined) {
    return { route: 'leader', reason: `jev 给出的执行者 "${verdict.executor}" 不在配置中(可能为幻觉),交还 leader` }
  }
  return { route: 'worker', worker, reason: `复杂度 ${verdict.complexity.toFixed(2)} < ${thresholds.complexityThreshold},jev 选择 worker "${worker.name}"(confidence=${verdict.confidence.toFixed(2)})` }
}
