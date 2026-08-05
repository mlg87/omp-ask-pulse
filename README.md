# masongoetz omp marketplace

An [omp](https://github.com/oh-my-pi/pi-coding-agent) plugin marketplace.

```
/marketplace add masongoetz/omp-ask-pulse
/marketplace discover masongoetz
```

| Plugin | Description |
|---|---|
| [`ask-pulse`](plugins/ask-pulse) | Pulsing dayglo banner above the `ask` dialog so a waiting agent is impossible to miss. |

Install one:

```
/marketplace install ask-pulse@masongoetz
```

## Local development

```
/marketplace add ./omp-ask-pulse
/marketplace install --force ask-pulse@masongoetz
```

The catalog is published at both `.omp-plugin/marketplace.json` (read by omp) and
`.claude-plugin/marketplace.json` (Claude Code compatible fallback); keep them in sync.
