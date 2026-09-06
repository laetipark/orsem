import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  BellOff,
  Check,
  ExternalLink,
  FileCheck2,
  FileText,
  MonitorSmartphone,
  Newspaper,
  RefreshCw,
  Settings2,
  ShieldAlert,
  Smartphone,
  Trash2,
} from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import {
  disclosureLabels,
  filingTypes,
  defaultNotificationFilingTypes,
} from '../lib/domain-labels';
import { formatKst } from '../lib/format';
import {
  applicationServerKey,
  browserPushSupport,
  currentDeviceId,
  defaultDeviceName,
  forgetCurrentDevice,
  pushWorkerRegistration,
  storeCurrentDevice,
  subscriptionInput,
} from '../lib/web-push';
import type {
  NotificationPreferences,
  NotificationSettings,
  NotificationTopic,
  Session,
} from '../types';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  ErrorState,
  Input,
  LoadingState,
} from '../components/ui';
import './notifications-page.css';

const topicOptions = [
  {
    id: 'FILINGS',
    label: '새 공시',
    description: '새로 접수된 공식 공시를 확인합니다.',
    icon: FileText,
  },
  {
    id: 'ANALYSIS',
    label: '분석 완료',
    description: '공시의 분류와 분석 결과가 준비되면 받습니다.',
    icon: FileCheck2,
  },
  {
    id: 'CORRECTIONS',
    label: '정정·철회',
    description: '기존 공시가 정정되거나 철회되면 받습니다.',
    icon: RefreshCw,
  },
  {
    id: 'NEWS',
    label: '기업 뉴스',
    description: '수집한 기업 뉴스와 공식 소식을 받습니다.',
    icon: Newspaper,
  },
  {
    id: 'OPERATIONS',
    label: '운영 상태',
    description: '수집 실패와 운영 점검 알림을 받습니다.',
    icon: ShieldAlert,
  },
] as const;

export function NotificationsPage() {
  const session = useOutletContext<Session>();
  const settings = useQuery({
    queryKey: ['notification-settings'],
    queryFn: api.notificationSettings,
  });
  if (settings.isPending) return <LoadingState label="내 알림 설정을 불러오는 중입니다." />;
  if (settings.isError)
    return <ErrorState message={settings.error.message} onRetry={() => void settings.refetch()} />;
  return (
    <NotificationSettingsContent
      settings={settings.data}
      userId={session.user!.id}
      isAdmin={session.user?.role === 'ADMIN'}
    />
  );
}

export function NotificationSettingsContent({
  settings,
  userId,
  isAdmin,
}: {
  settings: NotificationSettings;
  userId: string;
  isAdmin: boolean;
}) {
  const queryClient = useQueryClient();
  const [support, setSupport] = useState(browserPushSupport);
  const [deviceName, setDeviceName] = useState(defaultDeviceName);
  const [deviceId, setDeviceId] = useState(() => currentDeviceId(userId));
  const [browserSubscribed, setBrowserSubscribed] = useState(false);
  const [checkingDevice, setCheckingDevice] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [draft, setDraft] = useState<NotificationPreferences>(() => ({
    enabled: settings.enabled,
    watchlistOnly: settings.watchlistOnly,
    filingTypes: settings.filingTypes ?? [...defaultNotificationFilingTypes],
    topics: settings.topics.filter((topic) => isAdmin || topic !== 'OPERATIONS'),
  }));
  const connected =
    browserSubscribed &&
    support.permission === 'granted' &&
    settings.subscriptions.some((device) => device.id === deviceId);
  const allowedTopics = topicOptions.filter((topic) => isAdmin || topic.id !== 'OPERATIONS');

  useEffect(() => {
    let cancelled = false;
    async function inspect() {
      const next = browserPushSupport();
      setSupport(next);
      if (!next.supported || next.needsInstall) {
        setCheckingDevice(false);
        return;
      }
      try {
        const registration = await pushWorkerRegistration();
        const subscription = await registration.pushManager.getSubscription();
        if (!cancelled) setBrowserSubscribed(Boolean(subscription));
      } catch {
        if (!cancelled)
          setConnectionError('이 브라우저의 알림 연결을 확인하지 못했습니다. 다시 연결해 주세요.');
      } finally {
        if (!cancelled) setCheckingDevice(false);
      }
    }
    void inspect();
    const onFocus = () => void inspect();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  const save = useMutation({
    mutationFn: () => api.updateNotificationSettings(draft),
    onSuccess: (next) => {
      queryClient.setQueryData(['notification-settings'], next);
      setMessage('알림 설정을 저장했습니다.');
    },
  });
  const disconnect = useMutation({
    mutationFn: async (id: string) => {
      await api.unsubscribeNotifications(id);
      if (id === deviceId) {
        try {
          const registration =
            'serviceWorker' in navigator
              ? await navigator.serviceWorker.getRegistration('/')
              : undefined;
          await (await registration?.pushManager.getSubscription())?.unsubscribe();
        } catch {
          // The confirmed server deletion already prevents delivery to this device.
        } finally {
          forgetCurrentDevice();
          setDeviceId(null);
          setBrowserSubscribed(false);
        }
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['notification-settings'] });
      setMessage('이 기기의 알림 연결을 해제했습니다.');
    },
  });
  const test = useMutation({
    mutationFn: api.testNotification,
    onSuccess: (result) =>
      setMessage(
        result.simulated
          ? '개발용 테스트 요청을 확인했습니다. 실제 푸시는 발송하지 않았습니다.'
          : '테스트 알림을 요청했습니다. 잠시 후 선택한 기기에서 확인해 주세요.',
      ),
  });

  // Permission is requested synchronously from this explicit button gesture, before any await.
  function connectDevice() {
    if (
      !support.supported ||
      support.needsInstall ||
      !settings.pushConfigured ||
      !settings.publicKey ||
      connecting
    )
      return;
    setConnectionError(null);
    setMessage(null);
    setConnecting(true);
    let permissionRequest: Promise<NotificationPermission>;
    try {
      permissionRequest =
        Notification.permission === 'granted'
          ? Promise.resolve<NotificationPermission>('granted')
          : Notification.requestPermission();
    } catch {
      setConnecting(false);
      setConnectionError(
        '알림 권한을 요청하지 못했습니다. 브라우저의 사이트 설정을 확인해 주세요.',
      );
      return;
    }
    void (async () => {
      let created: PushSubscription | null = null;
      try {
        const permission = await permissionRequest;
        setSupport(browserPushSupport());
        if (permission !== 'granted') {
          setMessage(
            '알림 권한이 허용되지 않았습니다. 브라우저의 사이트 설정에서 변경할 수 있습니다.',
          );
          return;
        }
        const registration = await pushWorkerRegistration();
        let subscription = await registration.pushManager.getSubscription();
        if (!subscription) {
          subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: applicationServerKey(settings.publicKey!),
          });
          created = subscription;
        }
        const result = await api.subscribeNotifications(
          subscriptionInput(subscription, deviceName || defaultDeviceName()),
        );
        storeCurrentDevice(userId, result.id);
        setDeviceId(result.id);
        setBrowserSubscribed(true);
        await queryClient.invalidateQueries({ queryKey: ['notification-settings'] });
        setMessage(
          settings.enabled
            ? '이 기기를 연결했습니다. 저장한 종류의 알림을 받습니다.'
            : '이 기기를 연결했습니다. 아래에서 알림 받기를 켜고 저장해 주세요.',
        );
      } catch (error) {
        if (created) await created.unsubscribe().catch(() => false);
        setConnectionError(
          error instanceof ApiError && error.statusCode === 409
            ? '다른 계정에 연결된 브라우저입니다. 해당 계정에서 기기 연결을 해제하거나 브라우저의 사이트 알림 권한을 초기화한 뒤 다시 연결해 주세요.'
            : error instanceof Error
              ? error.message
              : '기기를 연결하지 못했습니다. 다시 시도해 주세요.',
        );
      } finally {
        setConnecting(false);
        setSupport(browserPushSupport());
      }
    })();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    save.mutate();
  }
  function toggleTopic(topic: NotificationTopic) {
    setDraft((current) => ({
      ...current,
      topics: current.topics.includes(topic)
        ? current.topics.filter((item) => item !== topic)
        : [...current.topics, topic],
    }));
  }
  const permissionLabel = support.needsInstall
    ? '홈 화면 설치 필요'
    : !support.supported
      ? '지원 확인 필요'
      : support.permission === 'denied'
        ? '권한 차단됨'
        : connected
          ? '기기 연결됨'
          : support.permission === 'granted'
            ? '연결 가능'
            : '허용 전';

  return (
    <div className="page-stack notifications-page">
      <div className="page-lead">
        <p>
          원하는 소식만 골라 이 기기로 받으세요. 알림을 누르면 해당 공시나 기업 화면으로 이동합니다.
        </p>
      </div>
      {message ? (
        <div className="notification-feedback" role="status">
          <Check size={17} />
          <span>{message}</span>
        </div>
      ) : null}
      {connectionError || save.isError || disconnect.isError || test.isError ? (
        <p className="form-error" role="alert">
          {connectionError ??
            save.error?.message ??
            disconnect.error?.message ??
            test.error?.message}
        </p>
      ) : null}
      <div className="notification-layout">
        <Card className="notification-device-card">
          <CardHeader>
            <div>
              <span className="section-kicker">THIS DEVICE</span>
              <h2>
                <Smartphone size={18} /> 이 기기 알림
              </h2>
            </div>
            <Badge
              tone={connected ? 'teal' : support.permission === 'denied' ? 'orange' : 'neutral'}
            >
              {permissionLabel}
            </Badge>
          </CardHeader>
          <CardContent>
            <div className={`notification-device-emblem ${connected ? 'is-connected' : ''}`}>
              {connected ? <Bell size={27} /> : <BellOff size={27} />}
            </div>
            <h3>{connected ? '연결된 기기입니다' : '알림을 받을 기기를 연결하세요'}</h3>
            <p>
              {connected
                ? settings.enabled
                  ? '선택한 알림을 이 브라우저에서 받습니다.'
                  : '기기는 연결되어 있고, 알림 받기는 꺼져 있습니다.'
                : '버튼을 누르면 브라우저에서 알림 권한을 요청합니다.'}
            </p>
            {!settings.pushConfigured ? (
              <div className="notification-hint">
                푸시 알림 서비스가 준비 중입니다. 알림 종류는 먼저 저장할 수 있습니다.
              </div>
            ) : null}
            {support.needsInstall ? (
              <div className="notification-install-guide">
                <strong>iPhone·iPad에서 시작하기</strong>
                <ol>
                  <li>iOS·iPadOS 16.4 이상으로 업데이트합니다.</li>
                  <li>
                    브라우저 공유 메뉴에서 <b>홈 화면에 추가</b>를 선택합니다.
                  </li>
                  <li>홈 화면의 ORSEM을 열고 이 화면에서 기기를 연결합니다.</li>
                </ol>
              </div>
            ) : !support.supported ? (
              <div className="notification-hint">
                {!support.secure
                  ? '보안 연결(HTTPS)에서 알림을 사용할 수 있습니다.'
                  : '현재 브라우저에서는 웹 푸시를 사용할 수 없습니다. Android는 최신 Chrome·Edge·Firefox 등 지원 브라우저에서 열어 주세요.'}
              </div>
            ) : support.permission === 'denied' ? (
              <div className="notification-hint">
                브라우저 또는 기기 설정에서 ORSEM의 알림 권한을 허용한 뒤 이 화면으로 돌아와 주세요.
              </div>
            ) : null}
            {!connected ? (
              <>
                <label className="notification-device-name">
                  기기 이름
                  <Input
                    value={deviceName}
                    maxLength={80}
                    onChange={(event) => setDeviceName(event.target.value)}
                    aria-label="알림 기기 이름"
                  />
                </label>
                <Button
                  onClick={connectDevice}
                  disabled={
                    checkingDevice ||
                    connecting ||
                    !support.supported ||
                    support.needsInstall ||
                    support.permission === 'denied' ||
                    !settings.pushConfigured ||
                    !settings.publicKey
                  }
                >
                  <Bell size={16} />
                  {connecting ? '연결 중…' : checkingDevice ? '기기 확인 중…' : '이 기기 연결'}
                </Button>
              </>
            ) : (
              <Button
                variant="secondary"
                onClick={() => deviceId && test.mutate(deviceId)}
                disabled={test.isPending || !settings.enabled || !settings.pushConfigured}
              >
                <Bell size={16} />
                {test.isPending ? '요청 중…' : '테스트 알림 보내기'}
              </Button>
            )}
            <p className="notification-device-note">
              {connected && !settings.enabled
                ? '알림 받기를 켜고 저장하면 테스트 알림도 보낼 수 있습니다.'
                : '브라우저를 닫아도 알림을 받을 수 있습니다. 기기 절전·집중 모드에 따라 전달이 늦어질 수 있습니다.'}
            </p>
            <a
              className="notification-guide-link"
              href="https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/"
              target="_blank"
              rel="noopener noreferrer"
            >
              iPhone 웹 알림 안내 <ExternalLink size={12} />
            </a>
          </CardContent>
        </Card>
        <Card className="notification-preferences">
          <CardHeader>
            <div>
              <span className="section-kicker">PREFERENCES</span>
              <h2>
                <Settings2 size={18} /> 내 알림 종류
              </h2>
            </div>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit}>
              <label className="notification-master-toggle">
                <span>
                  <strong>알림 받기</strong>
                  <small>연결된 내 기기 전체에 적용됩니다.</small>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={draft.enabled}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, enabled: event.target.checked }))
                  }
                  aria-label="알림 받기"
                />
              </label>
              <div className="notification-topic-list">
                {allowedTopics.map(({ id, label, description, icon: Icon }) => (
                  <label
                    key={id}
                    className={`notification-topic ${draft.topics.includes(id) ? 'is-selected' : ''}`}
                  >
                    <span className="notification-topic__icon">
                      <Icon size={18} />
                    </span>
                    <span>
                      <strong>{label}</strong>
                      <small>{description}</small>
                    </span>
                    <input
                      type="checkbox"
                      checked={draft.topics.includes(id)}
                      onChange={() => toggleTopic(id)}
                      aria-label={label}
                    />
                  </label>
                ))}
              </div>
              {!draft.topics.length ? (
                <p className="notification-device-note">
                  알림 종류를 하나 이상 선택해야 해당 소식을 받을 수 있습니다.
                </p>
              ) : null}
              <fieldset className="notification-filing-types">
                <legend>받을 공시 유형</legend>
                <p>
                  공시·분석·정정 알림에 적용합니다. 모두 해제하면 공시 알림을 받지 않으며 뉴스
                  설정은 유지됩니다.
                </p>
                <div className="notification-topics">
                  {filingTypes.map((type) => (
                    <label key={type}>
                      <input
                        type="checkbox"
                        checked={draft.filingTypes?.includes(type) ?? false}
                        onChange={() =>
                          setDraft((current) => ({
                            ...current,
                            filingTypes: current.filingTypes?.includes(type)
                              ? current.filingTypes.filter((item) => item !== type)
                              : [...(current.filingTypes ?? []), type],
                          }))
                        }
                      />
                      <span>{disclosureLabels[type]}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className="notification-watchlist">
                <input
                  type="checkbox"
                  checked={draft.watchlistOnly}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, watchlistOnly: event.target.checked }))
                  }
                />
                <span>
                  <strong>국내·미국 시총 상위 20종목 소식만 받기</strong>
                  <small>
                    국내·미국 월간 시총 상위 20종목과 연결된 공시·분석·뉴스만 받습니다.
                    {isAdmin ? ' 운영 알림에는 적용되지 않습니다.' : ''}
                  </small>
                </span>
              </label>
              <Button type="submit" disabled={save.isPending}>
                <Check size={16} />
                {save.isPending ? '저장 중…' : '알림 설정 저장'}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <div>
            <span className="section-kicker">CONNECTED DEVICES</span>
            <h2>
              <MonitorSmartphone size={18} /> 연결된 내 기기
            </h2>
          </div>
          <Badge>{settings.subscriptions.length}</Badge>
        </CardHeader>
        <CardContent>
          {settings.subscriptions.length ? (
            <ul className="notification-devices">
              {settings.subscriptions.map((device) => (
                <li key={device.id}>
                  <Smartphone size={20} />
                  <div>
                    <strong>
                      {device.deviceName}
                      {connected && device.id === deviceId ? (
                        <Badge tone="teal">현재 기기</Badge>
                      ) : null}
                    </strong>
                    <small>
                      연결 {formatKst(device.createdAt)} · 최근 확인 {formatKst(device.lastSeenAt)}
                    </small>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => disconnect.mutate(device.id)}
                    disabled={disconnect.isPending}
                    aria-label={`${device.deviceName} 알림 연결 해제`}
                  >
                    <Trash2 size={15} /> 연결 해제
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="notification-empty">
              아직 연결된 기기가 없습니다. 기기마다 한 번씩 알림을 허용해 주세요.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
