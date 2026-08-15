interface ReplayChunks {
  readonly kind: 'chunks'
  readonly chunks: readonly Record<string, unknown>[]
}

/** Build one deterministic model tool call for the replay provider. */
function toolCall(id: string, name: string, args: unknown): ReplayChunks {
  const serialized = JSON.stringify(args)
  return {
    kind: 'chunks',
    chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: serialized },
      {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id, name, arguments: serialized },
      },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ],
  }
}

/** Build one deterministic final text response for the replay provider. */
function textCall(text: string): ReplayChunks {
  return {
    kind: 'chunks',
    chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text },
      { type: 'block-end', index: 0, block: { type: 'text', text } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  }
}

const HOST_PROOF = [
  "return { name: 'e2e-managed-proof', inject: ['tools'], apply(ctx) {",
  '  ctx.effect(() => harness.registerTool(ctx, harness.defineTool({',
  "    name: 'managed_host_probe',",
  "    description: 'Return a stable receipt from a managed Host-only extension.',",
  "    parameters: { text: { type: 'string', required: true } },",
  '    output: {',
  "      schema: { type: 'string' },",
  "      render(_args, value) { return [{ type: 'text', text: value }] },",
  '    },',
  "    async execute(args) { return 'MANAGED_HOST:' + args.text },",
  '  })))',
  '} }',
].join('\n')

/** Parent-session replay: managed plan, failed verification, repair, pass, and final handoff. */
export const PRIMARY_REPLAY: readonly ReplayChunks[] = Object.freeze([
  toolCall('call_flow_interview', 'autopilot_flow', {
    action: 'interview',
    summary: 'The objective is a bounded packed-bundle lifecycle and repair proof.',
    decisions: [
      'Use only the managed Host-only Cordis wrapper.',
      'Require the deployment-fixed check and fresh independent review before completion.',
    ],
    openQuestions: [],
  }),
  toolCall('call_plan_initial', 'autopilot_plan', {
    action: 'replace',
    intent: 'implementation',
    acceptanceCriteria: [
      'e2e-proof.txt contains exactly DSH_AUTOPILOT_E2E followed by a newline.',
      'A managed Host-only Cordis proof tool runs and is removed before completion.',
    ],
    tasks: [{
      id: 'delivery',
      title: 'Exercise managed Cordis and create the candidate artifact',
      description: 'Run a wrapper-owned Host-only proof extension, remove it, and write the candidate artifact.',
      acceptanceCriteria: [
        'The managed proof tool returns MANAGED_HOST:receipt-ok.',
        'The dynamic extension is durably removed.',
        'The candidate artifact is submitted to the independent verifier.',
      ],
      dependencies: [],
    }],
  }),
  toolCall('call_flow_harden', 'autopilot_flow', { action: 'harden' }),
  toolCall('call_task_start_delivery', 'autopilot_task', {
    taskId: 'delivery',
    action: 'start',
  }),
  toolCall('call_cordis_apply', 'autopilot_cordis_apply', {
    logicalId: 'managed-proof',
    name: 'Managed E2E proof',
    purpose: 'Prove the durable Host-only Autopilot Cordis lifecycle in the packed Web profile.',
    hostCode: HOST_PROOF,
  }),
  toolCall('call_host_probe', 'managed_host_probe', { text: 'receipt-ok' }),
  toolCall('call_cordis_remove', 'autopilot_cordis_remove', {
    logicalId: 'managed-proof',
    reason: 'The one-shot proof receipt was captured.',
  }),
  toolCall('call_write_candidate', 'write', {
    file_path: 'e2e-proof.txt',
    content: 'NEEDS_REPAIR\n',
  }),
  toolCall('call_task_complete_delivery', 'autopilot_task', {
    taskId: 'delivery',
    action: 'complete',
    evidence: [
      {
        kind: 'note',
        ref: 'managed-proof',
        summary: 'The managed Host-only tool returned MANAGED_HOST:receipt-ok and was removed.',
      },
      {
        kind: 'file',
        ref: 'e2e-proof.txt',
        summary: 'The candidate artifact is ready for independent verification.',
      },
    ],
  }),
  toolCall('call_verify_fail', 'autopilot_verify', {
    summary: 'The managed lifecycle ran and the first candidate is ready.',
    evidence: ['managed_host_probe returned MANAGED_HOST:receipt-ok', 'e2e-proof.txt was created'],
  }),
  toolCall('call_plan_repair', 'autopilot_plan', {
    action: 'add',
    tasks: [{
      id: 'repair-artifact',
      title: 'Repair the artifact rejected by verification',
      description: 'Apply the verifier finding and produce the exact required file content.',
      acceptanceCriteria: ['e2e-proof.txt matches the deployment-fixed verifier exactly.'],
      dependencies: ['delivery'],
    }],
  }),
  toolCall('call_flow_reharden', 'autopilot_flow', { action: 'harden' }),
  toolCall('call_task_start_repair', 'autopilot_task', {
    taskId: 'repair-artifact',
    action: 'start',
  }),
  toolCall('call_write_repair', 'write', {
    file_path: 'e2e-proof.txt',
    content: 'DSH_AUTOPILOT_E2E\n',
  }),
  toolCall('call_task_complete_repair', 'autopilot_task', {
    taskId: 'repair-artifact',
    action: 'complete',
    evidence: [{
      kind: 'file',
      ref: 'e2e-proof.txt',
      summary: 'The repaired artifact contains the exact required content.',
    }],
  }),
  toolCall('call_verify_pass', 'autopilot_verify', {
    summary: 'The verifier finding was repaired and all acceptance criteria are now satisfied.',
    evidence: [
      'e2e-proof.txt contains DSH_AUTOPILOT_E2E followed by a newline',
      'managed-proof ran and was removed through the Autopilot lifecycle',
    ],
  }),
  textCall(
    'Autopilot completed successfully. The managed Host-only Cordis proof ran and was removed, '
      + 'the failed first candidate was repaired, e2e-proof.txt now contains the exact expected '
      + 'content, and both the deployment-fixed check and fresh independent review passed.',
  ),
])

/** Child-session JSONL whose sole call returns one structured consultation. */
function childReplayJsonl(
  id: string,
  createdAt: number,
  callId: string,
  result: Record<string, unknown>,
): string {
  const chunks = toolCall(callId, 'structured_output', result).chunks
  const records = [
    {
      type: 'session',
      version: 0,
      id,
      createdAt,
      delegationDepth: 1,
    },
    ...chunks.map((chunk, seq) => ({
      type: 'assistant/chunk',
      seq,
      time: seq + 1,
      data: { turn: 1, step: 1, chunk },
    })),
  ]
  return `${records.map(record => JSON.stringify(record)).join('\n')}\n`
}

/** Child-session JSONL files in the exact bind order used by the packed scenario. */
export function childReplayJsonls(): readonly string[] {
  return [
    childReplayJsonl('dsh-autopilot-e2e-metis', 2, 'call_metis_advice', {
      verdict: 'advice',
      summary: 'The objective and acceptance criteria are sufficiently bounded.',
      findings: [],
      recommendations: [],
    }),
    childReplayJsonl('dsh-autopilot-e2e-momus', 3, 'call_momus_advice', {
      verdict: 'advice',
      summary: 'The plan is concrete, dependency-coherent, and independently verifiable.',
      findings: [],
      recommendations: [],
    }),
    childReplayJsonl('dsh-autopilot-e2e-oracle', 4, 'call_oracle_advice', {
      verdict: 'advice',
      summary: 'The lifecycle, rollback, and verification sequence is safe for this proof.',
      findings: [],
      recommendations: [],
    }),
    childReplayJsonl('dsh-autopilot-e2e-first-reviewer', 5, 'call_first_reviewer_pass', {
      verdict: 'pass',
      summary: 'The managed lifecycle evidence is sound; the deployment check decides artifact acceptance.',
      findings: [],
    }),
    childReplayJsonl('dsh-autopilot-e2e-repair-metis', 6, 'call_repair_metis_advice', {
      verdict: 'advice',
      summary: 'The repair task addresses the exact verifier finding.',
      findings: [],
      recommendations: [],
    }),
    childReplayJsonl('dsh-autopilot-e2e-repair-momus', 7, 'call_repair_momus_advice', {
      verdict: 'advice',
      summary: 'The repair acceptance criterion is exact and independently checkable.',
      findings: [],
      recommendations: [],
    }),
    childReplayJsonl('dsh-autopilot-e2e-repair-oracle', 8, 'call_repair_oracle_advice', {
      verdict: 'advice',
      summary: 'The repair preserves the reviewed lifecycle and changes only the rejected artifact.',
      findings: [],
      recommendations: [],
    }),
    childReplayJsonl('dsh-autopilot-e2e-reviewer', 9, 'call_reviewer_pass', {
      verdict: 'pass',
      summary: 'The final artifact and managed lifecycle evidence satisfy the recorded criteria.',
      findings: [],
    }),
  ]
}
