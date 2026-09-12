/**
 * viewer.bench.ts — `ConversationViewer.render()` against transcripts of
 * growing size.
 *
 * Toolkit caches unchanged transcript content as well as Markdown messages.
 * Warm frames should therefore stay stable as history grows; opening a fresh
 * viewer still pays the initial transcript/layout cost. Both paths are measured.
 *
 * Both markdown modes are measured. `assistant` is the default and sends
 * assistant text through pi's Markdown parser; `off` is the raw wrap path. The
 * pair is the cost of #259, and the cap it introduced (RESULT_MAX_CHARS) is what
 * keeps a single large tool result from dominating the whole frame.
 *
 * Cold vs warm is the other axis worth knowing: the Markdown cache is a WeakMap
 * keyed by the message object, so the first frame parses and later frames reuse.
 * A regression that breaks cache identity would leave "warm" looking like
 * "cold" here while every other test stays green.
 */
import { bench, describe } from "vitest";
import { ConversationViewer } from "../../../pi-toolkit-lib/unified-subagents/ui/conversation-viewer.js";
import { makeSession, mountViewer } from "../helpers/perf-fixtures.js";

const SIZES = [50, 500, 5000];

describe("ConversationViewer.render — markdown: assistant (default)", () => {
  for (const n of SIZES) {
    const viewer = mountViewer(ConversationViewer, makeSession(n));
    viewer.render(120); // prime: first frame parses, the measured ones reuse
    bench(`${n} messages`, () => {
      viewer.render(120);
    });
  }
});

describe("ConversationViewer.render — markdown: off (raw wrap)", () => {
  for (const n of SIZES) {
    const viewer = mountViewer(ConversationViewer, makeSession(n), undefined, () => "off");
    viewer.render(120);
    bench(`${n} messages`, () => {
      viewer.render(120);
    });
  }
});

describe("ConversationViewer — cold open and first frame", () => {
  // Reuse the transcript, never the viewer. A finite viewer pool can wrap when
  // the benchmark runner adds samples and accidentally report cached frames as
  // cold. Constructor cost is deliberately included; fixture allocation is not.
  for (const n of [50, 500]) {
    const session = makeSession(n);
    bench(`${n} messages`, () => {
      mountViewer(ConversationViewer, session).render(120);
    }, { time: 0, iterations: n === 50 ? 40 : 12, warmupTime: 0, warmupIterations: 2 });
  }
});
