import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFile, uploadReserved, removeReserved, downloadPrivate } from '../forum/files.js';

test('the client rejects over 950000 bytes for ordinary uploads and never accepts active file types', () => {
  assert.equal(validateFile(new File([new Uint8Array(950000)], 'photo.png', { type: 'image/png' })), 'image/png');
  assert.throws(() => validateFile(new File([new Uint8Array(950001)], 'photo.png', { type: 'image/png' })), /fc_file_too_large/);
  for (const type of ['image/svg+xml','text/html','application/javascript']) assert.throws(() => validateFile(new File(['x'], 'file', { type })), /fc_file_type/);
  assert.equal(validateFile(new File([new Uint8Array(950001)], 'photo.png', { type: 'image/png' }), 50000000), 'image/png');
});

test('upload sends exact raw bytes without upsert, then finalizes the server-owned reservation', async () => {
  const calls = [], reservation = { id: 'r', bucket_id: 'fc-attachments', object_path: 'owner/r' };
  const ready = await uploadReserved({ file: new File(['abc'], 'file.txt', { type: 'text/plain' }),
    rpc: async (name, args) => { calls.push({ name, args }); return name === 'fc_reserve_file' ? reservation : { ...reservation, status: 'ready' }; },
    client: { storage: { from: bucket => ({ upload: async (path, bytes, options) => { calls.push({ bucket,path,bytes: new TextDecoder().decode(bytes),options }); return { error: null }; } }) } },
  });
  assert.equal(ready.status, 'ready'); assert.equal(calls[0].args.p_size, 3);
  assert.deepEqual(calls[1], { bucket: 'fc-attachments', path: 'owner/r', bytes: 'abc', options: { contentType: 'text/plain', cacheControl: '0', upsert: false } });
  assert.equal(calls[2].name, 'fc_finish_file');
});

test('failed finalization revokes before physical cleanup; a switched account never cleans another actor files', async () => {
  const reservation = { id: 'r', bucket_id: 'fc-attachments', object_path: 'owner/r' }, calls = [];
  const client = { storage: { from: () => ({ upload: async () => ({ error: null }), remove: async paths => { calls.push(['physical',paths]); return { error: null }; } }) } };
  await assert.rejects(uploadReserved({ file: new File(['abc'], 'file.txt', { type: 'text/plain' }),client,
    rpc: async name => { calls.push(name); if (name === 'fc_finish_file') throw new Error('metadata mismatch'); return reservation; },
  }), /metadata mismatch/);
  assert.deepEqual(calls, ['fc_reserve_file','fc_finish_file','fc_remove_file',['physical',['owner/r']]]);
  calls.length = 0; let valid = true;
  await assert.rejects(uploadReserved({ file: new File(['abc'], 'file.txt', { type: 'text/plain' }),client,
    rpc: async name => { calls.push(name); valid = false; return reservation; },
    check: () => { if (!valid) throw Object.assign(new Error('session changed'),{code:'FC_SESSION_CHANGED'}); },
  }), error => error.code === 'FC_SESSION_CHANGED');
  assert.deepEqual(calls, ['fc_reserve_file']);
});

test('private download uses authenticated Storage, and removal revokes logical access before deleting bytes', async () => {
  const calls = [], file = { id:'f',bucket_id:'fc-attachments',object_path:'owner/f' }, blob = new Blob(['private']);
  const client = { storage: { from: bucket => ({ download: async path => { calls.push(['download',bucket,path]); return {data:blob,error:null}; }, remove: async paths => { calls.push(['remove',bucket,paths]); return {error:null}; } }) } };
  assert.equal(await downloadPrivate({ file,client }),blob);
  await removeReserved({ file,client,rpc:async(name,args) => { calls.push([name,args]); } });
  assert.deepEqual(calls,[['download','fc-attachments','owner/f'],['fc_remove_file',{p_id:'f'}],['remove','fc-attachments',['owner/f']]]);
});
