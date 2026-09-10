import type { DatabaseClient } from '../../platform/database.js';

export interface AuditEntry {
  actorUserId?: string;
  action: string;
  targetType: string;
  targetId?: string;
  outcome: 'success' | 'failure' | 'denied';
  requestId: string;
  safeMetadata?: Record<string, unknown>;
}

export async function appendAudit(client: DatabaseClient, entry: AuditEntry): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs
       (actor_user_id, action, target_type, target_id, outcome, request_id, safe_metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      entry.actorUserId ?? null,
      entry.action,
      entry.targetType,
      entry.targetId ?? null,
      entry.outcome,
      entry.requestId,
      JSON.stringify(entry.safeMetadata ?? {}),
    ],
  );
}
