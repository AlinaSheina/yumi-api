# yumi-api

REST API на TypeScript + Express.

## Вимоги

- Node.js 18+

## Запуск

```bash
npm install
npm run dev        # режим розробки з автоперезапуском (tsx watch)
npm run build      # компіляція в dist/
npm start          # запуск зібраної версії
npm run typecheck  # перевірка типів
```

Порт задається змінною `PORT` (за замовчуванням `3000`).

## Ендпоінти

- `GET /health` — стан сервісу
