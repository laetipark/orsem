import type { BrowserSubscriptionInput } from '../types';

export interface PushSupport {
  supported: boolean;
  needsInstall: boolean;
  ios: boolean;
  android: boolean;
  secure: boolean;
  permission: NotificationPermission | 'unsupported';
}

export function browserPushSupport(): PushSupport {
  const ios =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const secure = window.isSecureContext;
  return {
    ios,
    android: /Android/i.test(navigator.userAgent),
    secure,
    needsInstall: ios && !standalone,
    supported:
      secure && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
    permission: 'Notification' in window ? Notification.permission : 'unsupported',
  };
}

export async function pushWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  const registration = await navigator.serviceWorker.register('/sw.js', {
    scope: '/',
    updateViaCache: 'none',
  });
  if (registration.active) return registration;
  return new Promise((resolve, reject) => {
    const worker = registration.installing ?? registration.waiting;
    const timer = window.setTimeout(() => {
      worker?.removeEventListener('statechange', ready);
      reject(new Error('알림 연결 준비가 지연됩니다. 다시 시도해 주세요.'));
    }, 15_000);
    function ready() {
      if (registration.active) {
        window.clearTimeout(timer);
        worker?.removeEventListener('statechange', ready);
        resolve(registration);
      }
    }
    worker?.addEventListener('statechange', ready);
    ready();
  });
}

export function applicationServerKey(value: string): ArrayBuffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(
    window.atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')),
    (character) => character.charCodeAt(0),
  );
  return bytes.buffer;
}

export function subscriptionInput(
  subscription: PushSubscription,
  deviceName: string,
): BrowserSubscriptionInput {
  const json = subscription.toJSON();
  if (!json.keys?.p256dh || !json.keys.auth)
    throw new Error('이 브라우저의 알림 인증 정보를 읽지 못했습니다. 다시 연결해 주세요.');
  return {
    endpoint: subscription.endpoint,
    expirationTime: subscription.expirationTime,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    deviceName: deviceName.trim().slice(0, 80),
  };
}

const deviceStorageKey = 'orsem-push-device-v1';
export function currentDeviceId(userId: string): string | null {
  try {
    const value = JSON.parse(localStorage.getItem(deviceStorageKey) ?? 'null') as {
      userId?: string;
      id?: string;
    } | null;
    return value?.userId === userId && typeof value.id === 'string' ? value.id : null;
  } catch {
    return null;
  }
}
export function storeCurrentDevice(userId: string, id: string) {
  try {
    localStorage.setItem(deviceStorageKey, JSON.stringify({ userId, id }));
  } catch {
    /* Subscription remains available on the server. */
  }
}
export function forgetCurrentDevice() {
  try {
    localStorage.removeItem(deviceStorageKey);
  } catch {
    /* Storage can be disabled. */
  }
}
export function defaultDeviceName(): string {
  const support = browserPushSupport();
  const platform = support.ios
    ? 'iPhone·iPad'
    : support.android
      ? 'Android'
      : /Mac/.test(navigator.platform)
        ? 'Mac'
        : /Win/.test(navigator.platform)
          ? 'Windows'
          : '이 기기';
  const browser = /Edg\//.test(navigator.userAgent)
    ? 'Edge'
    : /Chrome\//.test(navigator.userAgent)
      ? 'Chrome'
      : /Firefox\//.test(navigator.userAgent)
        ? 'Firefox'
        : /Safari\//.test(navigator.userAgent)
          ? 'Safari'
          : '브라우저';
  return `${platform} · ${browser}`;
}

export async function disconnectPushOnLogout(
  userId: string | undefined,
  revoke: (id: string) => Promise<void>,
): Promise<void> {
  const id = userId ? currentDeviceId(userId) : null;
  // Either confirmed server or browser revocation is enough to stop account delivery.
  const results = await Promise.allSettled([
    id ? revoke(id).then(() => true) : Promise.resolve(false),
    (async () => {
      if (!('serviceWorker' in navigator)) return true;
      const registration = await navigator.serviceWorker.getRegistration('/');
      const subscription = await registration?.pushManager.getSubscription();
      return subscription ? subscription.unsubscribe() : true;
    })(),
  ]);
  if (!results.some((result) => result.status === 'fulfilled' && result.value === true))
    throw new Error(
      '이 기기의 알림 연결을 해제하지 못해 로그아웃을 중단했습니다. 연결을 확인하고 다시 시도해 주세요.',
    );
  forgetCurrentDevice();
}
