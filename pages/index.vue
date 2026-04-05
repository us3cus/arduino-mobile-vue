<script setup lang="ts">
type HttpMethod = 'GET' | 'POST';
type RequestStatus = 'success' | 'error';
type ControlMode = 'manual' | 'auto';
type RelayChannel = 'light' | 'fan' | 'humidifier' | 'pump';
type RelayState = 0 | 1;

type RelayStates = Record<RelayChannel, RelayState>;

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

const relayOrder: RelayChannel[] = ['light', 'fan', 'humidifier', 'pump'];

const relayTitles: Record<RelayChannel, string> = {
  light: 'Свет',
  fan: 'Кулер',
  humidifier: 'Увлажнитель',
  pump: 'Насос полива',
};

const relayPins: Record<RelayChannel, number> = {
  light: 16,
  fan: 17,
  humidifier: 18,
  pump: 19,
};

const runtimeConfig = useRuntimeConfig();
const backendBase = computed(() => {
  const source = String(runtimeConfig.public.backendBase || '/backend').trim();

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
const isRefreshing = ref(false);
const statusMessage = ref('Подключение к growbox-контроллеру...');

const healthOnline = ref(false);
const controlMode = ref<ControlMode>('manual');
const lastSeenIso = ref<string | null>(null);
const lastPumpTriggeredIso = ref<string | null>(null);

const relays = reactive<RelayStates>({
  light: 0,
  fan: 0,
  humidifier: 0,
  pump: 0,
});

const dht = reactive({
  temperatureC: null as number | null,
  humidity: null as number | null,
});

const telemetryForm = reactive({
  device_id: 'esp32-growbox-01',
  temperature_c: 26,
  humidity: 60,
});

let refreshTimer: ReturnType<typeof setInterval> | null = null;

const failedRequests = computed(
  () => logs.value.filter((entry) => entry.status === 'error').length,
);
const successfulRequests = computed(
  () => logs.value.filter((entry) => entry.status === 'success').length,
);
const canManualControl = computed(() => controlMode.value === 'manual');
const connectionTone = computed(() => (healthOnline.value ? 'online' : 'offline'));

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

function parseRelayState(value: unknown): RelayState | null {
  if (value === 0 || value === 1) {
    return value;
  }

  return null;
}

function parseMode(value: unknown): ControlMode | null {
  if (value === 'manual' || value === 'auto') {
    return value;
  }

  return null;
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

function formatTimestamp(value: string | null): string {
  if (!value) {
    return 'Нет данных';
  }

  const asDate = new Date(value);
  if (Number.isNaN(asDate.getTime())) {
    return value;
  }

  return asDate.toLocaleString();
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

function applyRelays(payload: Record<string, unknown>) {
  const relayBag = toRecord(payload.relays);

  for (const channel of relayOrder) {
    const nested = relayBag ? parseRelayState(relayBag[channel]) : null;
    const flat = parseRelayState(payload[`relay_${channel}`]);
    const chosen = nested ?? flat;

    if (chosen !== null) {
      relays[channel] = chosen;
    }
  }

  const legacyLight =
    parseRelayState(payload.relay) ?? parseRelayState(payload.relayState);
  if (legacyLight !== null) {
    relays.light = legacyLight;
  }
}

function applyAutomation(payload: Record<string, unknown>) {
  const automation = toRecord(payload.automation);
  const pump = automation ? toRecord(automation.pump) : null;

  if (!pump) {
    return;
  }

  const lastTriggered = toStringSafe(pump.lastTriggeredAt);
  lastPumpTriggeredIso.value = lastTriggered || null;
}

function applyRootStatus(response: unknown) {
  const payload = toRecord(response);
  if (!payload) {
    return;
  }

  const mode = parseMode(payload.mode);
  if (mode) {
    controlMode.value = mode;
  }

  applyRelays(payload);
  applyAutomation(payload);

  const seen = toStringSafe(payload.lastSeen);
  if (seen) {
    lastSeenIso.value = seen;
  }
}

function applyModeStatus(response: unknown) {
  const payload = toRecord(response);
  if (!payload) {
    return;
  }

  const mode = parseMode(payload.mode);
  if (mode) {
    controlMode.value = mode;
  }

  applyRelays(payload);
  applyAutomation(payload);
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

  const mode = parseMode(payload.mode);
  if (mode) {
    controlMode.value = mode;
  }

  applyRelays(payload);
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
    lastSeenIso.value = seen;
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

async function requestMode(options: { silent?: boolean } = {}) {
  return runAction({
    key: 'mode-get',
    label: 'Read control mode',
    method: 'GET',
    endpoint: '/api/mode',
    silent: options.silent,
    logErrors: !options.silent,
    onSuccess: applyModeStatus,
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

async function requestSetMode(mode: ControlMode) {
  return runAction({
    key: `mode-${mode}`,
    label: `Set mode ${mode}`,
    method: 'POST',
    endpoint: '/api/mode',
    payload: { mode },
    onSuccess: applyModeStatus,
  });
}

async function requestSetRelay(channel: RelayChannel, state: RelayState) {
  return runAction({
    key: `relay-${channel}`,
    label: `Set ${channel} ${state === 1 ? 'ON' : 'OFF'}`,
    method: 'POST',
    endpoint: '/api/relay',
    payload: {
      channel,
      state,
    },
    onSuccess: (response) => {
      const payload = toRecord(response);
      if (!payload) {
        return;
      }

      applyRelays(payload);
    },
  });
}

async function requestTelemetry() {
  return runAction({
    key: 'telemetry',
    label: 'Send test telemetry',
    method: 'POST',
    endpoint: '/api/device/telemetry',
    payload: {
      device_id: telemetryForm.device_id.trim() || 'esp32-growbox-01',
      relay: relays.light,
      relay_light: relays.light,
      relay_fan: relays.fan,
      relay_humidifier: relays.humidifier,
      relay_pump: relays.pump,
      temperature_c: telemetryForm.temperature_c,
      humidity: telemetryForm.humidity,
    },
  });
}

async function refreshSnapshot() {
  if (isRefreshing.value) {
    return;
  }

  isRefreshing.value = true;
  statusMessage.value = 'Обновляем состояние growbox...';

  const healthResult = await requestHealth({ silent: true }).then(
    () => true,
    () => false,
  );

  await Promise.allSettled([
    requestRootStatus({ silent: true }),
    requestMode({ silent: true }),
    requestDeviceCommand({ silent: true }),
    requestDht({ silent: true }),
  ]);

  healthOnline.value = healthResult;
  statusMessage.value = healthOnline.value
    ? controlMode.value === 'auto'
      ? 'Автономный режим активен'
      : 'Ручной режим активен'
    : 'Нет связи. Проверьте питание и сеть';

  isRefreshing.value = false;
}

async function switchMode(mode: ControlMode) {
  await requestSetMode(mode);
  await refreshSnapshot();
}

async function toggleChannel(channel: RelayChannel) {
  if (!canManualControl.value) {
    return;
  }

  const nextState: RelayState = relays[channel] === 1 ? 0 : 1;
  await requestSetRelay(channel, nextState);
  await requestDeviceCommand({ silent: true });
}

async function sendTelemetryAndRefresh() {
  await requestTelemetry();
  await refreshSnapshot();
}

function clearLogs() {
  logs.value = [];
}

onMounted(async () => {
  await refreshSnapshot();

  refreshTimer = setInterval(() => {
    refreshSnapshot().catch(() => {
      healthOnline.value = false;
      statusMessage.value = 'Потеряна связь с growbox-контроллером';
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
  <main class="growbox-page">
    <section class="panel hero-panel">
      <p class="eyebrow">Growbox Control Center</p>
      <h1>Управление 4-канальным реле</h1>
      <p class="subtitle">
        Свет, кулер, увлажнитель и насос работают в ручном или автономном режиме.
      </p>

      <div class="status-strip" :class="`is-${connectionTone}`">
        <strong>{{ healthOnline ? 'Онлайн' : 'Оффлайн' }}</strong>
        <span>{{ statusMessage }}</span>
      </div>

      <div class="chip-row">
        <span class="chip">Backend: {{ backendBase }}</span>
        <span class="chip">Режим: {{ controlMode === 'auto' ? 'Авто' : 'Ручной' }}</span>
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

    <section class="grid-top">
      <article class="panel mode-panel">
        <h2>Режим работы</h2>
        <p class="hint">
          В режиме "Авто" сервер сам управляет каналами по сценарию growbox.
        </p>

        <div class="mode-buttons">
          <UButton
            class="action-btn"
            :color="controlMode === 'manual' ? 'primary' : 'neutral'"
            :loading="pending['mode-manual']"
            :disabled="controlMode === 'manual'"
            @click="switchMode('manual')"
          >
            Ручной режим
          </UButton>
          <UButton
            class="action-btn"
            :color="controlMode === 'auto' ? 'primary' : 'neutral'"
            :loading="pending['mode-auto']"
            :disabled="controlMode === 'auto'"
            @click="switchMode('auto')"
          >
            Автономный режим
          </UButton>
        </div>

        <ul class="scenario-list">
          <li>Свет: включен с 08:00 до 22:00</li>
          <li>Кулер: ON от 28 C, OFF от 25 C</li>
          <li>Увлажнитель: ON при 55%, OFF при 65%</li>
          <li>Насос: в 09:00 и 21:00 на 10 секунд</li>
        </ul>

        <p class="meta">
          Последний запуск насоса: {{ formatTimestamp(lastPumpTriggeredIso) }}
        </p>
      </article>

      <article class="panel climate-panel">
        <h2>Климат и телеметрия</h2>
        <p class="hint">Показания DHT и отправка тестовой телеметрии на сервер.</p>

        <div class="climate-grid">
          <div class="climate-box">
            <span>Температура</span>
            <strong>
              {{ dht.temperatureC === null ? '--' : `${dht.temperatureC} C` }}
            </strong>
          </div>
          <div class="climate-box">
            <span>Влажность</span>
            <strong>{{ dht.humidity === null ? '--' : `${dht.humidity} %` }}</strong>
          </div>
        </div>

        <p class="meta">Последняя телеметрия: {{ formatTimestamp(lastSeenIso) }}</p>

        <div class="telemetry-form">
          <label>
            Device ID
            <input v-model="telemetryForm.device_id" type="text" maxlength="64" />
          </label>
          <label>
            Температура (C)
            <input v-model.number="telemetryForm.temperature_c" type="number" step="0.1" />
          </label>
          <label>
            Влажность (%)
            <input v-model.number="telemetryForm.humidity" type="number" step="0.1" />
          </label>
        </div>

        <div class="climate-actions">
          <UButton
            class="action-btn"
            color="neutral"
            :loading="pending['device-dht']"
            @click="() => requestDht()"
          >
            Обновить DHT
          </UButton>
          <UButton
            class="action-btn"
            color="primary"
            :loading="pending.telemetry"
            @click="sendTelemetryAndRefresh"
          >
            Отправить тестовую телеметрию
          </UButton>
        </div>
      </article>
    </section>

    <section class="panel relay-panel">
      <div class="relay-header">
        <div>
          <h2>Каналы реле</h2>
          <p class="hint">
            Пины: свет 16, кулер 17, увлажнитель 18, насос 19.
          </p>
        </div>
        <strong class="manual-note" :class="{ disabled: !canManualControl }">
          {{
            canManualControl
              ? 'Ручное управление активно'
              : 'Кнопки заблокированы: работает авто-сценарий'
          }}
        </strong>
      </div>

      <div class="relay-grid">
        <article v-for="channel in relayOrder" :key="channel" class="relay-card">
          <p class="relay-title">{{ relayTitles[channel] }}</p>
          <p class="relay-pin">GPIO {{ relayPins[channel] }}</p>
          <p class="relay-state" :class="{ on: relays[channel] === 1 }">
            {{ relays[channel] === 1 ? 'ВКЛ' : 'ВЫКЛ' }}
          </p>

          <UButton
            class="action-btn"
            :color="relays[channel] === 1 ? 'error' : 'primary'"
            :disabled="!canManualControl"
            :loading="pending[`relay-${channel}`]"
            @click="toggleChannel(channel)"
          >
            {{ relays[channel] === 1 ? 'Выключить' : 'Включить' }}
          </UButton>
        </article>
      </div>
    </section>

    <section class="panel history-panel">
      <div class="history-head">
        <div>
          <h2>Журнал запросов</h2>
          <p class="hint">Последние команды и ответы сервера.</p>
        </div>
        <UButton class="action-btn" color="neutral" variant="soft" @click="clearLogs">
          Очистить
        </UButton>
      </div>

      <div v-if="logs.length === 0" class="log-empty">Пока нет записей.</div>

      <div v-else class="log-list">
        <article
          v-for="entry in logs.slice(0, 10)"
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
