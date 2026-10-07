#!/usr/bin/env bash
set -euo pipefail
npm ci --ignore-scripts --no-audit --no-fund
npm run build:server
npm run typecheck
npm run lint
npm run format:check
(cd packages/server && npx vitest run src/server/host-clipboard.test.ts src/server/session.test.ts --bail=1)
(cd packages/app && npx vitest run --project unit src/i18n/resources.test.ts src/terminal/runtime/terminal-emulator-runtime.test.ts src/terminal/runtime/terminal-paste.test.ts src/utils/terminal-keys.test.ts --bail=1)
