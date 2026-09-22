# mlg87 omp plugins

An [omp](https://github.com/oh-my-pi/pi-coding-agent) plugin marketplace.

```
/marketplace add mlg87/omp-plugins
/marketplace discover mlg87
```

| Plugin | Description |
|---|---|
| [`ask-pulse`](plugins/ask-pulse) | Pulsing dayglo banner above the `ask` dialog so a waiting agent is impossible to miss. |
| [`obvi-plan`](https://github.com/mlg87/omp-obvi-plan/tree/main/plugins/obvi-plan) | Tints the terminal background (lilac by default) while plan mode is active, and restores your theme when you leave it. |

![ask-pulse ask dialog banner](plugins/ask-pulse/docs/ask-pulse.gif)

![ask-pulse idle caret wave](plugins/ask-pulse/docs/idle-wave.gif)

Install one:

```
/marketplace install ask-pulse@mlg87
/marketplace install obvi-plan@mlg87
```

## Local development

```
/marketplace add ./omp-plugins
/marketplace install --force ask-pulse@mlg87
```

`obvi-plan` lives in its own repo, [mlg87/omp-obvi-plan](https://github.com/mlg87/omp-obvi-plan);
its catalog entry is a `git-subdir` source pointing at `plugins/obvi-plan` on that repo's `main`.
A new obvi-plan release reaches users only when its `version` is bumped here, since
`omp plugin upgrade` compares catalog versions.

The catalog is published at both `.omp-plugin/marketplace.json` (read by omp) and
`.claude-plugin/marketplace.json` (Claude Code compatible fallback); keep them in sync.
