import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationSettingsContent } from './notifications-page';
import type { NotificationSettings } from '../types';

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  test: vi.fn(),
  support: vi.fn(),
  registration: vi.fn(),
  device: vi.fn(),
  store: vi.fn(),
}));
vi.mock('../lib/api', async (original) => ({
  ...(await original<typeof import('../lib/api')>()),
  api: {
    updateNotificationSettings: mocks.settings,
    subscribeNotifications: mocks.subscribe,
    unsubscribeNotifications: mocks.unsubscribe,
    testNotification: mocks.test,
  },
}));
vi.mock('../lib/web-push', async (original) => ({
  ...(await original<typeof import('../lib/web-push')>()),
  browserPushSupport: mocks.support,
  pushWorkerRegistration: mocks.registration,
  currentDeviceId: mocks.device,
  storeCurrentDevice: mocks.store,
  defaultDeviceName: () => 'Test phone',
}));
const settings: NotificationSettings = {
  enabled: false,
  topics: ['FILINGS', 'ANALYSIS', 'CORRECTIONS', 'NEWS'],
  watchlistOnly: true,
  pushConfigured: true,
  publicKey: 'AQID',
  subscriptions: [],
};
const support = {
  supported: true,
  needsInstall: false,
  ios: false,
  android: true,
  secure: true,
  permission: 'default',
};
const browserSubscription = {
  endpoint: 'https://fcm.googleapis.com/test',
  expirationTime: null,
  toJSON: () => ({ keys: { p256dh: 'public-browser-key', auth: 'browser-auth' } }),
  unsubscribe: vi.fn(async () => true),
};
const manager = {
  getSubscription: vi.fn(async () => null as typeof browserSubscription | null),
  subscribe: vi.fn(async () => browserSubscription),
};
let requestPermission: ReturnType<typeof vi.fn>;
function show(value = settings, isAdmin = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <NotificationSettingsContent settings={value} userId="user-1" isAdmin={isAdmin} />
    </QueryClientProvider>,
  );
  return client;
}
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.support.mockReturnValue(support);
  mocks.device.mockReturnValue(null);
  manager.getSubscription.mockResolvedValue(null);
  mocks.registration.mockResolvedValue({ pushManager: manager });
  mocks.subscribe.mockResolvedValue({ id: 'subscription-1' });
  mocks.settings.mockImplementation(async (value) => ({ ...settings, ...value }));
  requestPermission = vi.fn(async () => 'granted');
  vi.stubGlobal('Notification', { permission: 'default', requestPermission });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('personal browser notifications', () => {
  it('requests permission only after the explicit device button and registers one subscription', async () => {
    const client = show();
    await waitFor(() => expect(screen.getByRole('button', { name: '이 기기 연결' })).toBeEnabled());
    expect(requestPermission).not.toHaveBeenCalled();
    expect(mocks.subscribe).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '이 기기 연결' }));
    expect(requestPermission).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(mocks.subscribe).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: 'https://fcm.googleapis.com/test',
          deviceName: 'Test phone',
        }),
      ),
    );
    expect(manager.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true }),
    );
    expect(mocks.store).toHaveBeenCalledWith('user-1', 'subscription-1');
    client.clear();
  });
  it('keeps operations hidden for members and persists the selected topics', async () => {
    const client = show();
    expect(screen.queryByLabelText('운영 상태')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: '알림 받기' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '기업 뉴스' }));
    fireEvent.click(screen.getByRole('button', { name: '알림 설정 저장' }));
    await waitFor(() =>
      expect(mocks.settings).toHaveBeenCalledWith({
        enabled: true,
        topics: ['FILINGS', 'ANALYSIS', 'CORRECTIONS'],
        watchlistOnly: true,
      }),
    );
    expect(await screen.findByText('알림 설정을 저장했습니다.')).toBeInTheDocument();
    client.clear();
  });
  it('shows iOS installation steps without requesting permission in a normal browser tab', async () => {
    mocks.support.mockReturnValue({
      ...support,
      supported: false,
      ios: true,
      android: false,
      needsInstall: true,
    });
    const client = show();
    expect(screen.getByText('iPhone·iPad에서 시작하기')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '이 기기 연결' })).toBeDisabled();
    expect(requestPermission).not.toHaveBeenCalled();
    client.clear();
  });
  it('does not request a blocked permission and leaves settings editable without a configured push server', async () => {
    mocks.support.mockReturnValue({ ...support, permission: 'denied' });
    const client = show({ ...settings, pushConfigured: false, publicKey: null });
    expect(await screen.findByRole('button', { name: '이 기기 연결' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '알림 설정 저장' })).toBeEnabled();
    expect(requestPermission).not.toHaveBeenCalled();
    client.clear();
  });
  it('sends tests through the server and clearly labels fixture simulation', async () => {
    mocks.support.mockReturnValue({ ...support, permission: 'granted' });
    mocks.device.mockReturnValue('subscription-1');
    manager.getSubscription.mockResolvedValue(browserSubscription);
    mocks.test.mockResolvedValue({ queued: true, simulated: true });
    const client = show({
      ...settings,
      enabled: true,
      subscriptions: [
        {
          id: 'subscription-1',
          deviceName: 'Test phone',
          createdAt: '2026-09-04T00:00:00Z',
          lastSeenAt: '2026-09-04T00:00:00Z',
        },
      ],
    });
    fireEvent.click(await screen.findByRole('button', { name: '테스트 알림 보내기' }));
    await waitFor(() =>
      expect(mocks.test).toHaveBeenCalledWith('subscription-1', expect.anything()),
    );
    expect(await screen.findByText(/실제 푸시는 발송하지 않았습니다/)).toBeInTheDocument();
    client.clear();
  });
});
