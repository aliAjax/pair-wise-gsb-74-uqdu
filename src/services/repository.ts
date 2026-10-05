import { toRaw } from 'vue'
import type { GovernanceState } from '@/models/domain'
import { createSeedState } from '@/models/seed'

const STORAGE_KEY = 'eventrail-governance-v2'

export const loadState = (): GovernanceState => {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seed = createSeedState()
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed))
    return seed
  }
  try {
    return JSON.parse(raw) as GovernanceState
  } catch {
    const seed = createSeedState()
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed))
    return seed
  }
}

export const saveState = (state: GovernanceState): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(toRaw(state)))
}

export const resetState = (): GovernanceState => {
  const seed = createSeedState()
  saveState(seed)
  return seed
}

export const createId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
