import type { Model } from "@earendil-works/pi-ai";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Container, getKeybindings, Input, SelectList, Spacer, Text, type SettingItem } from "@earendil-works/pi-tui";
import { liteModelChoices, selectLiteModel } from "./session-title.js";

export function liteModelSetting(models: readonly Model<any>[], configured?: string): SettingItem {
	const choices = liteModelChoices(models, configured);
	const automatic = selectLiteModel(models);
	const autoLabel = automatic ? `Auto (${automatic.provider}/${automatic.id})` : "Auto (no model available)";
	return {
		id: "liteModel",
		label: "Lite model",
		description: "ptk/lite: Auto chooses the newest lightweight model; a manual physical model stays pinned.",
		currentValue: configured ?? autoLabel,
		submenu: (current, done) => {
			const container = new Container();
			container.addChild(new Text("Lite model · type to filter, Enter to select, Esc to cancel", 0, 0));
			container.addChild(new Spacer(1));
			const input = new Input();
			container.addChild(input);
			container.addChild(new Spacer(1));
			const options = choices.map((value) => ({
				value,
				label: value === "Auto" ? autoLabel : value,
				description: value === "Auto" ? "Dynamic: newest available lightweight model" : undefined,
			}));
			const buildList = (query = "") => {
				const filtered = options.filter((item) => item.label.toLowerCase().includes(query.toLowerCase()));
				const list = new SelectList(filtered, 10, getSelectListTheme());
				list.onSelect = (item) => done(item.value);
				list.onCancel = () => done();
				return list;
			};
			let list = buildList();
			list.setSelectedIndex(Math.max(0, choices.indexOf(current === autoLabel ? "Auto" : current)));
			const listIndex = container.children.length;
			container.addChild(list);
			return {
				render: (width) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput(data) {
					const keys = getKeybindings();
					if ((["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const)
						.some((key) => keys.matches(data, key))) {
						list.handleInput(data);
					} else {
						input.handleInput(data);
						list = buildList(input.getValue());
						container.children[listIndex] = list;
					}
				},
			};
		},
	};
}
