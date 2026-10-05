import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  DeprecationPlan,
  EventDefinition,
  EventProperty,
  GovernanceState,
  PlatformRule,
  ReceiptResult,
  ReleaseApproval,
  ReleaseCandidate,
  RollbackRecord,
} from '@/models/domain'
import {
  STORAGE_KEY,
  createId,
  loadState,
  migrateState,
  resetState,
  saveState,
} from '@/services/repository'
import {
  affectedDependencies,
  buildReleaseSnapshot,
  cloneContractData,
  hashSnapshotEvent,
  releaseReadiness,
  snapshotDifferences,
  validateGovernance,
} from '@/services/selectors'

export const useGovernanceStore = defineStore('governance', () => {
  const data = ref<GovernanceState>(loadState())
  const lastSavedAt = ref(new Date().toISOString())

  const issues = computed(() => validateGovernance(data.value))

  // 其他客户端窗口写入后同步本地状态，保证回执校验基于同一份快照
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return
      try {
        data.value = migrateState(JSON.parse(event.newValue) as GovernanceState)
      } catch {
        // 忽略无法解析的跨窗口写入
      }
    })
  }

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

  // 契约变更后重算候选快照：相关确认与审批失效待重算，已提交的回执内容保留
  const syncReleaseSnapshot = (release: ReleaseCandidate): boolean => {
    try {
      const snapshot = buildReleaseSnapshot(data.value.events, release.eventIds, createId('snap'))
      const previousEventHashes = new Map(
        release.snapshot.events.map((event) => [event.eventId, hashSnapshotEvent(event)]),
      )
      const changedEventIds = new Set(
        snapshot.events
          .filter((event) => previousEventHashes.get(event.eventId) !== hashSnapshotEvent(event))
          .map((event) => event.eventId),
      )
      if (changedEventIds.size === 0) {
        delete release.lastRecomputeError
        return true
      }
      const previousHash = release.snapshot.hash
      const now = new Date().toISOString()
      release.snapshot = snapshot
      release.differences = snapshotDifferences(data.value, snapshot)
      const affected = affectedDependencies(data.value, release.differences)
      affected.forEach((dependencyId) => {
        if (!release.migrationConfirmations.some((item) => item.dependencyId === dependencyId)) {
          release.migrationConfirmations.push({
            id: createId('mig'),
            dependencyId,
            version: release.version,
            status: 'pending',
            reviewer:
              data.value.dependencies.find((dependency) => dependency.id === dependencyId)?.owner ??
              '',
            note: '',
            snapshotHash: snapshot.hash,
          })
        }
      })
      // 已移出影响范围的空占位确认移除；有人工内容的回执一律保留
      release.migrationConfirmations = release.migrationConfirmations.filter(
        (confirmation) =>
          affected.includes(confirmation.dependencyId) ||
          confirmation.status !== 'pending' ||
          confirmation.note.trim().length > 0 ||
          Boolean(confirmation.lastAttempt),
      )
      release.affectedDependencyIds = affected

      const impactedDependencyIds = new Set(
        data.value.dependencies
          .filter(
            (dependency) =>
              dependency.eventIds.some((eventId) => changedEventIds.has(eventId)) ||
              dependency.propertyRefs.some((reference) => changedEventIds.has(reference.eventId)),
          )
          .map((dependency) => dependency.id),
      )
      let staleCount = 0
      release.migrationConfirmations.forEach((confirmation) => {
        if (
          confirmation.status !== 'pending' &&
          impactedDependencyIds.has(confirmation.dependencyId)
        ) {
          confirmation.status = 'stale'
          confirmation.invalidatedAt = now
          staleCount += 1
        }
      })
      release.approvals.forEach((approval) => {
        if (approval.status !== 'pending') {
          approval.status = 'stale'
          approval.invalidatedAt = now
          staleCount += 1
        }
      })
      delete release.lastRecomputeError
      audit(
        'release',
        release.id,
        '契约快照重算',
        `快照 ${previousHash} → ${snapshot.hash}，${staleCount} 条确认/审批失效待重算`,
      )
      return true
    } catch (error) {
      // 重算失败：保留全部回执，记录错误等待重试
      release.lastRecomputeError = error instanceof Error ? error.message : String(error)
      return false
    }
  }

  const syncReleasesForEvent = (eventId: string): void => {
    data.value.releases
      .filter(
        (release) =>
          (release.status === 'reviewing' || release.status === 'draft') &&
          release.eventIds.includes(eventId),
      )
      .forEach((release) => {
        syncReleaseSnapshot(release)
      })
  }

  const retryRecompute = (releaseId: string): boolean => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    if (!release) return false
    const synced = syncReleaseSnapshot(release)
    if (synced) {
      audit('release', release.id, '重试快照重算', `快照已更新至 ${release.snapshot.hash}`)
    }
    persist()
    return synced
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
    syncReleasesForEvent(event.id)
    persist()
  }

  const saveProperty = (eventId: string, property: EventProperty): void => {
    const event = data.value.events.find((item) => item.id === eventId)
    if (!event) return
    const index = event.properties.findIndex((item) => item.id === property.id)
    if (index >= 0) {
      event.properties[index] = property
    } else {
      event.properties.push(property)
    }
    event.updatedAt = new Date().toISOString()
    audit('property', property.id, index >= 0 ? '更新属性' : '新增属性', `${event.key}.${property.name}`)
    syncReleasesForEvent(eventId)
    persist()
  }

  const deleteProperty = (eventId: string, propertyId: string): void => {
    const event = data.value.events.find((item) => item.id === eventId)
    const property = event?.properties.find((item) => item.id === propertyId)
    if (!event || !property) return
    property.deletedAt = new Date().toISOString()
    event.updatedAt = new Date().toISOString()
    audit('property', property.id, '标记删除', `${event.key}.${property.name} 进入删除兼容期`)
    syncReleasesForEvent(eventId)
    persist()
  }

  const savePlatformRule = (eventId: string, rule: PlatformRule): void => {
    const event = data.value.events.find((item) => item.id === eventId)
    if (!event) return
    const index = event.platformRules.findIndex((item) => item.id === rule.id)
    if (index >= 0) {
      event.platformRules[index] = rule
    } else {
      event.platformRules.push(rule)
    }
    event.updatedAt = new Date().toISOString()
    audit('platform_rule', rule.id, index >= 0 ? '更新平台规则' : '新增平台规则', `${event.key}/${rule.platform}`)
    syncReleasesForEvent(eventId)
    persist()
  }

  const createRelease = (version: string, title: string, eventIds: string[]): ReleaseCandidate => {
    const snapshot = buildReleaseSnapshot(data.value.events, eventIds, createId('snap'))
    const differences = snapshotDifferences(data.value, snapshot)
    const affected = affectedDependencies(data.value, differences)
    const release: ReleaseCandidate = {
      id: createId('rel'),
      version,
      title,
      status: 'reviewing',
      eventIds,
      affectedDependencyIds: affected,
      differences,
      snapshot,
      processedReceiptKeys: [],
      migrationConfirmations: affected.map((dependencyId) => ({
        id: createId('mig'),
        dependencyId,
        version,
        status: 'pending',
        reviewer:
          data.value.dependencies.find((dependency) => dependency.id === dependencyId)?.owner ?? '',
        note: '',
        snapshotHash: snapshot.hash,
      })),
      approvals: [
        { id: createId('appr'), role: 'data', actor: '顾清', status: 'pending', comment: '', snapshotHash: snapshot.hash },
        { id: createId('appr'), role: 'product', actor: '丁禾', status: 'pending', comment: '', snapshotHash: snapshot.hash },
        { id: createId('appr'), role: 'client', actor: '江驰', status: 'pending', comment: '', snapshotHash: snapshot.hash },
        { id: createId('appr'), role: 'qa', actor: '余安', status: 'pending', comment: '', snapshotHash: snapshot.hash },
      ],
      createdAt: new Date().toISOString(),
    }
    data.value.releases.unshift(release)
    data.value.currentVersion = version
    audit(
      'release',
      release.id,
      '创建发布候选',
      `${version} 包含 ${eventIds.length} 个事件，契约快照 ${snapshot.hash}，影响 ${affected.length} 个下游依赖`,
    )
    persist()
    return release
  }

  const confirmMigration = (
    releaseId: string,
    confirmationId: string,
    reviewer: string,
    note: string,
    snapshotHash: string,
    receiptKey: string,
  ): ReceiptResult => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    const confirmation = release?.migrationConfirmations.find((item) => item.id === confirmationId)
    if (!release || !confirmation) return { ok: false, reason: 'not_found' }
    if (release.status !== 'reviewing' && release.status !== 'draft') {
      return { ok: false, reason: 'closed' }
    }
    // 重复回执只处理一次
    if (release.processedReceiptKeys.includes(receiptKey)) {
      return { ok: true, duplicate: true }
    }
    if (confirmation.status === 'confirmed' && confirmation.snapshotHash === release.snapshot.hash) {
      return { ok: true, duplicate: true }
    }
    // 与当前快照不匹配的回执退回，内容保留可重试
    if (snapshotHash !== release.snapshot.hash) {
      confirmation.lastAttempt = {
        reviewer,
        note,
        snapshotHash,
        reason: `回执基于快照 ${snapshotHash}，当前快照为 ${release.snapshot.hash}`,
        createdAt: new Date().toISOString(),
      }
      audit(
        'dependency',
        confirmation.dependencyId,
        '退回迁移回执',
        `${reviewer} 的回执与当前快照 ${release.snapshot.hash} 不匹配，已退回`,
      )
      persist()
      return { ok: false, reason: 'stale_snapshot' }
    }
    confirmation.status = 'confirmed'
    confirmation.reviewer = reviewer
    confirmation.note = note
    confirmation.confirmedAt = new Date().toISOString()
    confirmation.snapshotHash = release.snapshot.hash
    delete confirmation.invalidatedAt
    delete confirmation.lastAttempt
    release.processedReceiptKeys.push(receiptKey)
    const dependency = data.value.dependencies.find((item) => item.id === confirmation.dependencyId)
    if (dependency) dependency.status = 'migrated'
    audit('dependency', confirmation.dependencyId, '确认迁移', `${reviewer}：${note}`)
    persist()
    return { ok: true, duplicate: false }
  }

  const updateApproval = (
    releaseId: string,
    role: ReleaseApproval['role'],
    status: 'approved' | 'rejected',
    actor: string,
    comment: string,
    snapshotHash: string,
    receiptKey: string,
  ): ReceiptResult => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    const approval = release?.approvals.find((item) => item.role === role)
    if (!release || !approval) return { ok: false, reason: 'not_found' }
    if (release.status !== 'reviewing' && release.status !== 'draft') {
      return { ok: false, reason: 'closed' }
    }
    // 重复回执只处理一次
    if (release.processedReceiptKeys.includes(receiptKey)) {
      return { ok: true, duplicate: true }
    }
    if (approval.status === status && approval.snapshotHash === release.snapshot.hash) {
      return { ok: true, duplicate: true }
    }
    // 与当前快照不匹配的回执退回，内容保留可重试
    if (snapshotHash !== release.snapshot.hash) {
      approval.lastAttempt = {
        actor,
        decision: status,
        comment,
        snapshotHash,
        reason: `回执基于快照 ${snapshotHash}，当前快照为 ${release.snapshot.hash}`,
        createdAt: new Date().toISOString(),
      }
      audit(
        'release',
        releaseId,
        '退回审批回执',
        `${role} 的审批与当前快照 ${release.snapshot.hash} 不匹配，已退回`,
      )
      persist()
      return { ok: false, reason: 'stale_snapshot' }
    }
    approval.status = status
    approval.actor = actor
    approval.comment = comment
    approval.createdAt = new Date().toISOString()
    approval.snapshotHash = release.snapshot.hash
    delete approval.invalidatedAt
    delete approval.lastAttempt
    release.processedReceiptKeys.push(receiptKey)
    audit('release', releaseId, status === 'approved' ? '审批通过' : '审批驳回', `${role}：${comment}`)
    persist()
    return { ok: true, duplicate: false }
  }

  const publishRelease = (releaseId: string): boolean => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    if (!release || release.lastRecomputeError) return false
    const hash = release.snapshot.hash
    const readiness = releaseReadiness(release, issues.value)
    const migrationsReady = release.migrationConfirmations
      .filter((item) => release.affectedDependencyIds.includes(item.dependencyId))
      .every((item) => item.status === 'confirmed' && item.snapshotHash === hash)
    const approvalsReady = release.approvals.every(
      (item) => item.status === 'approved' && item.snapshotHash === hash,
    )
    if (!migrationsReady || !approvalsReady || readiness < 90) return false
    release.status = 'published'
    release.publishedAt = new Date().toISOString()
    // 发布以当前冻结快照为准
    release.snapshot.events.forEach((snapshotEvent) => {
      const event = data.value.events.find((item) => item.id === snapshotEvent.eventId)
      if (!event) return
      event.status = 'published'
      data.value.baselines.forEach((baseline) => {
        if (baseline.eventId === event.id && baseline.status === 'published') {
          baseline.status = 'superseded'
        }
      })
      data.value.baselines.unshift({
        id: createId('base'),
        eventId: event.id,
        version: snapshotEvent.version,
        properties: cloneContractData(snapshotEvent.properties),
        createdAt: new Date().toISOString(),
        status: 'published',
      })
    })
    audit('release', release.id, '发布契约', `${release.version} 已按快照 ${hash} 发布`)
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
    releaseId: string,
    reason: string,
    scope: string,
    evidence: string,
  ): void => {
    const target = data.value.releases.find((item) => item.id === releaseId)
    if (!target || target.status !== 'published') return
    const now = new Date().toISOString()
    // 恢复目标已发布快照，快照之后新增的契约字段与平台规则保留
    target.snapshot.events.forEach((snapshotEvent) => {
      const event = data.value.events.find((item) => item.id === snapshotEvent.eventId)
      if (!event) return
      const snapshotPropertyIds = new Set(
        snapshotEvent.properties.map((property) => property.id),
      )
      const addedProperties = event.properties.filter(
        (property) => !snapshotPropertyIds.has(property.id),
      )
      event.properties = [...cloneContractData(snapshotEvent.properties), ...addedProperties]
      const snapshotRuleIds = new Set(snapshotEvent.platformRules.map((rule) => rule.id))
      const addedRules = event.platformRules.filter((rule) => !snapshotRuleIds.has(rule.id))
      event.platformRules = [...cloneContractData(snapshotEvent.platformRules), ...addedRules]
      event.updatedAt = now
    })
    // 目标之后发布且事件范围重叠的版本随之失效
    const targetPublishedAt = target.publishedAt ? new Date(target.publishedAt).getTime() : 0
    data.value.releases.forEach((release) => {
      if (
        release.id !== target.id &&
        release.status === 'published' &&
        release.eventIds.some((eventId) => target.eventIds.includes(eventId)) &&
        release.publishedAt !== undefined &&
        new Date(release.publishedAt).getTime() > targetPublishedAt
      ) {
        release.status = 'rolled_back'
      }
    })
    const record: RollbackRecord = {
      id: createId('rollback'),
      releaseId,
      version: target.version,
      reason,
      operator: '当前用户',
      scope,
      createdAt: now,
      status: 'executed',
      evidence,
    }
    data.value.rollbacks.unshift(record)
    target.eventIds.forEach((eventId) => syncReleasesForEvent(eventId))
    audit('rollback', record.id, '执行回滚', `${target.version}：${reason}`)
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
    confirmMigration,
    updateApproval,
    publishRelease,
    retryRecompute,
    saveDeprecation,
    executeRollback,
    verifyRollback,
    resetDemo,
    exportContract,
  }
})
