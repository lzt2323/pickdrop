import { ConfirmationOutlet, useConfirmationHost } from './Confirmation';
import { palette } from '../theme';
import { ArrowUp, ArrowLeftRight, ChevronLeft, Ellipsis, Plus, Settings, X, ScanLine, Folder, UserRound } from 'lucide-react-native';
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { AccessibilityInfo, Animated, ActivityIndicator, Modal, Platform, Pressable, StyleSheet, Text, View, KeyboardAvoidingView, ScrollView } from 'react-native';

const ReducedMotion = createContext(true);
export function MotionProvider({ children }: { children: React.ReactNode }) {
  const [reduced, setReduced] = useState(true);
  useEffect(() => { AccessibilityInfo.isReduceMotionEnabled().then(setReduced).catch(() => {}); const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced); return () => subscription.remove(); }, []);
  return <ReducedMotion.Provider value={reduced}>{children}</ReducedMotion.Provider>;
}
export function MotionView({ children, animate = true, style }: { children: React.ReactNode; animate?: boolean; style?: React.ComponentProps<typeof View>['style'] }) {
  const reduced = useContext(ReducedMotion), value = useRef(new Animated.Value(animate && !reduced ? 0 : 1)).current;
  useEffect(() => { if (reduced) { value.stopAnimation(); value.setValue(1); return; } const motion = Animated.timing(value, { toValue: 1, duration: 180, useNativeDriver: Platform.OS !== 'web' }); motion.start(); return () => motion.stop(); }, [reduced, value]);
  return <Animated.View style={[style, { opacity: value, transform: [{ translateY: value.interpolate({ inputRange: [0, 1], outputRange: [5, 0] }) }] }]}>{children}</Animated.View>;
}
export { palette } from '../theme';
// Personal identity uses the device name; animal marks belong exclusively to groups.
export function Avatar({ name, size = 32, muted = false }: { name: string; id: string; size?: number; muted?: boolean }) {
  const initial = Array.from(name.trim())[0]?.toLocaleUpperCase() || '?';
  return <View accessible={false} style={{width:size,height:size,borderRadius:size/2,backgroundColor:palette.recess,alignItems:'center',justifyContent:'center',opacity:muted?.5:1}}><Text style={{fontSize:Math.round(size*.42),fontWeight:'500',color:palette.secondary}}>{initial}</Text></View>;
}
export function Button({ label, onPress, disabled = false, primary = false, danger = false, accessibilityLabel, compact = false }: { label: string; onPress: () => void; disabled?: boolean; primary?: boolean; danger?: boolean; accessibilityLabel?: string; compact?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel || label} accessibilityState={{ disabled }} onPress={onPress} disabled={disabled} style={({ pressed }) => [u.button, compact && u.compact, primary && u.primary, pressed && { opacity: .72 }, disabled && { opacity: .45 }]}><Text numberOfLines={1} style={[u.buttonLabel, primary && { color: palette.accentInk }, danger && { color: palette.red }]}>{label}</Text></Pressable>;
}
const icons = { back: ChevronLeft, more: Ellipsis, plus: Plus, settings: Settings, close: X, send: ArrowUp, scan: ScanLine };
export function IconButton({ icon, label, onPress, disabled = false }: { icon: keyof typeof icons; label: string; onPress: () => void; disabled?: boolean }) {
  const Icon = icons[icon];
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} onPress={onPress} disabled={disabled} style={({ pressed }) => [u.iconButton, pressed && { backgroundColor: palette.recess }, disabled && { opacity: .4 }]}><Icon size={22} strokeWidth={1.8} color={palette.blue} accessible={false} /></Pressable>;
}
export function Notice({ text, onDismiss, error = false }: { text: string; onDismiss?: () => void; error?: boolean }) {
  if (!text) return null;
  return <View accessibilityLiveRegion="polite" style={[u.notice, error && { backgroundColor: palette.errorBackground }]}><Text style={[u.noticeText, error && { color: palette.red }]}>{text}</Text>{onDismiss && <IconButton icon="close" label="关闭提示" onPress={onDismiss} />}</View>;
}
export function Busy({ label }: { label: string }) {
  if (!label) return null;
  return <View accessibilityLiveRegion="polite" style={u.busy}><ActivityIndicator size="small" color={palette.blue} /><Text style={u.busyText}>{label}</Text></View>;
}
export function Sheet({ visible, title, onClose, children, footer, onDismiss, inline = false }: { visible: boolean; title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; onDismiss?: () => void; inline?: boolean }) {
  const reduced = useContext(ReducedMotion);
  const confirmation = useConfirmationHost(visible);
  const content = <KeyboardAvoidingView accessibilityElementsHidden={confirmation.open} importantForAccessibility={confirmation.open ? 'no-hide-descendants' : 'auto'} style={u.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}><View style={u.sheetHeader}><IconButton icon="back" label="返回" onPress={onClose} /><Text accessibilityRole="header" style={u.sheetTitle}>{title}</Text></View><ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={u.sheetContent}>{children}</ScrollView>{footer}</KeyboardAvoidingView>;
  // Bottom tabs are root pages. Group operations alone use native modal presentation.
  if (inline) return visible ? <View style={u.sheet}>{content}<ConfirmationOutlet host={confirmation.id}/></View> : null;
  return <Modal visible={visible} animationType={reduced ? 'none' : 'slide'} presentationStyle="fullScreen" onRequestClose={confirmation.open ? confirmation.dismiss : onClose} onDismiss={onDismiss}><SafeAreaProvider><SafeAreaView style={u.sheet}>{content}<ConfirmationOutlet host={confirmation.id}/></SafeAreaView></SafeAreaProvider></Modal>;
}

const u = StyleSheet.create({
  flex: { flex: 1 }, button: { minHeight: 44, paddingHorizontal: 17, paddingVertical: 12, borderRadius: 10, borderWidth: 1, borderColor: palette.ruleSoft, backgroundColor: palette.recess, alignItems: 'center', justifyContent: 'center' }, compact: { minHeight: 44, paddingHorizontal: 12, paddingVertical: 9 }, primary: { backgroundColor: palette.accent, borderColor: palette.accent }, buttonLabel: { color: palette.blue, fontSize: 14, fontWeight: '600' }, iconButton: { width: 44, minHeight: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }, icon: { color: palette.blue, fontSize: 26, lineHeight: 30 }, notice: { marginHorizontal: 16, marginBottom: 8, paddingLeft: 13, paddingVertical: 3, paddingRight: 5, backgroundColor: palette.recess, borderRadius: 11, flexDirection: 'row', alignItems: 'center' }, noticeText: { flex: 1, fontSize: 12, color: palette.blue, lineHeight: 19, paddingVertical: 7 }, busy: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 20, paddingVertical: 9 }, busyText: { flex: 1, fontSize: 12, color: palette.blue, lineHeight: 18 }, sheet: { flex: 1, backgroundColor: palette.background }, sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: palette.border }, sheetTitle: { flex: 1, fontSize: 21, fontWeight: '600', color: palette.ink }, sheetContent: { padding: 24, paddingBottom: 38 },
});

export function BottomNav({ active, onChange }: { active: 'home' | 'transfers' | 'settings'; onChange(value: 'home' | 'transfers' | 'settings'): void }) {
  return <View accessibilityRole="tablist" style={nav.container}>{([{id:'home',label:'群组',Icon:Folder},{id:'transfers',label:'传输',Icon:ArrowLeftRight},{id:'settings',label:'我的',Icon:UserRound}] as const).map(({id,label,Icon}) => <Pressable key={id} testID={`nav-${id}`} accessibilityRole="tab" accessibilityLabel={label} aria-selected={active===id} accessibilityState={{selected:active===id}} onPress={()=>onChange(id)} style={({pressed})=>[nav.item,active===id&&nav.selected,pressed&&{opacity:.7}]}><Icon size={19} color={active===id?palette.blue:palette.ink} strokeWidth={1.7}/><Text numberOfLines={1} style={[nav.label,active===id&&nav.selectedLabel]}>{label}</Text></Pressable>)}</View>;
}
const nav=StyleSheet.create({container:{flexDirection:'row',paddingHorizontal:12,paddingVertical:6,gap:4,marginTop:0,borderTopWidth:StyleSheet.hairlineWidth,borderColor:palette.border,backgroundColor:palette.surface},item:{flex:1,minHeight:44,flexDirection:'row',alignItems:'center',justifyContent:'center',gap:7,borderRadius:8},selected:{backgroundColor:palette.surface},label:{fontSize:13,color:palette.secondary},selectedLabel:{color:palette.blue,fontWeight:'700'}});
