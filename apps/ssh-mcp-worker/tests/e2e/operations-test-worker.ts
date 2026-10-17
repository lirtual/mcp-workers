import handler from '../../src/handler.ts';
import { canonicalOperationDigest, SshOperationsDO as ProductionOperationsDO, type CanonicalOperationIntent } from '../../src/operations.ts';
import type { Env } from '../../src/types.ts';

// This entrypoint is used only by the disposable local e2e runner. It routes the
// fixture hostname to loopback while exercising the production DO admission,
// receipt, SSH client, pin verification, and result handling code.
export class SshOperationsDO extends ProductionOperationsDO {
  private fixtureNow: number | null = null;
  private closeDelay: Promise<void> | null = null;
  private releaseCloseDelay: (() => void) | null = null;
  private closeEntered: Promise<void> = Promise.resolve();
  private markCloseEntered: (() => void) | null = null;

  protected override now(): number {
    return this.fixtureNow ?? super.now();
  }

  protected override async resolveTarget(host: string, signal?: AbortSignal): Promise<string> {
    if (host === 'fixture.example.test') return '127.0.0.1';
    if (host === 'slow-dns.example.test') {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error('aborted'));
          return;
        }
        const timer = setTimeout(resolve, 5_000);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        }, { once: true });
      });
      return '127.0.0.1';
    }
    return super.resolveTarget(host, signal);
  }

  protected override async closeShell(resources: Parameters<ProductionOperationsDO['closeShell']>[0]): Promise<void> {
    this.markCloseEntered?.();
    this.markCloseEntered = null;
    if (this.closeDelay) await this.closeDelay;
    await super.closeShell(resources);
  }

  async armSessionCloseDelay(): Promise<void> {
    this.closeEntered = new Promise(resolve => { this.markCloseEntered = resolve; });
    this.closeDelay = new Promise(resolve => { this.releaseCloseDelay = resolve; });
  }

  async waitForSessionCloseEntered(): Promise<void> {
    await this.closeEntered;
  }

  async releaseSessionCloseDelay(): Promise<void> {
    this.releaseCloseDelay?.();
    this.closeDelay = null;
    this.releaseCloseDelay = null;
  }

  async setFixtureClock(now: number | null): Promise<void> {
    this.fixtureNow = now;
  }

  async runSessionAlarmForFixture(): Promise<void> {
    await this.alarm();
  }

  async sessionAlarmForFixture(): Promise<number | null> {
    return await this.ctx.storage.getAlarm();
  }

  async setSessionActivityForFixture(sessionId: string, lastActivityAt: number): Promise<boolean> {
    const session = this.sessions.get(sessionId.toLowerCase());
    if (!session || session.releaseReason !== 'live') return false;
    session.lastActivityAt = lastActivityAt;
    this.ctx.storage.sql.exec('UPDATE managed_sessions SET last_activity_at = ? WHERE session_id = ?', lastActivityAt, session.sessionId);
    await this.scheduleSessionAlarm();
    return true;
  }

  async operationCountForFixture(): Promise<number> {
    return this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM operations').one().count;
  }

  async leaseSnapshotForFixture(): Promise<{ total: number; perHost: Record<string, number> }> {
    const rows = this.ctx.storage.sql.exec<{ host_id: string; count: number }>(
      'SELECT host_id, COUNT(*) AS count FROM connection_leases GROUP BY host_id',
    ).toArray();
    const perHost: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      perHost[row.host_id] = row.count;
      total += row.count;
    }
    return { total, perHost };
  }

  async injectReceiptStoreFailure(): Promise<void> {
    this.ctx.storage.sql.exec(`CREATE TRIGGER IF NOT EXISTS fixture_fail_operation_insert
      BEFORE INSERT ON operations BEGIN SELECT RAISE(FAIL, 'synthetic fixture failure'); END`);
  }

  async clearReceiptStoreFailure(): Promise<void> {
    this.ctx.storage.sql.exec('DROP TRIGGER IF EXISTS fixture_fail_operation_insert');
  }

  async injectRunningUpdateFailure(): Promise<void> {
    this.ctx.storage.sql.exec(`CREATE TRIGGER IF NOT EXISTS fixture_fail_running_update
      BEFORE UPDATE OF status ON operations WHEN NEW.status = 'running'
      BEGIN SELECT RAISE(FAIL, 'synthetic running update failure'); END`);
  }

  async clearRunningUpdateFailure(): Promise<void> {
    this.ctx.storage.sql.exec('DROP TRIGGER IF EXISTS fixture_fail_running_update');
  }

  async injectTerminalUpdateFailure(): Promise<void> {
    this.ctx.storage.sql.exec(`CREATE TRIGGER IF NOT EXISTS fixture_fail_terminal_update
      BEFORE UPDATE OF result_json ON operations WHEN NEW.result_json IS NOT NULL
      BEGIN SELECT RAISE(FAIL, 'synthetic fixture failure'); END`);
  }

  async clearTerminalUpdateFailure(): Promise<void> {
    this.ctx.storage.sql.exec('DROP TRIGGER IF EXISTS fixture_fail_terminal_update');
  }

  async ageReceiptForFixture(operationId: string, createdAt: number): Promise<void> {
    this.ctx.storage.sql.exec('UPDATE operations SET created_at = ? WHERE operation_id = ?', createdAt, operationId);
  }

  async getReceiptForFixture(operationId: string): Promise<{ digest: string; status: string; result_json: string | null } | null> {
    return this.ctx.storage.sql.exec<{ digest: string; status: string; result_json: string | null }>(
      'SELECT digest, status, result_json FROM operations WHERE operation_id = ?', operationId.toLowerCase(),
    ).toArray()[0] ?? null;
  }

  async seedLegacyReceiptForFixture(input: {
    operationId: string;
    hostId: string;
    digest: string;
    status: 'completed' | 'unknown';
    resultJson: string | null;
  }): Promise<void> {
    this.ctx.storage.sql.exec(
      'INSERT INTO operations(operation_id,digest,host_id,status,result_json,created_at) VALUES(?,?,?,?,?,?)',
      input.operationId.toLowerCase(), input.digest, input.hostId.toLowerCase(), input.status, input.resultJson, Date.now(),
    );
  }

  async seedCleanupRowsForFixture(input: { count: number; createdAt: number }): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      for (let index = 0; index < input.count; index++) {
        const operationId = `fixture-expired-terminal-${String(index).padStart(3, '0')}`;
        this.ctx.storage.sql.exec(
          'INSERT INTO operations(operation_id,digest,host_id,status,result_json,created_at) VALUES(?,?,?,\'completed\',?,?)',
          operationId, 'fixture-digest', '33333333-3333-4333-8333-333333333333',
          JSON.stringify({ operation_id: operationId, status: 'completed' }), input.createdAt,
        );
      }
      for (const status of ['unknown', 'admitted', 'running']) {
        const operationId = `fixture-expired-${status}`;
        this.ctx.storage.sql.exec(
          'INSERT INTO operations(operation_id,digest,host_id,status,result_json,created_at) VALUES(?,?,?, ?,NULL,?)',
          operationId, 'fixture-digest', '33333333-3333-4333-8333-333333333333', status, input.createdAt,
        );
      }
    });
  }

  async getCleanupStateForFixture(cutoff: number): Promise<{
    expiredTerminal: number;
    expiredUnknown: number;
    expiredInFlight: number;
    queryPlan: string[];
  }> {
    const sql = this.ctx.storage.sql;
    const expiredTerminal = sql.exec<{ count: number }>(
      'SELECT COUNT(*) AS count FROM operations WHERE status IN (?, ?) AND created_at <= ?', 'completed', 'failed', cutoff,
    ).one().count;
    const expiredUnknown = sql.exec<{ count: number }>(
      'SELECT COUNT(*) AS count FROM operations WHERE status = ? AND created_at <= ?', 'unknown', cutoff,
    ).one().count;
    const expiredInFlight = sql.exec<{ count: number }>(
      'SELECT COUNT(*) AS count FROM operations WHERE status IN (?, ?) AND created_at <= ?', 'admitted', 'running', cutoff,
    ).one().count;
    const queryPlan = sql.exec<{ detail: string }>(
      'EXPLAIN QUERY PLAN SELECT operation_id FROM operations WHERE status IN (?, ?) AND created_at <= ? LIMIT ?',
      'completed', 'failed', cutoff, 50,
    ).toArray().map(row => row.detail);
    return { expiredTerminal, expiredUnknown, expiredInFlight, queryPlan };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/__fixture/receipt-store-failure' || path === '/__fixture/running-update-failure'
      || path === '/__fixture/terminal-update-failure') {
      const operations = env.SSH_OPERATIONS.getByName('single-admin-operations') as unknown as SshOperationsDO;
      if (request.method === 'PUT' && path.endsWith('running-update-failure')) await operations.injectRunningUpdateFailure();
      else if (request.method === 'DELETE' && path.endsWith('running-update-failure')) await operations.clearRunningUpdateFailure();
      else if (request.method === 'PUT' && path.endsWith('terminal-update-failure')) await operations.injectTerminalUpdateFailure();
      else if (request.method === 'DELETE' && path.endsWith('terminal-update-failure')) await operations.clearTerminalUpdateFailure();
      else if (request.method === 'PUT') await operations.injectReceiptStoreFailure();
      else await operations.clearReceiptStoreFailure();
      return new Response(null, { status: 204 });
    }
    if (path === '/__fixture/age-receipt' || path === '/__fixture/read-receipt') {
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      const { operationId, createdAt } = await request.json() as { operationId: string; createdAt?: number };
      const operations = env.SSH_OPERATIONS.getByName('single-admin-operations') as unknown as SshOperationsDO;
      if (path.endsWith('age-receipt')) {
        if (typeof createdAt !== 'number') return new Response(null, { status: 400 });
        await operations.ageReceiptForFixture(operationId, createdAt);
        return new Response(null, { status: 204 });
      }
      return Response.json(await operations.getReceiptForFixture(operationId));
    }
    if (path === '/__fixture/seed-legacy' && request.method === 'POST') {
      const input = await request.json() as Parameters<SshOperationsDO['seedLegacyReceiptForFixture']>[0];
      const operations = env.SSH_OPERATIONS.getByName('single-admin-operations') as unknown as SshOperationsDO;
      await operations.seedLegacyReceiptForFixture(input);
      return new Response(null, { status: 204 });
    }
    if (path === '/__fixture/seed-cleanup' && request.method === 'POST') {
      const input = await request.json() as { count: number; createdAt: number };
      const operations = env.SSH_OPERATIONS.getByName('single-admin-operations') as unknown as SshOperationsDO;
      await operations.seedCleanupRowsForFixture(input);
      return new Response(null, { status: 204 });
    }
    if (path === '/__fixture/cleanup-state' && request.method === 'POST') {
      const { cutoff } = await request.json() as { cutoff: number };
      const operations = env.SSH_OPERATIONS.getByName('single-admin-operations') as unknown as SshOperationsDO;
      return Response.json(await operations.getCleanupStateForFixture(cutoff));
    }
    if (path === '/__fixture/session-close-delay' && request.method === 'POST') {
      const operations = env.SSH_OPERATIONS.getByName('single-admin-operations') as unknown as SshOperationsDO;
      await operations.armSessionCloseDelay();
      return new Response(null, { status: 204 });
    }
    if (path === '/__fixture/session-close-release' && request.method === 'POST') {
      const operations = env.SSH_OPERATIONS.getByName('single-admin-operations') as unknown as SshOperationsDO;
      await operations.releaseSessionCloseDelay();
      return new Response(null, { status: 204 });
    }
    if (path === '/__fixture/session-close-entered' && request.method === 'POST') {
      const operations = env.SSH_OPERATIONS.getByName('single-admin-operations') as unknown as SshOperationsDO;
      await operations.waitForSessionCloseEntered();
      return new Response(null, { status: 204 });
    }
    if (path === '/__fixture/session-clock' && request.method === 'POST') {
      const { now } = await request.json() as { now: number | null };
      const operations = env.SSH_OPERATIONS.getByName('single-admin-operations') as unknown as SshOperationsDO;
      await operations.setFixtureClock(now);
      return new Response(null, { status: 204 });
    }
    if (path === '/__fixture/session-alarm' && request.method === 'POST') {
      const operations = env.SSH_OPERATIONS.getByName('single-admin-operations') as unknown as SshOperationsDO;
      await operations.runSessionAlarmForFixture();
      return new Response(null, { status: 204 });
    }
    if (path === '/__fixture/session-alarm-time' && request.method === 'POST') {
      const operations = env.SSH_OPERATIONS.getByName('single-admin-operations') as unknown as SshOperationsDO;
      return Response.json({ alarm: await operations.sessionAlarmForFixture() });
    }
    if (path === '/__fixture/session-activity' && request.method === 'POST') {
      const { sessionId, lastActivityAt } = await request.json() as { sessionId: string; lastActivityAt: number };
      const operations = env.SSH_OPERATIONS.getByName('single-admin-operations') as unknown as SshOperationsDO;
      return Response.json({ updated: await operations.setSessionActivityForFixture(sessionId, lastActivityAt) });
    }
    if (path === '/__fixture/operation-count' && request.method === 'POST') {
      const operations = env.SSH_OPERATIONS.getByName('single-admin-operations') as unknown as SshOperationsDO;
      return Response.json({ count: await operations.operationCountForFixture() });
    }
    if (path === '/__fixture/lease-count' && request.method === 'POST') {
      const operations = env.SSH_OPERATIONS.getByName('single-admin-operations') as unknown as SshOperationsDO;
      return Response.json(await operations.leaseSnapshotForFixture());
    }
    if (path === '/__fixture/digest' && request.method === 'POST') {
      const intent = await request.json() as CanonicalOperationIntent;
      return Response.json({ digest: await canonicalOperationDigest(intent) });
    }
    if (path === '/__fixture/host-row' && request.method === 'POST') {
      const body = await request.json() as {
        action: 'update' | 'delete' | 'insert';
        hostId: string;
        accountId?: string;
        encryptedPayload?: string;
        updatedAt?: number;
      };
      const db = env.EDGE_SSH_DB;
      if (!db) return new Response(null, { status: 503 });
      const statement = body.action === 'delete'
        ? db.prepare('DELETE FROM hosts WHERE id = ?').bind(body.hostId)
        : body.action === 'insert'
          ? db.prepare('INSERT INTO hosts(id, account_id, encrypted_payload, updated_at) VALUES(?, ?, ?, ?)').bind(body.hostId, body.accountId ?? '', body.encryptedPayload ?? '', body.updatedAt ?? 1)
          : db.prepare('UPDATE hosts SET encrypted_payload = ?, updated_at = ? WHERE id = ?').bind(body.encryptedPayload ?? '', body.updatedAt ?? 1, body.hostId);
      await (statement as unknown as { run(): Promise<unknown> }).run();
      return new Response(null, { status: 204 });
    }
    return handler.fetch(request, env);
  },
};
