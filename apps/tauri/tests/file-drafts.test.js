import test from 'node:test';
import assert from 'node:assert/strict';
import {draftFile,snapshotFiles,removeDraft,acceptDrop} from '../src/file-drafts.js';
test('a frozen batch survives draft removal and later additions',()=>{
  const a=draftFile('/temp/a'), b=draftFile('/temp/b');
  const batch=snapshotFiles([a,b]);
  const c=draftFile('/temp/c'); let current=[a,b,c];
  current=removeDraft(current,b.draftId);
  assert.deepEqual(batch.map(f=>f.path),['/temp/a','/temp/b']);
  current=removeDraft(current,a.draftId);
  assert.deepEqual(current,[c]);
  assert.equal(draftFile(c).draftId,c.draftId);
  assert.notEqual(a.draftId,b.draftId);
});
test('drop ownership and stable replay identity are independent of group equality',()=>{
  const seen=new Set(),payload={owner:'A',groupId:'same',dropId:'once',paths:['/temp/a']};
  assert.equal(acceptDrop(payload,'B',seen),false);
  assert.equal(acceptDrop(payload,'A',seen),true);
  assert.equal(acceptDrop({...payload},'A',seen),false);
  assert.equal(acceptDrop({...payload,dropId:null},'A',seen),false);
});
