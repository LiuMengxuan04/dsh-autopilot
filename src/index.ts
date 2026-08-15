/** Public package metadata for the DSH Autopilot bundle. */
export const PACKAGE_NAME = 'dsh-autopilot'

/** Current pre-release package version. */
export const PACKAGE_VERSION = '0.1.0-alpha.3'

export {
  AutopilotRecovery,
  planRunRecovery,
  recoveryRunRef,
} from './recovery.ts'
export type {
  RecoveryActivationResult,
  RecoveryPlan,
  RecoveryReport,
  RecoveryRun,
  RecoveryRunController,
  RecoveryRunRef,
} from './recovery.ts'

export {
  AutopilotRecoveryCoordinator,
  AutopilotRecoveryReadiness,
  RECOVERY_COORDINATOR_INJECT,
  RECOVERY_CRITICAL_CONTRIBUTIONS,
  registerRecoveryContribution,
} from './recovery-coordinator.ts'
export type { RecoveryCriticalContribution } from './recovery-coordinator.ts'

export type {
  AutonomyLeasePhase,
  AutonomyLeaseView,
  AutonomyServiceConfig,
  SelfModificationMode,
} from './service.ts'
export type { RunIntent } from './run-state.ts'

export {
  ContinuableTeamError,
  ContinuableTeamService,
  DEFAULT_TEAM_TOOL_ALLOWLIST,
} from './team-service.ts'
export type {
  ContinuableTeamConfig,
  ContinuableTeamFollowupRequest,
  ContinuableTeamReconcileResult,
  ContinuableTeamStartRequest,
  ManagedContinuableStart,
} from './team-service.ts'
export {
  TEAM_STATE_VERSION,
  TEAM_TASK_ID_PATTERN,
} from './team-state.ts'
export type {
  TeamEvidence,
  TeamOrphanRecord,
  TeamTaskReport,
  TeamThreadPhase,
  TeamThreadSnapshot,
} from './team-state.ts'

export {
  DEFAULT_RALPH_MAX_ROUNDS,
  DEFAULT_RALPH_ROUND_CEILING,
  RalphError,
  RalphService,
  resolveRalphLimits,
} from './ralph-service.ts'
export type {
  RalphErrorCode,
  RalphLimits,
  RalphResumeRequest,
  RalphServiceConfig,
  RalphStartRequest,
} from './ralph-service.ts'
export {
  RALPH_STATE_VERSION,
  RALPH_STORAGE_LIMITS,
} from './ralph-state.ts'
export type {
  RalphAuditRecord,
  RalphEvidence,
  RalphOperation,
  RalphPhase,
  RalphRound,
  RalphSnapshot,
} from './ralph-state.ts'

export {
  DEFAULT_DELIVERY_MAX_AUDIT_BYTES,
  DEFAULT_DELIVERY_MAX_AUDIT_RECORDS,
  DeliveryService,
  FixedGitRunner,
} from './delivery-service.ts'
export type {
  DeliveryCheckpointInput,
  DeliveryCleanupInput,
  DeliveryCreateInput,
  DeliveryGitRunner,
  DeliveryHostCleanupRequest,
  DeliveryObservation,
  DeliveryPrepareInput,
  DeliveryServiceConfig,
  DeliveryServiceHost,
  DeliveryStatus,
  HumanDeliveryAuthorization,
} from './delivery-service.ts'
export {
  DELIVERY_STATE_VERSION,
  DeliveryError,
  MAX_DELIVERY_AUDIT_BYTES,
  MAX_DELIVERY_AUDIT_RECORDS,
  MAX_DELIVERY_VERIFICATIONS,
} from './delivery-state.ts'
export type {
  DeliveryAuditRecord,
  DeliveryHandoff,
  DeliveryOperation,
  DeliveryPhase,
  DeliveryPlan,
  DeliverySnapshot,
  DeliveryVerification,
} from './delivery-state.ts'
export {
  hashAnchoredEdit,
  hashLineWindow,
  resolveCodeLanguage,
  rewriteAst,
  searchAst,
  sha256,
} from './code-intelligence.ts'
export type { AstMatch, CodeLanguage, HashedLine } from './code-intelligence.ts'

export {
  CompletionNotificationService,
  HttpsNotificationTransport,
  notificationRetryDelay,
} from './notification-service.ts'
export type {
  CompletionNotificationConfig,
  NotificationTransport,
  NotificationTransportRequest,
} from './notification-service.ts'
export { NOTIFICATION_STATE_VERSION } from './notification-state.ts'
export type {
  CompletionNotificationEvent,
  CompletionNotificationPayload,
  CompletionNotificationReasonCode,
  NotificationAuditRecord,
  NotificationDeliveryPhase,
  NotificationFailureCode,
  NotificationSnapshot,
} from './notification-state.ts'

export {
  SkillMcpLifecycle,
  createSkillMcpPlugin,
  mountPublishedMcpClient,
  parseSkillMcpReferences,
  resolveSkillMcpConfig,
} from './skill-mcp.ts'
export type {
  Config as SkillMcpConfig,
  ResolvedSkillMcpConfig,
  ResolvedSkillMcpServer,
  SkillMcpMetadata,
  SkillMcpMount,
  SkillMcpMountHandle,
  SkillMcpServerConfig,
} from './skill-mcp.ts'

export {
  DEFAULT_VISUAL_QA_ORIGINS,
  VisualQaError,
  compareVisualQaPng,
  decodeVisualQaPng,
  isAllowedVisualQaUrl,
  normalizeAllowedOrigin,
  resolveVisualQaConfig,
} from './visual-qa.ts'
export type {
  VisualQaAssertion,
  VisualQaComparison,
  VisualQaConfig,
  VisualQaResult,
  VisualQaRunIdentity,
  VisualQaScreenshotReceipt,
  VisualQaStep,
} from './visual-qa.ts'

export {
  MAX_WORKFLOW_PROFILE_SCRIPT_CHARS,
  ManagedWorkflowError,
  ManagedWorkflowService,
} from './workflow-service.ts'
export type {
  ManagedWorkflowProfileConfig,
  ManagedWorkflowProfileView,
  ManagedWorkflowReconcileResult,
  ManagedWorkflowRunRequest,
  ManagedWorkflowServiceConfig,
  ManagedWorkflowStart,
} from './workflow-service.ts'
export {
  WORKFLOW_PROFILE_ID_PATTERN,
  WORKFLOW_STATE_VERSION,
  isManagedWorkflowTerminal,
} from './workflow-state.ts'
export type {
  ManagedWorkflowAuditRecord,
  ManagedWorkflowOperation,
  ManagedWorkflowPhase,
  ManagedWorkflowSnapshot,
  ManagedWorkflowTaskOutcome,
  ManagedWorkflowTerminalPhase,
} from './workflow-state.ts'

export {
  MissionService,
  MissionServiceError,
} from './mission-service.ts'
export type {
  MissionMarkRequest,
  MissionPlanRequest,
  MissionRunPolicy,
  MissionServiceConfig,
  ResolvedMissionServiceConfig,
} from './mission-service.ts'
export {
  MISSION_STATE_VERSION,
  MissionStateError,
  deriveMissionPhase,
  missionCounts,
  missionSlug,
  missionSourceSha256,
  parseMissionMarkdown,
} from './mission-state.ts'
export type {
  MissionAuditRecord,
  MissionOperation,
  MissionParseLimits,
  MissionPhase,
  MissionSnapshot,
  MissionSource,
  MissionTaskAttempt,
  MissionTaskSnapshot,
  MissionTaskStatus,
  ParsedMissionTask,
} from './mission-state.ts'

export {
  AutopilotLifecycleHookService,
  DEFAULT_LIFECYCLE_HANDLER_TIMEOUT_MS,
  DEFAULT_MAX_LIFECYCLE_HANDLERS,
  MAX_LIFECYCLE_HANDLER_TIMEOUT_MS,
  MAX_LIFECYCLE_HANDLERS,
  resolveAutopilotLifecycleHookConfig,
} from './lifecycle-hooks.ts'
export type {
  AutopilotAfterToolHookEvent,
  AutopilotAgentErrorHookEvent,
  AutopilotBeforeToolHookDecision,
  AutopilotBeforeToolHookEvent,
  AutopilotLifecycleHookConfig,
  AutopilotLifecycleHookContext,
  AutopilotLifecycleHookDisposer,
  AutopilotLifecycleHookEventMap,
  AutopilotLifecycleHookHandler,
  AutopilotLifecycleHookName,
  AutopilotLifecycleHookOptions,
  AutopilotLifecycleRunRef,
  AutopilotPreStepHookEvent,
  AutopilotRunMutationHookEvent,
  AutopilotSessionStartHookEvent,
  AutopilotTurnStoppingHookEvent,
  BeforeToolFailurePolicy,
  ResolvedAutopilotLifecycleHookConfig,
} from './lifecycle-hooks.ts'

export {
  SPECIALIST_CATALOG,
  SPECIALIST_CATEGORIES,
  SPECIALIST_READ_ONLY_TOOLS,
  getSpecialist,
  getSpecialistCategory,
  specialistCatalogJson,
} from './specialist-catalog.ts'
export type {
  SpecialistCategory,
  SpecialistDefinition,
  SpecialistFamily,
  SpecialistToolPolicy,
} from './specialist-catalog.ts'
export {
  consultSpecialist,
  specialistConsultationJson,
} from './specialist-runner.ts'
export type {
  SpecialistConsultRequest,
  SpecialistConsultation,
} from './specialist-runner.ts'

export {
  DEFAULT_RUN_DASHBOARD_INTERVAL_MS,
  DEFAULT_RUN_DASHBOARD_ROWS,
  DEFAULT_RUN_DASHBOARD_WIDTH,
  MAX_RUN_DASHBOARD_INTERVAL_MS,
  MAX_RUN_DASHBOARD_ROWS,
  MIN_RUN_DASHBOARD_INTERVAL_MS,
  RunDashboardWatch,
  buildRunDashboardSnapshot,
  openRunDashboardStores,
  readRunDashboards,
  renderRunDashboards,
  resolveRunDashboardConfig,
} from './run-dashboard.ts'
export type {
  OpenRunDashboardStores,
  ReadRunDashboardRequest,
  ResolvedRunDashboardConfig,
  RunDashboardConfig,
  RunDashboardDelivery,
  RunDashboardDynamicCleanup,
  RunDashboardGoal,
  RunDashboardInput,
  RunDashboardNotice,
  RunDashboardRalphWorker,
  RunDashboardScheduler,
  RunDashboardSnapshot,
  RunDashboardStores,
  RunDashboardTask,
  RunDashboardTaskCounts,
  RunDashboardTeamWorker,
  RunDashboardWatchOptions,
  RunDashboardWorkflow,
} from './run-dashboard.ts'
export {
  AutopilotRunDashboardService,
  resolveAutopilotRunDashboardConfig,
} from './run-dashboard-service.ts'
export type {
  AutopilotRunDashboardConfig,
  AutopilotRunDashboardReadRequest,
  AutopilotRunDashboardRuntime,
  AutopilotRunDashboardWatchHandle,
  AutopilotRunDashboardWatchRequest,
  ResolvedAutopilotRunDashboardConfig,
} from './run-dashboard-service.ts'
