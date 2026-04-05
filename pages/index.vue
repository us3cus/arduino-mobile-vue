<script setup lang="ts">
type HttpMethod = 'GET' | 'POST';
type RequestStatus = 'success' | 'error';

interface RequestLogEntry {
  id: number;
  label: string;
  method: HttpMethod;
  endpoint: string;
  status: RequestStatus;
  payload?: Record<string, unknown>;
  response?: unknown;
  errorMessage?: string;
  timestamp: string;
}

interface RequestAction {
  key: string;
  label: string;
  method: HttpMethod;
  endpoint: string;
  payload?: Record<string, unknown>;
  silent?: boolean;
  logErrors?: boolean;
  onSuccess?: (response: unknown) => void;
}

interface NormalizedError {
  statusCode: number | null;
  message: string;
  data: unknown;
}

const runtimeConfig = useRuntimeConfig();
const backendBase = computed(() => {
  const source = String(
    runtimeConfig.public.backendBase || 'https://api.temten.me',
  ).trim();

  if (
    import.meta.client &&
    window.location.protocol === 'https:' &&
    source.startsWith('http://')
  ) {
    return source.replace(/^http:\/\//, 'https://').replace(/\/$/, '');
  }

  return source.replace(/\/$/, '');
});

const logs = ref<RequestLogEntry[]>([]);
const pending = reactive<Record<string, boolean>>({});
const runFlowPending = ref(false);
const isRefreshing = ref(false);
const statusMessage = ref('Подключение к контроллеру...');

const healthOnline = ref(false);
const relayState = ref<0 | 1>(0);
const lastSeen = ref('Нет данных');
const dht = reactive({
  temperatureC: null as number | null,
  humidity: null as number | null,
});

const lcdForm = reactive({
  line1: 'Добро пожаловать',
  line2: 'Система активна',
});

const telemetryForm = reactive({
  device_id: 'esp32-home-01',
  relay: 0,
  sensor_mock: 123,
  temperature_c: 24.5,
  humidity: 51,
});

let refreshTimer: ReturnType<typeof setInterval> | null = null;

const failedRequests = computed(
  () => logs.value.filter((entry) => entry.status === 'error').length,
);
const successfulRequests = computed(
  () => logs.value.filter((entry) => entry.status === 'success').length,
);

const relayIsOn = computed(() => relayState.value === 1);
const relayLabel = computed(() =>
  relayIsOn.value ? 'Свет в доме включен' : 'Свет в доме выключен',
);
const relayButtonLabel = computed(() =>
  relayIsOn.value ? 'Выключить освещение' : 'Включить освещение',
);
const connectionTone = computed(() => (healthOnline.value ? 'online' : 'offline'));
const latestLog = computed(() => logs.value[0] ?? null);

function toRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null) {
    return value as Record<string, unknown>;
  }

  return null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  return null;
}

function toStringSafe(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  return '';
}

function endpoint(path: string): string {
  return `${backendBase.value}${path}`;
}

function formatJson(value: unknown): string {
  if (value === undefined) {
    return 'No body';
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function pushLog(entry: Omit<RequestLogEntry, 'id' | 'timestamp'>) {
  logs.value.unshift({
    id: Date.now() + Math.floor(Math.random() * 1000),
    timestamp: new Date().toLocaleString(),
    ...entry,
  });
}

function normalizeError(error: unknown): NormalizedError {
  const candidate = error as {
    statusCode?: number;
    statusMessage?: string;
    message?: string;
    data?: unknown;
  };

  return {
    statusCode: candidate.statusCode ?? null,
    message:
      candidate.statusMessage ??
      candidate.message ??
      'Запрос завершился с неизвестной ошибкой',
    data: candidate.data ?? null,
  };
}

function applyRootStatus(response: unknown) {
  const payload = toRecord(response);

  if (!payload) {
    return;
  }

  const relay = toFiniteNumber(payload.relayState);
  if (relay === 0 || relay === 1) {
    relayState.value = relay;
    telemetryForm.relay = relay;
  }

  const seen = toStringSafe(payload.lastSeen);
  if (seen) {
    lastSeen.value = seen;
  }
}

function applyHealth(response: unknown) {
  const payload = toRecord(response);
  const status = payload ? toStringSafe(payload.status) : '';

  healthOnline.value = status.toLowerCase() === 'ok';
}

function applyDeviceCommand(response: unknown) {
  const payload = toRecord(response);

  if (!payload) {
    return;
  }

  const relay = toFiniteNumber(payload.relay);
  if (relay === 0 || relay === 1) {
    relayState.value = relay;
    telemetryForm.relay = relay;
  }

  const line1 = toStringSafe(payload.lcd_line1);
  const line2 = toStringSafe(payload.lcd_line2);

  lcdForm.line1 = line1;
  lcdForm.line2 = line2;
}

function applyDht(response: unknown) {
  const payload = toRecord(response);

  if (!payload) {
    return;
  }

  dht.temperatureC = toFiniteNumber(payload.temperature_c);
  dht.humidity = toFiniteNumber(payload.humidity);

  const seen = toStringSafe(payload.timestamp);
  if (seen) {
    lastSeen.value = seen;
  }
}

async function runAction(action: RequestAction) {
  pending[action.key] = true;

  try {
    const response = await $fetch<unknown>(endpoint(action.endpoint), {
      method: action.method,
      body: action.payload,
    });

    action.onSuccess?.(response);

    if (!action.silent) {
      pushLog({
        label: action.label,
        method: action.method,
        endpoint: action.endpoint,
        status: 'success',
        payload: action.payload,
        response,
      });
    }

    return response;
  } catch (error) {
    const normalized = normalizeError(error);

    if (!action.silent || action.logErrors !== false) {
      pushLog({
        label: action.label,
        method: action.method,
        endpoint: action.endpoint,
        status: 'error',
        payload: action.payload,
        response: normalized.data,
        errorMessage:
          normalized.statusCode === null
            ? normalized.message
            : `${normalized.statusCode} ${normalized.message}`,
      });
    }

    throw error;
  } finally {
    pending[action.key] = false;
  }
}

async function requestRootStatus(options: { silent?: boolean } = {}) {
  return runAction({
    key: 'root-status',
    label: 'Root status',
    method: 'GET',
    endpoint: '/',
    silent: options.silent,
    logErrors: !options.silent,
    onSuccess: applyRootStatus,
  });
}

async function requestHealth(options: { silent?: boolean } = {}) {
  return runAction({
    key: 'health',
    label: 'Health',
    method: 'GET',
    endpoint: '/health',
    silent: options.silent,
    logErrors: !options.silent,
    onSuccess: applyHealth,
  });
}

async function requestDeviceCommand(options: { silent?: boolean } = {}) {
  return runAction({
    key: 'device-command',
    label: 'Device command',
    method: 'GET',
    endpoint: '/api/device/command',
    silent: options.silent,
    logErrors: !options.silent,
    onSuccess: applyDeviceCommand,
  });
}

async function requestDht(options: { silent?: boolean } = {}) {
  return runAction({
    key: 'device-dht',
    label: 'Get latest DHT values',
    method: 'GET',
    endpoint: '/api/device/dht',
    silent: options.silent,
    logErrors: !options.silent,
    onSuccess: applyDht,
  });
}

async function requestSetLcd() {
  return runAction({
    key: 'set-lcd',
    label: 'Set LCD text',
    method: 'POST',
    endpoint: '/api/lcd',
    payload: {
      line1: lcdForm.line1,
      line2: lcdForm.line2,
    },
  });
}

async function requestClearLcd() {
  const action = runAction({
    key: 'clear-lcd',
    label: 'Clear LCD text',
    method: 'POST',
    endpoint: '/api/lcd',
    payload: {
      line1: '',
      line2: '',
    },
  });

  lcdForm.line1 = '';
  lcdForm.line2 = '';

  return action;
}

async function requestRelayOn() {
  return runAction({
    key: 'relay-on',
    label: 'Set relay ON',
    method: 'POST',
    endpoint: '/api/relay',
    payload: {
      relay: 1,
    },
    onSuccess: () => {
      relayState.value = 1;
      telemetryForm.relay = 1;
    },
  });
}

async function requestRelayOff() {
  return runAction({
    key: 'relay-off',
    label: 'Set relay OFF',
    method: 'POST',
    endpoint: '/api/relay',
    payload: {
      relay: 0,
    },
    onSuccess: () => {
      relayState.value = 0;
      telemetryForm.relay = 0;
    },
  });
}

async function requestRelayInvalid() {
  return runAction({
    key: 'relay-invalid',
    label: 'Invalid relay (validation test)',
    method: 'POST',
    endpoint: '/api/relay',
    payload: {
      relay: 2,
    },
  });
}

async function requestTelemetry() {
  return runAction({
    key: 'telemetry',
    label: 'Send telemetry',
    method: 'POST',
    endpoint: '/api/device/telemetry',
    payload: {
      device_id: telemetryForm.device_id.trim() || 'esp32-home-01',
      relay: telemetryForm.relay,
      sensor_mock: telemetryForm.sensor_mock,
      temperature_c: telemetryForm.temperature_c,
      humidity: telemetryForm.humidity,
    },
  });
}

async function requestRootAfterTelemetry() {
  return runAction({
    key: 'root-after-telemetry',
    label: 'Root status after telemetry',
    method: 'GET',
    endpoint: '/',
    onSuccess: applyRootStatus,
  });
}

async function refreshSnapshot() {
  if (isRefreshing.value) {
    return;
  }

  isRefreshing.value = true;
  statusMessage.value = 'Обновляем состояние дома...';

  const healthResult = await requestHealth({ silent: true }).then(
    () => true,
    () => false,
  );

  await Promise.allSettled([
    requestRootStatus({ silent: true }),
    requestDeviceCommand({ silent: true }),
    requestDht({ silent: true }),
  ]);

  healthOnline.value = healthResult;
  statusMessage.value = healthOnline.value
    ? 'Все работает стабильно'
    : 'Нет связи. Проверьте питание и сеть';

  isRefreshing.value = false;
}

async function toggleRelay() {
  if (relayIsOn.value) {
    await requestRelayOff();
  } else {
    await requestRelayOn();
  }
}

async function runSceneHome() {
  lcdForm.line1 = 'Добро пожаловать';
  lcdForm.line2 = 'Режим дом';
  await requestRelayOn();
  await requestSetLcd();
  await refreshSnapshot();
}

async function runSceneNight() {
  lcdForm.line1 = 'Ночной режим';
  lcdForm.line2 = 'Тихий дом';
  await requestRelayOff();
  await requestSetLcd();
  await refreshSnapshot();
}

async function sendQuickTelemetry() {
  telemetryForm.relay = relayState.value;
  await requestTelemetry();
  await requestRootAfterTelemetry();
  await requestDht({ silent: true });
}

async function runAllRequestsFlow() {
  if (runFlowPending.value) {
    return;
  }

  runFlowPending.value = true;

  try {
    await requestRootStatus();
    await requestHealth();
    await requestDeviceCommand();
    await requestSetLcd();
    await requestClearLcd();
    await requestRelayOn();
    await requestRelayOff();
    await requestRelayInvalid();
    await requestTelemetry();
    await requestRootAfterTelemetry();
    await requestDht();
  } finally {
    runFlowPending.value = false;
  }
}

function clearLogs() {
  logs.value = [];
}

onMounted(async () => {
  await refreshSnapshot();

  refreshTimer = setInterval(() => {
    refreshSnapshot().catch(() => {
      healthOnline.value = false;
      statusMessage.value = 'Потеряна связь с контроллером';
    });
  }, 15000);
});

onBeforeUnmount(() => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
});
</script>

<template>
  <main class="smart-page">
    <section class="hero card">
      <p class="eyebrow">Smart Home Dashboard</p>
      <h1>Умный дом Arduino</h1>
      <p class="subtitle">
        Простой экран управления: свет, климат и дисплей устройства в одном месте.
      </p>

      <div class="status-strip" :class="`is-${connectionTone}`">
        <strong>{{ healthOnline ? 'Онлайн' : 'Оффлайн' }}</strong>
        <span>{{ statusMessage }}</span>
      </div>

      <div class="chips">
        <span class="chip">Backend: {{ backendBase }}</span>
        <span class="chip">Успех: {{ successfulRequests }}</span>
        <span class="chip">Ошибки: {{ failedRequests }}</span>
      </div>

      <div class="hero-actions">
        <UButton
          class="action-btn"
          color="primary"
          size="lg"
          :loading="isRefreshing"
          @click="refreshSnapshot"
        >
          Обновить состояние
        </UButton>
      </div>
    </section>

    <section class="quick-grid">
      <article class="card quick-card relay-card">
        <h2>Освещение</h2>
        <p class="hint">Управление главным реле одним нажатием.</p>
        <p class="big-value">{{ relayLabel }}</p>
        <UButton
          class="action-btn"
          size="xl"
          :color="relayIsOn ? 'error' : 'primary'"
          :loading="pending['relay-on'] || pending['relay-off']"
          @click="toggleRelay"
        >
          {{ relayButtonLabel }}
        </UButton>
      </article>

      <article class="card quick-card climate-card">
        <h2>Климат</h2>
        <p class="hint">Температура и влажность с датчика DHT.</p>

        <div class="climate-grid">
          <div class="climate-box">
            <span>Температура</span>
            <strong>
              {{ dht.temperatureC === null ? '--' : `${dht.temperatureC} °C` }}
            </strong>
          </div>
          <div class="climate-box">
            <span>Влажность</span>
            <strong>{{ dht.humidity === null ? '--' : `${dht.humidity} %` }}</strong>
          </div>
        </div>

        <p class="meta">Последнее обновление: {{ lastSeen }}</p>

        <UButton
          class="action-btn"
          color="neutral"
          :loading="pending['device-dht']"
          @click="() => requestDht()"
        >
          Обновить климат
        </UButton>
      </article>

      <article class="card quick-card scene-card">
        <h2>Сценарии</h2>
        <p class="hint">Готовые действия как в приложениях умного дома.</p>

        <div class="button-stack">
          <UButton
            class="action-btn"
            color="primary"
            :loading="pending['relay-on'] || pending['set-lcd']"
            @click="runSceneHome"
          >
            Я дома
          </UButton>
          <UButton
            class="action-btn"
            color="neutral"
            :loading="pending['relay-off'] || pending['set-lcd']"
            @click="runSceneNight"
          >
            Ночной режим
          </UButton>
          <UButton
            class="action-btn"
            color="neutral"
            :loading="pending.telemetry"
            @click="sendQuickTelemetry"
          >
            Отправить телеметрию
          </UButton>
        </div>
      </article>

      <article class="card quick-card lcd-card">
        <h2>Экран устройства</h2>
        <p class="hint">Сообщение на LCD, которое увидит пользователь у устройства.</p>

        <div class="form-grid">
          <label class="field full">
            <span>Строка 1</span>
            <input v-model="lcdForm.line1" type="text" maxlength="32" />
          </label>
          <label class="field full">
            <span>Строка 2</span>
            <input v-model="lcdForm.line2" type="text" maxlength="32" />
          </label>
        </div>

        <div class="button-stack">
          <UButton
            class="action-btn"
            color="primary"
            :loading="pending['set-lcd']"
            @click="requestSetLcd"
          >
            Сохранить сообщение
          </UButton>
          <UButton
            class="action-btn"
            color="neutral"
            :loading="pending['clear-lcd']"
            @click="requestClearLcd"
          >
            Очистить экран
          </UButton>
        </div>
      </article>
    </section>

    <section class="card support-panel">
      <details>
        <summary>Расширенные инструменты поддержки</summary>
        <p class="hint">
          Полный набор запросов для диагностики и тестов из test-requests.http.
        </p>

        <div class="advanced-grid">
          <UButton class="action-btn" @click="() => requestRootStatus()">
            GET /
          </UButton>
          <UButton class="action-btn" color="neutral" @click="() => requestHealth()">
            GET /health
          </UButton>
          <UButton
            class="action-btn"
            color="neutral"
            @click="() => requestDeviceCommand()"
          >
            GET /api/device/command
          </UButton>
          <UButton class="action-btn" color="neutral" @click="() => requestDht()">
            GET /api/device/dht
          </UButton>
          <UButton class="action-btn" color="success" @click="requestRelayOn">
            POST /api/relay { relay: 1 }
          </UButton>
          <UButton class="action-btn" color="neutral" @click="requestRelayOff">
            POST /api/relay { relay: 0 }
          </UButton>
          <UButton class="action-btn" color="error" @click="requestRelayInvalid">
            POST /api/relay { relay: 2 }
          </UButton>
          <UButton class="action-btn" color="neutral" @click="requestSetLcd">
            POST /api/lcd (set)
          </UButton>
          <UButton class="action-btn" color="neutral" @click="requestClearLcd">
            POST /api/lcd (clear)
          </UButton>
          <UButton class="action-btn" color="neutral" @click="requestTelemetry">
            POST /api/device/telemetry
          </UButton>
          <UButton
            class="action-btn"
            color="neutral"
            @click="requestRootAfterTelemetry"
          >
            GET / after telemetry
          </UButton>
          <UButton
            class="action-btn"
            color="primary"
            :loading="runFlowPending"
            @click="runAllRequestsFlow"
          >
            Полный тестовый прогон
          </UButton>
        </div>
      </details>
    </section>

    <section class="card history-panel">
      <div class="history-head">
        <div>
          <h2>История действий</h2>
          <p class="hint">Последние ответы от контроллера.</p>
        </div>
        <UButton class="action-btn" color="neutral" variant="soft" @click="clearLogs">
          Очистить
        </UButton>
      </div>

      <div v-if="!latestLog" class="log-empty">Пока нет действий.</div>

      <div v-else class="log-list">
        <article
          v-for="entry in logs.slice(0, 8)"
          :key="entry.id"
          class="log-item"
          :class="`is-${entry.status}`"
        >
          <header class="log-item-head">
            <strong>{{ entry.label }}</strong>
            <span>{{ entry.timestamp }}</span>
          </header>

          <p class="log-meta">{{ entry.method }} {{ entry.endpoint }}</p>
          <p v-if="entry.errorMessage" class="log-error">{{ entry.errorMessage }}</p>

          <details>
            <summary>Показать ответ</summary>
            <pre>{{ formatJson(entry.response) }}</pre>
          </details>
        </article>
      </div>
    </section>
  </main>
</template>
