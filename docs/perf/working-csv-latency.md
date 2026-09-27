# Working CSV latency

`pnpm -s perf:latency` prints cold and warm timings for the Working CSV paths. This page stores one local Linux run. The web section is the Vite dev server. The desktop section is the production Electron build. `pnpm test` and `pnpm build` do not start the command.

Cold is the first sample after a fresh app launch. Warm samples repeat in that launch after the path resets. Each path gets its own launch, so a cold sort does not include opening the file.

Open starts at the file drop and stops when the first `name` cell text is in the DOM. Sort, search, insert, and rename stop when the expected cell text is in the DOM, after the status has passed through Querying. That stamp can be a frame before pixels. Filter `input-to-cell` includes the grid filter debounce, `filterDebounceMs` in `packages/ui/src/csv/csv-grid.tsx` (1500). `querying-to-ready` is only the Querying to Ready edge. Edit and delete stop on that edge and on the dirty badge. They do not stop on the cell text, which updates before `csv.edit-cell` returns.

The fixtures are `fixtures/phase-2-sample.csv` (656 bytes, 5 rows, 10 columns) and `fixtures/large-phase-3-test.csv` (28,858,844 bytes, 100,000 rows, 14 columns). The harness checks each file's SHA-256 before launch. Session `local` means `CI` was unset. The viewport is 1440 by 900.

The recorded commit is `7d30675` with a modified working tree. That tree is the harness in this change. A later run on the same machine will not match these milliseconds exactly. Compare medians, and treat a different CPU, OS, or viewport as a different baseline.

## Web dev

- Recorded at 2026-09-27T00:36:33.847Z
- Commit 7d30675, working tree modified
- CPU Intel(R) Xeon(R) Processor, 4 cores, 16 GiB memory, load average 1
- OS linux 6.12.94+
- Node v24.21.0. Web Chrome 148.0.7778.96.
- viewport: 1440x900
- Command `pnpm -s perf:latency --runtime web`

| runtime | fixture | path | phase | interval | median ms | samples ms | bytes | rows | columns | os | session |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| web-dev | phase-2-sample | open | cold | input-to-cell | 253 | 253 | 656 | 5 | 10 | linux | local |
| web-dev | phase-2-sample | open | warm | input-to-cell | 124 | 124 126 119 | 656 | 5 | 10 | linux | local |
| web-dev | phase-2-sample | sort | cold | input-to-cell | 71 | 71 | 656 | 5 | 10 | linux | local |
| web-dev | phase-2-sample | sort | cold | querying-to-ready | 19 | 19 | 656 | 5 | 10 | linux | local |
| web-dev | phase-2-sample | sort | warm | input-to-cell | 57 | 57 59 57 | 656 | 5 | 10 | linux | local |
| web-dev | phase-2-sample | sort | warm | querying-to-ready | 19 | 19 16 19 | 656 | 5 | 10 | linux | local |
| web-dev | phase-2-sample | filter | cold | input-to-cell, includes filter debounce | 1563 | 1563 | 656 | 5 | 10 | linux | local |
| web-dev | phase-2-sample | filter | cold | querying-to-ready | 23 | 23 | 656 | 5 | 10 | linux | local |
| web-dev | phase-2-sample | filter | warm | input-to-cell, includes filter debounce | 1547 | 1546 1549 1547 | 656 | 5 | 10 | linux | local |
| web-dev | phase-2-sample | filter | warm | querying-to-ready | 20 | 19 20 20 | 656 | 5 | 10 | linux | local |
| web-dev | phase-2-sample | search | cold | input-to-cell | 73 | 73 | 656 | 5 | 10 | linux | local |
| web-dev | phase-2-sample | search | cold | querying-to-ready | 31 | 31 | 656 | 5 | 10 | linux | local |
| web-dev | phase-2-sample | search | warm | input-to-cell | 63 | 64 63 62 | 656 | 5 | 10 | linux | local |
| web-dev | phase-2-sample | search | warm | querying-to-ready | 27 | 27 24 27 | 656 | 5 | 10 | linux | local |
| web-dev | phase-2-sample | edit-cell | cold | input-to-ready | 93 | 93 | 656 | 5 | 10 | linux | local |
| web-dev | phase-2-sample | edit-cell | cold | input-to-dirty | 51 | 51 | 656 | 5 | 10 | linux | local |
| web-dev | phase-2-sample | edit-cell | warm | input-to-ready | 68 | 77 68 68 | 656 | 5 | 10 | linux | local |
| web-dev | phase-2-sample | edit-cell | warm | input-to-dirty | 33 | 38 32 33 | 656 | 5 | 10 | linux | local |
| web-dev | phase-2-sample | insert-column | cold | input-to-cell | 144 | 144 | 656 | 5 | 10 | linux | local |
| web-dev | phase-2-sample | insert-column | cold | input-to-dirty | 70 | 70 | 656 | 5 | 10 | linux | local |
| web-dev | phase-2-sample | insert-column | warm | input-to-cell | 118 | 121 115 118 | 656 | 5 | 10 | linux | local |
| web-dev | phase-2-sample | insert-column | warm | input-to-dirty | 58 | 58 55 61 | 656 | 5 | 10 | linux | local |
| web-dev | phase-2-sample | delete-column | cold | input-to-ready | 131 | 131 | 656 | 5 | 10 | linux | local |
| web-dev | phase-2-sample | delete-column | cold | input-to-dirty | 71 | 71 | 656 | 5 | 10 | linux | local |
| web-dev | phase-2-sample | delete-column | warm | input-to-ready | 106 | 109 106 103 | 656 | 5 | 10 | linux | local |
| web-dev | phase-2-sample | delete-column | warm | input-to-dirty | 55 | 55 55 52 | 656 | 5 | 10 | linux | local |
| web-dev | phase-2-sample | rename-column | cold | input-to-cell | 102 | 102 | 656 | 5 | 10 | linux | local |
| web-dev | phase-2-sample | rename-column | cold | input-to-dirty | 52 | 52 | 656 | 5 | 10 | linux | local |
| web-dev | phase-2-sample | rename-column | warm | input-to-cell | 86 | 90 82 86 | 656 | 5 | 10 | linux | local |
| web-dev | phase-2-sample | rename-column | warm | input-to-dirty | 44 | 44 43 44 | 656 | 5 | 10 | linux | local |
| web-dev | large-phase-3-test | open | cold | input-to-cell | 612 | 612 | 28858844 | 100000 | 14 | linux | local |
| web-dev | large-phase-3-test | open | warm | input-to-cell | 384 | 403 384 377 | 28858844 | 100000 | 14 | linux | local |
| web-dev | large-phase-3-test | sort | cold | input-to-cell | 176 | 176 | 28858844 | 100000 | 14 | linux | local |
| web-dev | large-phase-3-test | sort | cold | querying-to-ready | 40 | 40 | 28858844 | 100000 | 14 | linux | local |
| web-dev | large-phase-3-test | sort | warm | input-to-cell | 142 | 169 142 139 | 28858844 | 100000 | 14 | linux | local |
| web-dev | large-phase-3-test | sort | warm | querying-to-ready | 31 | 37 31 30 | 28858844 | 100000 | 14 | linux | local |
| web-dev | large-phase-3-test | filter | cold | input-to-cell, includes filter debounce | 1595 | 1595 | 28858844 | 100000 | 14 | linux | local |
| web-dev | large-phase-3-test | filter | cold | querying-to-ready | 57 | 57 | 28858844 | 100000 | 14 | linux | local |
| web-dev | large-phase-3-test | filter | warm | input-to-cell, includes filter debounce | 1582 | 1582 1581 1586 | 28858844 | 100000 | 14 | linux | local |
| web-dev | large-phase-3-test | filter | warm | querying-to-ready | 51 | 50 51 53 | 28858844 | 100000 | 14 | linux | local |
| web-dev | large-phase-3-test | search | cold | input-to-cell | 541 | 541 | 28858844 | 100000 | 14 | linux | local |
| web-dev | large-phase-3-test | search | cold | querying-to-ready | 492 | 492 | 28858844 | 100000 | 14 | linux | local |
| web-dev | large-phase-3-test | search | warm | input-to-cell | 524 | 542 523 524 | 28858844 | 100000 | 14 | linux | local |
| web-dev | large-phase-3-test | search | warm | querying-to-ready | 472 | 485 472 468 | 28858844 | 100000 | 14 | linux | local |
| web-dev | large-phase-3-test | edit-cell | cold | input-to-ready | 164 | 164 | 28858844 | 100000 | 14 | linux | local |
| web-dev | large-phase-3-test | edit-cell | cold | input-to-dirty | 73 | 73 | 28858844 | 100000 | 14 | linux | local |
| web-dev | large-phase-3-test | edit-cell | warm | input-to-ready | 136 | 138 136 132 | 28858844 | 100000 | 14 | linux | local |
| web-dev | large-phase-3-test | edit-cell | warm | input-to-dirty | 57 | 57 60 57 | 28858844 | 100000 | 14 | linux | local |
| web-dev | large-phase-3-test | insert-column | cold | input-to-cell | 242 | 242 | 28858844 | 100000 | 14 | linux | local |
| web-dev | large-phase-3-test | insert-column | cold | input-to-dirty | 105 | 105 | 28858844 | 100000 | 14 | linux | local |
| web-dev | large-phase-3-test | insert-column | warm | input-to-cell | 231 | 252 231 225 | 28858844 | 100000 | 14 | linux | local |
| web-dev | large-phase-3-test | insert-column | warm | input-to-dirty | 109 | 116 109 104 | 28858844 | 100000 | 14 | linux | local |
| web-dev | large-phase-3-test | delete-column | cold | input-to-ready | 227 | 227 | 28858844 | 100000 | 14 | linux | local |
| web-dev | large-phase-3-test | delete-column | cold | input-to-dirty | 124 | 124 | 28858844 | 100000 | 14 | linux | local |
| web-dev | large-phase-3-test | delete-column | warm | input-to-ready | 181 | 193 181 174 | 28858844 | 100000 | 14 | linux | local |
| web-dev | large-phase-3-test | delete-column | warm | input-to-dirty | 93 | 94 93 88 | 28858844 | 100000 | 14 | linux | local |
| web-dev | large-phase-3-test | rename-column | cold | input-to-cell | 199 | 199 | 28858844 | 100000 | 14 | linux | local |
| web-dev | large-phase-3-test | rename-column | cold | input-to-dirty | 82 | 82 | 28858844 | 100000 | 14 | linux | local |
| web-dev | large-phase-3-test | rename-column | warm | input-to-cell | 200 | 209 200 195 | 28858844 | 100000 | 14 | linux | local |
| web-dev | large-phase-3-test | rename-column | warm | input-to-dirty | 92 | 92 95 88 | 28858844 | 100000 | 14 | linux | local |

## Desktop production

- Recorded at 2026-09-27T00:39:41.082Z
- Commit 7d30675, working tree modified
- CPU Intel(R) Xeon(R) Processor, 4 cores, 16 GiB memory, load average 0.52
- OS linux 6.12.94+
- Node v24.21.0. Desktop Electron 44.1.1 with Chrome 152.0.7977.65.
- viewport: 1440x900
- Command `pnpm -s perf:latency --runtime desktop`

| runtime | fixture | path | phase | interval | median ms | samples ms | bytes | rows | columns | os | session |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| desktop-prod | phase-2-sample | open | cold | input-to-cell | 310 | 310 | 656 | 5 | 10 | linux | local |
| desktop-prod | phase-2-sample | open | warm | input-to-cell | 47 | 49 47 44 | 656 | 5 | 10 | linux | local |
| desktop-prod | phase-2-sample | sort | cold | input-to-cell | 25 | 25 | 656 | 5 | 10 | linux | local |
| desktop-prod | phase-2-sample | sort | cold | querying-to-ready | 8 | 8 | 656 | 5 | 10 | linux | local |
| desktop-prod | phase-2-sample | sort | warm | input-to-cell | 18 | 18 18 18 | 656 | 5 | 10 | linux | local |
| desktop-prod | phase-2-sample | sort | warm | querying-to-ready | 8 | 7 8 8 | 656 | 5 | 10 | linux | local |
| desktop-prod | phase-2-sample | filter | cold | input-to-cell, includes filter debounce | 1524 | 1524 | 656 | 5 | 10 | linux | local |
| desktop-prod | phase-2-sample | filter | cold | querying-to-ready | 6 | 6 | 656 | 5 | 10 | linux | local |
| desktop-prod | phase-2-sample | filter | warm | input-to-cell, includes filter debounce | 1517 | 1517 1517 1521 | 656 | 5 | 10 | linux | local |
| desktop-prod | phase-2-sample | filter | warm | querying-to-ready | 5 | 5 5 8 | 656 | 5 | 10 | linux | local |
| desktop-prod | phase-2-sample | search | cold | input-to-cell | 27 | 27 | 656 | 5 | 10 | linux | local |
| desktop-prod | phase-2-sample | search | cold | querying-to-ready | 14 | 14 | 656 | 5 | 10 | linux | local |
| desktop-prod | phase-2-sample | search | warm | input-to-cell | 22 | 22 22 20 | 656 | 5 | 10 | linux | local |
| desktop-prod | phase-2-sample | search | warm | querying-to-ready | 11 | 11 11 7 | 656 | 5 | 10 | linux | local |
| desktop-prod | phase-2-sample | edit-cell | cold | input-to-ready | 35 | 35 | 656 | 5 | 10 | linux | local |
| desktop-prod | phase-2-sample | edit-cell | cold | input-to-dirty | 20 | 20 | 656 | 5 | 10 | linux | local |
| desktop-prod | phase-2-sample | edit-cell | warm | input-to-ready | 21 | 24 21 21 | 656 | 5 | 10 | linux | local |
| desktop-prod | phase-2-sample | edit-cell | warm | input-to-dirty | 12 | 13 12 12 | 656 | 5 | 10 | linux | local |
| desktop-prod | phase-2-sample | insert-column | cold | input-to-cell | 51 | 51 | 656 | 5 | 10 | linux | local |
| desktop-prod | phase-2-sample | insert-column | cold | input-to-dirty | 27 | 27 | 656 | 5 | 10 | linux | local |
| desktop-prod | phase-2-sample | insert-column | warm | input-to-cell | 41 | 41 41 38 | 656 | 5 | 10 | linux | local |
| desktop-prod | phase-2-sample | insert-column | warm | input-to-dirty | 20 | 20 21 19 | 656 | 5 | 10 | linux | local |
| desktop-prod | phase-2-sample | delete-column | cold | input-to-ready | 46 | 46 | 656 | 5 | 10 | linux | local |
| desktop-prod | phase-2-sample | delete-column | cold | input-to-dirty | 27 | 27 | 656 | 5 | 10 | linux | local |
| desktop-prod | phase-2-sample | delete-column | warm | input-to-ready | 38 | 38 39 36 | 656 | 5 | 10 | linux | local |
| desktop-prod | phase-2-sample | delete-column | warm | input-to-dirty | 19 | 19 22 18 | 656 | 5 | 10 | linux | local |
| desktop-prod | phase-2-sample | rename-column | cold | input-to-cell | 34 | 34 | 656 | 5 | 10 | linux | local |
| desktop-prod | phase-2-sample | rename-column | cold | input-to-dirty | 18 | 18 | 656 | 5 | 10 | linux | local |
| desktop-prod | phase-2-sample | rename-column | warm | input-to-cell | 28 | 28 28 28 | 656 | 5 | 10 | linux | local |
| desktop-prod | phase-2-sample | rename-column | warm | input-to-dirty | 15 | 15 15 14 | 656 | 5 | 10 | linux | local |
| desktop-prod | large-phase-3-test | open | cold | input-to-cell | 335 | 335 | 28858844 | 100000 | 14 | linux | local |
| desktop-prod | large-phase-3-test | open | warm | input-to-cell | 238 | 258 238 229 | 28858844 | 100000 | 14 | linux | local |
| desktop-prod | large-phase-3-test | sort | cold | input-to-cell | 46 | 46 | 28858844 | 100000 | 14 | linux | local |
| desktop-prod | large-phase-3-test | sort | cold | querying-to-ready | 18 | 18 | 28858844 | 100000 | 14 | linux | local |
| desktop-prod | large-phase-3-test | sort | warm | input-to-cell | 37 | 40 37 35 | 28858844 | 100000 | 14 | linux | local |
| desktop-prod | large-phase-3-test | sort | warm | querying-to-ready | 18 | 21 18 17 | 28858844 | 100000 | 14 | linux | local |
| desktop-prod | large-phase-3-test | filter | cold | input-to-cell, includes filter debounce | 1551 | 1551 | 28858844 | 100000 | 14 | linux | local |
| desktop-prod | large-phase-3-test | filter | cold | querying-to-ready | 29 | 29 | 28858844 | 100000 | 14 | linux | local |
| desktop-prod | large-phase-3-test | filter | warm | input-to-cell, includes filter debounce | 1543 | 1542 1543 1543 | 28858844 | 100000 | 14 | linux | local |
| desktop-prod | large-phase-3-test | filter | warm | querying-to-ready | 27 | 27 27 29 | 28858844 | 100000 | 14 | linux | local |
| desktop-prod | large-phase-3-test | search | cold | input-to-cell | 428 | 428 | 28858844 | 100000 | 14 | linux | local |
| desktop-prod | large-phase-3-test | search | cold | querying-to-ready | 409 | 409 | 28858844 | 100000 | 14 | linux | local |
| desktop-prod | large-phase-3-test | search | warm | input-to-cell | 419 | 422 419 416 | 28858844 | 100000 | 14 | linux | local |
| desktop-prod | large-phase-3-test | search | warm | querying-to-ready | 404 | 405 404 401 | 28858844 | 100000 | 14 | linux | local |
| desktop-prod | large-phase-3-test | edit-cell | cold | input-to-ready | 49 | 49 | 28858844 | 100000 | 14 | linux | local |
| desktop-prod | large-phase-3-test | edit-cell | cold | input-to-dirty | 23 | 23 | 28858844 | 100000 | 14 | linux | local |
| desktop-prod | large-phase-3-test | edit-cell | warm | input-to-ready | 45 | 45 36 45 | 28858844 | 100000 | 14 | linux | local |
| desktop-prod | large-phase-3-test | edit-cell | warm | input-to-dirty | 23 | 26 17 23 | 28858844 | 100000 | 14 | linux | local |
| desktop-prod | large-phase-3-test | insert-column | cold | input-to-cell | 73 | 73 | 28858844 | 100000 | 14 | linux | local |
| desktop-prod | large-phase-3-test | insert-column | cold | input-to-dirty | 35 | 35 | 28858844 | 100000 | 14 | linux | local |
| desktop-prod | large-phase-3-test | insert-column | warm | input-to-cell | 65 | 68 62 65 | 28858844 | 100000 | 14 | linux | local |
| desktop-prod | large-phase-3-test | insert-column | warm | input-to-dirty | 31 | 33 29 31 | 28858844 | 100000 | 14 | linux | local |
| desktop-prod | large-phase-3-test | delete-column | cold | input-to-ready | 72 | 72 | 28858844 | 100000 | 14 | linux | local |
| desktop-prod | large-phase-3-test | delete-column | cold | input-to-dirty | 38 | 38 | 28858844 | 100000 | 14 | linux | local |
| desktop-prod | large-phase-3-test | delete-column | warm | input-to-ready | 58 | 58 58 57 | 28858844 | 100000 | 14 | linux | local |
| desktop-prod | large-phase-3-test | delete-column | warm | input-to-dirty | 28 | 28 26 28 | 28858844 | 100000 | 14 | linux | local |
| desktop-prod | large-phase-3-test | rename-column | cold | input-to-cell | 53 | 53 | 28858844 | 100000 | 14 | linux | local |
| desktop-prod | large-phase-3-test | rename-column | cold | input-to-dirty | 27 | 27 | 28858844 | 100000 | 14 | linux | local |
| desktop-prod | large-phase-3-test | rename-column | warm | input-to-cell | 46 | 46 48 46 | 28858844 | 100000 | 14 | linux | local |
| desktop-prod | large-phase-3-test | rename-column | warm | input-to-dirty | 21 | 21 22 19 | 28858844 | 100000 | 14 | linux | local |

## Rerun

```sh
pnpm -s perf:latency
pnpm -s perf:latency --runtime web --fixture large-phase-3-test --path search
```

`--runtime`, `--fixture`, and `--path` can repeat. `--cold` defaults to 1. `--warm` defaults to 3. The command needs a display and refuses to start while a verify session is already running.
