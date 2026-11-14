# dots-bot

Бот для игры «Точки» (проектный практикум ИРИТ-РТФ, турнирный эмулятор).
Все работаем в своих ветках!!! 

## Быстрый старт

```bash
npm start          # сервер на порту 4003 (нужен Node.js 20+)
npm test           # автотесты
```

Через Docker: `docker compose up -d --build`.

Для проверки в «Песочнице» на сайте арены укажите `http://localhost:4003`.
Для «Проверки API» в кабинете нужен публичный https-адрес без редиректов.

## Структура проекта

```text
dots-bot/
├── README.md                    этот файл
├── SKILL.md                     контекст и правила для ИИ-ассистента
├── package.json                 команды npm start и npm test
├── .env.example                 пример настроек (PORT, BOT_TOKEN)
├── Dockerfile                   сборка образа
├── docker-compose.yml           запуск одной командой
├── .github/
│   ├── workflows/ci.yml         тесты на каждый push и pull request
│   ├── PULL_REQUEST_TEMPLATE.md шаблон описания pull request
│   └── CODEOWNERS               кто смотрит какую папку
├── bot/index.js                 алгоритм: chooseMove(request) -> {x, y}
├── server/index.js              HTTP API для арены
├── engine/                      эталонный движок арены и наша обёртка adapter.js
├── web/index.html               интерфейс для игры человека против бота
├── tests/
│   ├── api.test.mjs             тесты API
│   ├── rules.test.mjs           тесты правил игры
│   └── match.mjs                бот против бота
└── docs/
    ├── api.md                   контракт API
    ├── STRATEGY.md              описание стратегии
    ├── RUNBOOK.md               что делать при аварии
    ├── ideas/                   идеи команды
    └── decisions/               принятые решения
```

## Документация

| Документ | Что внутри |
|---|---|
| [SKILL.md](SKILL.md) | правила проекта и подсказки для ИИ-ассистента |
| [docs/api.md](docs/api.md) | формат запроса и ответа, правила API |
| [docs/STRATEGY.md](docs/STRATEGY.md) | как бот выбирает ход (сдаём преподавателям) |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | перезапуск, логи, смена адреса, откат версии |
| [docs/ideas/README.md](docs/ideas/README.md) | как вести идеи, статусы |
| [docs/ideas/algorithm.md](docs/ideas/algorithm.md) | идеи по алгоритму бота |
| [docs/ideas/software.md](docs/ideas/software.md) | идеи по серверу и интерфейсу |
| [docs/ideas/devops.md](docs/ideas/devops.md) | идеи по деплою и CI |
| [docs/ideas/qa.md](docs/ideas/qa.md) | идеи по тестам и матчам |
| [docs/decisions/README.md](docs/decisions/README.md) | принятые решения и почему |
| [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md) | чек-лист для pull request |
| [.github/CODEOWNERS](.github/CODEOWNERS) | кто ревьюит какие папки |

## Команда

| Кто | Роль |
|---|---|
| Евгений | алгоритм |
| Владислав | разработка ПО |
| Лев | QA |
| Всеволод | DevOps |
