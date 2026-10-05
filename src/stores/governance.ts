import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  DeprecationPlan,
  EventDefinition,
  EventProperty,
  GovernanceState,
  PlatformRule,
  ReceiptKind,
  ReceiptPayload,
  ReleaseApproval,
  ReleaseCandidate,
  RollbackRecord,
} from '@/models/domain'
import { createId, loadState, resetState, saveState } from '@/services/repository'
import {
  affectedDependencies,
  affectedDependencyIdsForDrifts,
  buildReleaseSnapshot,
  releaseReadiness,
  releaseSnapshotDrifts,
  snapshotDifferences,
  validateGovernance,
} from '@/services/selectors'

export interface ReceiptSubmission {
  releaseId: string
  kind: ReceiptKind
  targetId: string
  clientId: string
  clientLabel: string
  idempotencyKey: string
  baseRevision: number
  payload: ReceiptPayload
}

export interface ReceiptSubmissionResult {
  ok: boolean
  receiptId: string
  status: 'accepted' | 'rejected' | 'duplicate' | 'failed'
  message: string
}

export interface InvalidationNotice {
  releaseId: string
  version: string
  confirmations: number
  approvals: number
  drifted: boolean
}

const approvalActors: Array<Pick<ReleaseApproval, 'role' | 'actor'>> = [
  { role: 'data', actor: '顾清' },
  { role: 'product', actor: '丁禾' },
  { role: 'client', actor: '江驰' },
  { role: 'qa', actor: '余安' },
]

export const useGovernanceStore = defineStore('governance', () => {
  const data = ref<GovernanceState>(loadState())
  const lastSavedAt = ref(new Date().toISOString())

  const issues = computed(() => validateGovernance(data.value))

  const persist = (): void => {
    saveState(data.value)
    lastSavedAt.value = new Date().toISOString()
  }

  const audit = (
    entityType: string,
    entityId: string,
    action: string,
    detail: string,
  ): void => {
    data.value.audit.unshift({
      id: createId('aud'),
      entityType,
      entityId,
      action,
      actor: '当前用户',
      detail,
      createdAt: new Date().toISOString(),
    })
  }

  // 评审中候选：字段/必填/平台规则变更后，相关确认与审批失效并列待重算
  const invalidateReviewingReleases = (
    eventId: string,
    changedPropertyIds: string[],
    reason: string,
  ): InvalidationNotice[] => {
    const notices: InvalidationNotice[] = []
    const now = new Date().toISOString()
    data.value.releases
      .filter((release) => release.status === 'reviewing' && release.eventIds.includes(eventId))
      .forEach((release) => {
        const drifts = releaseSnapshotDrifts(data.value, release)
        if (drifts.length === 0) return
        const affectedDependencyIds = new Set(
          affectedDependencyIdsForDrifts(data.value, drifts),
        )
        // 事件级规则变更（启停/触发时机，不绑定具体字段）默认影响全部已确认下游
        if (changedPropertyIds.length === 0) {
          release.affectedDependencyIds.forEach((id) => affectedDependencyIds.add(id))
        }
        let confirmationCount = 0
        let approvalCount = 0
        release.migrationConfirmations.forEach((confirmation) => {
          if (
            confirmation.status === 'confirmed' &&
            affectedDependencyIds.has(confirmation.dependencyId)
          ) {
            confirmation.status = 'invalidated'
            confirmation.invalidatedAt = now
            confirmation.invalidReason = reason
            confirmationCount += 1
            if (!release.recalculationQueue.includes(confirmation.id)) {
              release.recalculationQueue.push(confirmation.id)
            }
          }
        })
        release.approvals.forEach((approval) => {
          if (approval.status === 'approved') {
            approval.status = 'invalidated'
            approval.invalidatedAt = now
            approval.invalidReason = reason
            approvalCount += 1
            if (!release.recalculationQueue.includes(approval.id)) {
              release.recalculationQueue.push(approval.id)
            }
          }
        })
        release.driftDetected = true
        notices.push({
          releaseId: release.id,
          version: release.version,
          confirmations: confirmationCount,
          approvals: approvalCount,
          drifted: true,
        })
        audit('release', release.id, '候选快照漂移', `${release.version}：${reason}`)
      })
    return notices
  }

  const saveEvent = (event: EventDefinition): void => {
    const index = data.value.events.findIndex((item) => item.id === event.id)
    const saved = { ...event, updatedAt: new Date().toISOString() }
    if (index >= 0) {
      data.value.events[index] = saved
    } else {
      data.value.events.unshift(saved)
    }
    audit('event', event.id, index >= 0 ? '更新事件' : '创建事件', `${event.key} 契约已保存`)
    persist()
  }

  const saveProperty = (eventId: string, property: EventProperty): InvalidationNotice[] => {
    const event = data.value.events.find((item) => item.id === eventId)
    if (!event) return []
    const index = event.properties.findIndex((item) => item.id === property.id)
    const created = index < 0
    if (index >= 0) {
      event.properties[index] = property
    } else {
      event.properties.push(property)
    }
    event.updatedAt = new Date().toISOString()
    audit('property', property.id, index >= 0 ? '更新属性' : '新增属性', `${event.key}.${property.name}`)
    const notices = invalidateReviewingReleases(
      eventId,
      created ? [] : [property.id],
      created
        ? `字段 ${property.name} 新增`
        : `字段 ${property.name} 的类型/必填/枚举/平台发生变化`,
    )
    persist()
    return notices
  }

  const deleteProperty = (eventId: string, propertyId: string): void => {
    const event = data.value.events.find((item) => item.id === eventId)
    const property = event?.properties.find((item) => item.id === propertyId)
    if (!event || !property) return
    property.deletedAt = new Date().toISOString()
    event.updatedAt = new Date().toISOString()
    audit('property', property.id, '标记删除', `${event.key}.${property.name} 进入删除兼容期`)
    invalidateReviewingReleases(eventId, [propertyId], `字段 ${property.name} 进入删除兼容期`)
    persist()
  }

  const savePlatformRule = (eventId: string, rule: PlatformRule): InvalidationNotice[] => {
    const event = data.value.events.find((item) => item.id === eventId)
    if (!event) return []
    const index = event.platformRules.findIndex((item) => item.id === rule.id)
    const created = index < 0
    if (index >= 0) {
      event.platformRules[index] = rule
    } else {
      event.platformRules.push(rule)
    }
    event.updatedAt = new Date().toISOString()
    audit('platform_rule', rule.id, index >= 0 ? '更新平台规则' : '新增平台规则', `${event.key}/${rule.platform}`)
    const notices = invalidateReviewingReleases(
      eventId,
      rule.requiredPropertyIds,
      created
        ? `新增 ${rule.platform} 平台规则`
        : `${rule.platform} 平台规则（启停/必填字段/触发时机）发生变化`,
    )
    persist()
    return notices
  }

  const createRelease = (version: string, title: string, eventIds: string[]): ReleaseCandidate => {
    // 冻结时固化完整契约快照，差异与受影响下游均基于快照而非实时事件
    const snapshot = buildReleaseSnapshot(data.value, eventIds)
    const differences = snapshotDifferences(data.value, snapshot)
    const affected = affectedDependencies(data.value, differences)
    const release: ReleaseCandidate = {
      id: createId('rel'),
      version,
      title,
      status: 'reviewing',
      eventIds,
      snapshot,
      snapshotRevision: 1,
      driftDetected: false,
      recalculationQueue: [],
      frozenAt: new Date().toISOString(),
      affectedDependencyIds: affected,
      differences,
      migrationConfirmations: affected.map((dependencyId) => ({
        id: createId('mig'),
        dependencyId,
        version,
        status: 'pending',
        reviewer:
          data.value.dependencies.find((dependency) => dependency.id === dependencyId)?.owner ?? '',
        note: '',
      })),
      approvals: approvalActors.map((item) => ({
        id: createId('appr'),
        role: item.role,
        actor: item.actor,
        status: 'pending',
        comment: '',
      })),
      receipts: [],
      createdAt: new Date().toISOString(),
    }
    data.value.releases.unshift(release)
    data.value.currentVersion = version
    audit(
      'release',
      release.id,
      '冻结发布候选',
      `${version} 已冻结 ${eventIds.length} 个事件契约快照，影响 ${affected.length} 个下游依赖`,
    )
    persist()
    return release
  }

  // 重新计算：用当前实时契约刷新快照、差异与下游清单，原失效确认/审批回到待处理
  const recalculateRelease = (releaseId: string): boolean => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    if (!release || release.status !== 'reviewing') return false
    const snapshot = buildReleaseSnapshot(data.value, release.eventIds)
    const differences = snapshotDifferences(data.value, snapshot)
    const affected = affectedDependencies(data.value, differences)
    const previousConfirmations = new Map(
      release.migrationConfirmations.map((item) => [item.dependencyId, item]),
    )
    release.snapshot = snapshot
    release.snapshotRevision += 1
    release.driftDetected = false
    release.recalculationQueue = []
    release.frozenAt = new Date().toISOString()
    release.recalculatedAt = new Date().toISOString()
    release.differences = differences
    release.affectedDependencyIds = affected
    release.migrationConfirmations = affected.map((dependencyId) => {
      const previous = previousConfirmations.get(dependencyId)
      if (!previous) {
        return {
          id: createId('mig'),
          dependencyId,
          version: release.version,
          status: 'pending' as const,
          reviewer:
            data.value.dependencies.find((dependency) => dependency.id === dependencyId)?.owner ?? '',
          note: '',
        }
      }
      return {
        ...previous,
        status: previous.status === 'rejected' ? 'rejected' : 'pending',
        confirmedAt: undefined,
        invalidatedAt: undefined,
        invalidReason: undefined,
      }
    })
    release.approvals = release.approvals.map((approval) =>
      approval.status === 'approved' || approval.status === 'invalidated'
        ? { ...approval, status: 'pending', invalidatedAt: undefined, invalidReason: undefined }
        : { ...approval, invalidatedAt: undefined, invalidReason: undefined },
    )
    audit(
      'release',
      release.id,
      '重算契约快照',
      `${release.version} 快照更新至修订 ${release.snapshotRevision}，差异 ${differences.length} 项`,
    )
    persist()
    return true
  }

  const submitReceipt = (submission: ReceiptSubmission): ReceiptSubmissionResult => {
    const release = data.value.releases.find((item) => item.id === submission.releaseId)
    const timestamp = new Date().toISOString()
    const pushReceipt = (
      status: ReceiptSubmissionResult['status'],
      message: string,
    ): ReceiptSubmissionResult => {
      const record = {
        id: createId('rcpt'),
        releaseId: submission.releaseId,
        kind: submission.kind,
        targetId: submission.targetId,
        clientId: submission.clientId,
        clientLabel: submission.clientLabel,
        idempotencyKey: submission.idempotencyKey,
        baseRevision: submission.baseRevision,
        status,
        payload: { ...submission.payload } as typeof submission.payload,
        message,
        createdAt: timestamp,
        processedAt: status === 'rejected' || status === 'failed' ? undefined : timestamp,
      }
      release?.receipts.unshift(record)
      persist()
      return { ok: status === 'accepted' || status === 'duplicate', receiptId: record.id, status, message }
    }

    if (!release) {
      return {
        ok: false,
        receiptId: '',
        status: 'failed',
        message: '发布候选不存在，回执无法投递',
      }
    }
    if (release.status !== 'reviewing') {
      return pushReceipt('rejected', `候选 ${release.version} 已结束评审（${release.status}），回执退回`)
    }
    // 快照版本不匹配 → 退回（保留回执，客户端同步当前修订后可用同一幂等键重试）
    if (submission.baseRevision !== release.snapshotRevision) {
      return pushReceipt(
        'rejected',
        `回执基于快照修订 ${submission.baseRevision}，当前为修订 ${release.snapshotRevision}，契约已变更，回执退回`,
      )
    }
    if (release.driftDetected) {
      return pushReceipt('rejected', '候选存在未重算的契约漂移，请先完成快照重算后再提交')
    }
    // 幂等：同一幂等键只处理一次，后续重复提交直接返回原结果
    const existing = release.receipts.find(
      (item) => item.idempotencyKey === submission.idempotencyKey,
    )
    if (existing && (existing.status === 'accepted' || existing.status === 'duplicate')) {
      return pushReceipt(
        'duplicate',
        `重复回执（幂等键 ${submission.idempotencyKey}），沿用首次处理结果，不重复处理`,
      )
    }
    if (submission.kind === 'migration') {
      const confirmation = release.migrationConfirmations.find(
        (item) => item.id === submission.targetId,
      )
      if (!confirmation) {
        return pushReceipt('rejected', '迁移确认项不存在或已随重算移除，回执退回')
      }
      const reviewer = submission.payload.reviewer?.trim()
      const note = submission.payload.note?.trim()
      if (!reviewer || !note) {
        return pushReceipt('failed', '确认人或迁移说明为空，处理失败，可补充后重试')
      }
      confirmation.status = 'confirmed'
      confirmation.reviewer = reviewer
      confirmation.note = note
      confirmation.confirmedAt = timestamp
      const dependency = data.value.dependencies.find((item) => item.id === confirmation.dependencyId)
      if (dependency) dependency.status = 'migrated'
      audit('dependency', confirmation.dependencyId, '回执确认迁移', `${submission.clientLabel}：${note}`)
      return pushReceipt('accepted', `迁移确认已受理（${dependency?.name ?? confirmation.dependencyId}）`)
    }

    const approval = release.approvals.find((item) => item.id === submission.targetId)
    if (!approval) {
      return pushReceipt('rejected', '审批项不存在，回执退回')
    }
    const comment = submission.payload.comment?.trim()
    if (!comment) {
      return pushReceipt('failed', '审批意见为空，处理失败，可补充后重试')
    }
    const decision = submission.payload.decision === 'rejected' ? 'rejected' : 'approved'
    approval.status = decision
    approval.actor = submission.payload.actor?.trim() || approval.actor
    approval.comment = comment
    approval.createdAt = timestamp
    audit(
      'release',
      release.id,
      decision === 'approved' ? '回执审批通过' : '回执审批驳回',
      `${submission.clientLabel}/${approval.role}：${comment}`,
    )
    return pushReceipt('accepted', decision === 'approved' ? '审批通过回执已受理' : '审批驳回回执已受理')
  }

  // 失败/退回回执的重试：沿用原幂等键与原 payload，按当前快照修订重新投递
  const retryReceipt = (
    releaseId: string,
    receiptId: string,
    payload?: ReceiptPayload,
  ): ReceiptSubmissionResult | null => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    const receipt = release?.receipts.find((item) => item.id === receiptId)
    if (!release || !receipt) return null
    return submitReceipt({
      releaseId,
      kind: receipt.kind,
      targetId: receipt.targetId,
      clientId: receipt.clientId,
      clientLabel: receipt.clientLabel,
      idempotencyKey: receipt.idempotencyKey,
      baseRevision: release.snapshotRevision,
      payload: payload ?? receipt.payload,
    })
  }

  const publishRelease = (releaseId: string): boolean => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    if (!release) return false
    if (release.driftDetected) return false
    const readiness = releaseReadiness(release, issues.value)
    const migrationsReady = release.migrationConfirmations.every((item) => item.status === 'confirmed')
    const approvalsReady = release.approvals.every((item) => item.status === 'approved')
    if (!migrationsReady || !approvalsReady || readiness < 90) return false
    release.status = 'published'
    release.publishedAt = new Date().toISOString()
    // 发布内容以冻结快照为准，而不是评审期间可能又被修改过的实时契约
    release.snapshot.forEach((snapshot) => {
      const event = data.value.events.find((item) => item.id === snapshot.eventId)
      if (!event) return
      event.status = 'published'
      event.version = snapshot.version
      snapshot.properties.forEach((frozenProperty) => {
        const property = event.properties.find((item) => item.id === frozenProperty.id)
        if (property) {
          property.name = frozenProperty.name
          property.displayName = frozenProperty.displayName
          property.type = frozenProperty.type
          property.required = frozenProperty.required
          property.description = frozenProperty.description
          property.enumValues = [...frozenProperty.enumValues]
          property.owner = frozenProperty.owner
          property.synonyms = [...frozenProperty.synonyms]
          property.platforms = [...frozenProperty.platforms]
          if (!frozenProperty.deleted) property.deletedAt = undefined
        }
      })
      snapshot.platformRules.forEach((frozenRule) => {
        const rule = event.platformRules.find((item) => item.id === frozenRule.id)
        if (rule) {
          rule.platform = frozenRule.platform
          rule.enabled = frozenRule.enabled
          rule.trigger = frozenRule.trigger
          rule.owner = frozenRule.owner
          rule.requiredPropertyIds = [...frozenRule.requiredPropertyIds]
          rule.note = frozenRule.note
        }
      })
      data.value.baselines.unshift({
        id: createId('base'),
        eventId: snapshot.eventId,
        version: snapshot.version,
        properties: snapshot.properties
          .filter((property) => !property.deleted)
          .map((property) => ({
            id: property.id,
            eventId: snapshot.eventId,
            name: property.name,
            displayName: property.displayName,
            type: property.type,
            required: property.required,
            description: property.description,
            enumValues: [...property.enumValues],
            owner: property.owner,
            synonyms: [...property.synonyms],
            platforms: [...property.platforms],
          })),
        createdAt: new Date().toISOString(),
        status: 'published',
      })
    })
    audit('release', release.id, '发布契约', `${release.version} 已按冻结快照（修订 ${release.snapshotRevision}）发布`)
    persist()
    return true
  }

  const saveDeprecation = (plan: DeprecationPlan): void => {
    const index = data.value.deprecations.findIndex((item) => item.id === plan.id)
    if (index >= 0) {
      data.value.deprecations[index] = plan
    } else {
      data.value.deprecations.unshift(plan)
    }
    const event = data.value.events.find((item) => item.id === plan.eventId)
    if (event && plan.status === 'stopped') event.status = 'deprecated'
    if (event && plan.status === 'retired') event.status = 'retired'
    audit('deprecation', plan.id, '更新废弃计划', `${event?.key ?? plan.eventId}：${plan.status}`)
    persist()
  }

  const executeRollback = (
    targetReleaseId: string,
    reason: string,
    scope: string,
    evidence: string,
  ): void => {
    const target = data.value.releases.find((item) => item.id === targetReleaseId)
    if (!target) return
    const now = new Date().toISOString()
    // 恢复目标已发布快照：按快照覆盖字段与平台规则；之后新增的事件/字段/规则全部保留
    target.snapshot.forEach((snapshot) => {
      const event = data.value.events.find((item) => item.id === snapshot.eventId)
      if (!event) return
      snapshot.properties.forEach((frozenProperty) => {
        const property = event.properties.find((item) => item.id === frozenProperty.id)
        if (!property) return
        property.type = frozenProperty.type
        property.required = frozenProperty.required
        property.name = frozenProperty.name
        property.displayName = frozenProperty.displayName
        property.description = frozenProperty.description
        property.enumValues = [...frozenProperty.enumValues]
        property.synonyms = [...frozenProperty.synonyms]
        property.platforms = [...frozenProperty.platforms]
        property.deletedAt = frozenProperty.deleted
          ? (property.deletedAt ?? now)
          : undefined
      })
      snapshot.platformRules.forEach((frozenRule) => {
        const rule = event.platformRules.find((item) => item.id === frozenRule.id)
        if (!rule) return
        rule.platform = frozenRule.platform
        rule.enabled = frozenRule.enabled
        rule.trigger = frozenRule.trigger
        rule.owner = frozenRule.owner
        rule.requiredPropertyIds = [...frozenRule.requiredPropertyIds]
        rule.note = frozenRule.note
      })
      event.version = snapshot.version
      event.status = 'published'
      event.updatedAt = now
      data.value.baselines.unshift({
        id: createId('base'),
        eventId: snapshot.eventId,
        version: snapshot.version,
        properties: snapshot.properties
          .filter((property) => !property.deleted)
          .map((property) => ({
            id: property.id,
            eventId: snapshot.eventId,
            name: property.name,
            displayName: property.displayName,
            type: property.type,
            required: property.required,
            description: property.description,
            enumValues: [...property.enumValues],
            owner: property.owner,
            synonyms: [...property.synonyms],
            platforms: [...property.platforms],
          })),
        createdAt: now,
        status: 'published',
      })
    })
    // 目标版本之后发布/评审中的候选标记为已回滚（其新增契约不删除）
    const targetPublishedAt = target.publishedAt ?? target.createdAt
    const superseded = data.value.releases.filter(
      (release) =>
        release.id !== target.id &&
        (release.status === 'published' || release.status === 'reviewing') &&
        new Date(release.publishedAt ?? release.createdAt).getTime() >
          new Date(targetPublishedAt).getTime(),
    )
    superseded.forEach((release) => {
      release.status = 'rolled_back'
    })
    data.value.currentVersion = target.version
    const record: RollbackRecord = {
      id: createId('rollback'),
      releaseId: superseded[0]?.id ?? target.id,
      version: superseded[0]?.version ?? target.version,
      targetReleaseId: target.id,
      targetVersion: target.version,
      reason,
      operator: '当前用户',
      scope,
      createdAt: now,
      status: 'executed',
      evidence,
    }
    data.value.rollbacks.unshift(record)
    audit(
      'rollback',
      record.id,
      '执行回滚',
      `恢复至 ${target.version} 已发布快照，保留之后新增契约；受影响候选 ${superseded
        .map((release) => release.version)
        .join('、') || '无'}`,
    )
    persist()
  }

  const verifyRollback = (rollbackId: string, evidence: string): void => {
    const record = data.value.rollbacks.find((item) => item.id === rollbackId)
    if (!record) return
    record.status = 'verified'
    record.evidence = evidence
    audit('rollback', record.id, '验证回滚', evidence)
    persist()
  }

  const resetDemo = (): void => {
    data.value = resetState()
    lastSavedAt.value = new Date().toISOString()
  }

  const exportContract = (eventIds?: string[]): string => {
    const selectedEvents = eventIds
      ? data.value.events.filter((event) => eventIds.includes(event.id))
      : data.value.events
    return JSON.stringify(
      {
        version: data.value.currentVersion,
        generatedAt: new Date().toISOString(),
        events: selectedEvents.map((event) => ({
          key: event.key,
          displayName: event.displayName,
          version: event.version,
          trigger: event.trigger,
          platforms: event.platformRules.map((rule) => ({
            platform: rule.platform,
            enabled: rule.enabled,
            trigger: rule.trigger,
          })),
          properties: event.properties
            .filter((property) => !property.deletedAt)
            .map(({ name, type, required, enumValues, description }) => ({
              name,
              type,
              required,
              enumValues,
              description,
            })),
        })),
      },
      null,
      2,
    )
  }

  return {
    data,
    lastSavedAt,
    issues,
    saveEvent,
    saveProperty,
    deleteProperty,
    savePlatformRule,
    createRelease,
    recalculateRelease,
    submitReceipt,
    retryReceipt,
    publishRelease,
    saveDeprecation,
    executeRollback,
    verifyRollback,
    resetDemo,
    exportContract,
  }
})
