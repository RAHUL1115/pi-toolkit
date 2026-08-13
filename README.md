# pi-toolkit

Local Pi extension combining:

- workflow settings and grouped built-in tool rendering (`Ctrl+O`: collapsed → preview → full); adjacent tool-only turns merge until non-empty text or thinking appears
- `$skill` autocomplete and loading
- toggleable `Ctrl+Backspace` previous-word deletion for VS Code and Windows Terminal
- observability footer, dashboard, TPS reporting, and session history

Grouped blocks use the same left margin as user/thinking content. Collapsed groups always show each tool target and status without output bodies; `Ctrl+O` reveals preview and full output.

## Install

```bash
pi install C:/Users/rahul/dev/pi-toolkit
```

Workflow configuration is stored in `pi-toolkit.json`. Footer configuration is stored under `pi-toolkit.footer` in `~/.pi/agent/settings.json`. Observability history remains under `~/.pi/agent/observability/`.

Commands:

- `/ptk`
- `/ptk-footer-settings`
- `/ptk-workflow-settings` — toggle workflow features, including the Pi `Ctrl+Backspace` delete-word keybind
