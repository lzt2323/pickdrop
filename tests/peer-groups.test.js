import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,writeFile}from'node:fs/promises';import{randomUUID,randomBytes}from'node:crypto';import os from'node:os';import path from'node:path';import{createGroupManager}from'../server/groups.js';
async function setup(t){const root=await mkdtemp(path.join(os.tmpdir(),'pickdrop-peer-'));const all=[];const make=async name=>{const m=await createGroupManager({dataDir:path.join(root,name),device:{id:randomUUID(),name,kind:'desktop'},host:'127.0.0.1',peerGroups:true,directoryPort:0,discoveryFactory:async()=>({list:()=>[],refresh(){},async close(){}}),monitorIntervalMs:600000});all.push(m);return m};t.after(async()=>{await Promise.all(all.map(m=>m.close({force:true})));await rm(root,{recursive:true,force:true})});return{make};}
async function join(host,peer,g){const i=await host.createInvite(g.id),t=await peer.joinAt(g.baseUrl,i.code);await host.respondJoin(g.id,t.requestId,true);return(await peer.checkJoin(t)).group;}
test('a stalled group does not block another group’s subsequent background sync', { timeout: 10000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pickdrop-independent-groups-'));
  const managers = [];
  let blockedId, release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const blocked = new Promise(resolve => { entered = resolve; });
  const make = async (name, fetchImpl, interval) => {
    const manager = await createGroupManager({
      dataDir: path.join(root, name), device: { id: randomUUID(), name, kind: 'desktop' },
      host: '127.0.0.1', peerGroups: true, directoryPort: 0,
      discoveryFactory: async () => ({ list: () => [], refresh() {}, async close() {} }),
      monitorIntervalMs: interval, networkPollMs: 600000, fetchImpl,
    });
    managers.push(manager); return manager;
  };
  t.after(async () => {
    release();
    await Promise.all(managers.map(manager => manager.close({ force: true })));
    await rm(root, { recursive: true, force: true });
  });
  const owner = await make('owner', undefined, 600000);
  const receiver = await make('receiver', async (url, options) => {
    if (blockedId && new URL(url).searchParams.get('group') === blockedId) {
      entered(); await gate;
    }
    return fetch(url, options);
  }, 25);
  const slow = await owner.createGroup('unreachable group');
  const healthy = await owner.createGroup('healthy group');
  await join(owner, receiver, slow); await join(owner, receiver, healthy);
  blockedId = slow.id;
  await blocked;
  const waitForMessage = async message => {
    const deadline = Date.now() + 1500;
    while (!receiver.getPeerStore(healthy.id).state().messages.some(item => item.id === message.id)) {
      assert.ok(Date.now() < deadline, 'An unrelated group must keep polling while the slow group is stalled');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  await waitForMessage(await owner.authenticated(healthy.id, '/api/messages', { method: 'POST', body: { text: 'first round' } }));
  // This message did not exist when the healthy group completed its first poll.
  await waitForMessage(await owner.authenticated(healthy.id, '/api/messages', { method: 'POST', body: { text: 'next round' } }));
  release();
});
test('creator exits; peers exchange messages, download from holders and survive local replica cleanup',async t=>{
 const{make}=await setup(t),a=await make('a'),b=await make('b'),c=await make('c'),g=await a.createGroup('peer');const gb=await join(a,b,g),gc=await join(a,c,g);
 await b.getPeerStore(g.id).sync(g.baseUrl);await b.getPeerStore(g.id).sync(gc.baseUrl);await a.close();
 await b.authenticated(g.id,'/api/messages',{method:'POST',body:{text:'creator offline'}});await c.getPeerStore(g.id).sync(gb.baseUrl);assert.equal((await c.authenticated(g.id,'/api/state')).messages[0].text,'creator offline');
 const content=randomBytes(5000),res=await fetch(gb.baseUrl+'/api/files?name=peer.bin',{method:'POST',headers:{'X-Room-Key':gb.key,'X-Device-Id':b.device.id},body:content});assert.equal(res.status,201);const message=await res.json();await c.getPeerStore(g.id).sync(gb.baseUrl);
 const cached=await c.preparePeerFile(g.id,message.id);const{readFile}=await import('node:fs/promises');assert.deepEqual(await readFile(cached),content);
 await b.getHostedInbox(g.id).deleteFiles([message.id]);assert.ok(b.getPeerStore(g.id).state().messages.some(m=>m.id===message.id));
 assert.deepEqual(await readFile(await b.preparePeerFile(g.id,message.id)),content);
 await writeFile(cached,Buffer.alloc(content.length,1));assert.deepEqual(await readFile(await c.preparePeerFile(g.id,message.id)),content);
});
test('unreachable peer sync does not lose pending invitations or deadlock reciprocal sync',async t=>{
 const{make}=await setup(t),a=await make('a'),b=await make('b'),g=await a.createGroup('peer'),gb=await join(a,b,g),store=a.getPeerStore(g.id);
 const i=await a.createInvite(g.id);assert.equal(await store.sync('http://127.0.0.1:1'),false);const c=await make('c'),ticket=await c.joinAt(g.baseUrl,i.code);assert.ok(ticket.requestId);
 await Promise.all([store.sync(gb.baseUrl),b.getPeerStore(g.id).sync(g.baseUrl)]);
 await a.respondJoin(g.id,ticket.requestId,true);assert.equal((await c.checkJoin(ticket)).status,'approved');
});
test('peer forget and rejoin uses signed identity, rename and dissolution propagate',async t=>{
 const{make}=await setup(t),a=await make('a'),b=await make('b'),g=await a.createGroup('peer');await join(a,b,g);await b.forgetGroup(g.id);const gb=await join(a,b,g);
 await a.renameGroup(g.id,'renamed');await b.getPeerStore(g.id).sync(g.baseUrl);assert.equal(b.getPeerStore(g.id).state().name,'renamed');
 await assert.rejects(b.deleteGroup(g.id),/creator/);await a.deleteGroup(g.id);await b.getPeerStore(g.id).sync(g.baseUrl);assert.equal(b.getPeerStore(g.id).state().dissolved,true);assert.equal(a.listGroups().length,0);assert.equal(gb.mode,'peer');
});
test('legacy upgrade retains more than one history page and refuses old guest credentials',async t=>{
 const{make}=await setup(t),a=await make('a'),g=await a.createGroup('peer');
 // Create an actual legacy manager, independent of the peer default fixture.
 const legacyRoot=await mkdtemp(path.join(os.tmpdir(),'pickdrop-upgrade-'));const legacy=await createGroupManager({dataDir:legacyRoot,device:{id:randomUUID(),name:'old',kind:'desktop'},host:'127.0.0.1',directoryPort:0,discoveryFactory:async()=>({list:()=>[],refresh(){},async close(){}}),monitorIntervalMs:600000});t.after(async()=>{await legacy.close({force:true});await rm(legacyRoot,{recursive:true,force:true});});
 const old=await legacy.createGroup('legacy'),oldGuest=await join(legacy,a,old);
 const body=Buffer.from('legacy-file'),fileResponse=await fetch(old.baseUrl+'/api/files?name=old.bin',{method:'POST',headers:{'X-Room-Key':old.key,'X-Device-Id':legacy.device.id},body});const oldFile=await fileResponse.json();
 const{mkdir}=await import('node:fs/promises');await mkdir(path.join(legacyRoot,'groups',old.id,'peer.json'));await assert.rejects(legacy.upgradeGroup(old.id));assert.equal(legacy.listGroups()[0].authVersion,2);assert.ok(await legacy.authenticated(old.id,'/api/state'));await rm(path.join(legacyRoot,'groups',old.id,'peer.json'),{recursive:true});
 for(let n=0;n<105;n++)await legacy.authenticated(old.id,'/api/messages',{method:'POST',body:{text:`old-${n}`}});
 const upgraded=await legacy.upgradeGroup(old.id);assert.equal(upgraded.id,old.id);assert.equal(upgraded.mode,'peer');const messages=(await legacy.authenticated(old.id,'/api/state')).messages;assert.equal(messages.length,106);assert.equal(messages[1].text,'old-0');assert.equal(messages.at(-1).text,'old-104');
 const revoked=await fetch(upgraded.baseUrl+'/api/state',{headers:{'X-Room-Key':oldGuest.key,'X-Device-Id':a.device.id}});assert.equal(revoked.status,401);const{readFile}=await import('node:fs/promises');assert.deepEqual(await readFile(await legacy.preparePeerFile(old.id,oldFile.id)),body);
});
test('legacy forgetting permits explicitly approved credential reset and preserves other membership',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'pickdrop-reset-'));const all=[];const make=async name=>{const m=await createGroupManager({dataDir:path.join(root,name),device:{id:randomUUID(),name,kind:'desktop'},host:'127.0.0.1',directoryPort:0,discoveryFactory:async()=>({list:()=>[],refresh(){},async close(){}}),monitorIntervalMs:600000});all.push(m);return m;};t.after(async()=>{await Promise.all(all.map(m=>m.close({force:true})));await rm(root,{recursive:true,force:true});});
 const host=await make('h'),guest=await make('g'),group=await host.createGroup('legacy'),first=await join(host,guest,group);await guest.forgetGroup(group.id);const invite=await host.createInvite(group.id),ticket=await guest.joinAt(group.baseUrl,invite.code);assert.equal((await host.listJoinRequests(group.id))[0].reset,true);await host.respondJoin(group.id,ticket.requestId,true);const next=(await guest.checkJoin(ticket)).group;assert.notEqual(next.key,first.key);
 const denied=await fetch(group.baseUrl+'/api/state',{headers:{'X-Room-Key':first.key,'X-Device-Id':guest.device.id}});assert.equal(denied.status,401);assert.ok(await guest.authenticated(group.id,'/api/state'));
});
test('each sync reauthenticates before sending history even when an old peer IP is reused',async t=>{
 const{make}=await setup(t),a=await make('a'),b=await make('b'),g=await a.createGroup('private'),gb=await join(a,b,g);await a.getPeerStore(g.id).sync(gb.baseUrl);await b.close({force:true});
 await a.authenticated(g.id,'/api/messages',{method:'POST',body:{text:'not-for-impostor'}});
 // Drain the immediate push to the now-offline owner before the IP is reused.
 await a.getPeerStore(g.id).sync(gb.baseUrl);
 const{createServer}=await import('node:http'),captured=[];const server=createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;captured.push(JSON.parse(body));res.writeHead(200,{'Content-Type':'application/json'});res.end('{}');});
 await new Promise(resolve=>server.listen(Number(new URL(gb.baseUrl).port),'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 assert.equal(await a.getPeerStore(g.id).sync(gb.baseUrl),false);assert.equal(captured.length,1);assert.deepEqual(captured[0].payload.events,[]);assert.deepEqual(captured[0].payload.known,[]);assert.equal(captured[0].payload.peers,undefined);assert.equal(JSON.stringify(captured).includes('not-for-impostor'),false);
});
test('offline dissolution stays durable and propagates after creator and member restart',async t=>{
 const{make}=await setup(t);let a=await make('a'),b=await make('b');const g=await a.createGroup('pending');await join(a,b,g);await b.close({force:true});
 await a.deleteGroup(g.id);assert.equal(a.listGroups().length,0);await a.close({force:true});
 a=await make('a');b=await make('b');assert.equal(a.getPeerStore(g.id).state().dissolved,true);await a.reconnectGroup(g.id,b.listGroups()[0].baseUrl);assert.equal(b.getPeerStore(g.id).state().dissolved,true);await a.deleteGroup(g.id);assert.equal(a.listGroups().length,0);
});

test('members learn each other only through the creator and automatically keep exchanging after it exits', { timeout: 15000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pickdrop-peer-autonomous-'));
  const managers = [];
  const make = async name => {
    const manager = await createGroupManager({
      dataDir: path.join(root, name),
      device: { id: randomUUID(), name, kind: 'desktop' },
      host: '127.0.0.1', peerGroups: true, directoryPort: 0,
      // No multicast records, directory hints, or manually connected survivors.
      discoveryFactory: async () => ({ list: () => [], refresh() {}, async close() {} }),
      monitorIntervalMs: 150, networkPollMs: 600000,
    });
    managers.push(manager);
    return manager;
  };
  t.after(async () => {
    await Promise.all(managers.map(manager => manager.close({ force: true })));
    await rm(root, { recursive: true, force: true });
  });
  const eventually = async (description, predicate) => {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail(`${description}; peers=${JSON.stringify(managers.map(manager => ({ device: manager.device.name, peers: manager.getPeerStore(group.id)?.peers() })))}`);
  };
  const creator = await make('creator'), first = await make('first'), second = await make('second');
  const group = await creator.createGroup('automatic endpoint propagation');
  const firstGroup = await join(creator, first, group);
  const secondGroup = await join(creator, second, group);
  const hasPeer = (manager, expected, address) => manager.getPeerStore(group.id).peers()
    .some(peer => peer.deviceId === expected.device.id && peer.baseUrl === address);
  await eventually('Both survivors must learn the other endpoint through ordinary background synchronization',
    () => hasPeer(first, second, secondGroup.baseUrl) && hasPeer(second, first, firstGroup.baseUrl));

  await creator.close({ force: true });
  await assert.rejects(fetch(group.baseUrl + '/api/state', { signal: AbortSignal.timeout(500) }));
  for (const [sender, receiver] of [[first, second], [second, first]]) {
    const text = `${sender.device.name}: sent after creator shutdown`;
    const message = await sender.authenticated(group.id, '/api/messages', { method: 'POST', body: { text } });
    await eventually('A survivor must receive the other survivor’s new message automatically',
      () => receiver.getPeerStore(group.id).state().messages.some(item => item.id === message.id && item.text === text));
  }

  const { readFile } = await import('node:fs/promises');
  for (const [sender, senderGroup, receiver] of [[first, firstGroup, second], [second, secondGroup, first]]) {
    const bytes = randomBytes(256 * 1024 + 17);
    const response = await fetch(`${senderGroup.baseUrl}/api/files?name=${sender.device.name}.bin`, {
      method: 'POST', body: bytes,
      headers: { 'X-Room-Key': senderGroup.key, 'X-Device-Id': sender.device.id },
    });
    assert.equal(response.status, 201);
    const file = await response.json();
    await eventually('File metadata must reach the receiver without any explicit sync or reconnect',
      () => receiver.getPeerStore(group.id).state().messages.some(item => item.id === file.id));
    assert.deepEqual(await readFile(await receiver.preparePeerFile(group.id, file.id)), bytes);
    assert.equal(creator.getPeerStore(group.id).state().messages.some(item => item.id === file.id), false,
      'The offline creator must never have received these file records');
  }
});

test('gossip preserves verified online state and cannot manufacture another peer’s reachability', async t => {
  const { make } = await setup(t);
  const creator = await make('creator'), receiver = await make('receiver'), third = await make('third');
  const group = await creator.createGroup('local reachability evidence');
  await join(creator, receiver, group);
  const thirdGroup = await join(creator, third, group);
  const store = receiver.getPeerStore(group.id);
  await store.sync(group.baseUrl);
  await store.sync(thirdGroup.baseUrl);
  const online = address => store.peers().find(peer => peer.baseUrl === address)?.online;
  assert.equal(online(thirdGroup.baseUrl), true);

  // The creator forwards its peer list without online fields over a real signed sync.
  await store.sync(group.baseUrl);
  assert.equal(online(thirdGroup.baseUrl), true,
    'A gossip refresh must not erase reachability verified directly with the third member');
  store.remember({ deviceId: third.device.id, baseUrl: thirdGroup.baseUrl, online: false });
  assert.equal(online(thirdGroup.baseUrl), true);
  store.remember({ deviceId: randomUUID(), baseUrl: thirdGroup.baseUrl, online: true });
  assert.equal(store.peers().find(peer => peer.baseUrl === thirdGroup.baseUrl)?.deviceId, third.device.id,
    'Conflicting gossip must not replace an authenticated address owner');
  await third.close({ force: true });
  assert.equal(await store.sync(thirdGroup.baseUrl), false);
  store.remember({ deviceId: third.device.id, baseUrl: thirdGroup.baseUrl, online: true });
  assert.equal(online(thirdGroup.baseUrl), false,
    'A stale hint cannot resurrect a peer after direct connection failure');

  // An authenticated member may still lie about a different endpoint in its gossip.
  const { createPeerReplica } = await import('../shared/peer-protocol.js');
  const { openPeerStore } = await import('../server/peer-store.js');
  const { readFile } = await import('node:fs/promises');
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'pickdrop-gossip-'));
  const { createPeerIdentity, createPeerGenesis } = await import('../shared/peer-protocol.js');
  const owner = { device: { id: randomUUID(), name: 'owner', kind: 'desktop' }, identity: createPeerIdentity(randomBytes(32).toString('hex')) };
  const local = { device: { id: randomUUID(), name: 'local', kind: 'desktop' }, identity: createPeerIdentity(randomBytes(32).toString('hex')) };
  const genesis = createPeerGenesis({ ...owner, groupId: randomUUID(), name: 'forged gossip' });
  const remote = createPeerReplica({ ...owner, genesis, randomBytes });
  remote.append('member.add', { ...local.device, publicKey: local.identity.publicKey });
  const allegedPeer = { deviceId: randomUUID(), baseUrl: 'http://127.0.0.1:65431', online: true };
  const localStore = await openPeerStore({
    dataDir: fixtureRoot, ...local, ...remote.snapshot(),
    request: async () => remote.proof('sync-result', {
      ...remote.snapshot(), known: remote.snapshot().events.map(event => event.eventId), peers: [allegedPeer],
    }),
  });
  t.after(async () => { await localStore.close(); await rm(fixtureRoot, { recursive: true, force: true }); });
  assert.equal(await localStore.sync('http://127.0.0.1:65430'), true);
  assert.equal(localStore.peers().find(peer => peer.baseUrl === allegedPeer.baseUrl)?.online, false,
    'Even signed gossip cannot assert that another device is online');
  localStore.remember({ ...allegedPeer, online: true });
  assert.equal(localStore.peers().find(peer => peer.baseUrl === allegedPeer.baseUrl)?.online, false);
  assert.equal((await readFile(path.join(fixtureRoot, 'peer.json'), 'utf8')).includes('"online"'), false,
    'Online evidence must not survive as a persisted hint across restarts');
});


test('one online acknowledgement retains dissolution relay for third offline member across restarts', async t => {
 const {make}=await setup(t);
 let owner=await make('owner'),relay=await make('relay'),offline=await make('offline');
 const group=await owner.createGroup('three devices');
 const relayGroup=await join(owner,relay,group);await join(owner,offline,group);
 await relay.getPeerStore(group.id).sync(group.baseUrl);
 await offline.close({force:true});
 await owner.deleteGroup(group.id);
 await relay.getPeerStore(group.id).sync(group.baseUrl);
 assert.equal(owner.listGroups().length,0);assert.equal(relay.listGroups().length,0);
 assert.equal(relay.getPeerStore(group.id).state().dissolved,true);
 await assert.rejects(owner.authenticated(group.id,'/api/messages',{method:'POST',body:{text:'forbidden'}}));
 await owner.close({force:true});await relay.close({force:true});
 // The creator may never return: a recipient must also retain the tombstone.
 relay=await make('relay');offline=await make('offline');
 assert.equal(relay.listGroups().length,0);
 assert.equal(relay.getPeerStore(group.id).state().dissolved,true);
 const relayUrl=relay.getHostedInbox(group.id).baseUrl;
 await offline.getPeerStore(group.id).sync(relayUrl);
 assert.equal(offline.getPeerStore(group.id).state().dissolved,true);
 assert.equal(offline.listGroups().length,0);
 await assert.rejects(offline.authenticated(group.id,'/api/messages',{method:'POST',body:{text:'forbidden'}}));
 await offline.forgetGroup(group.id);
 assert.ok(offline.getPeerStore(group.id),'forget must not erase the last dissemination relay');
 await offline.close({force:true});offline=await make('offline');
 assert.equal(offline.listGroups().length,0);
 assert.equal(offline.getPeerStore(group.id).state().dissolved,true);
 await assert.rejects(offline.authenticated(group.id,'/api/messages',{method:'POST',body:{text:'still forbidden after restart'}}));
 await assert.rejects(offline.getPeerStore(group.id).append('message',{text:'direct append after restart'}),error=>error.status===403);
});

test('offline leave is hidden and durable until remaining member reconnects', async t => {
 const {make}=await setup(t);let owner=await make('leave-owner'),leaver=await make('leaver');
 const group=await owner.createGroup('leave');await join(owner,leaver,group);
 const leftId=leaver.device.id;await owner.close({force:true});
 await leaver.leaveGroup(group.id);assert.equal(leaver.listGroups().length,0);
 await assert.rejects(leaver.authenticated(group.id,'/api/messages',{method:'POST',body:{text:'forbidden'}}));
 await leaver.close({force:true});leaver=await make('leaver');owner=await make('leave-owner');
 assert.equal(leaver.listGroups().length,0);
 await owner.getPeerStore(group.id).sync(leaver.getHostedInbox(group.id).baseUrl);
 assert.equal(owner.getPeerStore(group.id).state().members.some(member=>member.id===leftId),false);
 assert.equal(owner.listGroups().length,1,'remaining member keeps its active group');
});
