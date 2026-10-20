# Rutzarg — нотатки для AI-асистента

- Концепт: `docs/Rutzarg_MMO_Concept_v2.md`. Архітектура: `docs/ARCHITECTURE.md`. Політика: `docs/POLITICS.md`. **Кожна ітерація роботи має бути записана в `docs/PROGRESS.md`** (новий запис зверху: що зроблено, рішення, перевірка, відомі проблеми, наступні кроки).
- Стек: TypeScript скрізь. Клієнт — Phaser 3.90 (`client/src`), сервер — Node + `ws` (`server/`), спільний код — `shared/`.
- Сервер виконує `.ts` напряму (Node type stripping): лише стираний синтаксис (без `enum`, `namespace`, parameter properties), імпорти з розширенням `.ts`.
- Сервер авторитетний. Клієнт ніколи не змінює стан світу — лише надсилає наміри (`shared/protocol.ts`).
- NPC і гравці використовують ті самі системи (`Being`). Нові механіки мають бути доступні NPC (§32 концепту).
- Перевірка: `npm run typecheck`, `npm run sim -- 5`, `node scripts/craft-test.ts`, `node scripts/offline-test.ts`, `node scripts/politics-test.ts`, `node scripts/gear-test.ts`, `node scripts/housing-test.ts`, `node scripts/tools-test.ts`, `node scripts/gamedata-test.ts`, `node scripts/editor-auth-test.ts`, `node scripts/smoke-test.ts ws://localhost:<port>/ws` (при запущеному сервері).
- Мова UI, документації та текстів гри — українська; код і коментарі в коді — англійською.
- Редактор речей: `tools/item-editor/` (чистий TS, `npm run editor`, відкривається на `/editor/`). Дані гри (речі, рецепти, знаряддя) — формат `shared/gamedata.ts`; правки з редактора зберігаються в `data/game-data.json` і накладаються на вбудовані значення з `shared/items.ts` / `crafting.ts` / `gear.ts`. Нові поля речей/рецептів додавати і в `gamedata.ts` (перевірка), і в інспектор редактора.
