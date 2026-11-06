// This module shares the runtime grammar. No expanded URI is persisted or logged.
import { configuredCatalog, connectionInventory } from '../apps/database-mcp-worker/src/catalog.ts';
import references from '../apps/database-mcp-worker/connection-references.json' with { type:'json' };
export function databaseCatalogStage(env) {
  const catalog=configuredCatalog(env);
  const secrets={}, variables={DATABASE_CONNECTIONS:env.DATABASE_CONNECTIONS};
  const raw=Object.values(connectionInventory(env.DATABASE_CONNECTIONS)).join('\n');
  for (const name of references.secrets) if (raw.includes('${'+name+'}')) secrets[name]=env[name];
  for (const name of references.variables) if (raw.includes('#{'+name+'}')) variables[name]=env[name];
  return {secrets,variables,count:catalog.length};
}
