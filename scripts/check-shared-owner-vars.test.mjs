import test from 'node:test';
import assert from 'node:assert/strict';
import {verifySharedOwnerVars} from './check-shared-owner-vars.mjs';
const env={GITHUB_REPOSITORY:'lirtual/mcp-workers',GITHUB_REF:'refs/heads/main',GITHUB_ACTOR:'lirtual',
  ACCESS_TEAM_DOMAIN:'owner.cloudflareaccess.com',CANONICAL_ACCESS_TEAM_DOMAIN:'owner.cloudflareaccess.com',
  OWNER_EMAIL:'owner@example.com',CANONICAL_OWNER_EMAIL:'owner@example.com'};
test('release owner values equal the independent no-Environment CI source',()=>{
  for(const worker of ['database-mcp-worker','browser-mcp-worker'])
    assert.equal(verifySharedOwnerVars(worker,env),true);
  for(const [key,value] of [['ACCESS_TEAM_DOMAIN','other.cloudflareaccess.com'],
    ['OWNER_EMAIL','someone@example.com'],['CANONICAL_ACCESS_TEAM_DOMAIN',''],
    ['CANONICAL_OWNER_EMAIL','bad'],['GITHUB_REF','refs/heads/other']])
    assert.throws(()=>verifySharedOwnerVars('browser-mcp-worker',{...env,[key]:value}),/identity|context/);
  assert.throws(()=>verifySharedOwnerVars('ssh-mcp-worker',env),/Unsupported/);
});

test('Repository source is captured outside the selected Worker Environment and compared before staging',async()=>{
  const {readFileSync}=await import('node:fs');
  const ci=readFileSync(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');
  const release=readFileSync(new URL('../.github/workflows/release.yml',import.meta.url),'utf8');
  const capture=ci.split('      - name: Capture Repository Owner values before entering a Worker Environment\n')[1]
    ?.split('\n      - name:')[0];
  assert.ok(capture);
  assert.match(capture,/github\.ref == 'refs\/heads\/main'/);
  assert.match(capture,/vars\.ACCESS_TEAM_DOMAIN/);
  assert.match(capture,/vars\.OWNER_EMAIL/);
  assert.doesNotMatch(capture,/environment:/);
  for(const name of ['canonical_access_team_domain','canonical_owner_email']){
    assert.match(ci,new RegExp('jobs\\.checks\\.outputs\\.'+name));
    assert.match(release,new RegExp('needs\\.checks\\.outputs\\.'+name));
  }
  assert.ok(release.indexOf('node scripts/check-shared-owner-vars.mjs') <
    release.indexOf('node scripts/bootstrap-worker-secrets.mjs'));
  const ownerStep=release.split('      - name: Compare selected Worker effective Owner identity to Repository source')[1]
    ?.split('      - name: Stage selected Worker Secrets')[0];
  assert.ok(ownerStep);
  assert.doesNotMatch(ownerStep,/GITHUB_TOKEN/);
});
