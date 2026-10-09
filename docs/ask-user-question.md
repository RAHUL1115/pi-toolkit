# Ask-user-question interaction

The `ask_user_question` tool presents one to four questions, with two to four choices each. The input schema is unchanged by the multiline/notes upgrade.

## Answering

- Navigate choices with Pi's configured `tui.select.up` / `tui.select.down` actions.
- Confirm a single choice with `tui.select.confirm` or `tui.input.submit`.
- For multi-select, Space toggles choices; confirming commits the question. Custom text can accompany checked choices.
- Switch question tabs with Left/Right or Tab/Shift+Tab outside text editing.
- A single question submits immediately when confirmed. Multiple questions retain a final review/Submit tab; every question must be confirmed before submission.

## Custom answers

The final row accepts a multiline custom answer. Drafts are isolated per question and survive leaving the editor or switching tabs. A draft is not an answer until explicitly submitted.

Inside the editor:

- `tui.input.newLine` inserts a newline (normally Shift+Enter or Ctrl+J).
- `tui.input.submit` commits the custom answer (normally Enter).
- Newline wins if a key is assigned to both newline and submit.
- Up moves within the text; at the top it returns to the previous option while retaining the draft.
- `tui.select.cancel` returns to the choices while retaining the draft. Outside an editor, it cancels the questionnaire.

Editing uses Pi's built-in multiline editor, including its configured text-editing shortcuts. Terminal protocol support still determines which modified keys can be distinguished.

## Notes

Use `n` on a regular choice to add a question-specific note without changing the selected answer. On the Submit tab, `n` edits an overall note. The custom-answer row retains normal text entry, including answers beginning with `n`.

Notes support multiline input. Submit or cancel closes the notes editor while preserving the note. A note alone never marks a question answered and cannot bypass the requirement to answer every question. Question notes are included alongside their answers in the review and tool result; the overall note is included separately.

## Result contract

The existing `answers` record remains available for compatibility:

```json
{
  "answers": { "Which features?": "Caching, Metrics, Use a 30-second TTL" },
  "answerDetails": [
    {
      "questionIndex": 0,
      "kind": "multi",
      "selectedLabels": ["Caching", "Metrics"],
      "customText": "Use a 30-second TTL",
      "note": "Avoid adding a service dependency."
    }
  ],
  "globalNote": "Keep the initial implementation small.",
  "cancelled": false
}
```

The complete result also includes the original `questions`. `answerDetails` distinguishes `option`, `custom`, and `multi` answers and preserves selected labels as an array; consumers should not parse the comma-joined compatibility string. `customText`, `note`, and `globalNote` are optional. The result is available in tool `details` and `structuredContent`, with a declared output schema; model-facing text also includes notes.

Cancellation produces `cancelled: true` with no submitted answers. Validation and unavailable-UI failures instead return `isError: true`, `cancelled: false`, and an `error` message; they are not presented as a user declining to answer. Notes and drafts are interaction-local, not durable session storage.

## Scope and provenance

The upgrade takes inspiration from [rpiv-ask-user-question 2.12.0](https://github.com/juicesharp/rpiv-mono/tree/7c9bc924c5bfd148f36d7ebc9f7bd0a9469d633f/packages/rpiv-ask-user-question): multiline drafts, side-band notes, typed answers, and semantic keyboard routing. It preserves this toolkit's existing combined multi-select/custom-answer and required-answer semantics.

Option previews, collapse/reopen, RPC fallback, numeric shortcuts, and external-editor integration are not part of this upgrade.
