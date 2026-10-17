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
    if (path === '/__fixture/digest' && request.method === 'POST') {
      const intent = await request.json() as CanonicalOperationIntent;
      return Response.json({ digest: await canonicalOperationDigest(intent) });
    }
    return handler.fetch(request, env);
  },
};
