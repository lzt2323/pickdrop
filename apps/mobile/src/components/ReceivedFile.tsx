import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Download, FileText, Image as ImageIcon, Share2 } from 'lucide-react-native';
import { fileSize } from '../../../../shared/protocol';
import type { Message } from '../client';
import { transfers, MAX_IMAGE_PREVIEW_BYTES, type TransferGroup } from '../transfers';
import { Button, IconButton, palette, Sheet } from './ui';

const MAX_PREVIEW = MAX_IMAGE_PREVIEW_BYTES;
// Automatic previews download the original into the verified receive cache, not Photos.
const AUTO_PREVIEW = 8 * 1024 * 1024;
const previewTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
type Props = { message: Message; own: boolean; group: TransferGroup; visible: boolean; onAction(action: 'save' | 'file' | 'share'): void };

/** Original bytes are verified by the transfer service before a local URI reaches Image. */
export function ReceivedFile({ message, own, group, visible, onAction }: Props) {
  const image = message.mime?.startsWith('image/');
  const supported = image && previewTypes.has(message.mime || '') && (message.size || 0) > 0 && (message.size || 0) <= MAX_PREVIEW && Platform.OS !== 'web';
  const [uri, setUri] = useState(''), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [requested, setRequested] = useState(false), [attempt, setAttempt] = useState(0), [expanded, setExpanded] = useState(false), [menu, setMenu] = useState(false);
  const context = useRef({ group, message });
  context.current = { group, message };
  const [seen, setSeen] = useState(false);
  useEffect(() => { if (visible) setSeen(true); }, [visible]);
  const shouldLoad = supported && !message.deleted && (seen || expanded) && (requested || (message.size || 0) <= AUTO_PREVIEW);
  useEffect(() => {
    setUri(''); setError('');
    if (!shouldLoad) { setLoading(false); return; }
    const controller = new AbortController();
    let release: (() => void) | undefined;
    setLoading(true);
    transfers.previewImage(context.current.group, context.current.message, controller.signal).then(result => {
      if (controller.signal.aborted) { result.release(); return; }
      release = result.release; setUri(result.uri); setLoading(false);
    }).catch(cause => {
      if (!controller.signal.aborted) { setLoading(false); setError(cause instanceof Error ? cause.message : '图片预览暂不可用'); }
    });
    return () => { controller.abort(); release?.(); };
  }, [shouldLoad, group.id, message.id, message.sha256, attempt]);
  useEffect(() => { if (message.deleted) { setExpanded(false); setMenu(false); } }, [message.deleted]);
  const pendingAction = useRef<'save' | 'file' | 'share' | null>(null);
  const finishAction = () => { const value = pendingAction.current; pendingAction.current = null; if (value && !message.deleted) onAction(value); };
  const action = (value: 'save' | 'file' | 'share') => { if (!menu && !expanded) { onAction(value); return; } pendingAction.current = value; setMenu(false); setExpanded(false); };
  // UIKit must finish dismissing our modal before presenting its save/share UI.
  useEffect(() => {
    if (Platform.OS === 'ios' || menu || expanded || !pendingAction.current) return;
    const timeout = setTimeout(finishAction, 0);
    return () => clearTimeout(timeout);
  }, [menu, expanded]);
  const extension = message.fileName?.split('.').pop()?.slice(0, 5).toUpperCase() || 'FILE';
  const previewLabel = message.deleted ? '原文件已清理' : !supported ? (Platform.OS === 'web' ? '在手机客户端中预览' : '保存后查看图片') : error ? '预览失败，点击重试' : loading ? '正在加载预览…' : uri ? '点击查看大图' : '点击加载图片';
  const openPreview = () => { if (!supported || message.deleted || loading) return; if (uri && !error) setExpanded(true); else { setRequested(true); setAttempt(value => value + 1); } };
  return <>
    <View style={[styles.card, own && styles.own]} testID={`received-file-${message.id}`}>
      {image && <Pressable accessibilityRole="button" accessibilityLabel={`${message.fileName}，${previewLabel}`} accessibilityState={{ disabled: !supported || !!message.deleted || loading }} disabled={!supported || message.deleted || loading} onPress={openPreview} style={({ pressed }) => [styles.preview, pressed && { opacity: .8 }]}>
        {uri && !error ? <Image source={{ uri }} resizeMode="cover" resizeMethod="resize" accessibilityLabel={message.fileName || '图片'} style={styles.thumbnail} onError={() => setError('图片无法显示，可尝试保存原文件')} /> : <View style={styles.placeholder}>{loading ? <ActivityIndicator color={palette.blue} /> : <ImageIcon size={30} color={palette.blue} strokeWidth={1.6} />}<Text style={styles.previewLabel}>{previewLabel}</Text>{!loading && !message.deleted && <Text style={styles.previewHint}>{fileSize(message.size || 0)}{!supported && Platform.OS !== 'web' ? ' · 此图片暂不支持预览' : ''}</Text>}</View>}
        {uri && !error && <View style={styles.previewBadge}><Text style={styles.previewBadgeText}>查看大图</Text></View>}
      </Pressable>}
      <View style={styles.footer}>
        {!image && <View style={styles.fileIcon}><FileText size={21} color={palette.blue} strokeWidth={1.7} /><Text style={styles.extension}>{extension}</Text></View>}
        <View style={styles.info}><Text numberOfLines={2} style={styles.name}>{message.fileName}</Text><Text style={styles.size}>{fileSize(message.size || 0)} · {message.deleted ? '原文件已清理' : extension}</Text></View>
        <IconButton icon="more" label={`${message.fileName}，更多操作`} disabled={message.deleted} onPress={() => setMenu(true)} />
      </View>
      <View style={styles.fileActions}><Text style={styles.size}>{message.deleted ? '原文件已清理' : own ? '已发送' : '可接收'}</Text><Button compact label={image ? '保存图片' : '另存文件'} disabled={message.deleted} onPress={() => action('save')} /></View>
    </View>
    <Sheet visible={menu && !message.deleted} title="文件操作" onClose={() => setMenu(false)} onDismiss={finishAction}>
      <Text selectable style={styles.fullName}>{message.fileName}</Text><Text style={styles.menuMeta}>{fileSize(message.size || 0)}</Text>
      <View style={styles.menuActions}><MenuAction icon={<Download size={20} color={palette.blue} />} label={image ? '保存到相册' : '保存到文件'} onPress={() => action('save')} /><MenuAction icon={<Share2 size={20} color={palette.blue} />} label="分享给其他应用" onPress={() => action('share')} />{image && <MenuAction icon={<FileText size={20} color={palette.blue} />} label="保存到文件" onPress={() => action('file')} />}</View>
    </Sheet>
    <Modal visible={expanded && !!uri && !message.deleted} animationType="none" onRequestClose={() => setExpanded(false)} onDismiss={finishAction}>
      <SafeAreaView style={styles.viewer}><View style={styles.viewerHeader}><Text numberOfLines={2} style={styles.viewerName}>{message.fileName}</Text><Button compact label="关闭" onPress={() => setExpanded(false)} /></View><ScrollView style={styles.viewerScroll} contentContainerStyle={styles.viewerContent} minimumZoomScale={1} maximumZoomScale={4} centerContent>{!!uri && <Image source={{ uri }} style={styles.fullImage} resizeMode="contain" resizeMethod="resize" accessibilityLabel={message.fileName || '图片原图'} onError={() => { setExpanded(false); setError('图片无法显示，可尝试保存原文件'); }} />}</ScrollView><View style={styles.viewerActions}><Button label="保存到相册" onPress={() => action('save')} /><Button label="分享" onPress={() => action('share')} /></View></SafeAreaView>
    </Modal>
  </>;
}
function MenuAction({ icon, label, onPress }: { icon: React.ReactNode; label: string; onPress(): void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [styles.menuAction, pressed && { backgroundColor: palette.recess }]}>{icon}<Text style={styles.menuLabel}>{label}</Text></Pressable>;
}
const styles = StyleSheet.create({
  fileActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 10, paddingBottom: 6 },
  card: { width: 228, maxWidth: '100%', borderRadius: 12, borderColor: palette.border, borderWidth: 1, backgroundColor: palette.surface }, own: { backgroundColor: palette.recess },
  preview: { borderTopLeftRadius: 12, borderTopRightRadius: 12, overflow: 'hidden', height: 138, backgroundColor: palette.recess, justifyContent: 'center' }, thumbnail: { width: '100%', height: '100%' }, placeholder: { alignItems: 'center', gap: 9, padding: 15 }, previewLabel: { fontSize: 12, color: palette.ink }, previewHint: { fontSize: 11, color: palette.secondary },
  previewBadge: { position: 'absolute', bottom: 10, right: 10, borderRadius: 12, paddingVertical: 5, paddingHorizontal: 9, backgroundColor: palette.backdrop }, previewBadgeText: { color: palette.surface, fontSize: 10 },
  footer: { flexDirection: 'row', alignItems: 'center', padding: 10, gap: 7 }, fileIcon: { width: 30, height: 38, backgroundColor: palette.recess, borderRadius: 9, justifyContent: 'center', alignItems: 'center', gap: 3 }, extension: { color: palette.blue, fontSize: 8, fontWeight: '700' }, info: { flex: 1, minWidth: 0 }, name: { fontSize: 14, fontWeight: '600', lineHeight: 20, color: palette.ink }, size: { fontSize: 11, marginTop: 4, color: palette.secondary },
  fullName: { fontSize: 16, color: palette.ink, lineHeight: 24 }, menuMeta: { color: palette.secondary, marginTop: 8 }, menuActions: { marginTop: 20, gap: 4 }, menuAction: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 13, padding: 13, borderRadius: 12 }, menuLabel: { color: palette.ink, fontSize: 15 },
  viewer: { flex: 1, backgroundColor: palette.background }, viewerHeader: { padding: 16, flexDirection: 'row', alignItems: 'center', gap: 16 }, viewerName: { flex: 1, fontSize: 14, color: palette.ink }, viewerScroll: { flex: 1 }, viewerContent: { flexGrow: 1 }, fullImage: { flex: 1, width: '100%', minHeight: 250 }, viewerActions: { flexDirection: 'row', justifyContent: 'center', padding: 16, gap: 12 },
});
