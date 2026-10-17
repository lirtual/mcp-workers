import handler from '../../src/handler.ts';
import { canonicalOperationDigest, SshOperationsDO as ProductionOperationsDO, type CanonicalOperationIntent } from '../../src/operations.ts';
import type { Env } from '../../src/types.ts';

// This entrypoint is used only by the disposable local e2e runner. It routes the
// fixture hostname to loopback while exercising the production DO admission,
// receipt, SSH client, pin verification, and result handling code.
export class SshOperationsDO extends ProductionOperationsDO {
  protected override async resolveTarget(_host: string, _signal?: AbortSignal): Promise<string> {
    return '127.0.0.1';
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
    if (path === '/__fixture/digest' && request.method === 'POST') {
      const intent = await request.json() as CanonicalOperationIntent;
      return Response.json({ digest: await canonicalOperationDigest(intent) });
    }
    return handler.fetch(request, env);
  },
};
