# yumi-api

Клієнт, REST API та MCP-сервер для [yumi.market](https://yumi.market) — оптового магазину повітряних куль.
Працює через внутрішній JSON API сайту (той самий, яким користується його вітрина на Bagisto).

## Вимоги

- Node.js 18+ (рекомендовано 20+ / 22 LTS)

## Запуск

```bash
npm install
npm run build
npm start          # REST API на http://localhost:3000
npm run mcp:start  # MCP-сервер (stdio) для асистента
npm run login      # вхід в акаунт: email -> код з листа (сесія зберігається локально)
npm run login -- --logout
npm run dev        # REST API в режимі розробки
npm run typecheck
npm run test:live  # e2e-тести на живому сайті (кошик повертається у вихідний стан)
```

Сайт не вміє сортувати за ціною: для `sort=price-asc|price-desc` клієнт збирає до 500
результатів і сортує їх сам. Текстовий пошук сайту нечіткий — для розміру, кольору й виробника
краще використовувати фільтри.

## Структура

| Шлях | Що це |
|---|---|
| `src/yumi/http.ts` | HTTP-шар: cookie-сесія, XSRF-токен Laravel, throttling запитів |
| `src/yumi/client.ts` | `YumiClient` — каталог, кошик, акаунт |
| `src/yumi/types.ts` | Типи відповідей сайту та нормалізовані типи |
| `src/mcp/server.ts` | MCP-сервер з інструментами для асистента |
| `src/routes/yumi.ts` | REST-ендпоінти |

## Налаштування (змінні середовища)

| Змінна | За замовчуванням | Опис |
|---|---|---|
| `PORT` | `3000` | Порт REST API |
| `YUMI_SESSION_FILE` | `<проєкт>/.yumi-session.json` | Де зберігаються cookies сесії (файл у `.gitignore`) |
| `YUMI_COOKIE` | — | Початкові cookies (`name=value; ...`) |
| `YUMI_MIN_INTERVAL_MS` | `300` | Мінімальна пауза між запитами до сайту |
| `YUMI_BASE_URL` | `https://yumi.market` | Адреса сайту |

## MCP-інструменти

| Інструмент | Що робить |
|---|---|
| `search_products` | Пошук: текст, категорія, фільтри атрибутів, ціна, сортування |
| `get_product` | Картка товару (опис + актуальні ціни й наявність) |
| `find_by_sku` | Товар за артикулом |
| `list_categories` | Дерево категорій |
| `get_category_filters` | Фільтри категорії (колір, розмір, виробник) з id опцій |
| `get_cart` | Кошик із сумами та прогресом до безкоштовної доставки |
| `add_to_cart` / `update_cart_item` / `remove_cart_item` | Керування кошиком |
| `auth_status` | Чи активна сесія акаунта |
| `login_send_code` / `login_verify_code` | Вхід: код на пошту → підтвердження |
| `list_orders` | Історія замовлень (номер, дата, статус, сума) |
| `get_order` | Деталі замовлення: товари з артикулами, суми, доставка, оплата |
| `reorder` | Покласти всі товари минулого замовлення в кошик (не оформлює замовлення) |

### Підключення до Claude Code

```bash
claude mcp add yumi-market -- node C:/projects/yumi-api/dist/mcp/server.js
```

### Підключення до Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "yumi-market": {
      "command": "node",
      "args": ["C:/projects/yumi-api/dist/mcp/server.js"]
    }
  }
}
```

## REST API

| Метод | Шлях | Опис |
|---|---|---|
| GET | `/health` | Стан сервісу |
| GET | `/catalog/products?query=&categoryId=&sort=&page=&limit=&minPrice=&maxPrice=&f.<attr>=id1,id2` | Пошук товарів |
| GET | `/catalog/products/:urlKey` | Картка товару |
| GET | `/catalog/products/sku/:sku` | Товар за артикулом |
| GET | `/catalog/categories` | Дерево категорій |
| GET | `/catalog/categories/:id/filters` | Фільтри категорії |
| GET | `/catalog/filters/:attributeId/options?categoryId=` | Опції фільтра |
| GET | `/catalog/suggestions?q=` | Підказки пошуку |
| GET | `/cart` | Кошик |
| POST | `/cart/items` `{ productId, quantity }` | Додати товар |
| PATCH | `/cart/items/:itemId` `{ quantity }` | Змінити кількість |
| DELETE | `/cart/items/:itemId` | Видалити рядок |
| GET | `/auth/status` | Чи виконано вхід |
| POST | `/auth/login/send` `{ email }` | Надіслати код входу на пошту |
| POST | `/auth/login/verify` `{ code }` | Підтвердити код |
| POST | `/auth/logout` | Видалити збережену сесію |
| GET | `/orders?page=&perPage=` | Історія замовлень |
| GET | `/orders/:id` | Деталі замовлення |
| POST | `/orders/:id/reorder` | Повторити замовлення в кошик |

## Ще не реалізовано

- Оформлення замовлення (адреса, Нова Пошта / Укрпошта, спосіб оплати).
  Ендпоінти сайту: `/api/checkout/onepage/addresses`, `/checkout/onepage/shipping-methods`,
  `/api/checkout/onepage/payment-methods`, `/api/checkout/cart/onepage/orders`.
