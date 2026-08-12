# pi-toolkit

Local Pi extension combining:

- workflow settings and grouped built-in tool rendering
- `$skill` autocomplete and loading
- toggleable `Ctrl+Backspace` previous-word deletion for VS Code and Windows Terminal
- observability footer, dashboard, TPS reporting, and session history

## Install

```bash
pi install C:/Users/rahul/dev/pi-toolkit
```

Workflow configuration is stored in `pi-toolkit.json`. Footer configuration is stored under `pi-toolkit.footer` in `~/.pi/agent/settings.json`. Observability history remains under `~/.pi/agent/observability/`.

Commands:

- `/ptk`
- `/ptk-footer-settings`
- `/ptk-workflow-settings` — toggle workflow features, including the Pi `Ctrl+Backspace` delete-word keybind
