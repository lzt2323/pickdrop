import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { ANIMALS, groupAnimal, nextAnimal } from '../shared/animals.js';
import { createPeerIdentity, createPeerGenesis, createPeerReplica } from '../shared/peer-protocol.js';
import { invitationText, parseInvitation, invitationUrl } from '../shared/invitation.js';

test('copied invitations preserve group/protocol, leading-zero code, endpoint and non-default port', () => {
  const id = randomUUID();
  const invite = { code: '001234', baseUrl: 'http://192.168.1.23:51854', link: `http://192.168.1.23:51854/#invite=001234&group=${id}&protocol=peer` };
  const pasted = parseInvitation(invitationText(invite));
  assert.equal(pasted.code, '001234'); assert.equal(pasted.address, '192.168.1.23'); assert.equal(pasted.port, '51854');
  assert.equal(pasted.groupId, id); assert.equal(new URL(pasted.link).hash, new URL(invite.link).hash);
  assert.equal(parseInvitation('邀请码：001234\n地址：192.168.1.23\n端口：51854').link, 'http://192.168.1.23:51854/#invite=001234');
  for (const port of ['0', '65536', 'abc', '12.3']) assert.throws(() => invitationUrl('192.168.1.23', port, '001234'));
  assert.throws(() => parseInvitation('http://user:secret@192.168.1.23:1234/#invite=001234'));
});

test('animal choices are signed group metadata, survive replica reload, and require creator authority to change', () => {
  const owner = { device: { id: randomUUID(), name: 'Mac' }, identity: createPeerIdentity(randomBytes(32).toString('hex')) };
  const guest = { device: { id: randomUUID(), name: 'Android' }, identity: createPeerIdentity(randomBytes(32).toString('hex')) };
  const genesis = createPeerGenesis({ ...owner, groupId: randomUUID(), name: '资料', animalId: 'alpaca' });
  const a = createPeerReplica({ ...owner, genesis, randomBytes });
  a.append('member.add', { ...guest.device, publicKey: guest.identity.publicKey });
  const b = createPeerReplica({ ...guest, ...a.snapshot(), randomBytes });
  assert.equal(b.state().animalId, 'alpaca');
  assert.throws(() => createPeerReplica({ ...guest, genesis: { ...genesis, animalId: 'dog' }, randomBytes }), /genesis/);
  assert.throws(() => b.append('rename', { name: '资料', animalId: 'dog' }), /creator/);
  a.append('rename', { name: '资料', animalId: 'lizard' }); b.merge(a.snapshot().events);
  assert.equal(b.state().animalId, 'lizard');
  assert.equal(createPeerReplica({ ...guest, ...b.snapshot(), randomBytes }).state().animalId, 'lizard');
  assert.throws(() => a.append('rename', { name: '资料', animalId: '<script>' }), /animal/);
  const oldGenesis = createPeerGenesis({ ...owner, groupId: randomUUID(), name: '旧群' });
  assert.equal(createPeerReplica({ ...guest, genesis: oldGenesis, randomBytes }).state().animalId, groupAnimal({ id: oldGenesis.groupId }));
  assert.equal(new Set(ANIMALS.map((_, index) => nextAnimal(ANIMALS.slice(0, index).map(animal => ({ animalId: animal.id }))))).size, ANIMALS.length);
});
