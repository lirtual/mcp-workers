import handler from '../../src/handler.ts';
import { SshOperationsDO as ProductionOperationsDO } from '../../src/operations.ts';
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
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/__fixture/receipt-store-failure' || path === '/__fixture/running-update-failure') {
      const operations = env.SSH_OPERATIONS.getByName('single-admin-operations') as unknown as SshOperationsDO;
      if (request.method === 'PUT' && path.endsWith('running-update-failure')) await operations.injectRunningUpdateFailure();
      else if (request.method === 'DELETE' && path.endsWith('running-update-failure')) await operations.clearRunningUpdateFailure();
      else if (request.method === 'PUT') await operations.injectReceiptStoreFailure();
      else await operations.clearReceiptStoreFailure();
      return new Response(null, { status: 204 });
    }
    return handler.fetch(request, env);
  },
};
