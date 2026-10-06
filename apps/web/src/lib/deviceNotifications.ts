/**
 * Notificações do navegador por dispositivo (Conta › Preferências › Este navegador).
 *
 * Cada navegador tem um id próprio (guardado só nele). O servidor guarda, por usuário, a lista
 * de navegadores ligados; "Revogar todas as notificações" esvazia a lista. Os avisos aparecem
 * enquanto o Verifco estiver aberto em alguma aba (não há push com o navegador fechado).
 */
import { useEffect, useRef } from 'react';

const DEVICE_KEY = 'verifco.deviceId';

export const browserNotificationsSupported = () => typeof window !== 'undefined' && 'Notification' in window;

/** Id deste navegador (criado na primeira vez). */
export function getDeviceId(): string {
  try {
    const saved = localStorage.getItem(DEVICE_KEY);
    if (saved) return saved;
    const id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, id);
    return id;
  } catch {
    return 'sem-armazenamento';
  }
}

export interface DeviceNotificationPrefs {
  enabled?: boolean;
  devices?: string[];
}

/** Este navegador está ligado (e com permissão do sistema)? */
export function deviceEnabled(prefs: DeviceNotificationPrefs | undefined): boolean {
  if (!browserNotificationsSupported() || prefs?.enabled === false) return false;
  return (prefs?.devices ?? []).includes(getDeviceId()) && Notification.permission === 'granted';
}

interface BellItem {
  id: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
}

/** Mostra como notificação do sistema as novas do sino, se este navegador estiver ligado. */
export function useBrowserNotifications(items: BellItem[] | undefined, prefs: DeviceNotificationPrefs | undefined, open: (link: string) => void) {
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!items) return;
    // primeira carga: só registra o que já existia
    if (!seen.current) {
      seen.current = new Set(items.map((n) => n.id));
      return;
    }
    const fresh = items.filter((n) => !n.readAt && !seen.current!.has(n.id));
    for (const n of items) seen.current.add(n.id);
    if (!fresh.length || !deviceEnabled(prefs)) return;
    for (const n of fresh.slice(0, 3)) {
      const shown = new Notification(n.title, { body: n.body ?? undefined, tag: n.id });
      shown.onclick = () => {
        window.focus();
        if (n.link) open(n.link);
        shown.close();
      };
    }
  }, [items, prefs, open]);
}
