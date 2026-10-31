// Spec #476: final Owner confirmation. Never retry external writes or activate D1 here.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchSource, verifyPreparedPullRequest, verifyGithubPrPreflight, verifySpec476MainMergeWindow } from './prepare-database-hyperdrive-476.mjs';
import { readConfiguration } from './manual-worker-release.mjs';
import { verifyCloudflareHyperdriveConfig } from './verify-database-hyperdrive.mjs';

const REPO = 'lirtual/mcp-workers';
const D1 = 'cbfe6a05-4979-4e6a-9cc2-4f6468586e4a';
const SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const PATHS = ['apps/database-mcp-worker/wrangler.jsonc', 'apps/database-mcp-worker/hyperdrive-bindings.json'];
const gate = (ok, reason) => { if (!ok) throw Object.assign(new Error('Hyperdrive apply blocked'), { reason }); };

export function verifyApplyIdentity(env) {
  gate(env.GITHUB_REPOSITORY === REPO && env.GITHUB_ACTOR === 'lirtual' &&
    env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_REF === 'refs/heads/main' &&
    env.GITHUB_RUN_ATTEMPT === '1' && /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') &&
    Number.isSafeInteger(Number(env.GITHUB_RUN_ID)) && SHA.test(env.GITHUB_SHA ?? '') &&
    UUID.test(env.DATABASE_HYPERDRIVE_OPERATION_ID ?? ''), 'apply_identity_invalid');
  gate(/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID ?? '') &&
    ['CLOUDFLARE_API_TOKEN','GITHUB_TOKEN','DATABASE_GITHUB_ACTIONS_TOKEN'].every(k =>
      typeof env[k] === 'string' && env[k].length > 0), 'apply_credentials_unavailable');
}

// Read the ordinary branch metadata and effective rules independently.
// An Admin API permission error NEVER means the branch is unprotected.
async function readApplyPolicy(github) {
  let branch, rules;
  try {
    branch = await github('/branches/main');
    rules = await github('/rulesets?includes_parents=true&per_page=100');
  } catch { gate(false, 'apply_policy_unavailable'); }
  gate(branch?.name === 'main' && typeof branch.protected === 'boolean' &&
    Array.isArray(rules) && rules.length<=1, 'apply_policy_unavailable');
  if(rules.length===1){
    gate(Number.isSafeInteger(rules[0]?.id) && rules[0].id>0,'apply_policy_unavailable');
    let detail;
    try { detail=await github('/rulesets/'+rules[0].id); }
    catch { gate(false,'apply_policy_unavailable'); }
    gate(verifySpec476MainMergeWindow(rules[0],detail),'apply_policy_unavailable');
    // REST branch.protected may count the Ruleset itself. Require an actual
    // 404 from the classic-protection endpoint, not a Boolean inference.
    try { await github('/branches/main/protection'); gate(false,'apply_policy_unavailable'); }
    catch(error){ gate(error?.status===404,'apply_policy_unavailable'); }
    return null;
  }
  if (!branch.protected) return null;
  let policy;
  try { policy = await github('/branches/main/protection'); }
  catch { gate(false, 'apply_policy_unavailable'); }
  gate(policy !== null && typeof policy === 'object' && !Array.isArray(policy) &&
    policy?.enforce_admins?.enabled === true, 'apply_policy_unavailable');
  return policy;
}

async function verifyCandidateCi(github, row, runId, pending = false) {
  gate(Number.isSafeInteger(runId) && runId > 0, 'apply_ci_receipt_unknown');
  const workflow = await github('/actions/workflows/ci.yml');
  gate(Number.isSafeInteger(workflow?.id) && workflow.id > 0 && workflow.state === 'active' &&
    workflow.path === '.github/workflows/ci.yml', 'apply_ci_receipt_unknown');
  const run = await github('/actions/runs/' + runId);
  gate(run?.id === runId && run.workflow_id === workflow.id && run.run_attempt === 1 &&
    run.repository?.full_name === REPO && run.event === 'workflow_dispatch' &&
    run.path === '.github/workflows/ci.yml' && run.actor?.login === 'lirtual' &&
    run.triggering_actor?.login === 'lirtual' && run.head_sha === row.head_sha &&
    run.head_branch === 'db476-' + row.operation_id &&
    ['queued','in_progress','completed','waiting','requested','pending'].includes(run.status),
    'apply_ci_receipt_unknown');
  if (pending && run.status !== 'completed') return false;
  gate(run.status === 'completed' && run.conclusion === 'success', 'apply_ci_failed');
  const result = await github('/actions/runs/' + runId + '/jobs?filter=latest&per_page=100');
  const names = ['Application checks','Database integration','Required checks gate'];
  gate(Array.isArray(result?.jobs) && result.total_count === result.jobs.length &&
    result.jobs.length === names.length && names.every(name =>
      result.jobs.filter(job => job.name === name).length === 1) &&
    result.jobs.every(job => job.run_id === runId && job.head_sha === row.head_sha &&
      job.status === 'completed' && job.conclusion === 'success'), 'apply_ci_failed');
  return true;
}

/** Dispatch evidence is accepted ONLY under a freshly proven unprotected policy. */
export async function verifyApplyEligibility(github, row, ciRunId, policyGithub = github) {
  const policy = await readApplyPolicy(policyGithub);
  const checks = policy?.required_status_checks;
  if (policy !== null) {
    gate(checks?.strict === true && Array.isArray(checks.contexts) &&
      checks.contexts.includes('Required checks gate') && Array.isArray(checks.checks) &&
      checks.contexts.every(c => typeof c === 'string' && c.length > 0) &&
      new Set(checks.checks.map(c => c.context)).size === checks.checks.length &&
      checks.checks.every(c => typeof c.context === 'string' && c.context.length > 0 &&
        (c.app_id === null || (Number.isSafeInteger(c.app_id) && c.app_id > 0))), 'apply_policy_unavailable');
  }
  const pr = await github('/pulls/' + row.pr_number);
  gate(pr.head?.sha === row.head_sha && pr.base?.sha === row.expected_source_sha &&
    pr.state === 'open' && pr.merged === false, 'apply_pr_stale');
  gate(pr.draft === false, 'apply_pr_draft');
  gate(pr.mergeable === true && pr.mergeable_state === 'clean', 'apply_merge_denied');
  const graph = await github('/graphql', 'POST', {
    query: 'query($number:Int!){repository(owner:"lirtual",name:"mcp-workers"){pullRequest(number:$number){headRefOid baseRefOid reviewDecision mergeStateStatus}}}',
    variables: {number:row.pr_number}
  });
  const decision = graph?.data?.repository?.pullRequest;
  gate(!graph?.errors && decision?.headRefOid === row.head_sha &&
    decision.baseRefOid === row.expected_source_sha && decision.mergeStateStatus === 'CLEAN',
    'apply_merge_denied');
  if (policy === null) {
    // No invented reviewer: GitHub must report no review requirement and CLEAN.
    gate(decision.reviewDecision === null, 'apply_review_missing');
    gate((await github('/git/ref/heads/db476-' + row.operation_id))?.object?.sha === row.head_sha,
      'apply_pr_stale');
    await verifyCandidateCi(github, row, ciRunId);
    return pr;
  }
  const reviews = policy.required_pull_request_reviews;
  gate(reviews && Number.isSafeInteger(reviews.required_approving_review_count) &&
    reviews.required_approving_review_count >= 0, 'apply_policy_unavailable');
  gate(decision.reviewDecision === 'APPROVED' ||
    (reviews.required_approving_review_count === 0 && reviews.require_code_owner_reviews === false &&
      decision.reviewDecision === null), 'apply_review_missing');

  const runs = await github('/commits/' + row.head_sha + '/check-runs?per_page=100&filter=latest');
  const statuses = await github('/commits/' + row.head_sha + '/status?per_page=100');
  gate(Array.isArray(runs?.check_runs) && runs.total_count === runs.check_runs.length &&
    runs.total_count < 100 && Array.isArray(statuses?.statuses) && statuses.sha === row.head_sha &&
    statuses.total_count === statuses.statuses.length && statuses.total_count < 100,
    'apply_checks_unknown');
  const required = new Set([...checks.contexts, ...checks.checks.map(c => c.context)]);
  for (const context of required) {
    const found = runs.check_runs.filter(c => c.name === context);
    const states = statuses.statuses.filter(c => c.context === context);
    // Duplicate/ambiguous providers fail closed. All observations on the exact
    // candidate must succeed, including optional checks that could block GitHub.
    gate(found.length + states.length === 1, 'apply_checks_unknown');
    const app = checks.checks.find(c => c.context === context)?.app_id;
    if (found.length) {
      const check = found[0];
      gate(check.head_sha === row.head_sha && check.status === 'completed' && check.conclusion === 'success' &&
        (app == null || check.app?.id === app), 'apply_checks_unknown');
      gate(Number.isSafeInteger(check.check_suite?.id), 'apply_checks_unknown');
      const suite = await github('/check-suites/' + check.check_suite.id);
      gate(suite.head_sha === row.head_sha && suite.pull_requests?.some(p =>
        p.number === row.pr_number && p.head?.sha === row.head_sha), 'apply_checks_unknown');
      if (check.app?.slug === 'github-actions') {
        const receipts = await github('/actions/runs?check_suite_id=' + check.check_suite.id + '&per_page=100');
        gate(receipts.total_count === 1 && receipts.workflow_runs?.length === 1, 'apply_checks_unknown');
        const run = receipts.workflow_runs[0];
        gate(run.event === 'pull_request' && run.head_sha === row.head_sha &&
          run.path === '.github/workflows/ci.yml' && run.status === 'completed' &&
          run.conclusion === 'success' && run.check_suite_id === check.check_suite.id,
          'apply_checks_unknown');
      }
    } else {
      gate(app == null && states[0].state === 'success', 'apply_checks_unknown');
    }
  }
  gate(runs.check_runs.every(c => c.head_sha === row.head_sha && c.status === 'completed' && c.conclusion === 'success') &&
    statuses.statuses.every(c => c.state === 'success'), 'apply_checks_unknown');
  return pr;
}

export async function applyDatabaseHyperdrive(env = process.env, request = fetch,
  {wait = ms => new Promise(resolve => setTimeout(resolve, ms))} = {}) {
  verifyApplyIdentity(env);
  const operationId = env.DATABASE_HYPERDRIVE_OPERATION_ID;
  const headers = token => ({authorization:'Bearer ' + token,accept:'application/vnd.github+json',
    'content-type':'application/json','user-agent':'lirtual-database-hyperdrive-476','x-github-api-version':'2022-11-28'});
  async function json(url, token, method='GET', body) {
    let response;
    try { response = await request(url, {method,headers:headers(token),redirect:'manual',
      signal:AbortSignal.timeout(15000),...(body ? {body:JSON.stringify(body)} : {})}); }
    catch { gate(false, method === 'GET' ? 'apply_read_unavailable' : 'apply_outcome_unknown'); }
    if (!response.ok) throw Object.assign(new Error('Hyperdrive apply blocked'), {
      status:response.status, reason:method === 'GET' ? 'apply_read_unavailable' :
        response.status >= 500 ? 'apply_outcome_unknown' : 'apply_write_rejected'
    });
    if (response.status === 204) return undefined;
    try { return await response.json(); } catch { gate(false,'apply_outcome_unknown'); }
  }
  const githubWith = token => (path, method='GET', body) => json(path === '/graphql' ? 'https://api.github.com/graphql' :
    'https://api.github.com/repos/' + REPO + path, token, method,body);
  const github = githubWith(env.GITHUB_TOKEN);
  // GitHub's administration read-only endpoints cannot be accessed with the
  // job-scoped GITHUB_TOKEN. Reuse the already-configured Owner token only for
  // protected policy reads; keep all source/PR writes job-scoped.
  const policyGithub = githubWith(env.DATABASE_GITHUB_ACTIONS_TOKEN);
  const cloud = async (path, method='GET', body) => {
    const result = await json('https://api.cloudflare.com/client/v4/accounts/' + env.CLOUDFLARE_ACCOUNT_ID + path,
      env.CLOUDFLARE_API_TOKEN,method,body);
    gate(result?.success === true && result.result != null,'apply_d1_unavailable');
    return result.result;
  };
  const sql = async (query, params=[]) => {
    const result = await cloud('/d1/database/' + D1 + '/query','POST',{sql:query,params});
    gate(result?.length === 1 && result[0].success === true,'apply_d1_unavailable');
    return result[0];
  };
  let claimed = false;
  try {
    const rows = await sql('SELECT * FROM hyperdrive_operations WHERE operation_id=?',[operationId]);
    const row = rows.results?.[0];
    gate(rows.results?.length === 1 && row.operation_id === operationId && row.action === 'create' &&
      row.expected_revision === 0 && ['running','unknown'].includes(row.phase) &&
      ['github_apply_dispatch_inflight','github_apply_accepted','github_apply_receipt_unknown'].includes(row.error_class) &&
      (row.apply_run_id === null || Number(row.apply_run_id) === Number(env.GITHUB_RUN_ID)) &&
      row.expires_at > Date.now() && SHA.test(row.expected_source_sha ?? '') &&
      SHA.test(row.head_sha ?? '') && Number.isSafeInteger(row.pr_number) && row.pr_number>0 &&
      /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(row.logical_id ?? '') &&
      /^[a-f0-9]{32}$/.test(row.config_id ?? '') &&
      row.binding_name === 'HYPERDRIVE_' + row.logical_id.replace(/-/g,'_').toUpperCase().slice(0,38) +
        '_' + operationId.slice(0,8).toUpperCase() &&
      row.ci_run_id === null && row.ciphertext === null && row.key_id === null && row.merged_sha === null && row.release_run_id === null,
      'apply_operation_not_current');
    const claim = await sql(`UPDATE hyperdrive_operations SET apply_run_id=?,phase='running',
      error_class='apply_verifying',updated_at=? WHERE operation_id=? AND phase=? AND error_class=?
      AND (apply_run_id IS NULL OR apply_run_id=?) AND expires_at>? AND expected_source_sha=? AND head_sha=?`,
      [Number(env.GITHUB_RUN_ID),Date.now(),operationId,row.phase,row.error_class,
        Number(env.GITHUB_RUN_ID),Date.now(),row.expected_source_sha,row.head_sha]);
    gate(claim.meta?.changes === 1,'apply_cas_failed');
    claimed = true;
    gate(row.expected_source_sha === env.GITHUB_SHA,'apply_main_advanced');
    const unused = await sql('SELECT COUNT(*) AS n FROM database_connections WHERE id=? UNION ALL SELECT COUNT(*) AS n FROM retired_connection_ids WHERE id=?',
      [row.logical_id,row.logical_id]);
    gate(unused.results?.length === 2 && unused.results.every(r => r.n === 0),'apply_logical_id_unavailable');
    const mainUnchanged = async () => gate((await github('/git/ref/heads/main'))?.object?.sha === row.expected_source_sha,
      'apply_main_advanced');
    await mainUnchanged();
    const originals = [];
    for (const path of PATHS) {
      const content = await github('/contents/' + path + '?ref=' + row.expected_source_sha);
      gate(content.path === path && content.type === 'file' && content.encoding === 'base64' &&
        typeof content.content === 'string','apply_source_invalid');
      originals.push(Buffer.from(content.content,'base64').toString('utf8'));
    }
    const source = readConfiguration('database-mcp-worker', originals[0]);
    gate(source.d1_databases?.length === 1 && source.d1_databases[0].database_id === D1,'apply_source_invalid');
    const config = await cloud('/hyperdrive/configs/' + row.config_id);
    gate(config.id === row.config_id && config.name === 'db476-' + operationId,'apply_config_drift');
    // Prepare appends id only after Cloudflare creates the Config. Keep the
    // same property order: the reviewed manifest is compared byte-for-byte.
    const entry = {binding:row.binding_name,dialect:config.origin?.scheme,
      origin_host:config.origin?.host,origin_port:config.origin?.port,origin_database:config.origin?.database,
      origin_user:config.origin?.user,ca_certificate_id:config.mtls?.ca_certificate_id,
      id:row.config_id};
    verifyCloudflareHyperdriveConfig(entry,config);
    const files = patchSource(originals[0],JSON.parse(originals[1]),entry);
    await verifyPreparedPullRequest({github,operationId,baseSha:row.expected_source_sha,
      headSha:row.head_sha,prNumber:row.pr_number,files});
    const headCommit = await github('/git/commits/' + row.head_sha);
    gate(headCommit.sha === row.head_sha && SHA.test(headCommit.tree?.sha ?? ''),'apply_source_invalid');
    const tree = await github('/git/trees/' + headCommit.tree.sha + '?recursive=1');
    gate(tree.sha === headCommit.tree.sha && tree.truncated === false && Array.isArray(tree.tree) &&
      PATHS.every(path => tree.tree.filter(f => f.path === path && f.type === 'blob' && f.mode === '100644').length === 1),
      'apply_source_invalid');
    let ciRunId;
    if (await readApplyPolicy(policyGithub) === null) {
      await verifyGithubPrPreflight({request,token:env.DATABASE_GITHUB_ACTIONS_TOKEN,
        sourceSha:row.expected_source_sha,allowSpec476MainMergeWindow:true});
      gate((await github('/git/ref/heads/db476-' + operationId))?.object?.sha === row.head_sha,
        'apply_pr_stale');
      // The source verifier above proves candidate workflow/scripts equal main.
      // A lost dispatch receipt is unknown, never followed by another dispatch.
      const dispatched = await json('https://api.github.com/repos/' + REPO + '/actions/workflows/ci.yml/dispatches',
        env.DATABASE_GITHUB_ACTIONS_TOKEN, 'POST', {ref:'db476-' + operationId,
          return_run_details:true,inputs:{worker:'database-mcp-worker',candidate_sha:row.head_sha}});
      gate(Number.isSafeInteger(dispatched?.workflow_run_id) && dispatched.workflow_run_id > 0,
        'apply_ci_receipt_unknown');
      ciRunId = dispatched.workflow_run_id;
      const recorded = await sql(`UPDATE hyperdrive_operations SET ci_run_id=?,updated_at=?
        WHERE operation_id=? AND phase='running' AND apply_run_id=? AND ci_run_id IS NULL`,
        [ciRunId,Date.now(),operationId,Number(env.GITHUB_RUN_ID)]);
      gate(recorded.meta?.changes === 1, 'apply_cas_failed');
      const deadline = Date.now() + 5 * 60_000;
      let passed = false;
      for (let attempt = 0; attempt < 60 && Date.now() < deadline; attempt++) {
        if (await verifyCandidateCi(github,row,ciRunId,true)) { passed = true; break; }
        if (attempt < 59) await wait(5000);
      }
      gate(passed, 'apply_ci_pending');
    }
    const pr = await verifyApplyEligibility(github,row,ciRunId,policyGithub);
    gate(SHA.test(pr.merge_commit_sha ?? ''),'apply_merge_sha_unknown');
    const preview = await github('/git/commits/' + pr.merge_commit_sha);
    gate(preview.sha === pr.merge_commit_sha && preview.tree?.sha === headCommit.tree.sha &&
      preview.parents?.length === 2 && preview.parents[0].sha === row.expected_source_sha &&
      preview.parents[1].sha === row.head_sha,'apply_merge_sha_unknown');
    await mainUnchanged();
    // Last eligibility read before the sole merge attempt. The job token is
    // constrained by enforce_admins; there is no admin/force/auto-merge path.
    await verifyPreparedPullRequest({github,operationId,baseSha:row.expected_source_sha,
      headSha:row.head_sha,prNumber:row.pr_number,files});
    await verifyApplyEligibility(github,row,ciRunId,policyGithub);
    await mainUnchanged();
    const mergeClaim = await sql(`UPDATE hyperdrive_operations SET error_class='apply_merge_started',updated_at=?
      WHERE operation_id=? AND phase='running' AND apply_run_id=? AND error_class='apply_verifying'
        AND expected_source_sha=? AND head_sha=? AND expires_at>? AND merged_sha IS NULL`,
      [Date.now(),operationId,Number(env.GITHUB_RUN_ID),row.expected_source_sha,row.head_sha,Date.now()]);
    gate(mergeClaim.meta?.changes === 1,'apply_cas_failed');
    const merged = await github('/pulls/' + row.pr_number + '/merge','PUT',{
      sha:row.head_sha,merge_method:'merge'
    });
    gate(merged.merged === true && SHA.test(merged.sha ?? ''),'apply_merge_denied');
    // GitHub's pre-merge SHA is only a test commit. Prove the actual merged SHA
    // BEFORE dispatch: exact parents/tree, merged PR head and current main must
    // all agree. Never dispatch the speculative test SHA or a later main HEAD.
    const receipt = await github('/pulls/' + row.pr_number);
    const commit = await github('/git/commits/' + merged.sha);
    gate(receipt.merged === true && receipt.merge_commit_sha === merged.sha &&
      receipt.head?.sha === row.head_sha && receipt.base?.ref === 'main' &&
      commit.sha === merged.sha && commit.tree?.sha === preview.tree.sha &&
      commit.parents?.length === 2 && commit.parents[0].sha === row.expected_source_sha &&
      commit.parents[1].sha === row.head_sha &&
      (await github('/git/ref/heads/main'))?.object?.sha === merged.sha, 'apply_merge_sha_unknown');
    const stored = await sql(`UPDATE hyperdrive_operations SET merged_sha=?,error_class='apply_release_dispatching',updated_at=?
      WHERE operation_id=? AND phase='running' AND apply_run_id=? AND merged_sha IS NULL`,
      [merged.sha,Date.now(),operationId,Number(env.GITHUB_RUN_ID)]);
    gate(stored.meta?.changes === 1,'apply_cas_failed');
    // Only the existing Owner PAT dispatches the existing sole production workflow.
    // No operation flags or origin secrets cross this boundary.
    gate((await github('/git/ref/heads/main'))?.object?.sha === merged.sha,'apply_main_advanced');
    const dispatched = await json('https://api.github.com/repos/' + REPO + '/actions/workflows/release.yml/dispatches',
      env.DATABASE_GITHUB_ACTIONS_TOKEN,'POST', {ref:'main',return_run_details:true,inputs:{
        worker:'database-mcp-worker',deploy_to_production:'true',database_expected_release_sha:merged.sha,database_hyperdrive_apply_id:operationId
      }});
    gate(Number.isSafeInteger(dispatched?.workflow_run_id) && dispatched.workflow_run_id>0,'apply_release_receipt_unknown');
    const runId = dispatched.workflow_run_id;
    const run = await github('/actions/runs/' + runId);
    gate(run.id === runId && run.event === 'workflow_dispatch' && run.path === '.github/workflows/release.yml' &&
      run.head_sha === merged.sha && run.head_branch === 'main' && run.actor?.login === 'lirtual' &&
      ['queued','in_progress','completed','waiting','requested','pending'].includes(run.status),
      'apply_release_receipt_unknown');
    const recorded = await sql(`UPDATE hyperdrive_operations SET release_run_id=?,error_class='apply_release_pending',updated_at=?
      WHERE operation_id=? AND phase='running' AND apply_run_id=? AND merged_sha=? AND release_run_id IS NULL`,
      [runId,Date.now(),operationId,Number(env.GITHUB_RUN_ID),merged.sha]);
    gate(recorded.meta?.changes === 1,'apply_cas_failed');
    gate(run.status !== 'completed' || run.conclusion === 'success','apply_release_failed');
    const final = await sql('SELECT phase,apply_run_id,merged_sha,release_run_id FROM hyperdrive_operations WHERE operation_id=?',[operationId]);
    gate(final.results?.length === 1 && final.results[0].phase === 'running' &&
      final.results[0].apply_run_id === Number(env.GITHUB_RUN_ID) && final.results[0].merged_sha === merged.sha &&
      final.results[0].release_run_id === runId,'apply_cas_failed');
    // The dependent protected release job verifies publication and hands off disabled D1.
    return {operationId,phase:'running',releaseRunId:runId,mergedSha:merged.sha};
  } catch (error) {
    if (claimed) await sql(`UPDATE hyperdrive_operations SET phase='unknown',error_class=?,updated_at=?
      WHERE operation_id=? AND phase='running' AND apply_run_id=?`,
      [classifyApplyVerificationFailure(error),Date.now(),operationId,
        Number(env.GITHUB_RUN_ID)]).catch(()=>undefined);
    throw error;
  }
}
const ERRORS = new Set(['apply_policy_unavailable','apply_pr_stale','apply_pr_draft','apply_merge_denied',
  'apply_ci_receipt_unknown','apply_ci_failed','apply_ci_pending','apply_review_missing','apply_checks_unknown','apply_main_advanced','apply_merge_sha_unknown',
  'apply_read_unavailable','apply_write_rejected','apply_outcome_unknown','apply_cas_failed',
  'apply_logical_id_unavailable','apply_source_invalid','apply_config_drift','apply_release_receipt_unknown','apply_release_failed']);
// Preserve useful fail-closed diagnostics without storing upstream text or secrets.
// External helper errors are classified only by explicitly reviewed, static codes.
const HELPER_FAILURES = new Map([
  ['github_pr_identity_drift', 'apply_pr_stale'],
  ['github_pr_parent_drift', 'apply_source_invalid'],
  ['github_pr_diff_invalid', 'apply_source_invalid'],
  ['github_pr_diff_not_allowlisted', 'apply_source_invalid'],
  ['github_pr_content_drift', 'apply_source_invalid'],
  ['source_format_unknown', 'apply_source_invalid'],
  ['main_sha_changed', 'apply_main_advanced'],
  ['github_protection_unavailable', 'apply_policy_unavailable'],
  ['github_ruleset_review_required', 'apply_policy_unavailable'],
  ['github_required_checks_unconfirmed', 'apply_policy_unavailable'],
  ['github_ci_unavailable', 'apply_ci_receipt_unknown'],
]);
const VERIFIED_CONFIG_MESSAGES = new Set([
  'invalid approved source metadata',
  'config ID differs from reviewed source',
  'SQL response caching is not disabled',
  'CA/hostname verification is not strict or does not match reviewed CA',
  'origin identity differs from reviewed source',
].map(message => 'Database Hyperdrive verification failed: ' + message));
export function classifyApplyVerificationFailure(error) {
  if (ERRORS.has(error?.reason)) return error.reason;
  if (HELPER_FAILURES.has(error?.reason)) return HELPER_FAILURES.get(error.reason);
  if (VERIFIED_CONFIG_MESSAGES.has(error?.message)) return 'apply_config_drift';
  return 'apply_verification_blocked';
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  applyDatabaseHyperdrive().then(() => {
    process.stdout.write('Hyperdrive apply: release receipt recorded; publication and activation NOT confirmed.\n');
  }).catch(() => {
    process.stderr.write('Hyperdrive apply: BLOCKED; inspect sanitized operation status. No automatic retry.\n');
    process.exitCode = 1;
  });
}
