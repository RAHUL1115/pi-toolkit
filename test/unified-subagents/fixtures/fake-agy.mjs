import readline from "node:readline";

const args = process.argv.slice(2);
const valueAfter = flag => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const model = valueAfter("--model") ?? "default-model";
const effort = valueAfter("--effort") ?? "default-effort";
const mode = valueAfter("--mode") ?? "accept-edits";
let turn = 0;

const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const responseStep = (index, delta, usage) => {
  send({ event: "step_update", step_update: { step_index: index, step_type: "agent_response", state: "ACTIVE", text_delta: delta } });
  send({ event: "step_update", step_update: { step_index: index, step_type: "agent_response", state: "DONE", usage } });
};

send({ event: "init", init: { model } });

const input = readline.createInterface({ input: process.stdin });
input.on("line", line => {
  const event = JSON.parse(line);
  const prompt = event?.message?.content ?? "";
  turn++;

  if (prompt.includes("wait for steer") || prompt.includes("wait for cancel")) {
    const delta = prompt.includes("cancel") ? "waiting" : "ready";
    responseStep(0, delta, { input_tokens: 2, output_tokens: 1, total_tokens: 3 });
    return;
  }
  if (turn > 1) {
    send({ event: "result", result: { status: "SUCCESS", response: "ready" } });
    const delta = `steered: ${prompt}`;
    responseStep(2, delta, { input_tokens: 3, output_tokens: 2, cache_read_tokens: 1, total_tokens: 6 });
    send({ event: "result", result: { status: "SUCCESS", response: delta } });
    return;
  }

  send({ event: "step_update", step_update: {
    step_index: 0,
    step_type: "tool",
    state: "ACTIVE",
    tool_name: "read_file",
    tool_info: { parameters: { path: "README.md" } },
  } });
  send({ event: "step_update", step_update: {
    step_index: 0,
    step_type: "tool",
    state: "DONE",
    tool_name: "read_file",
    tool_info: { output: "contents" },
  } });
  const delta = `agy done (${model}, ${effort}, ${mode})`;
  responseStep(1, delta, { input_tokens: 10, output_tokens: 5, cache_read_tokens: 2, total_tokens: 17 });
  send({ event: "result", result: { status: "SUCCESS", response: delta } });
});
