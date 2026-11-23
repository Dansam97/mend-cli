# mend-cli

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Dansam97/mend-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Dansam97/mend-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every edit format an AI model writes: unified diffs (line numbers forgiven — hunks are located by content, nearest the stated line), SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON. Old lines are found at the first of three matching tiers — exact, trailing-whitespace tolerant, then indentation-drift tolerant — so an edit still lands when the model's whitespace wandered. Every edit in a patch is checked against the tree the earlier edits left, a failed edit changes nothing and is reported with its reason, and when any edit fails no file is written at all. It runs on Node 22 with the standard library alone: no install step, no dependencies.

## Run it

```sh
node main.ts [--format=unified|search-replace|v4a|json] [--check] [--strict] [PATCH]
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=p62m1pd8&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
