import type { GovernanceState } from '@/models/domain'
import { createSeedState } from '@/models/seed'
import { buildReleaseSnapshot } from '@/services/selectors'

export const STORAGE_KEY = 'eventrail-governance-v1'

export const createId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

export const migrateState = (state: GovernanceState): GovernanceState => {
  state.releases.forEach((release) => {
    release.processedReceiptKeys ??= []
    if (!release.snapshot) {
      release.snapshot = buildReleaseSnapshot(state.events, release.eventIds, createId('snap'))
    }
    release.migrationConfirmations.forEach((confirmation) => {
      confirmation.snapshotHash ??= release.snapshot.hash
    })
    release.approvals.forEach((approval) => {
      approval.snapshotHash ??= release.snapshot.hash
    })
  })
  return state
}

export const loadState = (): GovernanceState => {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seed = createSeedState()
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed))
    return seed
  }
  try {
    return migrateState(JSON.parse(raw) as GovernanceState)
  } catch {
    const seed = createSeedState()
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed))
    return seed
  }
}

export const saveState = (state: GovernanceState): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

export const resetState = (): GovernanceState => {
  const seed = createSeedState()
  saveState(seed)
  return seed
}
