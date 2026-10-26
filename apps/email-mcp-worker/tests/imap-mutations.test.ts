import test from 'node:test';
import assert from 'node:assert/strict';
import type { ImapFlow } from 'imapflow';
import { markSelectedImapMessage, moveSelectedImapMessage } from '../src/imap.ts';

type Options = {
  missing?: boolean;
  disappeared?: boolean;
  afterSeen?: boolean;
  addResult?: boolean;
  removeResult?: boolean;
  moveResult?: false | { destination: string };
};
function fakeClient(options: Options = {}) {
  let reads = 0;
  let writes = 0;
  const client = {
    async fetchOne(uid: number, query: { uid: boolean; flags?: boolean }, fetchOptions: { uid: boolean }) {
      assert.equal(uid, 42);
      assert.deepEqual(fetchOptions, { uid: true }, 'always use UID, never message sequence numbers');
      assert.equal(query.uid, true);
      reads++;
      if (options.missing || (options.disappeared && reads === 2)) return false;
      if (query.flags) return { uid, flags: new Set(options.afterSeen ? ['\\Seen'] : []) };
      return { uid };
    },
    async messageFlagsAdd(uid: number, flags: string[], params: { uid: boolean }) {
      assert.equal(uid, 42);
      assert.deepEqual(flags, ['\\Seen']);
      assert.deepEqual(params, { uid: true });
      writes++;
      return options.addResult ?? true;
    },
    async messageFlagsRemove(uid: number, flags: string[], params: { uid: boolean }) {
      assert.equal(uid, 42);
      assert.deepEqual(flags, ['\\Seen']);
      assert.deepEqual(params, { uid: true });
      writes++;
      return options.removeResult ?? true;
    },
    async messageMove(uid: number, folder: string, params: { uid: boolean }) {
      assert.equal(uid, 42);
      assert.deepEqual(params, { uid: true });
      assert.equal(folder, 'Deleted Messages');
      writes++;
      return options.moveResult === undefined ? { destination: folder } : options.moveResult;
    },
  } as unknown as ImapFlow;
  return { client, reads: () => reads, writes: () => writes };
}

test('mark read and unread report success only after server flag readback', async () => {
  for (const read of [true, false]) {
    const fake = fakeClient({ afterSeen: read });
    await markSelectedImapMessage(fake.client, 42, read);
    assert.equal(fake.reads(), 2);
    assert.equal(fake.writes(), 1);
  }
});

test('flag commands returning false never claim successful mark', async () => {
  for (const [read, options] of [
    [true, { addResult: false }],
    [false, { removeResult: false }],
  ] as const) {
    const fake = fakeClient(options);
    await assert.rejects(markSelectedImapMessage(fake.client, 42, read), /imap_mutation_failed/);
    assert.equal(fake.reads(), 1);
    assert.equal(fake.writes(), 1);
  }
});

test('mark readback mismatches and disappearing UIDs fail closed', async () => {
  await assert.rejects(
    markSelectedImapMessage(fakeClient({ afterSeen: false }).client, 42, true),
    /imap_mutation_failed/,
  );
  await assert.rejects(
    markSelectedImapMessage(fakeClient({ disappeared: true }).client, 42, true),
    /stale_reference/,
  );
});

test('a UID missing in the selected mailbox must not be marked or moved', async () => {
  const mark = fakeClient({ missing: true });
  await assert.rejects(markSelectedImapMessage(mark.client, 42, true), /stale_reference/);
  assert.equal(mark.writes(), 0);
  const move = fakeClient({ missing: true });
  await assert.rejects(moveSelectedImapMessage(move.client, 42, 'Deleted Messages'), /stale_reference/);
  assert.equal(move.writes(), 0);
});

test('MOVE false and an unexpected destination are not reported as success', async () => {
  for (const moveResult of [false, { destination: 'Archive' }] as const) {
    const fake = fakeClient({ moveResult });
    await assert.rejects(
      moveSelectedImapMessage(fake.client, 42, 'Deleted Messages'), /imap_mutation_failed/,
    );
    assert.equal(fake.writes(), 1);
  }
});

test('a confirmed MOVE produces no extra write or unsafe fallback', async () => {
  const fake = fakeClient();
  await moveSelectedImapMessage(fake.client, 42, 'Deleted Messages');
  assert.equal(fake.writes(), 1);
  assert.equal(fake.reads(), 1);
});
