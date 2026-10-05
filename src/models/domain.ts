export type Platform = 'web' | 'ios' | 'android' | 'server' | 'miniprogram'
export type EventStatus = 'draft' | 'reviewing' | 'approved' | 'published' | 'deprecated' | 'retired'
export type PropertyType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'enum'
export type ReleaseStatus = 'draft' | 'reviewing' | 'approved' | 'published' | 'rolled_back'
export type Severity = 'critical' | 'high' | 'medium' | 'low'

export interface EventProperty {
  id: string
  eventId: string
  name: string
  displayName: string
  type: PropertyType
  required: boolean
  description: string
  enumValues: string[]
  owner: string
  synonyms: string[]
  platforms: Platform[]
  lineageSourceId?: string
  deletedAt?: string
}

export interface PlatformRule {
  id: string
  eventId: string
  platform: Platform
  enabled: boolean
  trigger: string
  owner: string
  requiredPropertyIds: string[]
  note: string
}

export interface EventDefinition {
  id: string
  key: string
  displayName: string
  category: string
  description: string
  trigger: string
  status: EventStatus
  version: string
  owner: string
  properties: EventProperty[]
  platformRules: PlatformRule[]
  scenarioIds: string[]
  downstreamDependencyIds: string[]
  updatedAt: string
}

export interface BusinessScenario {
  id: string
  name: string
  domain: string
  owner: string
  platform: Platform
  eventIds: string[]
  status: 'active' | 'migrating' | 'retired'
}

export interface DownstreamDependency {
  id: string
  name: string
  type: 'dashboard' | 'alert' | 'model' | 'dataset' | 'experiment'
  owner: string
  environment: 'production' | 'staging' | 'analysis'
  eventIds: string[]
  propertyRefs: Array<{ eventId: string; propertyId: string }>
  status: 'active' | 'migration_required' | 'migrated' | 'disabled'
}

export interface EventVersionSnapshot {
  id: string
  eventId: string
  version: string
  properties: EventProperty[]
  createdAt: string
  status: 'published' | 'superseded'
}

export interface ContractDifference {
  eventId: string
  eventKey: string
  addedProperties: string[]
  removedProperties: string[]
  requiredChanges: string[]
  typeChanges: string[]
  enumChanges: string[]
}

export interface MigrationConfirmation {
  id: string
  dependencyId: string
  version: string
  status: 'pending' | 'confirmed' | 'rejected' | 'invalidated'
  reviewer: string
  note: string
  confirmedAt?: string
  invalidatedAt?: string
  invalidReason?: string
}

export interface ReleaseApproval {
  id: string
  role: 'data' | 'product' | 'client' | 'qa'
  actor: string
  status: 'pending' | 'approved' | 'rejected' | 'invalidated'
  comment: string
  createdAt?: string
  invalidatedAt?: string
  invalidReason?: string
}

export interface SnapshotProperty {
  id: string
  name: string
  displayName: string
  type: PropertyType
  required: boolean
  description: string
  enumValues: string[]
  owner: string
  synonyms: string[]
  platforms: Platform[]
  deleted: boolean
}

export interface SnapshotPlatformRule {
  id: string
  platform: Platform
  enabled: boolean
  trigger: string
  owner: string
  requiredPropertyIds: string[]
  note: string
}

export interface EventContractSnapshot {
  eventId: string
  eventKey: string
  version: string
  properties: SnapshotProperty[]
  platformRules: SnapshotPlatformRule[]
}

export type ReceiptKind = 'migration' | 'approval'
export type ReceiptStatus = 'accepted' | 'rejected' | 'duplicate' | 'failed'

export interface ReceiptPayload {
  reviewer?: string
  note?: string
  actor?: string
  comment?: string
  decision?: 'confirmed' | 'approved' | 'rejected'
}

export interface ReceiptRecord {
  id: string
  releaseId: string
  kind: ReceiptKind
  targetId: string
  clientId: string
  clientLabel: string
  idempotencyKey: string
  baseRevision: number
  status: ReceiptStatus
  payload: ReceiptPayload
  message: string
  createdAt: string
  processedAt?: string
}

export interface ReleaseCandidate {
  id: string
  version: string
  title: string
  status: ReleaseStatus
  eventIds: string[]
  snapshot: EventContractSnapshot[]
  snapshotRevision: number
  driftDetected: boolean
  recalculationQueue: string[]
  frozenAt: string
  recalculatedAt?: string
  affectedDependencyIds: string[]
  differences: ContractDifference[]
  migrationConfirmations: MigrationConfirmation[]
  approvals: ReleaseApproval[]
  receipts: ReceiptRecord[]
  createdAt: string
  publishedAt?: string
}

export interface DeprecationPlan {
  id: string
  eventId: string
  replacementEventId?: string
  reason: string
  owner: string
  stopCollectAt: string
  retireAt: string
  status: 'planned' | 'announced' | 'stopped' | 'retired' | 'cancelled'
  migrationNote: string
}

export interface RollbackRecord {
  id: string
  releaseId: string
  version: string
  targetReleaseId: string
  targetVersion: string
  reason: string
  operator: string
  scope: string
  createdAt: string
  status: 'executed' | 'verified'
  evidence: string
}

export interface AuditEvent {
  id: string
  entityType: string
  entityId: string
  action: string
  actor: string
  detail: string
  createdAt: string
}

export interface GovernanceState {
  events: EventDefinition[]
  scenarios: BusinessScenario[]
  dependencies: DownstreamDependency[]
  baselines: EventVersionSnapshot[]
  releases: ReleaseCandidate[]
  deprecations: DeprecationPlan[]
  rollbacks: RollbackRecord[]
  audit: AuditEvent[]
  currentVersion: string
}

export interface ValidationIssue {
  id: string
  kind:
    | 'duplicate_event'
    | 'synonym_property'
    | 'naming_violation'
    | 'type_change'
    | 'deleted_property_referenced'
    | 'required_mismatch'
  severity: Severity
  title: string
  detail: string
  entityId: string
  suggestion: string
}

export interface SampleValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}
