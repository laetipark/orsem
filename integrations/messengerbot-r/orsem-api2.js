/*
 * Orsem MessengerBotR bridge
 * Requires MessengerBotR 0.7.40+ and API2.
 * Rhino 호환성을 위해 의도적으로 ES5 문법을 사용합니다.
 */
var bot = BotManager.getCurrentBot();
var CONFIG_FILE = 'orsem-config.json';
var STATE_FILE = 'orsem-state.json';
var BOT_VERSION = '0.2.0';

function loadConfig() {
  if (!Database.exists(CONFIG_FILE)) {
    throw new Error('Database/' + CONFIG_FILE + ' 파일을 먼저 생성하세요.');
  }
  var value = Database.readObject(CONFIG_FILE);
  if (!value || !value.apiBaseUrl) throw new Error('apiBaseUrl 설정이 필요합니다.');
  value.apiBaseUrl = String(value.apiBaseUrl).replace(/\/$/, '');
  value.packageName = value.packageName || 'com.kakao.talk';
  value.pollIntervalMs = Math.max(15000, Number(value.pollIntervalMs || 15000));
  value.heartbeatIntervalMs = Math.max(60000, Number(value.heartbeatIntervalMs || 60000));
  value.requestTimeoutMs = Math.max(3000, Number(value.requestTimeoutMs || 10000));
  value.deliveryLedgerSize = Math.max(100, Number(value.deliveryLedgerSize || 500));
  return value;
}

function loadState() {
  if (!Database.exists(STATE_FILE)) {
    return {
      deviceId: String(Security.uuid()),
      deviceToken: null,
      boundRoom: null,
      boundAuthorHash: null,
      seenDeliveryIds: [],
    };
  }
  var value = Database.readObject(STATE_FILE) || {};
  value.deviceId = value.deviceId || String(Security.uuid());
  value.deviceToken = value.deviceToken || null;
  value.boundRoom = value.boundRoom || null;
  value.boundAuthorHash = value.boundAuthorHash || null;
  value.seenDeliveryIds = value.seenDeliveryIds || [];
  return value;
}

var config = loadConfig();
var state = loadState();
var pollRunning = false;
var lastHeartbeatAt = 0;

function saveState() {
  Database.writeObject(STATE_FILE, state);
}

function authorHash(message) {
  return message.author && message.author.hash ? String(message.author.hash) : '';
}

function isBoundAdmin(message) {
  return Boolean(
    state.deviceToken &&
    state.boundRoom === String(message.room) &&
    state.boundAuthorHash === authorHash(message),
  );
}

function runAsync(fn) {
  new java.lang.Thread(
    new java.lang.Runnable({
      run: function () {
        try {
          fn();
        } catch (error) {
          console.error('[orsem] background request failed: ' + safeError(error));
        }
      },
    }),
  ).start();
}

function requestJson(method, path, payload, token, callback) {
  runAsync(function () {
    var url = config.apiBaseUrl + path;
    var connection = org.jsoup.Jsoup.connect(url)
      .ignoreContentType(true)
      .ignoreHttpErrors(true)
      .timeout(config.requestTimeoutMs)
      .header('Accept', 'application/json')
      .header('User-Agent', 'Orsem-MessengerBotR/' + BOT_VERSION);

    if (token) connection.header('Authorization', 'Bearer ' + token);
    if (payload !== null && payload !== undefined) {
      connection.header('Content-Type', 'application/json; charset=UTF-8');
      connection.requestBody(JSON.stringify(payload));
    }
    connection.method(org.jsoup.Connection.Method.valueOf(method));
    var response = connection.execute();
    var status = Number(response.statusCode());
    var body = String(response.body() || '');
    if (status < 200 || status >= 300) {
      callback(new Error('HTTP ' + status), null);
      return;
    }
    if (!body) {
      callback(null, {});
      return;
    }
    try {
      callback(null, JSON.parse(body));
    } catch (error) {
      callback(new Error('서버 응답을 해석할 수 없습니다.'), null);
    }
  });
}

function safeError(error) {
  if (!error) return 'unknown';
  return String(error.message || error)
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .slice(0, 300);
}

function rememberDelivery(deliveryId) {
  state.seenDeliveryIds.push(String(deliveryId));
  if (state.seenDeliveryIds.length > config.deliveryLedgerSize) {
    state.seenDeliveryIds = state.seenDeliveryIds.slice(-config.deliveryLedgerSize);
  }
  saveState();
}

function hasSeen(deliveryId) {
  return state.seenDeliveryIds.indexOf(String(deliveryId)) !== -1;
}

function acknowledge(deliveryId, ok, errorMessage) {
  requestJson(
    'POST',
    '/outbox/' + encodeURIComponent(String(deliveryId)) + '/ack',
    { ok: Boolean(ok), error: errorMessage || null },
    state.deviceToken,
    function (error) {
      if (error) console.warn('[orsem] ack failed for ' + deliveryId + ': ' + safeError(error));
    },
  );
}

function deliver(item) {
  var deliveryId = String(item.deliveryId || '');
  if (!deliveryId || !item.content) return;
  if (hasSeen(deliveryId)) {
    acknowledge(deliveryId, true, null);
    return;
  }
  var sent = false;
  try {
    sent = bot.send(state.boundRoom, String(item.content), config.packageName);
  } catch (error) {
    acknowledge(deliveryId, false, safeError(error));
    return;
  }
  if (sent) {
    rememberDelivery(deliveryId);
    acknowledge(deliveryId, true, null);
  } else {
    acknowledge(deliveryId, false, 'bound room session is unavailable');
  }
}

function heartbeat() {
  requestJson(
    'POST',
    '/heartbeat',
    {
      deviceId: state.deviceId,
      botVersion: BOT_VERSION,
      room: state.boundRoom,
      observedAt: new Date().toISOString(),
    },
    state.deviceToken,
    function (error) {
      if (error) console.warn('[orsem] heartbeat failed: ' + safeError(error));
    },
  );
}

function pollOutbox() {
  if (!state.deviceToken || !state.boundRoom || pollRunning) return;
  pollRunning = true;
  requestJson(
    'POST',
    '/outbox/pull',
    { deviceId: state.deviceId, limit: 10, leaseSeconds: 60 },
    state.deviceToken,
    function (error, response) {
      pollRunning = false;
      if (error) {
        console.warn('[orsem] outbox pull failed: ' + safeError(error));
        return;
      }
      var items = response && response.items ? response.items : [];
      for (var index = 0; index < items.length; index += 1) deliver(items[index]);
    },
  );
  var now = Date.now();
  if (now - lastHeartbeatAt >= config.heartbeatIntervalMs) {
    lastHeartbeatAt = now;
    heartbeat();
  }
}

function pair(message, pairingCode) {
  requestJson(
    'POST',
    '/pair',
    {
      code: pairingCode,
      deviceId: state.deviceId,
      room: String(message.room),
      authorHash: authorHash(message),
      packageName: String(message.packageName || config.packageName),
      botVersion: BOT_VERSION,
    },
    null,
    function (error, response) {
      if (error || !response || !response.deviceToken) {
        message.reply('연결에 실패했습니다. 코드 만료 여부와 서버 상태를 확인해 주세요.');
        return;
      }
      state.deviceToken = String(response.deviceToken);
      state.boundRoom = String(message.room);
      state.boundAuthorHash = authorHash(message);
      state.seenDeliveryIds = [];
      saveState();
      message.reply('오르셈 알림 연결이 완료되었습니다. 이 방과 관리자 계정에만 응답합니다.');
    },
  );
}

function executeCommand(message, command, query) {
  requestJson(
    'POST',
    '/command',
    { deviceId: state.deviceId, command: command, query: query || null },
    state.deviceToken,
    function (error, response) {
      if (error || !response || !response.message) {
        message.reply('조회에 실패했습니다. 오르셈 운영 화면을 확인해 주세요.');
        return;
      }
      message.reply(String(response.message));
    },
  );
}

function parseCommand(content) {
  if (content === '/오르셈 상태') return { command: 'STATUS', query: null };
  if (content === '/오르셈 최근') return { command: 'RECENT', query: null };
  if (content.indexOf('/오르셈 종목 ') === 0) {
    var company = content.substring('/오르셈 종목 '.length).trim();
    return company ? { command: 'COMPANY', query: company } : null;
  }
  var matched = /^\/오르셈 (시장|뉴스)(?:\s+(국내|한국|미국|전체|kr|us|all))?$/i.exec(content);
  if (!matched) return null;
  var command = matched[1] === '시장' ? 'MARKET' : 'NEWS';
  var key = String(matched[2] || '').toLowerCase();
  var region =
    key === 'us' || key === '미국'
      ? 'us'
      : key === 'kr' || key === '국내' || key === '한국'
        ? 'kr'
        : key === 'all' || key === '전체'
          ? 'all'
          : command === 'MARKET'
            ? 'kr'
            : 'all';
  if (command === 'MARKET' && region === 'all') return null;
  return { command: command, query: region };
}

function onMessage(message) {
  var content = String(message.content || '').trim();
  if (content.indexOf('/오르셈 연결 ') === 0) {
    var code = content.substring('/오르셈 연결 '.length).trim();
    if (!/^\d{6}$/.test(code)) {
      message.reply('연결 코드는 6자리 숫자입니다.');
      return;
    }
    pair(message, code);
    return;
  }
  if (content.indexOf('/오르셈') !== 0) return;
  if (!isBoundAdmin(message)) {
    message.reply('연결된 관리자와 채팅방에서만 사용할 수 있습니다.');
    return;
  }
  var parsed = parseCommand(content);
  if (parsed) {
    executeCommand(message, parsed.command, parsed.query);
  } else {
    message.reply(
      '명령어: /오르셈 상태, /오르셈 최근, /오르셈 종목 <회사명|종목코드>, /오르셈 시장 <국내|미국>, /오르셈 뉴스 [국내|미국|전체]',
    );
  }
}

saveState();
bot.addListener(Event.MESSAGE, onMessage);
setInterval(pollOutbox, config.pollIntervalMs);
console.info(
  '[orsem] MessengerBotR bridge loaded; token=' + (state.deviceToken ? '[PRESENT]' : '[MISSING]'),
);
