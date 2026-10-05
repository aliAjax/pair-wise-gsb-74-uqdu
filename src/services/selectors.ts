import type {
  ContractDifference,
  EventDefinition,
  EventProperty,
  EventVersionSnapshot,
  GovernanceState,
  ReleaseCandidate,
  ReleaseContractSnapshot,
  SampleValidationResult,
  Severity,
  SnapshotEventContract,
  ValidationIssue,
} from '@/models/domain'

const NAMING_PATTERN = /^[a-z][a-z0-9_]{2,31}$/
const normalize = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

const tokens = (value: string): Set<string> =>
  new Set(normalize(value).split('_').filter((token) => token.length > 1))

// 状态可能来自 Vue 响应式代理，structuredClone 无法序列化，统一用 JSON 深拷贝
export const cloneContractData = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const similarity = (left: string, right: string): number => {
  const a = tokens(left)
  const b = tokens(right)
  const union = new Set([...a, ...b])
  const intersection = [...a].filter((token) => b.has(token)).length
  return union.size === 0 ? 0 : intersection / union.size
}

export const latestBaseline = (
  baselines: EventVersionSnapshot[],
  eventId: string,
): EventVersionSnapshot | undefined =>
  baselines
    .filter((baseline) => baseline.eventId === eventId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]

const canonicalEventContract = (event: SnapshotEventContract): string =>
  JSON.stringify({
    eventId: event.eventId,
    eventKey: event.eventKey,
    version: event.version,
    properties: event.properties
      .map((property) => [
        property.id,
        property.name,
        property.type,
        property.required ? 1 : 0,
        property.enumValues.join('|'),
        [...property.platforms].sort().join('|'),
        property.deletedAt ? 1 : 0,
      ])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    platformRules: event.platformRules
      .map((rule) => [
        rule.id,
        rule.platform,
        rule.enabled ? 1 : 0,
        rule.trigger,
        [...rule.requiredPropertyIds].sort().join('|'),
      ])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
  })

export const hashContractText = (input: string): string => {
  let hash = 5381
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(index)) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export const hashSnapshotEvent = (event: SnapshotEventContract): string =>
  hashContractText(canonicalEventContract(event))

export const buildReleaseSnapshot = (
  events: EventDefinition[],
  eventIds: string[],
  id: string,
): ReleaseContractSnapshot => {
  const snapshotEvents: SnapshotEventContract[] = eventIds
    .map((eventId) => events.find((item) => item.id === eventId))
    .filter((item): item is EventDefinition => Boolean(item))
    .map((event) => ({
      eventId: event.id,
      eventKey: event.key,
      version: event.version,
      properties: cloneContractData(event.properties),
      platformRules: cloneContractData(event.platformRules),
    }))
  return {
    id,
    hash: hashContractText(snapshotEvents.map(hashSnapshotEvent).sort().join('|')),
    eventIds: [...eventIds],
    events: snapshotEvents,
    createdAt: new Date().toISOString(),
  }
}

export const compareEventContract = (
  event: Pick<EventDefinition, 'id' | 'key' | 'properties'>,
  baseline?: EventVersionSnapshot,
): ContractDifference => {
  const before = baseline?.properties ?? []
  const after = event.properties.filter((property) => !property.deletedAt)
  const beforeMap = new Map(before.map((property) => [property.id, property]))
  const afterMap = new Map(after.map((property) => [property.id, property]))
  const addedProperties: string[] = []
  const removedProperties: string[] = []
  const requiredChanges: string[] = []
  const typeChanges: string[] = []
  const enumChanges: string[] = []

  after.forEach((property) => {
    const previous = beforeMap.get(property.id)
    if (!previous) {
      addedProperties.push(property.name)
      return
    }
    if (previous.required !== property.required) {
      requiredChanges.push(
        `${property.name}: ${previous.required ? '必填' : '选填'} → ${property.required ? '必填' : '选填'}`,
      )
    }
    if (previous.type !== property.type) {
      typeChanges.push(`${property.name}: ${previous.type} → ${property.type}`)
    }
    if (previous.enumValues.join('|') !== property.enumValues.join('|')) {
      const added = property.enumValues.filter((value) => !previous.enumValues.includes(value))
      const removed = previous.enumValues.filter((value) => !property.enumValues.includes(value))
      enumChanges.push(
        `${property.name}: ${added.length ? `新增 ${added.join('/')}` : ''}${added.length && removed.length ? '；' : ''}${removed.length ? `移除 ${removed.join('/')}` : ''}`,
      )
    }
  })

  before.forEach((property) => {
    if (!afterMap.has(property.id)) removedProperties.push(property.name)
  })

  return {
    eventId: event.id,
    eventKey: event.key,
    addedProperties,
    removedProperties,
    requiredChanges,
    typeChanges,
    enumChanges,
  }
}

export const contractDifferences = (
  state: GovernanceState,
  eventIds: string[],
): ContractDifference[] =>
  eventIds
    .map((eventId) => {
      const event = state.events.find((item) => item.id === eventId)
      if (!event) return null
      return compareEventContract(event, latestBaseline(state.baselines, eventId))
    })
    .filter((item): item is ContractDifference => Boolean(item))

export const snapshotDifferences = (
  state: Pick<GovernanceState, 'baselines'>,
  snapshot: ReleaseContractSnapshot,
): ContractDifference[] =>
  snapshot.events.map((event) =>
    compareEventContract(
      { id: event.eventId, key: event.eventKey, properties: event.properties },
      latestBaseline(state.baselines, event.eventId),
    ),
  )

export const affectedDependencies = (
  state: GovernanceState,
  differences: ContractDifference[],
): string[] => {
  const changedPropertyNames = new Set<string>()
  differences.forEach((difference) => {
    ;[
      ...difference.addedProperties,
      ...difference.removedProperties,
      ...difference.requiredChanges.map((item) => item.split(':')[0] ?? ''),
      ...difference.typeChanges.map((item) => item.split(':')[0] ?? ''),
      ...difference.enumChanges.map((item) => item.split(':')[0] ?? ''),
    ].forEach((name) => {
      if (name) changedPropertyNames.add(name)
    })
  })

  return state.dependencies
    .filter((dependency) =>
      dependency.propertyRefs.some((reference) => {
        const event = state.events.find((item) => item.id === reference.eventId)
        const property = event?.properties.find((item) => item.id === reference.propertyId)
        return Boolean(property && changedPropertyNames.has(property.name))
      }),
    )
    .map((dependency) => dependency.id)
}

export const validateGovernance = (state: GovernanceState): ValidationIssue[] => {
  const issues: ValidationIssue[] = []
  const activeEvents = state.events.filter((event) => event.status !== 'retired')

  for (let index = 0; index < activeEvents.length; index += 1) {
    for (let cursor = index + 1; cursor < activeEvents.length; cursor += 1) {
      const left = activeEvents[index]!
      const right = activeEvents[cursor]!
      if (
        left.category === right.category &&
        (similarity(left.key, right.key) >= 0.5 ||
          similarity(left.displayName, right.displayName) >= 0.5)
      ) {
        issues.push({
          id: `duplicate-${left.id}-${right.id}`,
          kind: 'duplicate_event',
          severity: 'high',
          title: `${left.key} 与 ${right.key} 可能重复`,
          detail: `两个事件同属“${left.category}”，名称或语义相似度较高。`,
          entityId: right.id,
          suggestion: '确认是否合并事件，或补充清晰的业务边界说明。',
        })
      }
    }
  }

  activeEvents.forEach((event) => {
    event.properties
      .filter((property) => !property.deletedAt)
      .forEach((property) => {
        if (!NAMING_PATTERN.test(property.name)) {
          issues.push({
            id: `naming-property-${property.id}`,
            kind: 'naming_violation',
            severity: 'medium',
            title: `${event.key}.${property.name} 命名越界`,
            detail: '属性名必须为 3 至 32 位小写 snake_case，并以字母开头。',
            entityId: event.id,
            suggestion: `建议调整为 ${normalize(property.name).slice(0, 32)}。`,
          })
        }
      })
    if (!NAMING_PATTERN.test(event.key)) {
      issues.push({
        id: `naming-event-${event.id}`,
        kind: 'naming_violation',
        severity: 'high',
        title: `${event.key} 事件命名越界`,
        detail: '事件名必须为 3 至 32 位小写 snake_case，并以字母开头。',
        entityId: event.id,
        suggestion: `建议调整为 ${normalize(event.key).slice(0, 32)}。`,
      })
    }
  })

  const properties = activeEvents.flatMap((event) =>
    event.properties.filter((property) => !property.deletedAt).map((property) => ({ event, property })),
  )
  for (let index = 0; index < properties.length; index += 1) {
    for (let cursor = index + 1; cursor < properties.length; cursor += 1) {
      const left = properties[index]!
      const right = properties[cursor]!
      if (
        left.event.id === right.event.id ||
        left.property.name === right.property.name ||
        left.property.type !== right.property.type
      ) {
        continue
      }
      const leftAliases = new Set([left.property.name, ...left.property.synonyms].map(normalize))
      const rightAliases = new Set([right.property.name, ...right.property.synonyms].map(normalize))
      const overlap = [...leftAliases].filter((alias) => rightAliases.has(alias))
      if (overlap.length > 0) {
        issues.push({
          id: `synonym-${left.property.id}-${right.property.id}`,
          kind: 'synonym_property',
          severity: 'medium',
          title: `${left.event.key}.${left.property.name} 与 ${right.event.key}.${right.property.name} 疑似同义`,
          detail: `共享属性别名：${overlap.join('、')}。`,
          entityId: left.event.id,
          suggestion: '统一属性字典，或明确两个字段不可互换的口径差异。',
        })
      }
    }
  }

  activeEvents.forEach((event) => {
    event.properties
      .filter((property) => !property.deletedAt)
      .forEach((property) => {
        const baseline = latestBaseline(state.baselines, event.id)
        const previous = baseline?.properties.find((item) => item.id === property.id)
        if (previous && previous.type !== property.type) {
          issues.push({
            id: `type-${property.id}`,
            kind: 'type_change',
            severity: 'high',
            title: `${event.key}.${property.name} 类型发生变化`,
            detail: `${previous.type} → ${property.type}，下游需要执行迁移兼容。`,
            entityId: event.id,
            suggestion: '确认所有下游依赖已转换为目标类型后再发布。',
          })
        }
      })

    event.platformRules.forEach((rule) => {
      rule.requiredPropertyIds.forEach((propertyId) => {
        const property = event.properties.find((item) => item.id === propertyId)
        if (property && !property.required) {
          issues.push({
            id: `required-${rule.id}-${propertyId}`,
            kind: 'required_mismatch',
            severity: 'medium',
            title: `${event.key} 在 ${rule.platform} 的必填规则不一致`,
            detail: `${rule.platform} 将 ${property.name} 列为必填，但契约属性本身标记为选填。`,
            entityId: event.id,
            suggestion: '统一平台差异说明，或在契约中标记为必填。',
          })
        }
      })
    })
  })

  state.dependencies.forEach((dependency) => {
    dependency.propertyRefs.forEach((reference) => {
      const event = state.events.find((item) => item.id === reference.eventId)
      const property = event?.properties.find((item) => item.id === reference.propertyId)
      if (!property || property.deletedAt) {
        const baseline = latestBaseline(state.baselines, reference.eventId)
        const deletedProperty = baseline?.properties.find((item) => item.id === reference.propertyId)
        issues.push({
          id: `deleted-ref-${dependency.id}-${reference.propertyId}`,
          kind: 'deleted_property_referenced',
          severity: 'critical',
          title: `${dependency.name} 仍引用已删除属性`,
          detail: `${event?.key ?? reference.eventId}.${deletedProperty?.name ?? reference.propertyId} 已不在当前契约中。`,
          entityId: dependency.id,
          suggestion: '要求下游完成迁移确认，或恢复属性并重新评审。',
        })
      }
    })
  })

  return issues.sort((a, b) => {
    const rank: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1 }
    return rank[b.severity] - rank[a.severity]
  })
}

export const validateSample = (
  event: EventDefinition,
  payload: Record<string, unknown>,
): SampleValidationResult => {
  const errors: string[] = []
  const warnings: string[] = []
  const activeProperties = event.properties.filter((property) => !property.deletedAt)

  activeProperties.forEach((property) => {
    const value = payload[property.name]
    if (property.required && (value === undefined || value === null || value === '')) {
      errors.push(`缺少必填属性 ${property.name}`)
      return
    }
    if (value === undefined || value === null) return

    const typeMatches = (() => {
      switch (property.type) {
        case 'string':
        case 'enum':
          return typeof value === 'string'
        case 'number':
          return typeof value === 'number'
        case 'boolean':
          return typeof value === 'boolean'
        case 'array':
          return Array.isArray(value)
        case 'object':
          return typeof value === 'object' && !Array.isArray(value)
      }
    })()
    if (!typeMatches) {
      errors.push(`${property.name} 期望 ${property.type}，实际为 ${Array.isArray(value) ? 'array' : typeof value}`)
    }
    if (
      property.type === 'enum' &&
      typeof value === 'string' &&
      !property.enumValues.includes(value)
    ) {
      errors.push(`${property.name} 的值 ${value} 不在枚举 ${property.enumValues.join('/')} 中`)
    }
  })

  Object.keys(payload).forEach((key) => {
    if (!activeProperties.some((property) => property.name === key)) {
      warnings.push(`示例包含未声明属性 ${key}`)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}

export const releaseReadiness = (
  release: ReleaseCandidate,
  issues: ValidationIssue[],
): number => {
  const scopedConfirmations = release.migrationConfirmations.filter((item) =>
    release.affectedDependencyIds.includes(item.dependencyId),
  )
  const migrationTotal = scopedConfirmations.length
  const migrationDone = scopedConfirmations.filter(
    (item) => item.status === 'confirmed',
  ).length
  const approvalTotal = release.approvals.length
  const approvalDone = release.approvals.filter((item) => item.status === 'approved').length
  const issuePenalty = Math.min(
    40,
    issues.filter((issue) => release.eventIds.includes(issue.entityId)).length * 8,
  )
  const migrationScore = migrationTotal === 0 ? 40 : (migrationDone / migrationTotal) * 40
  const approvalScore = approvalTotal === 0 ? 30 : (approvalDone / approvalTotal) * 30
  return Math.max(0, Math.round(migrationScore + approvalScore + 30 - issuePenalty))
}

export const propertyReferences = (
  state: GovernanceState,
  propertyId: string,
): Array<{ event: EventDefinition; property: EventProperty }> =>
  state.events.flatMap((event) => {
    const property = event.properties.find((item) => item.id === propertyId)
    return property ? [{ event, property }] : []
  })
