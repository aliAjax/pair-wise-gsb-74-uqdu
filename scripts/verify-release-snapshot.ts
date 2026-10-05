// 端到端验证：契约快照冻结 / 回执校验与幂等 / 失效重算 / 快照发布 / 快照回滚
const storage = new Map<string, string>()
// @ts-expect-error 测试环境模拟 localStorage
globalThis.localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, String(value)),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => storage.clear(),
  key: (index: number) => [...storage.keys()][index] ?? null,
  get length() {
    return storage.size
  },
}

const { createPinia, setActivePinia } = await import('pinia')
const { useGovernanceStore } = await import('@/stores/governance')

setActivePinia(createPinia())
const store = useGovernanceStore()

let passed = 0
let failed = 0
const assert = (condition: boolean, label: string): void => {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.error(`  ✗ ${label}`)
  }
}

const rel = () => store.data.releases.find((item) => item.id === 'rel-001')!
const evt = (id: string) => store.data.events.find((item) => item.id === id)!

console.log('A. 候选冻结为契约快照')
{
  const release = rel()
  assert(Boolean(release.snapshot.hash), '评审中的候选带有快照哈希')
  assert(release.snapshot.events.length === 3, '快照包含范围内 3 个事件的完整契约')
  assert(
    release.snapshot.events.every((event) => event.properties.length > 0 && event.platformRules.length >= 0),
    '快照冻结了属性与平台规则',
  )
  assert(
    release.migrationConfirmations.every((item) => item.snapshotHash === release.snapshot.hash) &&
      release.approvals.every((item) => item.snapshotHash === release.snapshot.hash),
    '种子回执均绑定当前快照哈希',
  )
}

console.log('B. 快照不匹配的回执被退回，内容保留')
{
  const hash = rel().snapshot.hash
  const rejected = store.confirmMigration('rel-001', 'mig-001', '数据产品组', '基于旧快照的确认', 'deadbeef', 'rcpt-b1')
  assert(!rejected.ok && !rejected.ok && rejected.reason === 'stale_snapshot', '错误哈希的回执被退回')
  const confirmation = rel().migrationConfirmations.find((item) => item.id === 'mig-001')!
  assert(confirmation.status === 'pending', '被退回的回执保持待处理')
  assert(confirmation.lastAttempt?.note === '基于旧快照的确认', '被退回的回执内容保留可重试')
  assert(rel().snapshot.hash === hash, '退回不改变当前快照')
}

console.log('C. 正常回执与幂等')
{
  const hash = rel().snapshot.hash
  const first = store.confirmMigration('rel-001', 'mig-001', '数据产品组', '看板已适配', hash, 'rcpt-c1')
  assert(first.ok && !first.duplicate, '匹配快照的回执确认成功')
  const confirmedAt = rel().migrationConfirmations.find((item) => item.id === 'mig-001')!.confirmedAt
  const againSameKey = store.confirmMigration('rel-001', 'mig-001', '数据产品组', '看板已适配', hash, 'rcpt-c1')
  assert(againSameKey.ok && againSameKey.duplicate, '相同幂等键的重复回执只处理一次')
  const againNewKey = store.confirmMigration('rel-001', 'mig-001', '数据产品组', '重复提交', hash, 'rcpt-c2')
  assert(againNewKey.ok && againNewKey.duplicate, '已确认的回执再次提交按重复处理')
  const confirmation = rel().migrationConfirmations.find((item) => item.id === 'mig-001')!
  assert(confirmation.confirmedAt === confirmedAt && confirmation.note === '看板已适配', '重复回执不覆盖首次处理结果')
  assert(store.data.dependencies.find((item) => item.id === 'dep-001')!.status === 'migrated', '依赖状态同步为已迁移')

  const approve = store.updateApproval('rel-001', 'product', 'approved', '丁禾', '口径无误', hash, 'rcpt-c3')
  assert(approve.ok && !approve.duplicate, '审批回执提交成功')
  const approveAgain = store.updateApproval('rel-001', 'product', 'approved', '丁禾', '口径无误', hash, 'rcpt-c3')
  assert(approveAgain.ok && approveAgain.duplicate, '重复审批回执只处理一次')
}

console.log('D. 字段/必填变更使相关确认与审批失效待重算')
{
  store.updateApproval('rel-001', 'product', 'approved', '丁禾', '通过', rel().snapshot.hash, 'rcpt-d1')
  store.updateApproval('rel-001', 'client', 'approved', '江驰', '通过', rel().snapshot.hash, 'rcpt-d2')
  store.updateApproval('rel-001', 'qa', 'approved', '余安', '通过', rel().snapshot.hash, 'rcpt-d3')
  store.confirmMigration('rel-001', 'mig-003', '增长实验组', '实验口径已冻结', rel().snapshot.hash, 'rcpt-d4')
  store.confirmMigration('rel-001', 'mig-004', '营销数据组', '只读兼容确认', rel().snapshot.hash, 'rcpt-d5')
  const before = rel().snapshot.hash

  const amount = evt('evt-001').properties.find((item) => item.id === 'prop-002')!
  store.saveProperty('evt-001', { ...amount, required: false })

  const release = rel()
  assert(release.snapshot.hash !== before, '必填变更后快照哈希重算')
  const statusOf = (id: string) => release.migrationConfirmations.find((item) => item.id === id)!.status
  assert(statusOf('mig-001') === 'stale', '引用变更事件的确认（dep-001）失效')
  assert(statusOf('mig-003') === 'stale', '引用变更事件的确认（dep-005）失效')
  assert(statusOf('mig-002') === 'confirmed', '未受影响的确认（dep-004）保持有效')
  assert(statusOf('mig-004') === 'confirmed', '未受影响的确认（dep-006）保持有效')
  assert(release.approvals.every((item) => item.status === 'stale'), '四角色审批全部失效待重算')
  assert(
    release.migrationConfirmations.find((item) => item.id === 'mig-001')!.note === '看板已适配' &&
      release.approvals.every((item) => item.comment.length > 0),
    '失效回执的已提交内容全部保留',
  )
  assert(
    release.differences.some((diff) => diff.eventId === 'evt-001' && diff.requiredChanges.length > 0),
    '差异按新快照重算并包含必填变化',
  )
}

console.log('E. 平台规则变更同样触发失效')
{
  const rule = evt('evt-003').platformRules.find((item) => item.id === 'rule-009')!
  const before = rel().snapshot.hash
  store.savePlatformRule('evt-003', {
    ...rule,
    requiredPropertyIds: [...rule.requiredPropertyIds, 'prop-013'],
  })
  const release = rel()
  assert(release.snapshot.hash !== before, '平台规则变更后快照哈希重算')
  assert(
    release.migrationConfirmations.find((item) => item.id === 'mig-002')!.status === 'stale',
    '依赖该事件平台规则的确认（dep-004）失效',
  )
}

console.log('F. 并发场景：窗口持有旧快照的回执被退回，可按新快照重试')
{
  const seenHash = rel().snapshot.hash
  const currency = evt('evt-001').properties.find((item) => item.id === 'prop-003')!
  store.saveProperty('evt-001', { ...currency, enumValues: [...currency.enumValues, 'EUR'] })
  const current = rel().snapshot.hash
  assert(current !== seenHash, '另一窗口修改字段后快照已变更')
  const rejected = store.updateApproval('rel-001', 'data', 'approved', '顾清', '旧快照审批', seenHash, 'rcpt-f1')
  assert(!rejected.ok && rejected.reason === 'stale_snapshot', '持旧快照的审批回执被退回')
  const approval = rel().approvals.find((item) => item.role === 'data')!
  assert(approval.lastAttempt?.comment === '旧快照审批', '被退回的审批内容保留')
  const retry = store.updateApproval('rel-001', 'data', 'approved', '顾清', '旧快照审批', current, 'rcpt-f2')
  assert(retry.ok && !retry.duplicate, '按新快照重试成功')
  assert(!rel().approvals.find((item) => item.role === 'data')!.lastAttempt, '重试成功后清理退回记录')
}

console.log('G. 发布使用当前快照')
{
  const created = store.createRelease('2026.11.0', '城市画像契约发布', ['evt-006'])
  const hash = created.snapshot.hash
  assert(
    created.migrationConfirmations.length === 0 &&
      created.differences.every(
        (diff) =>
          diff.addedProperties.length === 0 &&
          diff.removedProperties.length === 0 &&
          diff.requiredChanges.length === 0 &&
          diff.typeChanges.length === 0 &&
          diff.enumChanges.length === 0,
      ),
    '无差异的候选无需迁移确认',
  )
  for (const [index, role] of (['data', 'product', 'client', 'qa'] as const).entries()) {
    const result = store.updateApproval(created.id, role, 'approved', '负责人', '通过', hash, `rcpt-g${index}`)
    assert(result.ok, `角色 ${role} 按当前快照审批`)
  }
  const published = store.publishRelease(created.id)
  assert(published, '全部回执绑定当前快照后允许发布')
  const release = store.data.releases.find((item) => item.id === created.id)!
  assert(release.status === 'published', '候选状态为已发布')
  const baseline = store.data.baselines.find((item) => item.eventId === 'evt-006' && item.status === 'published')
  assert(
    baseline?.properties.length === release.snapshot.events[0]!.properties.length,
    '新基线来自发布时的快照',
  )
  assert(
    store.data.baselines.find((item) => item.id === 'base-005')!.status === 'superseded',
    '旧基线标记为已取代',
  )
  const blocked = store.updateApproval(created.id, 'data', 'approved', '负责人', '重复', hash, 'rcpt-g9')
  assert(!blocked.ok && blocked.reason === 'closed', '已发布的候选不再接受回执')
}

console.log('H. 回滚恢复目标已发布快照并保留之后新增的契约')
{
  const payResult = evt('evt-002').properties.find((item) => item.id === 'prop-007')!
  store.saveProperty('evt-002', { ...payResult, type: 'string' })
  store.saveProperty('evt-002', {
    id: 'prop-new-01',
    eventId: 'evt-002',
    name: 'risk_level',
    displayName: '风险等级',
    type: 'number',
    required: false,
    description: '支付风险等级。',
    enumValues: [],
    owner: '支付平台组',
    synonyms: [],
    platforms: ['server'],
  })
  assert(
    evt('evt-002').properties.find((item) => item.id === 'prop-007')!.type === 'string',
    '回滚前契约修改已生效',
  )
  const rel001HashBefore = rel().snapshot.hash

  store.executeRollback('rel-000', '支付结果类型变更引发告警', 'production 全量', 'EVD-001')

  const restored = evt('evt-002')
  assert(
    restored.properties.find((item) => item.id === 'prop-007')!.type === 'enum',
    '目标已发布快照中的字段类型被恢复',
  )
  assert(
    restored.properties.some((item) => item.id === 'prop-new-01'),
    '快照之后新增的契约字段保留',
  )
  const rollbackRecord = store.data.rollbacks[0]!
  assert(rollbackRecord.version === '2026.09.0' && rollbackRecord.status === 'executed', '回滚台账已记录')
  assert(
    store.data.releases.find((item) => item.id === 'rel-000')!.status === 'published',
    '回滚目标版本保持已发布',
  )
  const laterRelease = store.data.releases.find((item) => item.version === '2026.11.0')!
  assert(laterRelease.status === 'rolled_back', '目标之后发布且范围重叠的版本标记为已回滚')
  assert(rel().snapshot.hash === rel001HashBefore, '范围外候选的快照不受回滚影响')
}

console.log('I. 重算失败保留回执并可重试')
{
  const hashBefore = rel().snapshot.hash
  const confirmationsBefore = JSON.stringify(rel().migrationConfirmations)
  const approvalsBefore = JSON.stringify(rel().approvals)
  const originalStringify = JSON.stringify
  // @ts-expect-error 模拟重算异常
  JSON.stringify = () => {
    throw new Error('模拟快照重算失败')
  }
  try {
    const amount = evt('evt-001').properties.find((item) => item.id === 'prop-002')!
    store.saveProperty('evt-001', { ...amount, required: true })
  } catch {
    // 模拟故障同样影响持久化，此处忽略
  } finally {
    JSON.stringify = originalStringify
  }
  const release = rel()
  assert(release.lastRecomputeError === '模拟快照重算失败', '重算失败被记录')
  assert(release.snapshot.hash === hashBefore, '失败时保留原快照')
  assert(
    JSON.stringify(release.migrationConfirmations) === confirmationsBefore &&
      JSON.stringify(release.approvals) === approvalsBefore,
    '失败时全部回执原样保留',
  )
  const retried = store.retryRecompute('rel-001')
  assert(retried && !release.lastRecomputeError, '重试后重算成功并清除错误')
  assert(release.snapshot.hash !== hashBefore, '重试后快照更新到新哈希')
}

console.log(`\n结果：${passed} 通过，${failed} 失败`)
if (failed > 0) process.exit(1)
