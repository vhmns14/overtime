// DEMO MODE: a deterministic stand-in for the model, replaying a recorded run of
// "Build a landing page for Kopi Senja". It goes through the real orchestrator, real tool calls and
// the real checks: the first build ships a broken stylesheet link and an image without alt text,
// the Reviewer's checks catch both, and the Coder fixes them. Replies depend only on the
// conversation state, so plan rejections, comments and skipped fixes still work.

import type { CompletionRequest, CompletionResult, LLM } from "../engine/types";
import indexV1 from "./site/index.v1.html?raw";
import indexV2 from "./site/index.v2.html?raw";
import styleCss from "./site/style.css?raw";
import mainJs from "./site/main.js?raw";
import cupSvg from "./site/senja-cup.svg?raw";

export const DEMO_TASK = "Build a landing page for Kopi Senja";
export const DEMO_FILES = { indexV1, indexV2, styleCss, mainJs, cupSvg };

const BRIEF = `# Kopi Senja: landing page brief

## Audience
Students and young workers in Purwokerto looking for a calm place after 3 pm; people who care where beans come from.

## Sections
1. Hero: "Coffee for the hour the sky turns orange." + opening hours badge + two CTAs (menu, find us)
2. Menu with tabs: Coffee / Non-coffee / Snacks, with short tasting notes and prices in Rupiah
3. Story: from a cart outside a bookshop to twelve seats facing west; three quick facts
4. Visit: address, hours, a tiny "save a seat by the window" form (name + arrival time)

## Tone
Warm, slow, a little poetic. Short sentences. Indonesian product names kept as they are.

## Palette (contrast checked)
espresso #2b1a12, dusk #3d2418, crema #f6ead8, senja orange #e8762c, sand #f2c48d, ink #1f120b.
Text on orange uses ink (6.2:1). Text on espresso uses crema (14:1).

## Art
One inline-friendly SVG: an iced palm-sugar coffee in front of a setting sun.`;

const j = (thought: string, tool: string, args: Record<string, unknown>) => JSON.stringify({ thought, tool, args });

function countAssistant(req: CompletionRequest) {
  return req.messages.filter((m) => m.role === "assistant").length;
}
function lastUser(req: CompletionRequest) {
  for (let i = req.messages.length - 1; i >= 0; i--) if (req.messages[i].role === "user") return req.messages[i].content;
  return "";
}

export function demoReply(req: CompletionRequest): string {
  const step = countAssistant(req);
  const first = req.messages[1]?.content ?? "";
  const feedback = /FEEDBACK FROM THE HUMAN/.test(first);
  switch (req.agent) {
    case "pm": {
      const tickets = [
        { id: "T1", title: "Audience, sections, copy and palette", owner: "research" },
        { id: "T2", title: "Page structure: hero, menu, story, visit", owner: "coder" },
        { id: "T3", title: "Warm dusk styling, responsive layout", owner: "coder" },
        { id: "T4", title: "Menu tabs, mobile nav, reservation form", owner: "coder" },
        { id: "T5", title: "Run checks: HTML, links, a11y, size", owner: "reviewer" },
        { id: "T6", title: "Deploy preview + ZIP", owner: "ops" },
      ];
      return j(
        feedback ? "Reworked the plan around your note; same scope, clearer tickets." : "A one-page site: hero, menu, story, visit. Six tickets.",
        "handoff",
        { to: "research", summary: "Single landing page for a dusk coffee bar. Research copy and palette first.", tickets },
      );
    }
    case "research":
      if (step === 0) return j("Writing the brief: audience, four sections, real menu copy, contrast-safe palette.", "write_file", { path: "notes/brief.md", content: BRIEF, ticket: "T1" });
      return j("Brief is ready. Handing the copy deck to Coder.", "handoff", {
        to: "coder",
        summary: "Four sections, menu with Rupiah prices, palette with checked contrast.",
        brief: BRIEF.slice(0, 1400),
      });
    case "coder": {
      if (/FIX ROUND/.test(first)) {
        if (step === 0) return j("Checking index.html against the two failures.", "read_file", { path: "index.html" });
        if (step === 1) return j("Fixing the stylesheet path and adding alt text to the hero art.", "write_file", { path: "index.html", content: indexV2, ticket: "T2" });
        return j("Both fixes in. Back to Reviewer.", "handoff", { to: "reviewer", summary: "Fixed css/style.css link and hero image alt text." });
      }
      const seq = [
        () => j("Drawing the hero art first: iced coffee against the sunset.", "write_file", { path: "img/senja-cup.svg", content: cupSvg, ticket: "T4" }),
        () => j("Styles: espresso and crema, orange only for actions.", "write_file", { path: "css/style.css", content: styleCss, ticket: "T3" }),
        () => j("JS for menu tabs, mobile nav and the seat form.", "write_file", { path: "js/main.js", content: mainJs, ticket: "T4" }),
        () => j("Now the page itself: hero, menu, story, visit.", "write_file", { path: "index.html", content: indexV1, ticket: "T2" }),
        () => j("All coder tickets done. Sending to review.", "handoff", { to: "reviewer", summary: "4 files: index.html, css, js and the hero SVG. Ready for checks." }),
      ];
      return seq[Math.min(step, seq.length - 1)]();
    }
    case "reviewer": {
      const last = lastUser(req);
      if (!/TOOL RESULT \(run_checks\)/.test(last)) return j("Running the automated checks.", "run_checks", {});
      let ok = true;
      try {
        ok = JSON.parse(last.slice(last.indexOf("{"))).ok;
      } catch {
        ok = !/"ok":false/.test(last);
      }
      if (ok) return j("Everything passes. Over to Ops.", "handoff", { to: "ops", verdict: "pass", summary: "All checks pass: HTML, links, alt text, labels, contrast, JS, size." });
      return j("Two problems: the stylesheet link is wrong and the hero image has no alt.", "handoff", {
        to: "coder",
        verdict: "fix",
        summary: "2 failing: broken stylesheet link, hero image missing alt text.",
        fixes: ['href="css/style.css" (file is style.css, not styles.css)', 'alt="Iced palm-sugar coffee against a setting sun"'],
      });
    }
    case "ops":
      if (step === 0) return j("Listing what ships.", "list_files", {});
      return j("Packaging 4 files for the preview.", "finish", { summary: "4 files, about 11 KB: index.html, css/style.css, js/main.js, img/senja-cup.svg." });
  }
}

export interface DemoOptions {
  /** multiplies the simulated thinking time; 0 for tests */
  speed?: number;
}

export class DemoLLM implements LLM {
  readonly label = "Demo (recorded run)";
  constructor(private opts: DemoOptions = {}) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const text = demoReply(req);
    const promptChars = req.messages.reduce((n, m) => n + m.content.length, 0);
    const usage = { prompt: Math.ceil(promptChars / 4) + 420, completion: Math.ceil(text.length / 4) + 60 };
    const speed = this.opts.speed ?? 1;
    if (speed > 0) {
      // deterministic "thinking": longer for bigger outputs
      const ms = Math.min(4200, 1100 + text.length * 0.35) * speed;
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        req.signal?.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
      });
    } else if (req.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return { text, usage };
  }
}

/** Demo runs are priced at gpt-4o list rates so the meter shows a realistic number. */
export const DEMO_PRICING = { input: 2.5, output: 10 };
