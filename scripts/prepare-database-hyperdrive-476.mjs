// Spec #476: Owner-confirmed, protected preparation of an UNBOUND Hyperdrive.
// No secrets enter workflow_dispatch, source, PR, HTTP response, or logs.
// This script never deploys a Worker, enables SQL, or deletes an upstream asset.
import { readFile } from 'node:fs/promises';
import { createDecipheriv } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfiguration, verifyDatabaseHyperdriveSource } from './manual-worker-release.mjs';
import { verifyCloudflareHyperdriveConfig } from './verify-database-hyperdrive.mjs';

const REPO = 'lirtual/mcp-workers';
const D1 = 'cbfe6a05-4979-4e6a-9cc2-4f6468586e4a';
const operationPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const shaPattern = /^[0-9a-f]{40}$/;
const caPattern = /^[A-Za-z0-9-]{8,128}$/;
const fail = reason => { throw Object.assign(new Error('Hyperdrive preparation blocked'), { reason }); };
const requireGate = (ok, reason) => { if (!ok) fail(reason); };

export function verifyPrepareIdentity(env) {
  requireGate(env.GITHUB_REPOSITORY === REPO && env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
    /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') && Number.isSafeInteger(Number(env.GITHUB_RUN_ID)) &&
    env.GITHUB_ACTOR === 'lirtual' && env.GITHUB_REF === 'refs/heads/main' &&
    shaPattern.test(env.GITHUB_SHA ?? '') && operationPattern.test(env.DATABASE_HYPERDRIVE_OPERATION_ID ?? ''),
    'owner_or_identity');
  requireGate(/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID ?? '') &&
    typeof env.CLOUDFLARE_API_TOKEN === 'string' && env.CLOUDFLARE_API_TOKEN.length > 0 &&
    typeof env.GITHUB_TOKEN === 'string' && env.GITHUB_TOKEN.length > 0 &&
    typeof env.DATABASE_GITHUB_ACTIONS_TOKEN === 'string' && env.DATABASE_GITHUB_ACTIONS_TOKEN.length > 0 &&
    typeof env.DATABASE_ENCRYPTION_KEY === 'string' &&
    /^[A-Za-z0-9_-]{1,32}$/.test(env.DATABASE_KEY_ID ?? ''), 'missing_credentials');
  return true;
}
// Only this short-lived, main-only update restriction is accepted by the
// protected Apply. Preparation intentionally does not opt into it.
export function verifySpec476MainMergeWindow(summary, detail) {
  const ref=detail?.conditions?.ref_name;
  const bypass=detail?.bypass_actors;
  const rules=detail?.rules;
  return Number.isSafeInteger(summary?.id) && summary.id>0 &&
    summary.name==='spec476-main-merge-window' &&
    summary.enforcement==='active' && summary.target==='branch' &&
    detail?.id===summary.id && detail.name===summary.name &&
    detail.enforcement==='active' && detail.target==='branch' &&
    detail.source_type==='Repository' && detail.source===REPO &&
    Array.isArray(ref?.include) && ref.include.length===1 &&
    ref.include[0]==='refs/heads/main' &&
    Array.isArray(ref?.exclude) && ref.exclude.length===0 &&
    Array.isArray(bypass) && bypass.length===1 &&
    bypass[0].actor_type==='Integration' && bypass[0].actor_id===15368 &&
    bypass[0].bypass_mode==='always' &&
    Array.isArray(rules) && rules.length===1 && rules[0].type==='update' &&
    rules[0].parameters?.update_allows_fetch_and_merge===false &&
    Object.keys(rules[0].parameters).length===1;
}
export async function verifyGithubPrPreflight({ request = fetch, token, sourceSha,
  allowSpec476MainMergeWindow = false }) {
  const headers = {
    authorization: 'Bearer ' + token, accept: 'application/vnd.github+json',
    'user-agent': 'lirtual-database-hyperdrive-476', 'x-github-api-version': '2022-11-28'
  };
  // GitHub's default Actions permission setting is an Administration API,
  // unrelated to permission to create a PR. The actual write is separately
  // checked after a fresh branch/ruleset/CI readback.
  let branch, protection, rules;
  try {
    const branchResponse = await request('https://api.github.com/repos/' + REPO + '/branches/main', {
      headers, redirect: 'manual', signal: AbortSignal.timeout(10000)
    });
    requireGate(branchResponse.status === 200, 'github_protection_unavailable');
    branch = await branchResponse.json();
    requireGate(branch?.name === 'main' && typeof branch.protected === 'boolean',
      'github_protection_unavailable');
    rules = await request('https://api.github.com/repos/' + REPO + '/rulesets?includes_parents=true&per_page=100', {
      headers, redirect: 'manual', signal: AbortSignal.timeout(10000)
    });
    requireGate(rules.ok, 'github_rulesets_unavailable');
    const parsed = await rules.json();
    requireGate(Array.isArray(parsed) && (parsed.length===0 ||
      (allowSpec476MainMergeWindow && parsed.length===1)), 'github_ruleset_review_required');
    if(parsed.length===1) {
      const rule=parsed[0];
      requireGate(Number.isSafeInteger(rule?.id) && rule.id>0,'github_ruleset_review_required');
      const detailResponse=await request('https://api.github.com/repos/'+REPO+'/rulesets/'+rule.id,{
        headers, redirect:'manual', signal:AbortSignal.timeout(10000)
      });
      requireGate(detailResponse.ok, 'github_ruleset_review_required');
      requireGate(verifySpec476MainMergeWindow(rule,await detailResponse.json()),'github_ruleset_review_required');
      // An enforced Ruleset may itself set branch.protected=true. Do not
      // conflate it with classic protection: prove that endpoint is 404.
      const classic=await request('https://api.github.com/repos/'+REPO+'/branches/main/protection',{
        headers, redirect:'manual', signal:AbortSignal.timeout(10000)
      });
      requireGate(classic.status===404,'github_ruleset_review_required');
    }
    if (branch.protected && parsed.length===0) {
      // A genuinely protected branch needs Administration-read evidence.
      // Do not infer no protection from 401/403/404.
      protection = await request('https://api.github.com/repos/' + REPO + '/branches/main/protection', {
        headers, redirect: 'manual', signal: AbortSignal.timeout(10000)
      });
      requireGate(protection.status === 200, 'github_protection_unavailable');
      const policy = await protection.json();
      const checks = policy?.required_status_checks;
      requireGate(checks?.strict === true && Array.isArray(checks.contexts) &&
        checks.contexts.includes('Required checks gate'), 'github_required_checks_unconfirmed');
    }
    // No settings/review bypass. A protected policy may require human review;
    // preparation does not authorize merge and cannot satisfy those reviews.
    const workflow = await request('https://api.github.com/repos/' + REPO + '/actions/workflows/ci.yml', {
      headers, redirect: 'manual', signal: AbortSignal.timeout(10000)
    });
    requireGate(workflow.ok, 'github_ci_unavailable');
    const ci = await workflow.json();
    requireGate(Number.isSafeInteger(ci.id) && ci.id > 0 && ci.path === '.github/workflows/ci.yml' &&
      ci.state === 'active', 'github_ci_unavailable');
    const head = await request('https://api.github.com/repos/' + REPO + '/git/ref/heads/main', {
      headers, redirect: 'manual', signal: AbortSignal.timeout(10000)
    });
    requireGate(head.ok && (await head.json())?.object?.sha === sourceSha, 'main_sha_changed');
    if (!branch.protected || parsed.length===1) {
      // The running preparer is checked out at this exact main SHA. Require the
      // existing CI definition, including its bounded dispatch/provenance gates.
      const content = await request('https://api.github.com/repos/' + REPO +
        '/contents/.github/workflows/ci.yml?ref=' + sourceSha, {
        headers, redirect:'manual', signal:AbortSignal.timeout(10000)
      });
      requireGate(content.ok, 'github_ci_unavailable');
      const file = await content.json();
      const local = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
      requireGate(file.path === '.github/workflows/ci.yml' && file.type === 'file' &&
        file.encoding === 'base64' && typeof file.content === 'string' &&
        Buffer.from(file.content, 'base64').equals(Buffer.from(local)) &&
        local.includes('  workflow_dispatch:') && local.includes('Verify candidate provenance'),
        'github_ci_unavailable');
    }
  } catch (error) {
    if (error?.reason) throw error;
    fail('github_protection_unavailable');
  }
  return {unprotected: !branch.protected};
}
function openPayload(row, keyBase64) {
  requireGate(row?.action === 'create' && row.expected_revision === 0 &&
    typeof row.logical_id === 'string' && typeof row.ciphertext === 'string', 'operation_invalid');
  let key, iv, encrypted;
  try {
    key = Buffer.from(keyBase64, 'base64');
    requireGate(key.length === 32 && key.toString('base64') === keyBase64, 'encryption_key_invalid');
    const pair = row.ciphertext.split('.');
    requireGate(pair.length === 2, 'ciphertext_invalid');
    iv = Buffer.from(pair[0], 'base64');
    encrypted = Buffer.from(pair[1], 'base64');
    requireGate(iv.length === 12 && encrypted.length >= 16, 'ciphertext_invalid');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from('database-mcp:hyperdrive-operation:v1:' +
      row.operation_id + ':create:' + row.logical_id + ':' + row.expected_revision));
    decipher.setAuthTag(encrypted.subarray(-16));
    const data = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
    const result = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(data));
    requireGate(result.id === row.logical_id && ['mysql','postgres'].includes(result.dialect) &&
      /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(result.id) &&
      /^[A-Za-z0-9][A-Za-z0-9.-]{3,252}$/.test(result.host) &&
      Number.isInteger(Number(result.port)) && Number(result.port) > 0 && Number(result.port) <= 65535 &&
      /^[A-Za-z0-9_.-]{1,128}$/.test(result.user) &&
      /^[A-Za-z0-9_.-]{1,128}$/.test(result.database) &&
      typeof result.password === 'string' && result.password.length > 0 &&
      result.password.length <= 2048 &&
      (result.caReplaces === undefined ||
        (/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(result.caReplaces) &&
          result.caReplaces !== result.id)), 'payload_invalid');
    return result;
  } catch (error) {
    if (error?.reason) throw error;
    fail('ciphertext_invalid');
  }
}
/** CA uploads are unbound and uniquely named. A lost POST receipt is reconciled
 * by exact GET/list, never by attempting a second write with the same name. */
async function certificateForCandidate({candidate,row,operationId,sourceSha,runId,cloud,sql}) {
  const base = '/mtls_certificates';
  if (!candidate.caPem) {
    requireGate(caPattern.test(candidate.caCertificateId ?? ''), 'ca_reference_invalid');
    const cert = await cloud(base + '/' + candidate.caCertificateId);
    requireGate(cert?.id === candidate.caCertificateId && cert.ca === true, 'ca_reference_invalid');
    return candidate.caCertificateId;
  }
  requireGate(!candidate.caCertificateId && typeof candidate.caPem === 'string' &&
    candidate.caPem.length <= 16384 &&
    /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----$/.test(candidate.caPem),
    'ca_reference_invalid');
  const name = 'db476-' + operationId + '-ca';
  const all = await cloud(base);
  requireGate(Array.isArray(all) && all.length < 100, 'ca_inventory_incomplete');
  const matches = all.filter(c => c.name === name);
  requireGate(matches.length <= 1, 'ca_inventory_ambiguous');
  const verify = async id => {
    requireGate(caPattern.test(id ?? ''), 'ca_receipt_invalid');
    const cert = await cloud(base + '/' + id);
    requireGate(cert?.id === id && cert?.ca === true && cert?.name === name &&
      typeof cert.certificates === 'string' &&
      cert.certificates.replaceAll('\r\n', '\n').trim() ===
        candidate.caPem.replaceAll('\r\n', '\n').trim(), 'ca_content_mismatch');
    return id;
  };
  let id;
  let reused = false;
  if (row.ca_write_started_at != null) {
    requireGate(matches.length === 1 &&
      (row.ca_certificate_id == null || matches[0].id === row.ca_certificate_id),
      'ca_outcome_requires_reconciliation');
    id = await verify(matches[0].id);
  } else {
    // An Owner-supplied CA may already be installed. Compare complete PEMs
    // via read-only Cloudflare detail, not a name/issuer guess or a second POST.
    requireGate(matches.length === 0, 'ca_name_collision');
    const existing = [];
    for (const item of all) {
      if (item?.ca !== true || item.type !== 'custom') continue;
      requireGate(caPattern.test(item.id ?? ''), 'ca_inventory_incomplete');
      const cert = await cloud(base + '/' + item.id);
      requireGate(cert?.id === item.id && cert.ca === true &&
        cert.type === 'custom' && typeof cert.certificates === 'string',
        'ca_inventory_incomplete');
      if (cert.certificates.replaceAll('\r\n','\n').trim() ===
          candidate.caPem.replaceAll('\r\n','\n').trim()) existing.push(item.id);
    }
    requireGate(existing.length <= 1,'ca_inventory_ambiguous');
    if (existing.length === 1) {
      // No certificate write occurred. The exact CA identifier is durable
      // provenance; never claim ca_write_started_at for a read-only reuse.
      id = existing[0];
      reused = true;
    } else {
      const claim = await sql(`UPDATE hyperdrive_operations SET ca_write_started_at=?,updated_at=?
        WHERE operation_id=? AND phase='running' AND expected_source_sha=?
        AND ca_write_started_at IS NULL AND resource_write_started_at IS NULL
        AND prepare_run_id=? AND expires_at>?`,
      [Date.now(),Date.now(),operationId,sourceSha,Number(runId),Date.now()]);
      requireGate(claim.meta?.changes === 1, 'ca_write_claim_failed');
      const cert = await cloud(base,'POST',{name,ca:true,certificates:candidate.caPem});
      id = await verify(cert?.id);
    }
  }
  if (row.ca_certificate_id == null) {
    const stored = await sql(`UPDATE hyperdrive_operations SET ca_certificate_id=?,updated_at=?
      WHERE operation_id=? AND phase='running' AND expected_source_sha=?
      AND ca_certificate_id IS NULL AND
      ca_write_started_at IS ${reused ? 'NULL' : 'NOT NULL'}`,
    [id,Date.now(),operationId,sourceSha]);
    requireGate(stored.meta?.changes === 1, 'ca_receipt_unknown');
  }
  return id;
}
function fixedBinding(candidate, operationId) {
  return 'HYPERDRIVE_' + candidate.id.replace(/-/g, '_').toUpperCase().slice(0, 38) +
    '_' + operationId.slice(0, 8).toUpperCase();
}
function checkedManifestSource(source, manifest, candidate, opId) {
  verifyDatabaseHyperdriveSource(source, manifest);
  requireGate(source?.name === 'database-mcp-worker' &&
    source?.d1_databases?.[0]?.database_id === D1 && source?.d1_databases?.length === 1,
    'source_drift');
  const binding = fixedBinding(candidate, opId);
  requireGate(!source.hyperdrive.some(b => b.binding === binding) &&
    !manifest.some(b => b.binding === binding), 'binding_collision');
  return binding;
}
export function patchSource(wranglerText, manifest, entry) {
  const match = /("hyperdrive": \[)([\s\S]*?)(\n  \],|\],)/.exec(wranglerText);
  requireGate(!!match, 'source_format_unknown');
  const original = match[2].trimEnd();
  const addon = '    { "binding": ' + JSON.stringify(entry.binding) +
    ', "id": ' + JSON.stringify(entry.id) + ' }';
  const rows = original.trim().length > 0 ? original.replace(/(\}\s*)$/, '},') + '\n' + addon : '\n' + addon;
  const patched = wranglerText.replace(match[0], match[1] + rows + (match[3] === '],' ? '\n  ],' : match[3]));
  const parsed = JSON.parse(patched);
  const nextManifest = [...manifest, entry];
  verifyDatabaseHyperdriveSource(parsed, nextManifest);
  return {
    'apps/database-mcp-worker/wrangler.jsonc': patched,
    'apps/database-mcp-worker/hyperdrive-bindings.json': JSON.stringify(nextManifest, null, 2) + '\n'
  };
}
/** Exact source readbacks; filenames and PR creation alone cannot attest the diff. */
export async function verifyPreparedPullRequest({github,operationId,baseSha,headSha,prNumber,files}) {
  const pr = await github('/pulls/' + prNumber);
  requireGate(pr?.number === prNumber && pr.state === 'open' && pr.changed_files === 2 &&
    pr.commits === 1 && pr.head?.sha === headSha && pr.head?.ref === 'db476-' + operationId &&
    pr.head?.repo?.full_name === REPO && pr.base?.sha === baseSha &&
    pr.base?.ref === 'main' && pr.base?.repo?.full_name === REPO, 'github_pr_identity_drift');
  const commit = await github('/git/commits/' + headSha);
  requireGate(commit?.sha === headSha && commit.parents?.length === 1 &&
    commit.parents[0]?.sha === baseSha, 'github_pr_parent_drift');
  const changed = await github('/pulls/' + prNumber + '/files?per_page=3');
  requireGate(Array.isArray(changed) && changed.length === 2 &&
    new Set(changed.map(f=>f.filename)).size === 2, 'github_pr_diff_invalid');
  for (const file of changed) {
    requireGate(Object.hasOwn(files,file.filename) && file.status === 'modified' &&
      !file.previous_filename && shaPattern.test(file.sha ?? ''), 'github_pr_diff_not_allowlisted');
    const blob = await github('/git/blobs/' + file.sha);
    requireGate(blob?.sha === file.sha && blob.encoding === 'base64' &&
      typeof blob.content === 'string' &&
      Buffer.from(blob.content,'base64').equals(Buffer.from(files[file.filename])), 'github_pr_content_drift');
  }
  return true;
}

/** One-time passwordless restaging. The old failed operation is read-only. */
export async function recoverFailedHyperdriveCandidate({row, sourceText, source, manifest,
    baseSha, runId, github, cloud, sql, preflight}) {
  requireGate(row?.action === 'create' && row.expected_revision === 0 &&
    row.phase === 'failed' && row.error_class === 'apply_merge_denied' &&
    operationPattern.test(row.operation_id ?? '') &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(row.logical_id ?? '') &&
    shaPattern.test(row.expected_source_sha ?? '') &&
    shaPattern.test(row.head_sha ?? '') && shaPattern.test(baseSha) &&
    /^[a-f0-9]{32}$/.test(row.config_id ?? '') &&
    row.binding_name === fixedBinding({id:row.logical_id},row.operation_id) &&
    caPattern.test(row.ca_certificate_id ?? '') &&
    Number.isSafeInteger(row.pr_number) && row.pr_number > 0 &&
    Number.isSafeInteger(row.prepare_run_id) && row.prepare_run_id > 0 &&
    Number.isSafeInteger(row.apply_run_id) && row.apply_run_id > 0 &&
    Number.isSafeInteger(row.ci_run_id) && row.ci_run_id > 0 &&
    row.resource_write_started_at != null && row.ca_write_started_at == null &&
    row.ciphertext == null && row.key_id == null &&
    row.merged_sha == null && row.release_run_id == null &&
    row.published_version_id == null && row.expected_source_sha !== baseSha,
    'recovery_operation_invalid');

  const comparison = await github('/compare/' + row.expected_source_sha + '...' + baseSha);
  const paths = ['apps/database-mcp-worker/wrangler.jsonc',
    'apps/database-mcp-worker/hyperdrive-bindings.json'];
  requireGate(comparison.status === 'ahead' && comparison.behind_by === 0 &&
    Number.isSafeInteger(comparison.ahead_by) && comparison.ahead_by >= 1 &&
    comparison.ahead_by <= 100 && Array.isArray(comparison.files) &&
    !comparison.files.some(f => paths.includes(f.filename) ||
      paths.includes(f.previous_filename)), 'recovery_base_drift');
  const oldTexts = await Promise.all(paths.map(async path => {
    const file = await github('/contents/' + path + '?ref=' + row.expected_source_sha);
    requireGate(file?.path === path && file.type === 'file' && file.encoding === 'base64' &&
      typeof file.content === 'string', 'recovery_source_unavailable');
    return Buffer.from(file.content,'base64').toString('utf8');
  }));
  const oldSource = readConfiguration('database-mcp-worker',oldTexts[0]);
  const oldManifest = JSON.parse(oldTexts[1]);
  verifyDatabaseHyperdriveSource(oldSource,oldManifest);
  verifyDatabaseHyperdriveSource(source,manifest);
  requireGate(oldTexts[0] === sourceText &&
    oldTexts[1] === JSON.stringify(manifest,null,2)+'\n' &&
    oldSource.name === 'database-mcp-worker' &&
    oldSource.d1_databases?.length === 1 &&
    oldSource.d1_databases[0]?.database_id === D1, 'recovery_base_drift');

  const config = await cloud('/hyperdrive/configs/' + row.config_id);
  requireGate(config?.id === row.config_id &&
    config.name === 'db476-' + row.operation_id &&
    config.mtls?.ca_certificate_id === row.ca_certificate_id &&
    config.caching?.disabled === true, 'recovery_config_drift');
  // Preserve original Prepare's field insertion order: id is appended last.
  // The reviewed manifest Blob is verified byte-for-byte, not as parsed JSON.
  const entry = {binding:row.binding_name,
    dialect:config.origin?.scheme === 'postgresql'?'postgres':config.origin?.scheme,
    origin_host:config.origin?.host,origin_port:config.origin?.port,
    origin_database:config.origin?.database,origin_user:config.origin?.user,
    ca_certificate_id:row.ca_certificate_id};
  entry.id = row.config_id;
  verifyCloudflareHyperdriveConfig(entry,config);
  await verifyPreparedPullRequest({github,operationId:row.operation_id,
    baseSha:row.expected_source_sha,headSha:row.head_sha,prNumber:row.pr_number,
    files:patchSource(oldTexts[0],oldManifest,entry)});
  const unused=await sql('SELECT COUNT(*) AS n FROM database_connections WHERE id=? UNION ALL SELECT COUNT(*) AS n FROM retired_connection_ids WHERE id=?',
    [row.logical_id,row.logical_id]);
  requireGate(unused.results?.length === 2 &&
    unused.results.every(r=>r.n===0), 'recovery_logical_id_unavailable');
  const newId=crypto.randomUUID();
  const binding=checkedManifestSource(source,manifest,{id:row.logical_id},newId);
  const newFiles=patchSource(sourceText,manifest,{...entry,binding});
  await preflight();
  const now=Date.now();
  const reserved=await sql(`INSERT INTO hyperdrive_operations
    (operation_id,logical_id,action,expected_revision,phase,expected_source_sha,
      config_id,binding_name,ca_certificate_id,prepare_run_id,created_at,updated_at,expires_at)
    SELECT ?,prev.logical_id,'create',0,'running',?,?,?,?,?,?,?,?
    FROM hyperdrive_operations prev WHERE prev.operation_id=?
      AND prev.phase='failed' AND prev.error_class='apply_merge_denied'
      AND prev.config_id=? AND prev.apply_run_id=? AND prev.ci_run_id=?
      AND prev.head_sha=? AND prev.expected_source_sha=?
      AND NOT EXISTS (SELECT 1 FROM hyperdrive_operations other
        WHERE other.config_id=prev.config_id AND other.operation_id<>prev.operation_id)
      AND NOT EXISTS (SELECT 1 FROM database_connections WHERE id=prev.logical_id)
      AND NOT EXISTS (SELECT 1 FROM retired_connection_ids WHERE id=prev.logical_id)`,
    [newId,baseSha,row.config_id,binding,row.ca_certificate_id,Number(runId),
      now,now,now+7*24*60*60_000,row.operation_id,row.config_id,
      row.apply_run_id,row.ci_run_id,row.head_sha,row.expected_source_sha]);
  requireGate(reserved.meta?.changes === 1,'recovery_reservation_conflict');
  try {
    const parent=await github('/git/commits/' + baseSha);
    requireGate(parent?.sha === baseSha && shaPattern.test(parent.tree?.sha ?? ''),
      'recovery_main_tree_invalid');
    const tree=await github('/git/trees','POST',{base_tree:parent.tree.sha,
      tree:await Promise.all(Object.entries(newFiles).map(async ([path,content])=>({
        path,mode:'100644',type:'blob',sha:(await github('/git/blobs','POST',{
          content:Buffer.from(content).toString('base64'),encoding:'base64'})).sha
      })))});
    const commit=await github('/git/commits','POST',{
      message:'feat(database): recover reviewed Hyperdrive binding for #476 '+newId,
      tree:tree.sha,parents:[baseSha]});
    requireGate(shaPattern.test(commit?.sha ?? ''),'recovery_commit_invalid');
    await github('/git/refs','POST',{ref:'refs/heads/db476-'+newId,sha:commit.sha});
    const policy=await preflight();
    const pr=await github('/pulls','POST',{
      title:'feat(database): recover Hyperdrive binding '+row.logical_id,
      head:'db476-'+newId,base:'main',draft:!policy.unprotected,
      body:'Spec #476 · Recovery operation '+newId+'\n\nPreserves failed operation '+
        row.operation_id+' and reuses verified Config '+row.config_id+
        '. No origin credentials, CA upload or additional Hyperdrive Config.'});
    requireGate(Number.isSafeInteger(pr?.number) && pr.number>0,'recovery_pr_invalid');
    await verifyPreparedPullRequest({github,operationId:newId,baseSha,
      headSha:commit.sha,prNumber:pr.number,files:newFiles});
    const stored=await sql(`UPDATE hyperdrive_operations SET phase='awaiting_confirmation',
      pr_number=?,head_sha=?,updated_at=?,error_class='github_pr_ci_pending'
      WHERE operation_id=? AND phase='running' AND prepare_run_id=?
      AND expected_source_sha=? AND config_id=? AND binding_name=?
      AND pr_number IS NULL AND head_sha IS NULL AND apply_run_id IS NULL`,
    [pr.number,commit.sha,Date.now(),newId,Number(runId),baseSha,row.config_id,binding]);
    requireGate(stored.meta?.changes===1,'recovery_receipt_unknown');
    return {operationId:newId,phase:'awaiting_confirmation',prNumber:pr.number};
  } catch(error) {
    await sql(`UPDATE hyperdrive_operations SET phase='unknown',
      error_class='preparation_requires_reconciliation',updated_at=?
      WHERE operation_id=? AND phase='running' AND prepare_run_id=?`,
    [Date.now(),newId,Number(runId)]).catch(()=>undefined);
    throw error;
  }
}

export async function prepareDatabaseHyperdrive(env = process.env, request = fetch) {
  verifyPrepareIdentity(env);
  const cloudBase = 'https://api.cloudflare.com/client/v4/accounts/' + env.CLOUDFLARE_ACCOUNT_ID;
  const cfHeaders = {authorization:'Bearer ' + env.CLOUDFLARE_API_TOKEN, accept:'application/json'};
  const ghHeaders = {authorization:'Bearer ' + env.GITHUB_TOKEN, accept:'application/vnd.github+json',
    'content-type':'application/json', 'user-agent':'lirtual-database-hyperdrive-476',
    'x-github-api-version':'2022-11-28'};
  async function cloud(path, method='GET', body) {
    let response, data;
    try {
      response = await request(cloudBase + path, {method, headers: {...cfHeaders,
        ...(body ? {'content-type':'application/json'} : {})},
        ...(body ? {body: JSON.stringify(body)} : {}), redirect:'manual',signal:AbortSignal.timeout(15000)});
      if (!response.ok && path.startsWith('/mtls_certificates')) {
        fail(response.status === 401 || response.status === 403 ?
          'ca_permission_denied' : 'ca_upstream_unavailable');
      }
      requireGate(response.ok, 'cloudflare_permission_or_status');
      data = await response.json();
      if (method === 'GET' && (path === '/hyperdrive/configs' || path === '/mtls_certificates')) {
        requireGate((data.result_info?.total_pages ?? 1) <= 1 &&
          (!data.result_info?.total_count || data.result_info.total_count <= data.result?.length),
          'cloudflare_inventory_incomplete');
      }
      requireGate(data?.success === true && data.result !== undefined, 'cloudflare_response_invalid');
    } catch (error) { if (error?.reason) throw error; fail('cloudflare_outcome_unknown'); }
    return data.result;
  }
  async function sql(query, params=[]) {
    const result = await cloud('/d1/database/' + D1 + '/query','POST',
      {sql:query,params:params.map(String)});
    requireGate(Array.isArray(result) && result.length === 1 &&
      result[0]?.success === true, 'd1_unavailable');
    return result[0];
  }
  async function github(path, method='GET', body) {
    let response;
    try {
      response = await request('https://api.github.com/repos/' + REPO + path, {
        method, headers:ghHeaders, ...(body ? {body:JSON.stringify(body)} : {}),
        redirect:'manual',signal:AbortSignal.timeout(15000)
      });
      requireGate(response.ok, 'github_write_unavailable');
      return await response.json();
    } catch (error) { if (error?.reason) throw error; fail('github_outcome_unknown'); }
  }
  // Preflight repository capabilities BEFORE any Cloudflare resource writes.
  await verifyGithubPrPreflight({request, token:env.DATABASE_GITHUB_ACTIONS_TOKEN, sourceSha:env.GITHUB_SHA});
  const text = await readFile(new URL('../apps/database-mcp-worker/wrangler.jsonc', import.meta.url), 'utf8');
  const source = readConfiguration('database-mcp-worker', text);
  const manifest = JSON.parse(await readFile(
    new URL('../apps/database-mcp-worker/hyperdrive-bindings.json', import.meta.url), 'utf8'));
  const operationId = env.DATABASE_HYPERDRIVE_OPERATION_ID;
  try {
  const rows = await sql('SELECT * FROM hyperdrive_operations WHERE operation_id=?', [operationId]);
  requireGate(rows.results?.length === 1, 'operation_not_found');
  const row = rows.results[0];
  if (row.phase === 'failed') {
    return recoverFailedHyperdriveCandidate({row,sourceText:text,source,manifest,
      baseSha:env.GITHUB_SHA,runId:env.GITHUB_RUN_ID,github,cloud,sql,
      preflight:()=>verifyGithubPrPreflight({
        request,token:env.DATABASE_GITHUB_ACTIONS_TOKEN,sourceSha:env.GITHUB_SHA})});
  }
  requireGate(['pending','running','unknown'].includes(row.phase) &&
    Number(row.expires_at) > Date.now() &&
    row.key_id === env.DATABASE_KEY_ID &&
    (!row.prepare_run_id || Number(row.prepare_run_id) === Number(env.GITHUB_RUN_ID)),
    'operation_not_current');
  requireGate(row.resource_write_started_at == null, 'cloudflare_outcome_requires_reconciliation');
  const unique = await sql('SELECT COUNT(*) AS n FROM database_connections WHERE id=? UNION ALL SELECT COUNT(*) AS n FROM retired_connection_ids WHERE id=?',
    [row.logical_id, row.logical_id]);
  requireGate(unique.results?.length === 2 && unique.results.every(r => r.n === 0),
    'logical_id_unavailable');
  const candidate = openPayload(row, env.DATABASE_ENCRYPTION_KEY);
  // An independent CA replacement must retain the old origin identity.
  // Recheck trusted immutable D1 provenance at the protected Runner, not
  // solely at the Owner preview. Never PATCH the old config or CA.
  if (candidate.caReplaces) {
    const previous = await sql(`SELECT id,dialect,transport,config_id,binding_name,target_metadata
      FROM database_connections WHERE id=?`, [candidate.caReplaces]);
    requireGate(previous.results?.length === 1, 'ca_replacement_target_changed');
    const prior = previous.results[0];
    let metadata;
    try { metadata = JSON.parse(prior.target_metadata); }
    catch { fail('ca_replacement_target_changed'); }
    const fields = ['binding','id','dialect','origin_host','origin_port',
      'origin_database','origin_user','ca_certificate_id'];
    requireGate(prior.transport === 'hyperdrive' && prior.id !== candidate.id &&
      metadata && typeof metadata === 'object' && !Array.isArray(metadata) &&
      Object.keys(metadata).length === fields.length &&
      fields.every(field => Object.hasOwn(metadata, field)) &&
      metadata.binding === prior.binding_name && metadata.id === prior.config_id &&
      prior.dialect === candidate.dialect && metadata.dialect === candidate.dialect &&
      metadata.origin_host === candidate.host.toLowerCase() &&
      metadata.origin_port === Number(candidate.port) &&
      metadata.origin_database === candidate.database &&
      metadata.origin_user === candidate.user &&
      typeof metadata.ca_certificate_id === 'string' &&
      (!candidate.caCertificateId ||
        candidate.caCertificateId !== metadata.ca_certificate_id),
      'ca_replacement_target_changed');
    // D1 provenance is immutable, but the old Cloudflare configuration can
    // drift independently. Refuse to prepare replacement CA/config assets if
    // the live target no longer matches the reviewed origin and strict TLS.
    requireGate(/^[a-f0-9]{32}$/i.test(prior.config_id ?? ''),
      'ca_replacement_target_changed');
    let previousConfig;
    try { previousConfig = await cloud('/hyperdrive/configs/' + prior.config_id); }
    catch { fail('ca_replacement_config_unavailable'); }
    try { verifyCloudflareHyperdriveConfig(metadata, previousConfig); }
    catch { fail('ca_replacement_target_changed'); }
  }
  const binding = checkedManifestSource(source, manifest, candidate, operationId);
  // Before Cloudflare POST: CAS the operation and source identity. Unknown
  // outcomes must be reconciled using the deterministic name rather than retried.
  const reservation = await sql(`UPDATE hyperdrive_operations SET phase='running',
    expected_source_sha=?,prepare_run_id=?,updated_at=?,error_class=NULL WHERE operation_id=?
    AND phase IN ('pending','running','unknown') AND expected_revision=0
    AND (expected_source_sha IS NULL OR expected_source_sha=?)`,
    [env.GITHUB_SHA,env.GITHUB_RUN_ID,Date.now(),operationId,env.GITHUB_SHA]);
  requireGate(reservation.meta?.changes === 1, 'operation_cas_failed');
  // Validate the candidate's certificate independently before any config write.
  // Upload is separately claimed in D1 and never repeated after an unknown POST.
  const name = 'db476-' + operationId;
  const base = '/hyperdrive/configs';
  const configs = await cloud(base);
  requireGate(Array.isArray(configs) && configs.length < 100, 'cloudflare_inventory_incomplete');
  const matches = configs.filter(item => item.name === name);
  requireGate(matches.length === 0, 'cloudflare_existing_candidate_requires_reconciliation');
  const certificateId = await certificateForCandidate({candidate,row,operationId,
    sourceSha:env.GITHUB_SHA,runId:env.GITHUB_RUN_ID,cloud,sql});
  const expected = {
    binding, dialect:candidate.dialect,
    origin_host:candidate.host.toLowerCase(), origin_port:Number(candidate.port),
    origin_database:candidate.database, origin_user:candidate.user,
    ca_certificate_id:certificateId
  };
  // Claim the external write exactly once, including across re-runs whose POST
  // timed out. Inventory name matching cannot verify a write-only password.
  const claimed = await sql(`UPDATE hyperdrive_operations SET resource_write_started_at=?,
    updated_at=? WHERE operation_id=? AND phase='running'
    AND expected_source_sha=? AND resource_write_started_at IS NULL AND expires_at>?`,
    [Date.now(),Date.now(),operationId,env.GITHUB_SHA,Date.now()]);
  requireGate(claimed.meta?.changes === 1, 'cloudflare_outcome_requires_reconciliation');
  let config;
  {
    config = await cloud(base,'POST',{
      name,origin:{scheme:candidate.dialect,host:expected.origin_host,port:expected.origin_port,
        database:candidate.database,user:candidate.user,password:candidate.password},
      mtls:{sslmode:candidate.dialect==='mysql'?'VERIFY_IDENTITY':'verify-full',
        ca_certificate_id:certificateId},
      caching:{disabled:true}, origin_connection_limit:5
    });
  }
  requireGate(/^[a-f0-9]{32}$/i.test(config?.id ?? ''), 'cloudflare_config_invalid');
  expected.id = config.id;
  const recorded = await sql(`UPDATE hyperdrive_operations SET config_id=?,binding_name=?,updated_at=?
    WHERE operation_id=? AND phase='running' AND expected_source_sha=? AND config_id IS NULL`,
    [config.id,binding,Date.now(),operationId,env.GITHUB_SHA]);
  requireGate(recorded.meta?.changes === 1, 'operation_cas_failed');
  const actual = await cloud(base + '/' + config.id);
  verifyCloudflareHyperdriveConfig(expected, actual);
  // The only generated source changes are the reviewed Binding and provenance
  // entry. No user input can specify a file, workflow, executable, or ref.
  const files = patchSource(text,manifest,expected);
  // Recheck main and policy after Cloudflare preparation, before any git write.
  const policy = await verifyGithubPrPreflight({request,token:env.DATABASE_GITHUB_ACTIONS_TOKEN,sourceSha:env.GITHUB_SHA});
  const parent = await github('/git/commits/' + env.GITHUB_SHA);
  requireGate(shaPattern.test(parent?.tree?.sha ?? ''), 'main_tree_missing');
  const tree = await github('/git/trees','POST',{
    base_tree:parent.tree.sha,
    tree: await Promise.all(Object.entries(files).map(async ([path,content]) => ({
      path,mode:'100644',type:'blob',
      sha:(await github('/git/blobs','POST',{content:Buffer.from(content).toString('base64'),encoding:'base64'})).sha
    })))
  });
  const commit = await github('/git/commits','POST',{
    message:'feat(database): stage Hyperdrive binding for #476 ' + operationId,
    tree:tree.sha,parents:[env.GITHUB_SHA]
  });
  const branch = 'db476-' + operationId;
  await github('/git/refs','POST',{ref:'refs/heads/' + branch,sha:commit.sha});
  const pr = await github('/pulls','POST',{
    title:'feat(database): Hyperdrive binding ' + candidate.id,
    head:branch,base:'main',draft:!policy.unprotected,
    body:'Spec #476 · Operation ' + operationId +
      '\n\nOnly the allowlisted nonsecret Binding and provenance manifest change. ' +
      'Owner must confirm and verify real CI/merge eligibility before publishing.'
  });
  requireGate(Number.isSafeInteger(pr?.number) && pr.number > 0 &&
    shaPattern.test(commit?.sha ?? ''), 'github_pr_invalid');
  await verifyPreparedPullRequest({github,operationId,baseSha:env.GITHUB_SHA,
    headSha:commit.sha,prNumber:pr.number,files});
  // The 15-minute encrypted intake is complete; PR review and protected
  // publication need a separate nonsecret window. Never extend ciphertext life.
  const reviewedAt = Date.now();
  const reviewExpiresAt = reviewedAt + 7 * 24 * 60 * 60_000;
  const stored = await sql(`UPDATE hyperdrive_operations
    SET phase='awaiting_confirmation',ciphertext=NULL,key_id=NULL,config_id=?,binding_name=?,
    pr_number=?,head_sha=?,updated_at=?,expires_at=?,error_class='github_pr_ci_pending' WHERE operation_id=?
      AND phase='running' AND expected_source_sha=? AND expires_at>?`,
    [config.id,binding,pr.number,commit.sha,reviewedAt,reviewExpiresAt,operationId,env.GITHUB_SHA,reviewedAt]);
  requireGate(stored.meta?.changes === 1, 'operation_cas_failed');
  return {operationId, phase:'awaiting_confirmation',prNumber:pr.number};
  } catch (error) {
    // Preserve a receipt even if Cloudflare/GitHub accepted a write whose
    // response was lost. Do not release this ID or replay an external step.
    const safeClasses = new Set(['ca_replacement_target_changed',
      'ca_replacement_config_unavailable','ca_permission_denied','ca_upstream_unavailable',
      'ca_inventory_incomplete','ca_inventory_ambiguous','ca_name_collision',
      'ca_content_mismatch','ca_outcome_requires_reconciliation','ca_receipt_unknown',
      'ca_reference_invalid','ca_receipt_invalid','ca_write_claim_failed']);
    await sql(`UPDATE hyperdrive_operations SET phase='unknown',
      error_class=?,updated_at=?
      WHERE operation_id=? AND phase IN ('pending','running','unknown')`,
      [safeClasses.has(error?.reason) ? error.reason : 'preparation_requires_reconciliation',
        Date.now(),operationId]).catch(()=>undefined);
    throw error;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareDatabaseHyperdrive().then(() => {
    process.stdout.write('HYPERDRIVE_UNBOUND_PREPARATION_AWAITING_OWNER_CONFIRMATION\n');
  }).catch(() => {
    process.stderr.write('HYPERDRIVE_PREPARATION_BLOCKED_OR_UNKNOWN\n');
    process.exitCode = 1;
  });
}
