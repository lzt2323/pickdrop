import React from 'react';
import { ArrowUp } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { TransferItem } from '../transfers';
import { IconButton, palette } from './ui';
import { ImageDrafts } from './ImageDrafts';
import NativeComposerInput from './NativeComposerInput';

type Props = {
  groupId: string; groupName: string; text: string; files: TransferItem[]; busy: boolean; canSend: boolean;
  onChangeText: (text: string) => void; onPasteImage: () => void; onChooseFiles: () => void;
  onSend: () => void; onRemoveImage: (id: string) => void;
};

export function MessageComposer(props: Props) {
  return <View style={s.composer}>
    <IconButton icon="plus" label="添加文件到待发送" onPress={props.onChooseFiles} disabled={props.busy} />
    <View style={s.field}>
      <ImageDrafts items={props.files} disabled={props.busy} onRemove={props.onRemoveImage} />
      <NativeComposerInput key={props.groupId} style={s.input} value={props.text} onChangeText={props.onChangeText} onPasteImage={props.onPasteImage} />
    </View>
    <Pressable accessibilityRole="button" accessibilityLabel={props.files.length ? `发送消息和 ${props.files.length} 份文件到${props.groupName}` : '发送消息'} accessibilityState={{ disabled: !props.canSend }} disabled={!props.canSend} onPress={props.onSend} style={({ pressed }) => [s.send, !props.canSend && { opacity: .4 }, pressed && { opacity: .7 }]}><ArrowUp size={22} strokeWidth={1.8} color={palette.accentInk} accessible={false} /></Pressable>
  </View>;
}
const s = StyleSheet.create({
  composer: { flexDirection: 'row', alignItems: 'flex-end', padding: 5, marginHorizontal: 8, marginBottom: 5, marginTop: 4, gap: 4, borderWidth: 1, borderColor: palette.border, borderRadius: 18, backgroundColor: palette.surface },
  field: { flex: 1, minWidth: 0, borderRadius: 16, overflow: 'hidden', backgroundColor: palette.surface },
  input: { minHeight: 44, maxHeight: 112 },
  send: { width: 44, height: 44, borderRadius: 14, backgroundColor: palette.accent, alignItems: 'center', justifyContent: 'center', marginLeft: 3 },
  arrow: { color: palette.surface, fontSize: 25 },
});
