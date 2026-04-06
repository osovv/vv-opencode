# vv-opencode

`@osovv/vv-opencode` - переносимый набор плагинов и CLI для `opencode`.

Стартовая цель репозитория:

- упаковать `guardian` как npm-плагин для `opencode`
- добавить CLI `vvoc` для установки, синка и диагностики конфигов
- сделать перенос workflow между устройствами предсказуемым и идемпотентным

## План v1

- npm-пакет `@osovv/vv-opencode`
- bin `vvoc`
- экспорт `GuardianPlugin`
- команды `install`, `sync`, `status`, `doctor`, `guardian config`

## Локальная разработка

```bash
bun install
bun run build
bun test
```

## Установка в OpenCode

После публикации пакета:

```bash
bunx vvoc install
```

CLI добавит `@osovv/vv-opencode` в `opencode` config и при необходимости создаст `guardian.jsonc`.

Эквивалент ручной настройки:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@osovv/vv-opencode"]
}
```
