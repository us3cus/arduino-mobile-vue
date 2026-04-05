# Growbox Control UI (Nuxt + Nuxt UI)

Адаптивное SPA-приложение для управления growbox через Nest backend.

## Что внутри

- Nuxt 3 + Nuxt UI
- Панель growbox: 4 канала реле, ручной/авто режим, климат и журнал команд
- Расширенный сервисный блок со всеми запросами из `test-requests.http`
- Mobile-first верстка
- SPA-сборка (`nuxt generate`)

## Запуск

1. Убедитесь, что Nest backend запущен (по умолчанию frontend ходит в `/backend` на том же домене, либо укажите внешний URL API через переменные окружения).
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

По умолчанию обе переменные равны `/backend` (same-origin через reverse proxy).

Если reverse proxy не настроен, задайте полный URL, например `https://api.temten.me`.
