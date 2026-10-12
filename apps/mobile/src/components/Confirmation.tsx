import React, { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { BackHandler, Keyboard, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { palette } from '../theme';

type Choice = { text?: string; style?: 'default' | 'cancel' | 'destructive'; onPress?: () => unknown };
type Confirmation = { host: string; title: string; message: string; choices: Choice[] };
type Context = { dialog: Confirmation | null; close(): void; register(id: string): () => void; request(title: string, message: string, choices: Choice[]): void };
const ConfirmationContext = createContext<Context | null>(null);
function useContextValue() { const value = useContext(ConfirmationContext); if (!value) throw new Error('ConfirmationProvider is required'); return value; }

export function ConfirmationProvider({ children }: { children: React.ReactNode }) {
  const [dialog, setDialog] = useState<Confirmation | null>(null);
  const hosts = useRef<string[]>([]);
  const register = useCallback((id: string) => { hosts.current.push(id); return () => { hosts.current = hosts.current.filter(host => host !== id); setDialog(current => current?.host === id ? null : current); }; }, []);
  const close = useCallback(() => setDialog(null), []);
  const request = useCallback((title: string, message: string, choices: Choice[]) => {
    Keyboard.dismiss();
    setDialog({ host: hosts.current.at(-1) || 'root', title, message, choices });
  }, []);
  const rootDialog = dialog?.host === 'root';
  return <ConfirmationContext.Provider value={{ dialog, close, register, request }}><View style={styles.flex}><View style={styles.flex} accessibilityElementsHidden={rootDialog} importantForAccessibility={rootDialog ? 'no-hide-descendants' : 'auto'}>{children}</View><ConfirmationOutlet host="root" /></View></ConfirmationContext.Provider>;
}
export function useConfirm() { return useContextValue().request; }
export function useConfirmationHost(active: boolean) {
  const id = useId(), { register, dialog, close } = useContextValue();
  useEffect(() => active ? register(id) : undefined, [active, id, register]);
  return { id, open: dialog?.host === id, dismiss: close };
}
export function ConfirmationOutlet({ host }: { host: string }) {
  const { dialog, close } = useContextValue();
  const active = dialog?.host === host;
  useEffect(() => {
    if (!active) return;
    const back = BackHandler.addEventListener('hardwareBackPress', () => { close(); return true; });
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close(); } };
    if (Platform.OS === 'web') globalThis.addEventListener?.('keydown', escape);
    return () => { back.remove(); if (Platform.OS === 'web') globalThis.removeEventListener?.('keydown', escape); };
  }, [active, close]);
  if (!active || !dialog) return null;
  return <View style={styles.overlay} accessibilityViewIsModal><Pressable accessible={false} style={StyleSheet.absoluteFill} onPress={close}/><View accessibilityRole="alert" style={styles.card} testID="confirmation-dialog"><Text accessibilityRole="header" style={styles.title}>{dialog.title}</Text><Text style={styles.message}>{dialog.message}</Text><View style={styles.actions}>{dialog.choices.map((choice,index)=><Pressable key={index} accessibilityRole="button" accessibilityLabel={choice.text} onPress={()=>{close();choice.onPress?.();}} style={({pressed})=>[styles.button,choice.style==='destructive'&&styles.destructive,choice.style!=='cancel'&&choice.style!=='destructive'&&styles.primary,pressed&&{opacity:.7}]}><Text numberOfLines={1} style={[styles.label,choice.style==='destructive'&&styles.danger,choice.style!=='cancel'&&choice.style!=='destructive'&&styles.primaryLabel]}>{choice.text}</Text></Pressable>)}</View></View></View>;
}
const styles=StyleSheet.create({
  flex:{flex:1},overlay:{position:'absolute',top:0,right:0,bottom:0,left:0,zIndex:1000,elevation:20,backgroundColor:palette.scrim,justifyContent:'center',alignItems:'center',padding:24},
  card:{width:'100%',maxWidth:330,borderWidth:1,borderColor:palette.border,borderRadius:20,padding:20,backgroundColor:palette.surface},
  title:{fontSize:18,fontWeight:'600',color:palette.ink,marginBottom:12},message:{fontSize:14,lineHeight:23,color:palette.secondary,marginBottom:20},
  actions:{flexDirection:'row',gap:10},button:{flex:1,minHeight:44,paddingHorizontal:12,justifyContent:'center',alignItems:'center',backgroundColor:palette.recess,borderRadius:12},primary:{backgroundColor:palette.accent},destructive:{backgroundColor:palette.errorBackground},label:{fontSize:14,fontWeight:'600',color:palette.ink},primaryLabel:{color:palette.accentInk},danger:{color:palette.red},
});
