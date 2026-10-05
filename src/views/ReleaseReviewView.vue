<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useQueryClient } from '@tanstack/vue-query'
import {
  AddIcon,
  CheckCircleIcon,
  ChevronRightIcon,
  CloseCircleIcon,
  DownloadIcon,
  RefreshIcon,
} from 'tdesign-icons-vue-next'
import { MessagePlugin } from 'tdesign-vue-next'
import PageHeader from '@/components/PageHeader.vue'
import StatusTag from '@/components/StatusTag.vue'
import { useReleaseQuery, useReleasesQuery } from '@/composables/useGovernanceQueries'
import type { ReceiptRecord, ReleaseApproval } from '@/models/domain'
import { releaseReadiness, releaseSnapshotDrifts } from '@/services/selectors'
import { useGovernanceStore } from '@/stores/governance'

interface ClientWindow {
  clientId: string
  label: string
  syncedRevision: number
}

const store = useGovernanceStore()
const queryClient = useQueryClient()
const releasesQuery = useReleasesQuery()
const releaseId = ref(
  store.data.releases.find((release) => release.status === 'reviewing')?.id ??
    store.data.releases[0]?.id ??
    '',
)
const releaseQuery = useReleaseQuery(releaseId)
const release = computed(
  () =>
    releaseQuery.data.value ??
    store.data.releases.find((item) => item.id === releaseId.value) ??
    null,
)
const releases = computed(() => releasesQuery.data.value ?? store.data.releases)
const readiness = computed(() => (release.value ? releaseReadiness(release.value, store.issues) : 0))
const drifts = computed(() =>
  release.value ? releaseSnapshotDrifts(store.data, release.value) : [],
)

// 两个客户端窗口，各自维护已同步的快照修订
const clientWindows = reactive<Record<string, ClientWindow>>({
  a: {
    clientId: 'client-a',
    label: '客户端窗口 A（Web 2.20.1）',
    syncedRevision: 1,
  },
  b: {
    clientId: 'client-b',
    label: '客户端窗口 B（iOS 8.4.0）',
    syncedRevision: 1,
  },
})
const activeClientKey = ref<'a' | 'b'>('a')
const activeClient = computed(() => clientWindows[activeClientKey.value])
const windowStale = computed(
  () =>
    Boolean(release.value) && activeClient.value.syncedRevision !== release.value!.snapshotRevision,
)

const syncWindow = (key: 'a' | 'b'): void => {
  if (!release.value) return
  clientWindows[key].syncedRevision = release.value.snapshotRevision
  MessagePlugin.info(`${clientWindows[key].label} 已同步至快照修订 ${release.value.snapshotRevision}`)
}

const createVisible = ref(false)
const migrationVisible = ref(false)
const approvalVisible = ref(false)
const createForm = reactive({
  version: '',
  title: '',
  eventIds: [] as string[],
})
const migrationForm = reactive({
  confirmationId: '',
  reviewer: '',
  note: '',
  idempotencyKey: '',
})
const approvalForm = reactive({
  approvalId: '',
  role: 'data' as ReleaseApproval['role'],
  actor: '',
  comment: '',
  idempotencyKey: '',
})
const selectedApprovalIds = ref<string[]>([])
const approvalComment = ref('')
const singleApproval = ref<ReleaseApproval | null>(null)

const receipts = computed<ReceiptRecord[]>(() => release.value?.receipts ?? [])

const eventName = (eventId: string): string => {
  const event = store.data.events.find((item) => item.id === eventId)
  return event ? `${event.displayName} (${event.key})` : eventId
}
const dependencyName = (dependencyId: string): string =>
  store.data.dependencies.find((dependency) => dependency.id === dependencyId)?.name ?? dependencyId
const roleLabel = (role: ReleaseApproval['role']): string =>
  ({ data: '数据负责人', product: '产品负责人', client: '客户端负责人', qa: '测试负责人' })[role]

const invalidate = async (): Promise<void> => {
  await queryClient.invalidateQueries({ queryKey: ['release'] })
  await queryClient.invalidateQueries({ queryKey: ['releases'] })
  await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
  await queryClient.invalidateQueries({ queryKey: ['lineage'] })
}

const notifyReceiptResult = async (
  result: { ok: boolean; status: string; message: string },
  successText: string,
): Promise<void> => {
  if (result.status === 'duplicate') {
    await MessagePlugin.warning(result.message)
  } else if (result.ok) {
    await MessagePlugin.success(result.message || successText)
  } else {
    await MessagePlugin.error(result.message)
  }
}

const newIdempotencyKey = (target: string): string =>
  `idem-${target}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

const openCreate = (): void => {
  createForm.version = `2026.${String(Number(store.data.currentVersion.split('.')[1] ?? 10) + 1).padStart(2, '0')}.0`
  createForm.title = ''
  createForm.eventIds = []
  createVisible.value = true
}

const createRelease = async (): Promise<void> => {
  if (!createForm.version.trim() || !createForm.title.trim() || createForm.eventIds.length === 0) {
    await MessagePlugin.error('版本号、标题和事件范围不能为空')
    return
  }
  const created = store.createRelease(createForm.version, createForm.title, createForm.eventIds)
  releaseId.value = created.id
  clientWindows.a.syncedRevision = created.snapshotRevision
  clientWindows.b.syncedRevision = created.snapshotRevision
  createVisible.value = false
  await invalidate()
  await MessagePlugin.success('发布候选已冻结契约快照，并基于快照生成下游迁移清单')
}

const openMigration = (confirmationId: string): void => {
  const confirmation = release.value?.migrationConfirmations.find(
    (item) => item.id === confirmationId,
  )
  if (!confirmation) return
  migrationForm.confirmationId = confirmationId
  migrationForm.reviewer = confirmation.reviewer
  migrationForm.note = confirmation.note
  migrationForm.idempotencyKey = newIdempotencyKey(confirmationId)
  migrationVisible.value = true
}

const submitMigration = async (): Promise<void> => {
  if (!release.value) return
  if (!migrationForm.reviewer.trim() || !migrationForm.note.trim()) {
    await MessagePlugin.error('确认人和迁移说明不能为空，否则回执会因校验失败保留可重试')
    return
  }
  const result = store.submitReceipt({
    releaseId: release.value.id,
    kind: 'migration',
    targetId: migrationForm.confirmationId,
    clientId: activeClient.value.clientId,
    clientLabel: activeClient.value.label,
    idempotencyKey: migrationForm.idempotencyKey,
    baseRevision: activeClient.value.syncedRevision,
    payload: {
      reviewer: migrationForm.reviewer,
      note: migrationForm.note,
      decision: 'confirmed',
    },
  })
  migrationVisible.value = false
  await invalidate()
  await notifyReceiptResult(result, '下游迁移已确认')
}

const openApproval = (approval: ReleaseApproval): void => {
  singleApproval.value = approval
  approvalForm.approvalId = approval.id
  approvalForm.role = approval.role
  approvalForm.actor = approval.actor
  approvalForm.comment = approval.comment
  approvalForm.idempotencyKey = newIdempotencyKey(approval.id)
  approvalComment.value = approval.comment
  approvalVisible.value = true
}

const submitApproval = async (status: ReleaseApproval['status']): Promise<void> => {
  if (!release.value || !singleApproval.value || !approvalForm.comment.trim()) {
    await MessagePlugin.error('审批意见不能为空，否则回执会因校验失败保留可重试')
    return
  }
  const result = store.submitReceipt({
    releaseId: release.value.id,
    kind: 'approval',
    targetId: singleApproval.value.id,
    clientId: activeClient.value.clientId,
    clientLabel: activeClient.value.label,
    idempotencyKey: approvalForm.idempotencyKey,
    baseRevision: activeClient.value.syncedRevision,
    payload: {
      actor: approvalForm.actor,
      comment: approvalForm.comment,
      decision: status === 'rejected' ? 'rejected' : 'approved',
    },
  })
  approvalVisible.value = false
  await invalidate()
  await notifyReceiptResult(result, status === 'approved' ? '审批已通过' : '审批已驳回')
}

const batchApprove = async (): Promise<void> => {
  if (!release.value) return
  if (selectedApprovalIds.value.length === 0 || !approvalComment.value.trim()) {
    await MessagePlugin.error('请选择审批项并填写批量审批意见')
    return
  }
  const results = selectedApprovalIds.value.map((id) => {
    const approval = release.value?.approvals.find((item) => item.id === id)
    if (!approval) return null
    return store.submitReceipt({
      releaseId: release.value!.id,
      kind: 'approval',
      targetId: approval.id,
      clientId: activeClient.value.clientId,
      clientLabel: activeClient.value.label,
      idempotencyKey: newIdempotencyKey(approval.id),
      baseRevision: activeClient.value.syncedRevision,
      payload: {
        actor: approval.actor,
        comment: approvalComment.value,
        decision: 'approved',
      },
    })
  })
  selectedApprovalIds.value = []
  approvalComment.value = ''
  await invalidate()
  const failed = results.filter((item) => item && !item.ok)
  if (failed.length === 0) {
    await MessagePlugin.success('批量审批回执已提交')
  } else {
    await MessagePlugin.warning(`批量提交完成：${results.length - failed.length} 条受理，${failed.length} 条退回，详见回执台账`)
  }
}

const recalculate = async (): Promise<void> => {
  if (!release.value) return
  if (!store.recalculateRelease(release.value.id)) {
    await MessagePlugin.error('仅评审中候选可以重算快照')
    return
  }
  // 重算后两个窗口持有的修订均过期，需要各自重新同步才能再提交
  await invalidate()
  await MessagePlugin.success('契约快照已按当前字段/必填/平台规则重算，失效确认与审批回到待处理')
}

const publish = async (): Promise<void> => {
  if (!release.value) return
  if (release.value.driftDetected) {
    await MessagePlugin.error('当前快照与实时契约不一致，请先重算后再发布')
    return
  }
  if (!store.publishRelease(release.value.id)) {
    await MessagePlugin.error('迁移确认或四角色审批尚未完成，当前不可发布')
    return
  }
  await invalidate()
  await MessagePlugin.success('已按当前冻结快照发布事件契约版本')
}

const retryReceipt = async (receipt: ReceiptRecord): Promise<void> => {
  if (!release.value) return
  if (receipt.status === 'failed') {
    if (receipt.kind === 'migration') {
      openMigration(receipt.targetId)
    } else {
      const approval = release.value.approvals.find((item) => item.id === receipt.targetId)
      if (approval) openApproval(approval)
    }
    return
  }
  const result = store.retryReceipt(release.value.id, receipt.id)
  if (!result) {
    await MessagePlugin.error('回执不存在，无法重试')
    return
  }
  await invalidate()
  await notifyReceiptResult(result, '回执重试已受理')
}

const receiptTargetLabel = (receipt: ReceiptRecord): string =>
  receipt.kind === 'migration'
    ? `迁移确认 · ${dependencyName(
        release.value?.migrationConfirmations.find((item) => item.id === receipt.targetId)
          ?.dependencyId ?? receipt.targetId,
      )}`
    : `审批 · ${roleLabel(
      release.value?.approvals.find((item) => item.id === receipt.targetId)?.role ?? 'data',
    )}`

const downloadDiff = (): void => {
  if (!release.value) return
  const content = JSON.stringify(
    {
      release: release.value.version,
      snapshotRevision: release.value.snapshotRevision,
      frozenAt: release.value.frozenAt,
      events: release.value.eventIds.map(eventName),
      differences: release.value.differences,
      affectedDependencies: release.value.affectedDependencyIds.map(dependencyName),
      migrationConfirmations: release.value.migrationConfirmations,
    },
    null,
    2,
  )
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${release.value.version}-contract-snapshot.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

const setApprovalChecked = (approvalId: string, checked: unknown): void => {
  selectedApprovalIds.value = checked
    ? [...selectedApprovalIds.value, approvalId]
    : selectedApprovalIds.value.filter((id) => id !== approvalId)
}
</script>

<template>
  <div class="page">
    <PageHeader
      eyebrow="发布门禁"
      title="版本差异与发布评审"
      description="创建候选时冻结契约快照；双窗口回执按快照修订校验、幂等去重；字段或平台规则变更后相关确认与审批失效，重算后重新评审。"
    />

    <section class="panel filter-panel">
      <div class="toolbar-row">
        <div class="toolbar-field release-field">
          <span>发布候选</span>
          <t-select
            v-model="releaseId"
            :options="releases.map((item) => ({ label: `${item.version} ${item.title}`, value: item.id }))"
          />
        </div>
        <div class="filter-actions">
          <t-button variant="outline" :disabled="!release" @click="downloadDiff">
            <template #icon><DownloadIcon /></template>
            导出快照差异
          </t-button>
          <t-button theme="primary" @click="openCreate">
            <template #icon><AddIcon /></template>
            创建发布候选
          </t-button>
        </div>
      </div>
    </section>

    <template v-if="release">
      <section class="panel client-panel">
        <div class="client-tabs">
          <button
            v-for="(client, key) in clientWindows"
            :key="client.clientId"
            type="button"
            class="client-tab"
            :class="{ active: activeClientKey === key }"
            @click="activeClientKey = key as 'a' | 'b'"
          >
            <strong>{{ client.label }}</strong>
            <span :class="{ stale: client.syncedRevision !== release.snapshotRevision }">
              已同步修订 {{ client.syncedRevision }} / 当前 {{ release.snapshotRevision }}
              <em v-if="client.syncedRevision !== release.snapshotRevision">（快照已过期）</em>
            </span>
          </button>
        </div>
        <div class="client-actions">
          <t-button variant="outline" size="small" @click="syncWindow(activeClientKey)">
            <template #icon><RefreshIcon /></template>
            同步当前快照修订
          </t-button>
          <t-tag v-if="windowStale" theme="warning" variant="light">
            {{ activeClient.label }} 立即提交将被退回
          </t-tag>
          <t-tag v-else theme="success" variant="light">
            {{ activeClient.label }} 可提交回执
          </t-tag>
        </div>
      </section>

      <section v-if="release.driftDetected" class="panel drift-panel">
        <div class="drift-head">
          <CloseCircleIcon />
          <div>
            <strong>冻结快照与实时契约不一致，发布已拦截</strong>
            <span>字段、必填或平台规则在评审期间发生变化，相关迁移确认与审批已失效并列待重算。</span>
          </div>
          <t-button theme="primary" @click="recalculate">
            <template #icon><RefreshIcon /></template>
            重算为新快照（修订 {{ release.snapshotRevision + 1 }}）
          </t-button>
        </div>
        <ul class="drift-list">
          <li v-for="drift in drifts" :key="drift.eventId">
            <strong>{{ eventName(drift.eventId) }}</strong>
            <span v-for="item in drift.propertyChanges" :key="item">{{ item }}</span>
            <span v-for="item in drift.platformRuleChanges" :key="item">{{ item }}</span>
          </li>
        </ul>
        <p class="drift-queue">
          待重算：{{ release.recalculationQueue.length }} 项确认/审批，重算后回到待处理状态重新评审
        </p>
      </section>

      <section class="release-overview">
        <div>
          <span>版本</span>
          <strong>{{ release.version }}</strong>
          <StatusTag :value="release.status" />
        </div>
        <div>
          <span>标题</span>
          <strong>{{ release.title }}</strong>
        </div>
        <div>
          <span>快照修订</span>
          <strong>#{{ release.snapshotRevision }}</strong>
          <span>冻结于 {{ new Date(release.frozenAt).toLocaleString('zh-CN') }}</span>
        </div>
        <div>
          <span>发布就绪度</span>
          <strong>{{ readiness }}%</strong>
        </div>
        <t-button
          theme="primary"
          :disabled="release.status === 'published' || release.status === 'rolled_back' || release.driftDetected"
          @click="publish"
        >
          发布契约
          <template #suffix><ChevronRightIcon /></template>
        </t-button>
      </section>

      <div class="release-grid">
        <section class="panel">
          <div class="panel-header">
            <h2 class="panel-title">冻结快照差异</h2>
            <span class="muted">
              {{ release.differences.length }} 个事件 · 快照修订 #{{ release.snapshotRevision }}
            </span>
          </div>
          <div class="diff-list">
            <article v-for="difference in release.differences" :key="difference.eventId" class="diff-event">
              <div class="diff-event-head">
                <strong>{{ difference.eventKey }}</strong>
                <span>{{ eventName(difference.eventId) }}</span>
              </div>
              <div class="diff-columns">
                <div class="diff-block">
                  <h4>新增与删除</h4>
                  <ul>
                    <li v-for="item in difference.addedProperties" :key="`add-${item}`">
                      新增属性 {{ item }}
                    </li>
                    <li v-for="item in difference.removedProperties" :key="`remove-${item}`">
                      删除属性 {{ item }}
                    </li>
                  </ul>
                  <span
                    v-if="
                      difference.addedProperties.length === 0 &&
                      difference.removedProperties.length === 0
                    "
                    class="muted"
                  >
                    无属性增删
                  </span>
                </div>
                <div class="diff-block">
                  <h4>兼容性变化</h4>
                  <ul>
                    <li v-for="item in difference.requiredChanges" :key="item">{{ item }}</li>
                    <li v-for="item in difference.typeChanges" :key="item">{{ item }}</li>
                    <li v-for="item in difference.enumChanges" :key="item">{{ item }}</li>
                  </ul>
                  <span
                    v-if="
                      difference.requiredChanges.length === 0 &&
                      difference.typeChanges.length === 0 &&
                      difference.enumChanges.length === 0
                    "
                    class="muted"
                  >
                    无破坏性变化
                  </span>
                </div>
              </div>
            </article>
            <div v-if="release.differences.length === 0" class="empty-state">该快照没有契约差异。</div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <h2 class="panel-title">发布门禁</h2>
          </div>
          <div class="gate-list">
            <div class="gate-row">
              <CheckCircleIcon />
              <div>
                <strong>契约快照已冻结</strong>
                <span>{{ release.snapshot.length }} 个事件参与发布，修订 #{{ release.snapshotRevision }}</span>
              </div>
            </div>
            <div class="gate-row">
              <CheckCircleIcon
                :class="{
                  pending: release.migrationConfirmations.some((item) => item.status !== 'confirmed'),
                }"
              />
              <div>
                <strong>下游迁移确认</strong>
                <span>
                  {{
                    release.migrationConfirmations.filter((item) => item.status === 'confirmed').length
                  }}/{{ release.migrationConfirmations.length }} 已确认
                </span>
              </div>
            </div>
            <div class="gate-row">
              <CheckCircleIcon
                :class="{ pending: release.approvals.some((item) => item.status !== 'approved') }"
              />
              <div>
                <strong>四角色批量审批</strong>
                <span>
                  {{ release.approvals.filter((item) => item.status === 'approved').length }}/{{
                    release.approvals.length
                  }}
                  已通过
                </span>
              </div>
            </div>
            <div class="readiness">
              <span>综合就绪度</span>
              <strong>{{ readiness }}%</strong>
              <t-progress :percentage="readiness" :label="false" />
            </div>
          </div>
        </section>
      </div>

      <div class="review-columns">
        <section class="panel">
          <div class="panel-header">
            <h2 class="panel-title">下游迁移确认（回执）</h2>
            <span class="muted">由 {{ activeClient.label }} 提交</span>
          </div>
          <div class="migration-list">
            <article
              v-for="confirmation in release.migrationConfirmations"
              :key="confirmation.id"
              class="migration-card"
              :class="{ invalid: confirmation.status === 'invalidated' }"
            >
              <div>
                <strong>{{ dependencyName(confirmation.dependencyId) }}</strong>
                <span>{{ confirmation.reviewer || '未指定确认人' }}</span>
              </div>
              <StatusTag :value="confirmation.status" />
              <p>{{ confirmation.note || '尚未填写迁移确认说明。' }}</p>
              <p v-if="confirmation.invalidReason" class="invalid-reason">
                失效原因：{{ confirmation.invalidReason }}
              </p>
              <t-button
                variant="outline"
                size="small"
                :disabled="confirmation.status === 'confirmed'"
                @click="openMigration(confirmation.id)"
              >
                {{ confirmation.status === 'invalidated' ? '重新确认' : '确认迁移' }}
              </t-button>
            </article>
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <h2 class="panel-title">四角色审批（回执）</h2>
            <span class="muted">由 {{ activeClient.label }} 提交</span>
          </div>
          <div class="approval-list">
            <label v-for="approval in release.approvals" :key="approval.id" class="approval-row">
              <t-checkbox
                :value="selectedApprovalIds.includes(approval.id)"
                :disabled="approval.status === 'approved'"
                @change="setApprovalChecked(approval.id, $event)"
              />
              <div>
                <strong>{{ roleLabel(approval.role) }}</strong>
                <span>{{ approval.actor }} · {{ approval.comment || '待填写意见' }}</span>
                <span v-if="approval.invalidReason" class="invalid-reason">
                  失效：{{ approval.invalidReason }}
                </span>
              </div>
              <StatusTag :value="approval.status" />
              <t-button variant="text" size="small" @click.prevent="openApproval(approval)">
                {{ approval.status === 'invalidated' ? '重新审批' : '审批' }}
              </t-button>
            </label>
          </div>
          <div class="batch-bar">
            <t-input v-model="approvalComment" placeholder="批量审批意见" />
            <t-button theme="primary" @click="batchApprove">批量通过</t-button>
          </div>
        </section>
      </div>

      <section class="panel">
        <div class="panel-header">
          <h2 class="panel-title">回执台账</h2>
          <span class="muted">
            与当前快照修订不匹配的回执退回；同一幂等键只处理一次；失败/退回回执保留并可重试
          </span>
        </div>
        <t-table
          row-key="id"
          :data="receipts"
          size="small"
          stripe
          :columns="[
            { colKey: 'createdAt', title: '提交时间', width: 170 },
            { colKey: 'clientLabel', title: '客户端窗口', width: 200 },
            { colKey: 'target', title: '回执目标', width: 200 },
            { colKey: 'revision', title: '基准修订', width: 100 },
            { colKey: 'idempotencyKey', title: '幂等键', width: 210 },
            { colKey: 'status', title: '结果', width: 100 },
            { colKey: 'message', title: '处理说明', minWidth: 240 },
            { colKey: 'actions', title: '操作', width: 90 },
          ]"
        >
          <template #createdAt="{ row }">
            {{ new Date(row.createdAt).toLocaleString('zh-CN') }}
          </template>
          <template #target="{ row }">{{ receiptTargetLabel(row) }}</template>
          <template #revision="{ row }">
            #{{ row.baseRevision }}
            <t-tag
              v-if="row.baseRevision !== release.snapshotRevision"
              theme="warning"
              size="small"
              variant="light"
            >
              过期
            </t-tag>
          </template>
          <template #status="{ row }"><StatusTag :value="row.status" /></template>
          <template #actions="{ row }">
            <t-button
              v-if="row.status === 'rejected' || row.status === 'failed'"
              variant="text"
              size="small"
              theme="primary"
              @click="retryReceipt(row)"
            >
              重试
            </t-button>
            <span v-else class="muted">—</span>
          </template>
        </t-table>
        <div v-if="receipts.length === 0" class="empty-state">
          暂无回执。可由两个客户端窗口分别提交迁移确认或审批，观察退回、去重与重试。
        </div>
      </section>
    </template>

    <div v-else class="panel empty-state">暂无发布候选。</div>

    <t-dialog v-model:visible="createVisible" header="创建发布候选" width="720px" :footer="false">
      <div class="editor-form">
        <div class="field">
          <label>版本号</label>
          <t-input v-model="createForm.version" />
        </div>
        <div class="field">
          <label>发布标题</label>
          <t-input v-model="createForm.title" />
        </div>
        <div class="field field-wide">
          <label>参与发布的事件（创建时冻结完整契约快照）</label>
          <t-select
            v-model="createForm.eventIds"
            :options="
              store.data.events
                .filter((event) => event.status !== 'retired')
                .map((event) => ({
                  label: `${event.displayName} (${event.key})`,
                  value: event.id,
                }))
            "
            multiple
            filterable
          />
        </div>
      </div>
      <div class="dialog-footer">
        <t-button variant="outline" @click="createVisible = false">取消</t-button>
        <t-button theme="primary" @click="createRelease">冻结快照并比较</t-button>
      </div>
    </t-dialog>

    <t-dialog v-model:visible="migrationVisible" header="提交下游迁移回执" width="620px" :footer="false">
      <div class="receipt-meta">
        <span>提交窗口：{{ activeClient.label }}</span>
        <span>基准快照修订：#{{ activeClient.syncedRevision }}</span>
        <span>幂等键：{{ migrationForm.idempotencyKey }}</span>
      </div>
      <div class="editor-form">
        <div class="field">
          <label>确认人</label>
          <t-input v-model="migrationForm.reviewer" />
        </div>
        <div class="field field-wide">
          <label>迁移说明</label>
          <t-textarea v-model="migrationForm.note" :autosize="{ minRows: 5, maxRows: 8 }" />
        </div>
      </div>
      <div class="dialog-footer">
        <t-button variant="outline" @click="migrationVisible = false">取消</t-button>
        <t-button theme="primary" @click="submitMigration">提交回执</t-button>
      </div>
    </t-dialog>

    <t-dialog v-model:visible="approvalVisible" header="提交审批回执" width="620px" :footer="false">
      <div class="receipt-meta" v-if="singleApproval">
        <span>提交窗口：{{ activeClient.label }}</span>
        <span>审批角色：{{ roleLabel(singleApproval.role) }}</span>
        <span>基准快照修订：#{{ activeClient.syncedRevision }}</span>
        <span>幂等键：{{ approvalForm.idempotencyKey }}</span>
      </div>
      <div class="editor-form">
        <div class="field">
          <label>审批人</label>
          <t-input v-model="approvalForm.actor" />
        </div>
        <div class="field">
          <label>审批意见</label>
          <t-textarea v-model="approvalForm.comment" :autosize="{ minRows: 5, maxRows: 8 }" />
        </div>
      </div>
      <div class="dialog-footer">
        <t-button variant="outline" @click="approvalVisible = false">取消</t-button>
        <t-button theme="danger" @click="submitApproval('rejected')">
          <template #icon><CloseCircleIcon /></template>
          驳回
        </t-button>
        <t-button theme="primary" @click="submitApproval('approved')">
          <template #icon><CheckCircleIcon /></template>
          通过
        </t-button>
      </div>
    </t-dialog>
  </div>
</template>

<style scoped>
.filter-panel {
  padding: 14px 16px;
}

.release-field {
  min-width: 390px;
}

.client-panel {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 16px;
}

.client-tabs {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  flex: 1;
}

.client-tab {
  display: grid;
  gap: 4px;
  padding: 10px 14px;
  text-align: left;
  border: 1px solid #dfe3e8;
  border-radius: 6px;
  background: #fff;
  cursor: pointer;
}

.client-tab.active {
  border-color: #1264c5;
  background: #f2f7ff;
}

.client-tab strong {
  font-size: 12px;
}

.client-tab span {
  color: #717c8e;
  font-size: 11px;
}

.client-tab span.stale,
.client-tab em {
  color: #c46a00;
  font-style: normal;
}

.client-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.drift-panel {
  border-color: #f0b7a8;
  background: #fff7f5;
}

.drift-head {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
}

.drift-head svg {
  color: #c0392b;
  font-size: 22px;
}

.drift-head > div {
  display: grid;
  gap: 4px;
}

.drift-head span {
  color: #7a5a52;
  font-size: 12px;
}

.drift-list {
  display: grid;
  gap: 10px;
  margin: 14px 0 0;
  padding: 0;
  list-style: none;
}

.drift-list li {
  display: grid;
  gap: 4px;
  padding: 10px 12px;
  border-radius: 6px;
  background: #fff;
}

.drift-list strong {
  font-size: 12px;
}

.drift-list span {
  color: #8a5a4e;
  font-size: 11px;
}

.drift-queue {
  margin: 12px 0 0;
  color: #b42318;
  font-size: 11px;
}

.release-overview {
  display: grid;
  grid-template-columns: 180px minmax(220px, 1fr) 200px 140px auto;
  align-items: center;
  gap: 1px;
  overflow: hidden;
  border: 1px solid #dfe3e8;
  border-radius: 6px;
  background: #dfe3e8;
}

.release-overview > div,
.release-overview > button {
  align-self: stretch;
}

.release-overview > div {
  display: grid;
  gap: 6px;
  padding: 14px 16px;
  background: #fff;
}

.release-overview span {
  color: #717c8e;
  font-size: 11px;
}

.release-overview > button {
  border-radius: 0;
}

.release-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.45fr) minmax(340px, 0.55fr);
  gap: 16px;
  align-items: start;
}

.diff-list {
  display: grid;
  gap: 1px;
  background: #e8ebef;
}

.diff-event {
  padding: 16px;
  background: #fff;
}

.diff-event-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 12px;
}

.diff-event-head strong {
  font-family: monospace;
  font-size: 12px;
}

.diff-event-head span {
  color: #737e90;
  font-size: 11px;
}

.gate-list {
  padding: 10px 16px 18px;
}

.gate-row {
  display: grid;
  grid-template-columns: 30px 1fr;
  gap: 10px;
  align-items: center;
  padding: 12px 0;
  border-bottom: 1px solid #edf0f3;
}

.gate-row svg {
  color: #0f8a62;
}

.gate-row svg.pending {
  color: #c46a00;
}

.gate-row > div {
  display: grid;
  gap: 4px;
}

.gate-row strong {
  font-size: 12px;
}

.gate-row span,
.readiness span {
  color: #727d8f;
  font-size: 11px;
}

.readiness {
  display: grid;
  gap: 7px;
  padding-top: 16px;
}

.readiness strong {
  font-size: 24px;
}

.review-columns {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.migration-list {
  display: grid;
  gap: 1px;
  background: #e8ebef;
}

.migration-card {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 9px;
  padding: 15px 16px;
  background: #fff;
}

.migration-card.invalid {
  background: #fff7f5;
}

.migration-card > div {
  display: grid;
  gap: 4px;
}

.migration-card span,
.migration-card p {
  color: #6d788b;
  font-size: 11px;
}

.migration-card p {
  grid-column: 1 / -1;
  margin: 0;
  line-height: 1.5;
}

.migration-card :deep(.t-button) {
  grid-column: 1 / -1;
  justify-self: start;
}

.invalid-reason {
  color: #b42318 !important;
}

.approval-list {
  display: grid;
  padding: 6px 16px;
}

.approval-row {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 10px;
  padding: 12px 0;
  border-bottom: 1px solid #edf0f3;
  cursor: pointer;
}

.approval-row > div {
  display: grid;
  gap: 4px;
}

.approval-row span {
  color: #717c8e;
  font-size: 11px;
}

.batch-bar {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  padding: 14px 16px;
  border-top: 1px solid #e8ebef;
}

.receipt-meta {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 16px;
  padding: 10px 12px;
  border-radius: 6px;
  background: #f6f8fb;
}

.receipt-meta span {
  color: #596579;
  font-size: 11px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 22px;
  padding-top: 16px;
  border-top: 1px solid #e8ebef;
}
</style>
