# Розгортання на сервері (Docker)

Стек описано в `docker-compose.yml`:

| Сервіс | Що робить | За замовчуванням |
|---|---|---|
| `game` | авторитетний сервер гри: симуляція світу, WebSocket, роздача клієнта | так |
| `db` | PostgreSQL 17: знімки світу, журнал подій, щоденна статистика, гравці | так |
| `ollama` | локальна LLM для рішень і реплік NPC | ні (профіль `ai`) |

## Перший запуск

```bash
git clone <repo> rutzarg && cd rutzarg
cp .env.example .env          # обов'язково зміни POSTGRES_PASSWORD
docker compose up -d --build
docker compose logs -f game   # має бути "Storage: PostgreSQL ..."
```

Гра буде на `http://<сервер>:8787`. Порт змінюється через `GAME_PORT` у `.env`.

### З AI (Ollama)

```bash
# у .env: RUTZARG_LLM=ollama, LLM_URL=http://ollama:11434
docker compose --profile ai up -d
docker compose exec ollama ollama pull gemma3:4b
```

- **Без GPU** модель працює, але повільно: відповідь NPC займає 5–20 с, а гра не чекає й тимчасово відповідає шаблоном.
- **З NVIDIA GPU** на Linux розкоментуй блок `deploy` у сервісі `ollama` (потрібен `nvidia-container-toolkit`).
- **Перевірити, що AI працює:** у логах старту має бути `LLM check: ✔ ... доступна`; `curl http://<сервер>/api/ai` показує стан і лічильники викликів; `node scripts/ai-check.ts https://<домен>` — бот питає NPC і показує, чи відповів AI.
- **Ollama вже стоїть на хост-машині?** Тоді профіль `ai` не потрібен: вкажи `LLM_URL=http://host.docker.internal:11434` (Docker Desktop) або IP хоста.

## Акаунти й вхід через Google

Гравці реєструються email+паролем або входять через Google. Персонаж прив'язаний до акаунта, тому однаковий з будь-якого пристрою. Гостьову гру (без акаунта) на сервері за замовчуванням вимкнено (`ALLOW_GUESTS=0`). Для локальної розробки (`npm start`) вона увімкнена.

**Налаштування Google (один раз):**
1. Відкрий https://console.cloud.google.com, створи проєкт (або обери наявний).
2. APIs & Services → OAuth consent screen: тип **External**, назва застосунку, email підтримки. Scopes: `openid`, `email`, `profile`.
3. APIs & Services → Credentials → **Create credentials → OAuth client ID** → тип **Web application**.
4. **Authorized redirect URI:** `https://<твій-домен>/auth/google/callback`. Для локального тесту також `http://localhost:8787/auth/google/callback`: Google дозволяє http лише для localhost.
5. Скопіюй Client ID і Client secret у `.env`:
   ```
   PUBLIC_URL=https://<твій-домен>
   GOOGLE_CLIENT_ID=....apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=....
   ```
6. `docker compose up -d`. На екрані входу з'явиться кнопка «Увійти через Google».

**Безпека:**
- паролі зберігаються лише як scrypt-хеш, сесійні токени — лише як SHA-256 (30 днів, «Вийти» видаляє сесію);
- `state` OAuth перевіряється через HttpOnly-cookie, у ID-токені Google перевіряються `aud`, `iss` і `exp`;
- є обмеження частоти спроб входу.

## Редактор речей (адміністратори)

Редактор речей відкривається на `https://<домен>/editor/` і доступний **лише адміністраторам**:

1. Зареєструйся в грі (email+пароль або Google) тим акаунтом, який буде адміністратором.
2. Додай у `.env`:
   ```
   ADMIN_EMAILS=you@example.com,colleague@example.com
   ```
3. `docker compose up -d`. Тепер `/editor/` просить увійти; входять лише акаунти зі списку.

Без `ADMIN_EMAILS` редактор ззовні закритий повністю. Для скриптів можна задати `ADMIN_TOKEN` (заголовок `x-admin-token`). Подробиці — [tools/item-editor/README.md](../tools/item-editor/README.md).

## HTTPS і домен (nginx)

Гра в Docker слухає лише `127.0.0.1:8787` (`GAME_BIND`), а назовні її віддає nginx на хості з TLS. Готовий конфіг: [`deploy/nginx/rutzarg.conf`](../deploy/nginx/rutzarg.conf) (HTTP→HTTPS, WebSocket `/ws`, gzip, обмеження частоти для входу).

```bash
sudo cp deploy/nginx/rutzarg.conf /etc/nginx/sites-available/rutzarg.conf
sudo sed -i 's/rutzarg.example.com/game.mydomain.com/g' /etc/nginx/sites-available/rutzarg.conf
sudo ln -s /etc/nginx/sites-available/rutzarg.conf /etc/nginx/sites-enabled/
sudo certbot --nginx -d game.mydomain.com     # сертифікат Let's Encrypt
sudo nginx -t && sudo systemctl reload nginx
```

У `.env`: `PUBLIC_URL=https://game.mydomain.com`. Він потрібен для redirect URI Google.

Якщо сертифіката ще немає, `nginx -t` скаржиться на відсутні файли в `/etc/letsencrypt/live/...`. Тоді спершу тимчасово закоментуй блок `server { listen 443 ... }`, перезавантаж nginx, запусти `certbot --nginx -d <домен>` і поверни блок.

## Оновлення

```bash
git pull
docker compose up -d --build   # під час зупинки гра встигає записати останній знімок світу (stop_grace_period 20s)
```

## Дані

- **Знімки світу:** `world_snapshots`, раз на хвилину й при зупинці. Зберігаються останні 30. Це аварійне відновлення, а не «збереження гравця».
- **Хроніка:** `world_events`, усі події світу, лише додаються.
- **Статистика:** `daily_stats`, раз на ігровий день: населення, ціни, скарбниця, підприємства, родовища, ліс. Також доступна через `GET /api/stats?days=30` (JSON).
- **Гравці:** `players` — хто, коли вперше й востаннє заходив, чи онлайн.
- **Акаунти й сесії:** `accounts`, `sessions`. Без бази вони лежать у файлі `data/accounts.json`.

Корисні команди:

```bash
docker compose exec db psql -U rutzarg -d rutzarg
#   SELECT day, population, data->'market'->'wood' FROM daily_stats ORDER BY day;
#   SELECT kind, text FROM world_events WHERE kind = 'crime' ORDER BY id DESC LIMIT 20;

docker compose exec db pg_dump -U rutzarg rutzarg > backup.sql   # резервна копія
```

**Почати світ заново:** `docker compose down -v` (видаляє томи, тобто всі дані!), потім `docker compose up -d`.

## Локальна розробка без Docker

Як і раніше: `npm start` (читає змінні з `.env`, якщо файл є). Без `DATABASE_URL` сервер зберігає світ у файл `data/world.json`, і база не потрібна.
