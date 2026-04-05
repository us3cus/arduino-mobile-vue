# Arduino Control UI (Nuxt + Nuxt UI)

Адаптивное SPA-приложение для управления Arduino через Nest backend в стиле готовых систем умного дома.

## Что внутри

- Nuxt 3 + Nuxt UI
- Упрощенная панель: свет, климат, LCD и готовые сценарии
- Расширенный сервисный блок со всеми запросами из `test-requests.http`
- Mobile-first верстка
- SPA-сборка (`nuxt generate`)

## Запуск

1. Убедитесь, что Nest backend запущен (по умолчанию `https://api.temten.me` или ваш адрес API).
2. Установите зависимости:

	```bash
	npm install
	```

3. Запустите frontend:

	```bash
	npm run dev
	```

4. Откройте `http://127.0.0.1:5173`.

## SPA build

```bash
npm run build
```

Результат генерации находится в `.output/public`.

Для server-сборки Nuxt (если нужна) используйте:

```bash
npm run build:server
```

## Переменные окружения

- `NUXT_BACKEND_BASE` - адрес backend для runtime-конфига Nuxt.
- `NUXT_PUBLIC_BACKEND_BASE` - публичный адрес backend для клиентских запросов.

По умолчанию обе переменные равны `https://api.temten.me`.
