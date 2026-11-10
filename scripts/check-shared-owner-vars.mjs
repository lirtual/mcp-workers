// Spec #733: compare the Environment-effective identity to the source captured
// by the existing reusable CI job, which has NO Worker Environment attached.
// The separate GitHub Settings audit must still prove no same-value shadow.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const scoped = new Set(['browser-mcp-worker']);
export function verifySharedOwnerVars(worker, env) {
  if (!scoped.has(worker)) throw Error('Unsupported shared Owner release target');
  if (env.GITHUB_REPOSITORY !== 'lirtual/mcp-workers' ||
      env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_ACTOR !== 'lirtual')
    throw Error('Invalid shared Owner release context');
  const fields = [
    ['OWNER_EMAIL', 'CANONICAL_OWNER_EMAIL', /^[^@\s]+@[^@\s]+\.[^@\s]+$/],
  ];
  for (const [runtime, source, pattern] of fields) {
    const actual = env[runtime], canonical = env[source];
    if (typeof canonical !== 'string' || canonical.length > 256 ||
        !pattern.test(canonical) || actual !== canonical)
      throw Error('Selected Worker Owner identity differs from canonical Repository source: ' + runtime);
  }
  return true;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    verifySharedOwnerVars(process.argv[2], process.env);
    console.log('Selected Worker effective Owner identity matches Repository source: PASS');
  } catch (error) {
    console.error('Repository Owner identity gate: BLOCKED (' +
      (/^Selected Worker Owner identity differs|^Invalid shared Owner release context|^Unsupported shared Owner release target/.test(error?.message ?? '')
        ? error.message : 'invalid input') + ')');
    process.exitCode = 1;
  }
}
