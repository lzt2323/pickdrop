import { useConfirm } from './Confirmation';
import React, { useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { fileSize } from '../../../../shared/protocol';
import { transfers, type TransferGroup, type TransferItem } from '../transfers';
import { Button, palette } from './ui';

/** Only app-owned cache is evicted. Drafts require an explicit delete or reassignment. */
export function StorageSettings({ items, groups, onError }: { items: TransferItem[]; groups: TransferGroup[]; onError(error: unknown): void }) {
  const confirm = useConfirm();
  const [usage, setUsage] = useState({ cacheBytes: 0, draftBytes: 0 });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (Platform.OS === 'web') return;
    let alive = true;
    transfers.storageStats().then(value => { if (alive) setUsage(value); }).catch(onError);
    return () => { alive = false; };
  }, [items, onError]);
  async function clean() {
    setBusy(true);
    try { await transfers.cleanCache(true); setUsage(await transfers.storageStats()); }
    catch (error) { onError(error); }
    finally { setBusy(false); }
  }
  return <View style={styles.section}>
    <Text style={styles.title}>存储空间</Text>
    <View style={styles.storageCard}><Text style={styles.label}>接收缓存</Text><Text style={styles.amount}>{fileSize(usage.cacheBytes)}</Text><View style={styles.row}><Text style={styles.detail}>待发送草稿</Text><Text style={styles.detail}>{fileSize(usage.draftBytes)}</Text></View></View>
    <Button label={busy ? '正在清理…' : '清理缓存'} disabled={busy || Platform.OS === 'web'} onPress={() => confirm('清理接收缓存？', '草稿和已另存文件会保留。', [{text:'取消',style:'cancel'},{text:'清理缓存',onPress:()=>{void clean();}}])} />
    {items.filter(item => item.status === 'orphaned').map(item => <View key={item.id} style={styles.draft}>
      <Text style={styles.label}>{item.name} · {fileSize(item.size)}</Text>
      <View style={styles.actions}>{!!item.localUri && groups.map(group => <Button key={group.id} compact label={`放入 ${group.name}`} onPress={() => { void transfers.reassignDraft(item.id, group).catch(onError); }} />)}<Button compact danger label="删除草稿" onPress={() => confirm('删除这份草稿？', '这会删除拾传中待发送的副本。', [{ text: '取消', style: 'cancel' }, { text: '删除', style: 'destructive', onPress: () => { void transfers.remove(item.id).catch(onError); } }])} /></View>
    </View>)}
  </View>;
}
const styles = StyleSheet.create({
  storageCard: { padding: 20, borderRadius: 16, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface }, amount: { fontSize: 34, fontWeight: '600', color: palette.ink, marginVertical: 20, fontVariant: ['tabular-nums'] },
  section: { gap: 12, marginBottom: 28 }, title: { fontSize: 14, fontWeight: '600', color: palette.ink },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }, details: { flex: 1, gap: 4 },
  label: { color: palette.ink, fontSize: 13 }, detail: { color: palette.secondary, fontSize: 12, lineHeight: 19 },
  draft: { borderColor: palette.border, borderWidth: 1, borderRadius: 12, padding: 12, gap: 10 }, actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
