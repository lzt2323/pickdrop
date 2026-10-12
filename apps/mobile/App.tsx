import { ArrowLeftRight } from 'lucide-react-native';
import { ConfirmationProvider, useConfirm } from './src/components/Confirmation';
import { useKeyboardOverlap } from './src/keyboard-overlap';
import { groupIconSource } from './src/group-icons';
import * as Clipboard from 'expo-clipboard';
import { ANIMALS, groupAnimal, nextAnimal } from '../../shared/animals';
import { invitationAddress, invitationUrl, invitationText, parseInvitation } from '../../shared/invitation';
import { createNativePeerOptions, peerFileStats, clearPeerFiles } from './src/peer-native';
import { ReceivedFile } from './src/components/ReceivedFile';
import { StorageSettings } from './src/components/StorageSettings';
import { cleanupIncoming, incomingFileName } from './src/storage-native';
import { mergeState, prependHistory } from '../../shared/history';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, BackHandler, FlatList, Image, KeyboardAvoidingView, Linking, Platform, Pressable, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Sharing from 'expo-sharing';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { createNearbyDiscovery } from './src/discovery';
import { fileSize } from '../../shared/protocol';
import { createMobileClient, createVerifiedTransferGroup, parseInviteLink } from './src/client';
import type { Device, Group, Message, GroupState, JoinTicket, Invite, JoinRequest, ConnectionStatus } from './src/client';
import { transfers } from './src/transfers';
import { pasteClipboardImage } from './src/clipboard-images';
import { MessageComposer } from './src/components/MessageComposer';
import type { TransferGroup, TransferItem } from './src/transfers';
import { Avatar, Button, IconButton, Notice, Busy, Sheet, MotionProvider, MotionView, BottomNav, palette } from './src/components/ui';

type Panel = 'join' | 'members' | 'invite' | 'settings' | 'transfers' | 'share' | 'create' | 'rename-group' | null;
type RawShare = { value: string; shareType: string; mimeType?: string };
const webMemory = new Map<string, string>();
const connectionStorage = Platform.OS === 'web' ? { getItemAsync: async (key: string) => webMemory.get(key) || null, setItemAsync: async (key: string, value: string) => { webMemory.set(key, value); }, deleteItemAsync: async (key: string) => { webMemory.delete(key); } } : SecureStore;
const emptyState: GroupState = { messages: [], devices: [] };
const phase: Record<TransferItem['status'], string> = { preparing: '准备中', draft: '待发送', queued: '排队中', uploading: '正在发送', downloading: '正在保存', verifying: '正在保存', saving: '正在保存', 'save-cancelled': '已取消保存', waiting: '等待持有者上线', orphaned: '未关联群草稿', completed: '已完成', failed: '失败', cancelled: '已取消' };
const inFlight = (item: TransferItem) => ['preparing', 'queued', 'uploading', 'downloading', 'verifying', 'saving'].includes(item.status);
const messageTime = (value: string) => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const dateLabel = (value: string) => new Date(value).toLocaleDateString('zh-CN') === new Date().toLocaleDateString('zh-CN') ? '今天' : new Date(value).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });

export default function App() { return <MotionProvider><SafeAreaProvider><ConfirmationProvider><MobileApp /></ConfirmationProvider></SafeAreaProvider></MotionProvider>; }
function GroupAnimal({ group, size = 38 }: { group: { id?: string; animalId?: string }; size?: number }) { return <Image source={groupIconSource(groupAnimal(group))} style={{ width: size, height: size }} resizeMethod="resize" resizeMode="contain" accessible={false} />; }
function AnimalPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) { return <View style={s.animalPicker}>{ANIMALS.map(animal => <Pressable key={animal.id} accessibilityRole="button" accessibilityLabel={animal.name} accessibilityState={{ selected: value === animal.id }} onPress={() => onChange(animal.id)} style={[s.animalChoice, value === animal.id && s.animalSelected]}><GroupAnimal group={{ animalId: animal.id }} size={40} /><Text style={s.animalLabel}>{animal.name}</Text></Pressable>)}</View>; }
function MobileApp() {
  const confirm = useConfirm();
  const keyboardOverlap = useKeyboardOverlap();
  const [client] = useState(() => createMobileClient({ storage: connectionStorage, peerOptions: createNativePeerOptions(), randomUUID: Crypto.randomUUID, deviceName: Platform.OS === 'ios' ? '我的 iPhone' : '我的安卓手机', kind: Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web' }));
  const [peerStorage, setPeerStorage] = useState({ count: 0, bytes: 0 });
  const [groupName, setGroupName] = useState(''), [animalId, setAnimalId] = useState('cat');
  const [initAttempt, setInitAttempt] = useState(0);
  const [arrivals, setArrivals] = useState<Record<string, Set<string>>>({});
  const [ready, setReady] = useState(false), [device, setDevice] = useState<Device | null>(null), [groups, setGroups] = useState<Group[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null), [home, setHome] = useState(true), [states, setStates] = useState<Record<string, GroupState>>({});
  const [connectionError, setConnectionError] = useState(''), [status, setStatus] = useState<ConnectionStatus>('offline'), [reconnect, setReconnect] = useState(0), [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const [chatTab, setChatTab] = useState<'messages' | 'files'>('messages');
  const [queueScope, setQueueScope] = useState<'all' | 'group'>('group');
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [panel, setPanel] = useState<Panel>(null), [error, setError] = useState(''), [busy, setBusy] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({}), [joinMode, setJoinMode] = useState<'scan' | 'code' | 'link'>('code'), [address, setAddress] = useState(''), [port, setPort] = useState(''), [code, setCode] = useState(''), [link, setLink] = useState(''), [name, setName] = useState('');
  const [pending, setPending] = useState<JoinTicket | null>(null), [joinStatus, setJoinStatus] = useState(''), [requests, setRequests] = useState<JoinRequest[]>([]), [invite, setInvite] = useState<Invite | null>(null), [now, setNow] = useState(Date.now());
  const [discovery] = useState(createNearbyDiscovery);
  const [scanning, setScanning] = useState(false), [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [queue, setQueue] = useState<TransferItem[]>(transfers.getSnapshot()), [incoming, setIncoming] = useState<RawShare[]>([]), [shareTarget, setShareTarget] = useState<string | null>(null);
  const list = useRef<FlatList<Message>>(null), nearBottom = useRef(true), scanLock = useRef(false), sending = useRef(false), joinAbort = useRef<AbortController | null>(null), incomingSignature = useRef('');
  const [visibleMessages, setVisibleMessages] = useState<Set<string>>(new Set());
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: Array<{ item: Message }> }) => setVisibleMessages(new Set(viewableItems.map(entry => entry.item.id)))).current;
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 10 }).current;
  const currentGroup = useRef(activeId), inviteEpoch = useRef(0), busyEpoch = useRef(0), knownMessages = useRef<Record<string, Set<string>>>({}), selectionEpoch = useRef(0);
  currentGroup.current = activeId;
  const pasteContext = useRef({ activeId, home, panel, appActive });
  pasteContext.current = { activeId, home, panel, appActive };
  const hasDiscoverableGroups = groups.some(group => !group.membershipRevoked);
  const activeGroup = groups.find(group => group.id === activeId) || null;
  const groupState = activeId ? states[activeId] || emptyState : emptyState;
  const groupQueue = queue.filter(item => item.groupId === activeId), draftFiles = groupQueue.filter(item => item.status === 'draft');
  const nonImageDrafts = draftFiles.filter(item => !item.mimeType?.startsWith('image/'));
  const activeTransfers = groupQueue.filter(inFlight), failedTransfers = groupQueue.filter(item => item.status === 'failed');
  const shownMessages = chatTab === 'files' ? groupState.messages.filter(message => message.type === 'file') : groupState.messages;
  const shownQueue = queueScope === 'all' ? queue : groupQueue;
  const text = activeId ? drafts[activeId] || '' : '', online = status === 'online';
  const report = useCallback((cause: unknown) => setError(cause instanceof Error ? cause.message : '操作失败，请重试'), []);
  const refreshGroups = useCallback(() => { setGroups(client.listGroups()); setDevice(client.device); }, [client]);
  const setText = (value: string) => { if (activeId) setDrafts(current => ({ ...current, [activeId]: value })); };
  const makeTransferGroup = useCallback((group: Group, deviceId: string, maxFileBytes?: number): TransferGroup => {
    return createVerifiedTransferGroup(client, group, deviceId, maxFileBytes);
  }, [client]);
  const transferGroup = (group: Group) => makeTransferGroup(group, device!.id, states[group.id]?.maxFileBytes);
  const perform = async (label: string, callback: () => Promise<unknown>) => { const operation = ++busyEpoch.current; setBusy(label); setError(''); try { await callback(); } catch (cause) { if (operation === busyEpoch.current) report(cause); } finally { if (operation === busyEpoch.current) setBusy(''); } };

  useEffect(() => {
    let alive = true; setReady(false); setError('');
    client.init().then(saved => { if (alive) { setDevice(saved.device); setName(saved.device.name); setGroups(saved.groups); setActiveId(saved.activeGroupId); setReady(true); if (Platform.OS !== 'web') transfers.restoreDrafts(saved.groups.map(group => makeTransferGroup(group, saved.device.id))).catch(report); } }).catch(cause => { if (alive) { report(cause); setReady(true); } });
    return () => { alive = false; joinAbort.current?.abort(); };
  }, [client, report, makeTransferGroup, initAttempt]);
  useEffect(() => { const subscription = AppState.addEventListener('change', value => setAppActive(value === 'active')); return () => subscription.remove(); }, []);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const rootTab = home && (panel === 'settings' || panel === 'transfers');
    if (!rootTab && (home || panel)) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => { setPanel(null); setHome(true); setError(''); return true; });
    return () => subscription.remove();
  }, [home, panel]);
  useEffect(() => {
    if (!ready || !device || !client.peerSupported) return;
    void client.setPeerActive(appActive).catch(report);
    if (!appActive) return;
    const timer = setInterval(() => transfers.retryWaiting(), 5000);
    return () => clearInterval(timer);
  }, [ready, device?.id, appActive, client, report]);
  useEffect(() => transfers.subscribe(() => setQueue(transfers.getSnapshot())), []);
  useEffect(() => client.subscribeGroupMetadata(next => {
    if (next.dissolved) {
      setGroups(current => current.filter(group => group.id !== next.id));
      if (activeId === next.id) { setActiveId(null); setHome(true); setPanel(null); setConnectionError(''); }
      return;
    }
    setGroups(current => current.some(group => group.id === next.id && (group.name !== next.name || group.animalId !== next.animalId))
      ? current.map(group => group.id === next.id ? next : group) : current);
  }), [client, activeId]);
  useEffect(() => {
    if (!activeId || !device) return;
    const groupId = activeId; setStatus('connecting'); setRequests([]);
    const watcher = client.watchGroup(groupId, { onState: next => { const nextGroup = client.listGroups().find(group => group.id === groupId); if (nextGroup) setGroups(current => current.some(group => group.id === groupId && (group.name !== nextGroup.name || group.animalId !== nextGroup.animalId)) ? current.map(group => group.id === groupId ? nextGroup : group) : current); const previous = knownMessages.current[groupId]; setArrivals(current => ({ ...current, [groupId]: new Set(previous ? next.messages.filter(message => !previous.has(message.id)).map(message => message.id) : []) })); knownMessages.current[groupId] = new Set(next.messages.map(message => message.id)); setStates(current => ({ ...current, [groupId]: mergeState(current[groupId], next) as GroupState })); }, onStatus: value => { setStatus(value); if (value === 'online') { setConnectionError(''); refreshGroups(); } }, onError: cause => setConnectionError(cause.message) });
    watcher.setActive(AppState.currentState === 'active');
    const subscription = AppState.addEventListener('change', value => watcher.setActive(value === 'active'));
    return () => { subscription.remove(); watcher.close(); };
  }, [client, activeId, device?.name, reconnect]);
  useEffect(() => {
    if (!activeId || !online || !appActive) return;
    let alive = true, loading = false;
    const refresh = async () => { if (loading) return; loading = true; try { const next = await client.listJoinRequests(activeId); if (alive) setRequests(next); } catch {} finally { loading = false; } };
    refresh(); const timer = setInterval(refresh, 3500); return () => { alive = false; clearInterval(timer); };
  }, [client, activeId, online, appActive]);
  useEffect(() => { if (panel === 'settings') void peerFileStats().then(setPeerStorage).catch(report); }, [panel, report]);
  useEffect(() => { if (panel !== 'invite') return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [panel]);
  // Expo's useIncomingShare also resolves remote URLs. Read the raw payloads so
  // receiving a link never fetches it or sends anything before confirmation.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const read = () => { try { const payloads = Sharing.getSharedPayloads(); const signature = JSON.stringify(payloads); if (payloads.length && signature !== incomingSignature.current) { incomingSignature.current = signature; setIncoming(payloads); setShareTarget(activeId || groups[0]?.id || null); setPanel('share'); } } catch {} };
    read(); const subscription = AppState.addEventListener('change', value => { if (value === 'active') read(); }); return () => subscription.remove();
  }, [activeId, groups]);
  useEffect(() => {
    const receiveLink = (url: string) => { if (/^https?:\/\//i.test(url) && /[#&](invite|key)=/.test(url)) { setLink(url); setJoinMode('link'); setPanel('join'); } };
    Linking.getInitialURL().then(url => { if (url) receiveLink(url); }).catch(() => {});
    const subscription = Linking.addEventListener('url', event => receiveLink(event.url)); return () => subscription.remove();
  }, []);

  useEffect(() => { const unsubscribe = discovery.subscribe(value => client.updateDiscovery(value.devices)); return () => { unsubscribe(); discovery.dispose(); }; }, [discovery]);
  useEffect(() => { discovery.setPairedGroups(groups); }, [discovery, groups]);
  useEffect(() => {
    if (appActive && hasDiscoverableGroups) { void discovery.start(); return () => discovery.stop(); }
    discovery.stop();
  }, [discovery, appActive, hasDiscoverableGroups]);

  async function selectGroup(group: Group) {
    inviteEpoch.current++; const selection = ++selectionEpoch.current; await client.setActiveGroup(group.id); if (selection !== selectionEpoch.current) return; const changed = currentGroup.current !== group.id; currentGroup.current = group.id; if (changed) { setStatus('connecting'); setRequests([]); } setActiveId(group.id); setChatTab('messages'); setQueueScope('group'); setHome(false); setPanel(null); setError(''); nearBottom.current = true;
  }
  function openJoin() { setJoinMode('code'); setAddress(''); setPort(''); setLink(''); setScanning(false); setCode(''); setError(''); setPanel('join'); }
  async function connect(value: string) {
    if (!device || busy || pending || joinAbort.current) return;
    const abort = new AbortController(); joinAbort.current = abort; setBusy('正在连接电脑…'); setError(''); setJoinStatus('');
    try {
      const parsed = parseInviteLink(value);
      let joined: Group;
      const paired = await client.reconnectInvite(value, { signal: abort.signal });
      if (paired) joined = paired;
      else if (parsed.legacy) joined = await client.joinLink(value, { signal: abort.signal });
      else {
        const ticket = await client.requestJoin(value, { signal: abort.signal });
        if (abort.signal.aborted) return;
        setPending(ticket); setJoinStatus(`等待「${ticket.groupName}」允许加入`); setBusy('');
        joined = await client.waitForJoin(ticket, { signal: abort.signal });
      }
      if (abort.signal.aborted) return;
      refreshGroups(); setReconnect(value => value + 1); await selectGroup(joined); setPending(null); setLink(''); setCode('');
    } catch (cause) { if (!abort.signal.aborted) { setPending(null); report(cause); } }
    finally { if (joinAbort.current === abort) { joinAbort.current = null; setBusy(''); } }
  }
  function cancelJoin() { joinAbort.current?.abort(); joinAbort.current = null; setPending(null); setJoinStatus(''); setBusy(''); }
  function fillInvitation(value: string) {
    const input = value.trim();
    if (/[#&]key=/i.test(input)) {
      const legacy = parseInviteLink(input);
      if (legacy.legacy) { setLink(input); setJoinMode('link'); return true; }
    }
    const parsed = parseInvitation(input); if (!parsed) return false;
    setAddress(parsed.baseUrl.startsWith('https:') ? `https://${parsed.address}` : parsed.address); setPort(parsed.port); setCode(parsed.code); setLink(parsed.link); setJoinMode('code'); return true;
  }
  function fillEndpoint(value: string) {
    if (!value.includes(':')) return false;
    try {
      const next = invitationAddress(value);
      setAddress(next.baseUrl.startsWith('https:') ? `https://${next.address}` : next.address);
      setPort(next.port);
      setLink('');
      return true;
    } catch { return false; }
  }
  async function pasteInvitation() { try { if (!fillInvitation(await Clipboard.getStringAsync())) throw new Error('剪贴板中没有完整邀请信息'); setError(''); } catch (cause) { report(cause); } }
  function connectCode() {
    try {
      const parsed = link && !/[#&]key=/i.test(link) ? parseInvitation(link) : null;
      const typedAddress = address.trim();
      const targetAddress = parsed && new URL(parsed.link).protocol === 'https:' && !typedAddress.includes('://') ? `https://${typedAddress}` : typedAddress;
      let target = invitationUrl(targetAddress, port, code);
      if (parsed && parsed.address === invitationAddress(typedAddress).address && parsed.port === port && parsed.code === code) target = parsed.link;
      void connect(target);
    } catch (cause) { report(cause); }
  }
  async function scan() {
    setError(''); const granted = cameraPermission?.granted || (await requestCameraPermission()).granted;
    if (!granted) { setError('相机权限未开启，可以粘贴邀请链接或填写邀请码加入。'); return; }
    scanLock.current = false; setScanning(true);
  }
  async function sendCurrent() {
    if (!activeGroup || !online || sending.current || (!text.trim() && !draftFiles.length)) return;
    const groupId = activeGroup.id, outgoing = text.trim(); sending.current = true; setBusy('发送中…'); setError('');
    try {
      if (outgoing) { await client.api(groupId, '/api/messages', { method: 'POST', body: { text: outgoing } }); setDrafts(current => ({ ...current, [groupId]: current[groupId]?.trim() === outgoing ? '' : current[groupId] })); }
      void transfers.startGroupDrafts(groupId).catch(report); if (currentGroup.current === groupId) { nearBottom.current = true; list.current?.scrollToEnd({ animated: false }); }
    } catch (cause) { report(cause); } finally { sending.current = false; setBusy(''); }
  }
  async function pickFiles() { if (Platform.OS === 'web') { setError('文件选择与传输请使用 iOS 或 Android 客户端；当前是浏览器界面预览。'); return; } if (!activeGroup || !device) return; const target = transferGroup(activeGroup); await perform('准备文件…', () => transfers.pickFiles(target)); }
  async function pasteImage() {
    if (Platform.OS !== 'android' || !activeGroup || !device || busy) return;
    const target = transferGroup(activeGroup), selection = selectionEpoch.current;
    const isCurrent = () => pasteContext.current.activeId === target.id && !pasteContext.current.home && !pasteContext.current.panel && pasteContext.current.appActive && selectionEpoch.current === selection;
    await perform('读取剪贴板图片…', async () => {
      try { await pasteClipboardImage(target, isCurrent); }
      catch (cause) { if (isCurrent()) throw cause; }
    });
  }
  async function shareFile(message: Message, action: 'save' | 'file' | 'share' = 'save') { if (Platform.OS === 'web') { setError('文件接收与系统分享请使用 iOS 或 Android 客户端。'); return; } if (!activeGroup || !device) return; try { await transfers.receive(transferGroup(activeGroup), message, action); } catch (cause) { report(cause); } }
  async function createInvite(targetId?: string) { const groupId = targetId || activeGroup?.id; if (!groupId) return; const operation = ++inviteEpoch.current; setPanel('invite'); setInvite(null); await perform('正在生成邀请码…', async () => { const result = await client.createInvite(groupId); if (currentGroup.current === groupId && inviteEpoch.current === operation) { setInvite(result); setNow(Date.now()); } }); }
  async function respond(request: JoinRequest, allow: boolean) { if (!activeId) return; const id = activeId; await perform('正在处理…', async () => { await client.respondJoin(id, request.id, allow); const next = await client.listJoinRequests(id); if (currentGroup.current === id) setRequests(next); }); }
  async function prepareIncoming() {
    const group = groups.find(item => item.id === shareTarget); if (!group || !device) return;
    await perform('准备分享内容…', async () => {
      const assets = incoming.filter(item => !['text', 'url'].includes(item.shareType));
      if (assets.some(item => !/^(file|content):\/\//i.test(item.value))) throw new Error('分享的文件地址无法直接读取，请先保存到手机，再用“添加文件”选择。');
      if (assets.length) {
        const ids = await transfers.importIncoming(transferGroup(group), assets.map(item => ({ uri: item.value, name: incomingFileName(item.value), mimeType: item.mimeType })));
        const failed = ids.map((id, index) => ({ id, asset: assets[index], item: transfers.getSnapshot().find(item => item.id === id) })).filter(result => result.item?.status !== 'draft');
        if (failed.length) {
          // Keep successful copies in the chosen group's drafts and only retry
          // failed inputs. Do not revoke provider access by clearing the share.
          setIncoming([...failed.map(result => result.asset), ...incoming.filter(item => ['text', 'url'].includes(item.shareType))]);
          await Promise.all(failed.map(result => transfers.remove(result.id)));
          throw new Error(`${failed.length} 个文件未能读取；其余文件已放入「${group.name}」待发送。请重试或从文件选择器添加。`);
        }
      }
      const sharedText = incoming.filter(item => ['text', 'url'].includes(item.shareType)).map(item => item.value).join('\n');
      if (sharedText) setDrafts(current => ({ ...current, [group.id]: [current[group.id], sharedText].filter(Boolean).join('\n') }));
      await cleanupIncoming(assets.map(item => item.value)); Sharing.clearSharedPayloads(); incomingSignature.current = ''; setIncoming([]); await selectGroup(group);
    });
  }
  const inviteSeconds = invite ? Math.max(0, Math.ceil((Number(invite.expiresAt) - now) / 1000)) : 0;
  const inviteLink = invite?.link || '';
  const inviteEndpoint = invite?.link ? invitationAddress(invite.baseUrl || new URL(invite.link).origin) : null;
  const currentOnline = groupState.devices.filter(item => item.online).length;
  const navigateHome = (target: 'home' | 'transfers' | 'settings') => { setError(''); setQueueScope('all'); setHome(true); setPanel(target === 'home' ? null : target); };
  const closePanel = () => { inviteEpoch.current++; setScanning(false); setPanel(null); setError(''); };

  function transferRow(item: TransferItem) {
    const percent = item.progress === undefined ? '' : ` · ${Math.round(item.progress * 100)}%`;
    return <View key={item.id} style={s.transferCard}><View style={s.transferHead}><Text numberOfLines={1} style={s.transferName}>{item.name}</Text><Text style={[s.transferStatus, item.status === 'failed' && s.red]}>{item.status === 'completed' && item.direction === 'download' ? item.destination === '分享面板' ? '分享面板已关闭' : `已保存到${item.destination || '文件'}` : phase[item.status]}{percent}</Text></View><Text style={s.small}>{item.direction === 'upload' ? '发往' : '来自'} {item.groupName || '当前群'} · {fileSize(item.size || 0)}</Text>{item.progress !== undefined && inFlight(item) && <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(item.progress * 100) }} style={s.progressTrack}><View style={[s.progressFill, { width: `${Math.round(item.progress * 100)}%` }]} /></View>}{!!item.error && <Text style={s.fieldError}>{item.error}</Text>}<View style={s.actions}>{item.status === 'orphaned' && !!item.localUri && groups.map(group => <Button key={group.id} compact label={`放入 ${group.name}`} onPress={() => { void transfers.reassignDraft(item.id, transferGroup(group)).catch(report); }} />)}{inFlight(item) && item.status !== 'saving' && <Button compact label="取消" onPress={() => { transfers.cancel(item.id).catch(report); }} />}{['failed', 'cancelled', 'save-cancelled', 'waiting'].includes(item.status) && <Button compact label="重试" onPress={() => { Promise.resolve(transfers.retry(item.id)).catch(report); }} />}{item.status === 'draft' && <Button compact label="发送" disabled={!online} onPress={() => { Promise.resolve(transfers.start(item.id)).catch(report); }} />}{!inFlight(item) && <Button compact label={item.status === 'draft' ? '移除' : '清除记录'} onPress={() => { Promise.resolve(transfers.remove(item.id)).catch(report); }} />}</View></View>;
  }
  if (!ready) return <SafeAreaView style={s.screen}><ActivityIndicator style={s.flex} color={palette.blue} /></SafeAreaView>;
  if (!device) return <SafeAreaView style={s.screen}><View style={s.welcome}><Text style={s.sheetHero}>暂时无法读取设备信息</Text><Text style={s.description}>{error || '请重试加载本机连接。'}</Text><Button primary label="重试加载" onPress={() => setInitAttempt(value => value + 1)} /></View></SafeAreaView>;
  return <SafeAreaView style={s.screen} edges={['top', 'bottom']}><StatusBar style="dark" /><KeyboardAvoidingView accessibilityElementsHidden={!!panel} importantForAccessibility={panel ? "no-hide-descendants" : "auto"} style={[s.flex, Platform.OS === 'android' && { paddingBottom: keyboardOverlap }, home && (panel === 'settings' || panel === 'transfers') && { display: 'none' }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    {home || !activeGroup ? <>
      <View style={s.homeHeader}><View style={s.brand}><Image source={require('./assets/brand-mark.png')} style={s.brandMark} accessible={false} /><Text accessibilityRole="header" style={s.brandName}>拾传</Text></View><Button compact primary label="＋ 新建" accessibilityLabel="创建群聊" onPress={() => { setGroupName(`传输群 ${groups.length + 1}`); setAnimalId(nextAnimal(groups)); setPanel('create'); }} /></View>
      <View style={s.homeToolbar}><View style={s.toolbarItem}><Button label="扫码加入" onPress={() => { openJoin(); void scan(); }} /></View><View style={s.toolbarItem}><Button label="邀请码加入" accessibilityLabel="加入群聊" onPress={openJoin} /></View></View>
      {Platform.OS === 'web' && <Notice text="网页预览：连接不持久保存；接收文件请用手机客户端。" />}
      {!!pending && <Pressable accessibilityRole="button" onPress={openJoin} style={s.pendingBanner}><ActivityIndicator size="small" color={palette.blue} /><Text style={s.pendingText}>加入申请等待允许 · 点此查看</Text></Pressable>}
      <FlatList data={groups} keyExtractor={group => group.id} contentContainerStyle={s.groupList} ListHeaderComponent={groups.length ? <Text style={s.sectionLabel}>我的群组 · {groups.length}</Text> : null} ListEmptyComponent={<View style={s.welcome}><View style={s.welcomeMark}><Image source={require('./assets/brand-mark.png')} style={{width:64,height:64}} accessible={false} /></View><Text accessibilityRole="header" style={s.welcomeTitle}>还没有群组</Text><Button primary label="＋ 加入一个群" onPress={openJoin} /></View>} renderItem={({ item }) => {
        const latest = states[item.id]?.messages.at(-1), count = queue.filter(task => task.groupId === item.id && (inFlight(task) || task.status === 'draft')).length;
        return <Pressable accessibilityRole="button" testID={`group-${item.id}`} accessibilityLabel={`打开${item.name}`} onPress={() => selectGroup(item).catch(report)} style={({ pressed }) => [s.groupCard, pressed && s.pressed]}><View style={s.groupIcon}><GroupAnimal group={item} size={42} /></View><View style={s.groupInfo}><View style={s.groupTitleRow}><Text numberOfLines={1} style={s.groupName}>{item.name}</Text>{latest && <Text style={s.small}>{messageTime(latest.createdAt)}</Text>}</View><Text numberOfLines={1} style={s.groupPreview}>{drafts[item.id]?.trim() ? `[草稿] ${drafts[item.id]}` : count ? `${count} 项文件待发或传输中` : latest ? latest.type === 'file' ? `${latest.senderName}：${latest.fileName}` : `${latest.senderName}：${latest.text}` : '尚无消息'}</Text></View><View style={s.groupEnd}>{count > 0 ? <Text style={s.groupCount}>{count > 99 ? '99+' : count}</Text> : <Text style={s.chevron}>›</Text>}</View></Pressable>;
      }} />
      <BottomNav active="home" onChange={navigateHome} />
    </> : <MotionView key={activeGroup.id} style={s.flex}>
      <View style={s.chatHeader}><IconButton icon="back" label="返回群列表" onPress={() => { setHome(true); setError(''); }} /><Pressable accessibilityRole="button" accessibilityLabel="查看群成员" onPress={() => setPanel('members')} style={s.chatTitleButton}><GroupAnimal group={activeGroup} size={32}/><View style={s.chatHeading}><Text numberOfLines={1} style={s.chatTitle}>{activeGroup.name}</Text><Text numberOfLines={1} style={s.chatSubtitle}>{online ? `● ${currentOnline} 台设备在线` : '○ 连接中'}</Text></View></Pressable><IconButton icon="more" label="群成员与邀请" onPress={() => setPanel('members')} /></View>
      {!!groupState.networkWarning && <Notice text={groupState.networkWarning} />}
      {groupState.pendingDeparture?.type === 'dissolve' && !groupState.pendingDeparture.acknowledged && <Notice text="解散记录已保存在本机，等待其他成员上线同步。确认后可再次点击解散。" />}
      {!online && <View style={s.offlineBanner}><Text style={s.offlineText}>{status === 'paused' ? '回到前台后继续同步' : connectionError || (activeGroup.mode === 'peer' ? '正在同步在线群成员；本机历史和文件会保留。' : '正在查找群主机并重连；待发内容会保留。')}</Text><Button compact label="重连" onPress={() => setReconnect(value => value + 1)} /></View>}
      {!!requests.length && <Pressable accessibilityRole="button" onPress={() => setPanel('members')} style={s.requestBanner}><Text style={s.requestBannerText}>{requests.length} 台设备申请加入</Text><Text style={s.linkText}>查看 ›</Text></Pressable>}
      <View style={s.chatTabs}>{(['messages','files'] as const).map(tab=><Pressable key={tab} accessibilityRole="tab" accessibilityLabel={tab==='messages'?'消息':'文件'} aria-selected={chatTab===tab} accessibilityState={{selected:chatTab===tab}} testID={`chat-tab-${tab}`} onPress={()=>{nearBottom.current=false;setChatTab(tab);}} style={[s.chatTab,chatTab===tab&&s.chatTabActive]}><Text style={[s.chatTabLabel,chatTab===tab&&s.chatTabLabelActive]}>{tab==='messages'?'消息':`文件 ${groupState.messages.filter(item=>item.type==='file').length}`}</Text></Pressable>)}<View style={s.flex}/><Button compact label="邀请 +" onPress={()=>{void createInvite();}} disabled={!online||!!busy}/></View>
      <FlatList ref={list} data={shownMessages} onViewableItemsChanged={onViewableItemsChanged} viewabilityConfig={viewabilityConfig} extraData={visibleMessages} ListHeaderComponent={groupState.history?.hasMore ? <Button compact label={loadingHistory ? '正在加载…' : '加载更早消息'} disabled={loadingHistory} onPress={() => { if (!activeId || loadingHistory) return; const id = activeId; setLoadingHistory(true); client.api(id, `/api/history?before=${encodeURIComponent(groupState.history?.before || '')}&limit=100`).then(page => setStates(current => ({ ...current, [id]: prependHistory(current[id], page) as GroupState }))).catch(report).finally(() => setLoadingHistory(false)); }} /> : null} keyExtractor={message => message.id} style={s.flex} contentContainerStyle={s.messages} keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled" onScroll={event => { const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent; nearBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 100; }} scrollEventThrottle={100} onContentSizeChange={() => { if (nearBottom.current) list.current?.scrollToEnd({ animated: false }); }} ListEmptyComponent={<View style={s.empty}><GroupAnimal group={activeGroup} size={72} /><Text style={s.emptyTitle}>{chatTab === 'files' ? '还没有文件' : '还没有消息'}</Text><Button label="添加文件" onPress={pickFiles} disabled={!!busy} /></View>} renderItem={({ item, index }) => {
        const own = item.senderId === device?.id, previous = shownMessages[index - 1], showDate = !previous || new Date(previous.createdAt).toLocaleDateString('zh-CN') !== new Date(item.createdAt).toLocaleDateString('zh-CN');
        return <><Text style={[s.dateDivider, !showDate && { display: 'none' }]}>{dateLabel(item.createdAt)}</Text><MotionView animate={arrivals[activeGroup.id]?.has(item.id)} style={[s.message, own && s.ownMessage]}><View style={[s.messageBody, own && s.ownBody]}><View style={[s.messageMeta, own && s.ownMeta]}><Text numberOfLines={1} style={s.senderName}>{item.senderName}</Text><Text style={s.messageTime}>{messageTime(item.createdAt)}</Text></View>{item.type === 'text' ? <View testID={own ? 'message-own' : 'message-peer'} style={[s.textBubble, own && s.ownBubble]}><Text selectable style={s.messageText}>{item.text}</Text></View> : <ReceivedFile key={`${activeGroup.id}:${item.id}`} message={item} own={own} group={transferGroup(activeGroup)} visible={appActive && !home && visibleMessages.has(item.id)} onAction={action => { void shareFile(item, action); }} />}</View></MotionView></>;

      }} />
      {(!!activeTransfers.length || !!failedTransfers.length) && <Pressable accessibilityRole="button" onPress={() => { setQueueScope('group'); setPanel('transfers'); }} style={s.transferBanner}>{!!activeTransfers.length && <ActivityIndicator size="small" color={palette.blue} />}<Text numberOfLines={1} style={s.transferBannerText}>{activeTransfers.length ? `${phase[activeTransfers[0].status]} · ${activeTransfers[0].name}` : `${failedTransfers.length} 项文件传输失败，点此重试`}</Text><Text style={s.linkText}>查看</Text></Pressable>}
      {!!nonImageDrafts.length && <View style={s.draftBar}><Pressable accessibilityRole="button" onPress={() => { setQueueScope('group'); setPanel('transfers'); }} style={s.draftSummary}><Text style={s.draftTitle}>{nonImageDrafts.length} 份文件待发送</Text><Text numberOfLines={1} style={s.small}>{nonImageDrafts.map(item => item.name).join('、')}</Text></Pressable><IconButton icon="more" label="查看待发送文件" onPress={() => { setQueueScope('group'); setPanel('transfers'); }} /></View>}
      <MessageComposer groupId={activeGroup.id} groupName={activeGroup.name} text={text} files={draftFiles} busy={!!busy} canSend={online && !busy && (!!text.trim() || !!draftFiles.length)} onChangeText={setText} onPasteImage={pasteImage} onChooseFiles={pickFiles} onSend={sendCurrent} onRemoveImage={id => { void transfers.remove(id).catch(report); }} />
    </MotionView>}
    {!panel && !!incoming.length && <Pressable accessibilityRole="button" accessibilityLabel="继续处理外部分享" onPress={() => { setShareTarget(activeId || groups[0]?.id || null); setPanel('share'); }} style={s.pendingBanner}><Text style={s.pendingText}>{incoming.length} 项外部分享待选择接收群</Text><Text style={s.linkText}>继续 ›</Text></Pressable>}
    {!panel && <><Busy label={busy} /><Notice text={error} error onDismiss={() => setError('')} /></>}
  </KeyboardAvoidingView>
  <Sheet visible={panel === 'create' || panel === 'rename-group'} title={panel === 'create' ? '创建群聊' : '群设置'} onClose={closePanel} footer={<Notice text={error} error onDismiss={() => setError('')} />}>
    {!client.peerSupported && <Notice text="创建群聊需要原生 Android 客户端。" />}
    <Text style={s.label}>群名称</Text><TextInput style={s.field} value={groupName} onChangeText={setGroupName} maxLength={40} accessibilityLabel="群名称" />
    <Text style={s.label}>群头像</Text><AnimalPicker value={animalId} onChange={setAnimalId} />
    <Button primary label={panel === 'create' ? '创建群聊' : '保存群设置'} disabled={!client.peerSupported || !groupName.trim() || !!busy} onPress={() => { void perform('正在保存…', async () => { if (panel === 'create') { const group = await client.createGroup(groupName.trim(), animalId); refreshGroups(); await selectGroup(group); await createInvite(group.id); } else if (activeId) { await client.renameGroup(activeId, groupName.trim(), animalId); refreshGroups(); closePanel(); } }); }} />
  </Sheet>
  <Sheet visible={panel === 'join'} title={pending ? '等待加入' : '加入群聊'} onClose={closePanel} footer={<><Busy label={busy} /><Notice text={error} error onDismiss={() => setError('')} /></>}>
    {pending ? <View style={s.pendingContent}><View style={s.pendingMark}><ActivityIndicator color={palette.blue} size="large" /></View><Text style={s.sheetHero}>申请已发出</Text><Text style={s.description}>{joinStatus}</Text><View style={s.spacer} /><Button label="取消等待" onPress={cancelJoin} /></View> : scanning ? <><View style={s.cameraFrame}>{cameraPermission?.granted && <CameraView style={s.flex} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={({ data }) => { if (scanLock.current) return; scanLock.current = true; setScanning(false); setLink(data); void connect(data); }} />}</View><Button label="返回邀请信息" onPress={() => setScanning(false)} /></> : <>
      {joinMode === 'link' ? <><Text style={s.label}>邀请链接</Text><TextInput style={[s.field, s.linkField]} value={link} onChangeText={setLink} autoCapitalize="none" autoCorrect={false} multiline placeholder="粘贴完整邀请链接" testID="join-link" accessibilityLabel="完整邀请链接" /><Button primary label="申请加入" onPress={() => { try { const input = link.trim(); const legacy = /[#&]key=/i.test(input) && parseInviteLink(input).legacy; const parsed = legacy ? null : parseInvitation(input); void connect(parsed?.link || input); } catch (cause) { report(cause); } }} disabled={!!busy || !link.trim()} /><View style={s.spacer} /><Button label="填写邀请码、地址和端口" onPress={() => setJoinMode('code')} /></> : <>
        <Text style={s.label}>邀请码</Text><TextInput style={[s.field, s.codeField]} value={code} onChangeText={value => setCode(value.replace(/\D/g, '').slice(0, 6))} keyboardType="number-pad" maxLength={6} placeholder="000000" testID="join-code" accessibilityLabel="6 位邀请码" />
        <View style={s.endpointFields}><View style={s.addressField}><Text style={s.label}>地址</Text><TextInput style={s.field} value={address} onChangeText={value => { try { if (!fillInvitation(value) && !fillEndpoint(value)) { setAddress(value); setLink(''); } } catch { if (!fillEndpoint(value)) { setAddress(value); setLink(''); } } }} onEndEditing={() => { try { fillEndpoint(address); } catch (cause) { report(cause); } }} autoCapitalize="none" autoCorrect={false} placeholder="192.168.1.23" testID="join-address" accessibilityLabel="设备地址" /></View><View style={s.portField}><Text style={s.label}>端口</Text><TextInput style={s.field} value={port} onChangeText={value => setPort(value.replace(/\D/g, '').slice(0, 5))} keyboardType="number-pad" maxLength={5} placeholder="51854" testID="join-port" accessibilityLabel="端口" /></View></View>
        <Button primary label="申请加入" onPress={connectCode} disabled={!!busy || !address.trim() || !port || code.length !== 6} /><View style={s.spacer} /><Button label="粘贴邀请信息" onPress={() => { void pasteInvitation(); }} disabled={!!busy} />
        <View style={s.joinAlternatives}><Button compact label="扫码加入" onPress={scan} disabled={!!busy} /><Button compact label="邀请链接" onPress={() => setJoinMode('link')} disabled={!!busy} /></View>
      </>}
    </>}
  </Sheet>
  <Sheet visible={panel === 'members'} title="群成员与设备" onClose={closePanel} footer={<><Busy label={busy} /><Notice text={error} error onDismiss={() => setError('')} /></>}>
    <Text style={s.sheetHero}>{activeGroup?.name}</Text><Text style={s.description}>{groupState.devices.length} 台已加入的设备{online ? `，${currentOnline} 台在线` : '，在线状态等待重连'}</Text>
    {requests.map(request => <View key={request.id} style={s.requestCard}><Text style={s.requestName}>{request.device.name} 申请加入</Text><View style={s.actions}><Button compact label="拒绝" onPress={() => respond(request, false)} disabled={!!busy} /><Button compact primary label="允许加入" onPress={() => respond(request, true)} disabled={!!busy} /></View></View>)}
    {activeGroup?.mode === 'peer' && activeGroup.creatorDeviceId === device.id && <><Button label="修改群名称与动物" onPress={() => { setGroupName(activeGroup.name); setAnimalId(groupAnimal(activeGroup)); setPanel('rename-group'); }} /><View style={s.spacer} /><Button danger label="解散群聊" disabled={!!busy} onPress={() => confirm('解散这个群？', '解散事件会同步给成员。已下载到各设备的文件不会被远程删除。', [{ text: '取消', style: 'cancel' }, { text: '解散', style: 'destructive', onPress: () => perform('正在解散…', async () => { await client.dissolveGroup(activeGroup.id); refreshGroups(); closePanel(); }) }])} /></>}
    {groupState.devices.map(member => <View key={member.id} style={s.deviceRow}><Avatar name={member.id === device?.id ? '我' : member.name} id={member.id} size={37} muted={!member.online} /><View style={s.deviceInfo}><Text numberOfLines={1} style={s.deviceName}>{member.name}{member.id === device?.id ? ' · 本机' : ''}</Text><Text style={s.small}>{online ? member.online ? '在线' : '离线' : '状态待更新'}</Text></View>{activeGroup?.hostDeviceId === device?.id && member.id !== device?.id && <Button compact danger label="移除" disabled={!online || !!busy} onPress={() => confirm('移除此设备？', '对方需要重新申请才能加入。', [{ text: '取消', style: 'cancel' }, { text: '移除', style: 'destructive', onPress: () => perform('正在移除设备…', async () => { await client.removeMember(activeGroup!.id, member.id); }) }])} />}</View>)}<View style={s.spacer} /><Button primary label="＋ 邀请设备加入" onPress={() => { void createInvite(); }} disabled={!online || !!busy} /><View style={s.spacer} /><Button label="传输记录与待发文件" onPress={() => { setQueueScope('group'); setPanel('transfers'); }} />{activeGroup && <><View style={s.spacer} /><Button danger label="退出群聊" disabled={(activeGroup.mode !== 'peer' && !online) || !!busy} onPress={() => confirm('退出此群？', '将撤销本机访问资格。待发草稿会保留，再次加入需要允许。', [{ text: '取消', style: 'cancel' }, { text: '退出', style: 'destructive', onPress: () => perform('正在退出…', async () => { await client.leaveGroup(activeGroup.id); await client.removeGroup(activeGroup.id); await transfers.detachGroup(activeGroup.id); refreshGroups(); setActiveId(null); setHome(true); setPanel(null); }) }])} /></>}
  </Sheet>
  <Sheet visible={panel === 'invite'} title="邀请设备" onClose={closePanel} footer={<><Busy label={busy} /><Notice text={error} error onDismiss={() => setError('')} /></>}>
    <View style={s.inviteHeading}>{activeGroup && <GroupAnimal group={activeGroup} size={30} />}<Text numberOfLines={1} style={s.inviteGroupName}>{activeGroup?.name}</Text></View>
    <View style={s.inviteCodeArea}><Text selectable style={s.inviteCode}>{invite?.code || '······'}</Text><Text style={s.small}>{invite ? inviteSeconds ? `一次有效 · ${Math.floor(inviteSeconds / 60)}:${String(inviteSeconds % 60).padStart(2, '0')} 后失效` : '邀请码已过期，请重新生成' : '正在生成邀请码…'}</Text></View>
    <View style={s.endpointFields}><View style={s.addressField}><Text style={s.label}>地址</Text><Text selectable style={s.endpointValue} testID="invite-address">{inviteEndpoint?.address || '—'}</Text></View><View style={s.portField}><Text style={s.label}>端口</Text><Text selectable style={s.endpointValue} testID="invite-port">{inviteEndpoint?.port || '—'}</Text></View></View>
    <View style={s.inviteActions}><Button primary label="复制邀请信息" disabled={!invite || !inviteSeconds || !!busy} onPress={() => { if (invite) void perform('正在复制…', () => Clipboard.setStringAsync(invitationText(invite))); }} /><Button label="重新生成" onPress={() => { void createInvite(); }} disabled={!!busy || !online} /></View>
  </Sheet>
  <Sheet inline={home} visible={panel === 'settings'} title="我的" onClose={closePanel} footer={<><Busy label={busy} /><Notice text={error} error onDismiss={() => setError('')} /><BottomNav active="settings" onChange={navigateHome}/></>}><View style={s.profileRow}><Avatar name={device.name} id={device.id} size={48}/><View style={s.flex}><Text style={s.profileName}>{device.name}</Text><Text style={s.small}>{Platform.OS === 'ios' ? 'iPhone' : Platform.OS === 'android' ? 'Android' : '网页预览'}</Text></View></View><StorageSettings items={queue} groups={device ? groups.map(group => transferGroup(group)) : []} onError={report} />{client.peerSupported && <><Text style={s.label}>本机提供的群文件 · {peerStorage.count} 个 · {fileSize(peerStorage.bytes)}</Text><Button danger label="清理本机群文件副本" onPress={() => confirm('清理本机持有的文件？', '只清理本机副本，不能撤回其他设备已保存的文件。最后一份副本清理后无法恢复。', [{ text: '取消', style: 'cancel' }, { text: '清理副本', style: 'destructive', onPress: () => perform('正在清理副本…', async () => { await clearPeerFiles(); setPeerStorage(await peerFileStats()); }) }])} /><View style={s.spacer} /></>}<Text style={s.label}>这台手机的名字</Text><TextInput style={s.field} value={name} onChangeText={setName} maxLength={40} placeholder="例如：小林的手机" placeholderTextColor={palette.secondary} accessibilityLabel="设备名称" /><Button primary label="保存名称" disabled={!!busy || !name.trim()} onPress={() => perform('正在保存…', async () => { await client.rename(name.trim()); refreshGroups(); setPanel(null); })} />{activeGroup && <><View style={s.spacer} /><Button danger label={`从此手机移除「${activeGroup.name}」`} onPress={() => confirm('移除此群？', '仅忘记本机连接，待发草稿会保留。再次加入需要邀请。', [{ text: '取消', style: 'cancel' }, { text: '移除', style: 'destructive', onPress: () => perform('正在移除…', async () => { const groupId = activeGroup.id; await client.removeGroup(groupId); await transfers.detachGroup(groupId); refreshGroups(); setActiveId(null); setHome(true); setPanel(null); }) }])} /></>}</Sheet>
  <Sheet inline={home && queueScope === 'all'} visible={panel === 'transfers'} title="传输" onClose={closePanel} footer={<><Notice text={error} error onDismiss={() => setError('')} />{queueScope==='all'&&<BottomNav active="transfers" onChange={navigateHome}/>}</>}><Text style={s.sectionLabel}>{queueScope==='all'?'全部群组':activeGroup?.name}</Text>{shownQueue.length ? shownQueue.map(transferRow) : <View style={s.empty}><ArrowLeftRight size={40} color={palette.secondary} strokeWidth={1.5} accessible={false}/><Text style={s.emptyTitle}>还没有传输记录</Text></View>}</Sheet>
  <Sheet visible={panel === 'share'} title="发送到拾传" onClose={closePanel} footer={<><Busy label={busy} /><Notice text={error} error onDismiss={() => setError('')} /></>}><Text style={s.sheetHero}>选择一个传输群</Text><Text style={s.description}>{incoming.length} 项分享内容，确认后放入群的待发送区。</Text>{incoming.map((item, index) => <View key={`${index}-${item.shareType}`} style={s.incomingCard}><Text style={s.small}>{['text', 'url'].includes(item.shareType) ? '文字 / 链接' : '文件'}</Text><Text numberOfLines={3} style={s.incomingText}>{['text', 'url'].includes(item.shareType) ? item.value : incomingFileName(item.value)}</Text></View>)}{groups.map(group => <Pressable key={group.id} accessibilityRole="radio" accessibilityState={{ checked: shareTarget === group.id }} onPress={() => setShareTarget(group.id)} style={[s.targetGroup, shareTarget === group.id && s.targetSelected]}><Text numberOfLines={1} style={s.targetName}>{group.name}</Text><Text style={s.linkText}>{shareTarget === group.id ? '●' : '○'}</Text></Pressable>)}{groups.length ? <Button primary label="放入此群待发送" onPress={prepareIncoming} disabled={!shareTarget || !!busy} /> : <Button primary label="先加入一个群" onPress={openJoin} />}<View style={s.spacer} /><Button label="取消这次分享" onPress={() => { void cleanupIncoming(incoming.map(item => item.value)).catch(report); Sharing.clearSharedPayloads(); incomingSignature.current = ''; setIncoming([]); setPanel(null); }} /></Sheet>
  </SafeAreaView>;
}

const s = StyleSheet.create({
  chatHeading: { flex: 1, minWidth: 0 }, ownMeta: { justifyContent: 'flex-end' }, groupEnd: { minWidth: 20, alignItems: 'center' }, groupCount: { minWidth: 20, borderRadius: 10, paddingHorizontal: 5, paddingVertical: 2, overflow: 'hidden', backgroundColor: palette.accent, color: palette.accentInk, fontSize: 11, textAlign: 'center', fontWeight: '600' },
  homeToolbar: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 4 }, toolbarItem: { flex: 1, minWidth: 0 },
  chatTabs: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 12, paddingBottom: 2, borderBottomWidth: 1, borderColor: palette.ruleSoft, gap: 4 },
  chatTab: { minHeight: 44, paddingHorizontal: 14, justifyContent: 'center', borderBottomWidth: 2, borderBottomColor: palette.clear }, chatTabActive: { borderBottomColor: palette.blue },
  chatTabLabel: { fontSize: 13, color: palette.secondary }, chatTabLabelActive: { color: palette.ink, fontWeight: '700' },
  profileRow: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingBottom: 24, marginBottom: 24, borderBottomWidth: 1, borderBottomColor: palette.ruleSoft }, profileName: { color: palette.ink, fontSize: 20, fontWeight: '700', marginBottom: 6 },

  animalPicker: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: 24 }, animalChoice: { width: '29%', minHeight: 88, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: palette.border, borderRadius: 16, backgroundColor: palette.surface }, animalSelected: { borderColor: palette.blue, borderWidth: 2, backgroundColor: palette.recess }, animalLabel: { color: palette.secondary, fontSize: 12, marginTop: 4 }, chatTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 7 }, endpointFields: { flexDirection: 'row', gap: 12, marginBottom: 10 }, addressField: { flex: 1, minWidth: 0 }, portField: { width: 84 }, endpointValue: { color: palette.ink, fontSize: 16, marginBottom: 18 }, inviteHeading: { flexDirection: 'row', alignItems: 'center', gap: 8 }, inviteGroupName: { color: palette.ink, fontSize: 18, fontWeight: '600', flex: 1 }, inviteCodeArea: { alignItems: 'center', paddingVertical: 24, paddingHorizontal: 12, marginVertical: 24, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.recess, borderRadius: 16 }, inviteActions: { gap: 10 }, joinAlternatives: { flexDirection: 'row', justifyContent: 'center', gap: 12, marginTop: 16 },

  flex: { flex: 1 }, screen: { flex: 1, backgroundColor: palette.background, width: '100%', maxWidth: 520, alignSelf: 'center' }, red: { color: palette.red }, pressed: { opacity: .72 }, actions: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }, spacer: { height: 16 }, small: { color: palette.secondary, fontSize: 12, lineHeight: 19 }, linkText: { color: palette.blue, fontSize: 12 },
  homeHeader: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }, brand: { flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1 }, brandMark: { width: 32, height: 32, resizeMode: 'contain' }, brandName: { fontSize: 24, fontWeight: '700', color: palette.ink }, brandCaption: { fontSize: 11, color: palette.secondary, marginTop: 4 }, groupList: { flexGrow: 1, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12 }, sectionLabel: { fontSize: 12, color: palette.secondary, marginBottom: 10, marginTop: 4, marginHorizontal: 4 }, groupCard: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 0, paddingVertical: 14, marginBottom: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: palette.ruleSoft, backgroundColor: palette.surface }, groupIcon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }, groupGlyph: { fontSize: 28, color: palette.blue }, groupInfo: { flex: 1, minWidth: 0 }, groupTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 }, groupName: { flex: 1, fontSize: 16, fontWeight: '600', color: palette.ink }, groupPreview: { color: palette.secondary, fontSize: 13, marginTop: 5, lineHeight: 19 }, chevron: { fontSize: 22, color: palette.secondary },
  welcome: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8, paddingVertical: 36 }, welcomeMark: { width: 88, height: 88, alignItems: 'center', justifyContent: 'center', marginBottom: 24 }, welcomeGlyph: { color: palette.accent, fontSize: 52 }, welcomeTitle: { color: palette.ink, fontSize: 20, fontWeight: '600', marginBottom: 24 }, welcomeText: { color: palette.secondary, fontSize: 14, lineHeight: 25, marginBottom: 31 }, welcomeNote: { textAlign: 'center', color: palette.secondary, fontSize: 11, marginTop: 18 },
  chatHeader: { minHeight: 62, paddingHorizontal: 4, flexDirection: 'row', alignItems: 'center', gap: 2, borderBottomWidth: 1, borderBottomColor: palette.ruleSoft }, chatTitleButton: { flex: 1, minWidth: 0, minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 8 }, chatTitle: { color: palette.ink, fontSize: 17, fontWeight: '600' }, chatSubtitle: { color: palette.secondary, fontSize: 11, marginTop: 3 }, membersStrip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, marginHorizontal: 20, minHeight: 46, gap: 8, backgroundColor: palette.recess, borderRadius: 24 }, avatarStack: { flexDirection: 'row' }, stackedAvatar: { borderWidth: 2, borderColor: palette.recess, borderRadius: 20 }, memberNames: { flex: 1, color: palette.secondary, fontSize: 12 }, connection: { color: palette.success, fontSize: 11 }, offline: { color: palette.secondary }, offlineBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 14, paddingRight: 6, marginHorizontal: 20, marginTop: 8, borderRadius: 16, backgroundColor: palette.recess }, offlineText: { flex: 1, fontSize: 12, lineHeight: 19, color: palette.secondary }, requestBanner: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 11, backgroundColor: palette.recess }, requestBannerText: { color: palette.secondary, fontSize: 12 },
  messages: { flexGrow: 1, paddingHorizontal: 12, paddingTop: 4, paddingBottom: 10 }, dateDivider: { textAlign: 'center', color: palette.secondary, fontSize: 11, marginVertical: 10 }, message: { flexDirection: 'row', alignItems: 'flex-start', gap: 7, marginBottom: 12, width: '100%' }, ownMessage: { flexDirection: 'row-reverse' }, messageBody: { flexShrink: 1, maxWidth: '82%', alignItems: 'flex-start', minWidth: 0 }, ownBody: { alignItems: 'flex-end' }, messageMeta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4, maxWidth: '100%' }, senderName: { fontSize: 11, color: palette.secondary, flexShrink: 1 }, messageTime: { color: palette.secondary, fontSize: 10, fontVariant: ['tabular-nums'] }, textBubble: { paddingHorizontal: 11, paddingVertical: 8, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.ruleSoft, borderRadius: 12, borderTopLeftRadius: 3 }, ownBubble: { backgroundColor: palette.recess, borderColor: palette.border, borderTopLeftRadius: 12, borderTopRightRadius: 3 }, messageText: { color: palette.ink, fontSize: 15, lineHeight: 22 }, empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 40, gap: 16 }, emptyGlyph: { color: palette.accent, fontSize: 47, marginBottom: 17 }, emptyTitle: { color: palette.ink, fontSize: 18, fontWeight: '600' }, emptyText: { color: palette.secondary, fontSize: 12, lineHeight: 21, textAlign: 'center' },
  draftBar: { flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 8, marginHorizontal: 12, paddingVertical: 8, borderRadius: 16, backgroundColor: palette.recess }, draftSummary: { flex: 1, minWidth: 0 }, draftTitle: { fontSize: 13, color: palette.ink, marginBottom: 3 }, transferBanner: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 19, paddingVertical: 10, backgroundColor: palette.background }, transferBannerText: { flex: 1, fontSize: 11, color: palette.secondary },
  sheetHero: { fontSize: 22, fontWeight: '700', color: palette.ink, lineHeight: 32, marginBottom: 12 }, description: { fontSize: 14, lineHeight: 23, color: palette.secondary, marginBottom: 20 }, label: { fontSize: 13, fontWeight: '600', color: palette.ink, marginBottom: 9 }, field: { borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface, borderRadius: 12, minHeight: 48, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, color: palette.ink, marginBottom: 20 }, codeField: { fontSize: 27, letterSpacing: 9, textAlign: 'center', paddingLeft: 22 }, linkField: { minHeight: 89, textAlignVertical: 'top', fontSize: 12, lineHeight: 21 }, modePicker: { marginTop: 27, marginBottom: 23, flexDirection: 'row', padding: 4, borderRadius: 11, backgroundColor: palette.recess }, modeButton: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 40, borderRadius: 8 }, modeActive: { backgroundColor: palette.background }, modeLabel: { fontSize: 12, color: palette.secondary }, modeLabelActive: { color: palette.blue, fontWeight: '600' }, footnote: { fontSize: 11, lineHeight: 20, color: palette.secondary, marginTop: 25 }, fieldError: { fontSize: 11, lineHeight: 19, color: palette.red, marginTop: 8 }, cameraFrame: { height: 330, overflow: 'hidden', borderRadius: 18, marginBottom: 21, backgroundColor: palette.ink }, pendingBanner: { marginHorizontal: 20, borderRadius: 12, padding: 14, backgroundColor: palette.recess, flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 17 }, pendingText: { color: palette.blue, fontSize: 12, flex: 1 }, pendingContent: { paddingTop: 45 }, pendingMark: { height: 80, justifyContent: 'center', marginBottom: 22 }, requestCard: { padding: 16, backgroundColor: palette.recess, borderRadius: 13, marginBottom: 15 }, requestName: { fontSize: 14, fontWeight: '600', color: palette.ink, marginBottom: 8 }, deviceRow: { flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1, borderBottomColor: palette.ruleSoft, paddingVertical: 16 }, deviceInfo: { flex: 1, minWidth: 0 }, deviceName: { color: palette.ink, fontSize: 15, marginBottom: 4 }, inviteCard: { alignItems: 'center', paddingVertical: 24, borderWidth: 1, borderColor: palette.border, borderRadius: 16, backgroundColor: palette.background, marginBottom: 28 }, inviteCode: { fontSize: 34, letterSpacing: 5, fontVariant: ['tabular-nums'], fontWeight: '600', color: palette.ink, marginBottom: 12 }, addressText: { fontSize: 13, color: palette.secondary, marginBottom: 25 }, transferCard: { paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: palette.ruleSoft, marginBottom: 4, gap: 10 }, transferHead: { gap: 6 }, transferName: { color: palette.ink, fontSize: 15, fontWeight: '600' }, transferStatus: { color: palette.secondary, fontSize: 12 }, progressTrack: { backgroundColor: palette.recess, height: 4, borderRadius: 2, overflow: 'hidden' }, progressFill: { backgroundColor: palette.accent, height: 4, borderRadius: 2 }, incomingCard: { backgroundColor: palette.recess, padding: 13, borderRadius: 11, marginBottom: 10 }, incomingText: { fontSize: 12, color: palette.secondary, lineHeight: 21, marginTop: 5 }, targetGroup: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: palette.border, borderRadius: 12, paddingHorizontal: 15, paddingVertical: 17, marginBottom: 12 }, targetSelected: { backgroundColor: palette.recess, borderColor: palette.accent }, targetName: { flex: 1, color: palette.ink, fontSize: 14 },
});
