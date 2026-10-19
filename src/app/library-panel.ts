// The "Library" panel: the skills Hermes created or improved (the books on the office shelf) and its
// memory activity (the filing cabinet). Names and counts only: Overtime never receives a skill's
// body or what Hermes remembered.

import { bookLabel, shelf, SPINE_COLORS, type LibraryState } from "../ext/library";
import { esc } from "./deploy";

const SPINE_CSS = ["#7a2f2a", "#2f5a3a", "#2b3d63", "#b88a2c", "#2c6b6b", "#5a3a26", "#5d6670", "#5b3557", "#b4562a", "#7a2f2a", "#2f5a3a", "#2b3d63", "#b88a2c", "#2c6b6b", "#5a3a26"];

function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export class LibraryPanel {
  private lib: LibraryState | null = null;
  private last = "";
  private highlight = "";

  constructor(private el: HTMLElement) {
    el.addEventListener("toggle", () => { if ((el as HTMLDetailsElement).open) this.render(this.lib, true, true); });
  }

  render(lib: LibraryState | null, visible: boolean, force = false) {
    this.lib = lib;
    this.el.hidden = !visible;
    if (!visible) return;
    const books = lib ? shelf(lib) : [];
    const removed = lib ? lib.order.filter((n) => lib.skills[n]?.removed).length : 0;
    const m = lib?.memory;
    const open = (this.el as HTMLDetailsElement).open;
    const summary = `<summary><span class="lib-title">Library</span><span class="lib-count">${books.length} skill${books.length === 1 ? "" : "s"}${m && (m.writes || m.recalls) ? ` · memory ${m.writes}↑ ${m.recalls}↓` : ""}</span></summary>`;
    let body = "";
    if (open || force) {
      const rows = books.slice().sort((a, b) => b.updatedAt - a.updatedAt).map((b) =>
        `<li class="lib-row${b.name === this.highlight ? " is-hl" : ""}" data-skill="${esc(b.name)}"><i class="lib-spine" style="background:${SPINE_CSS[b.spine % SPINE_COLORS]}"></i><span class="lib-name">${esc(b.name)}</span><span class="lib-meta">v${b.versions}${b.uses ? ` · ${b.uses}×` : ""} · ${ago(b.updatedAt)}</span></li>`).join("");
      body = `<p class="lib-lead">Every skill Hermes creates is a book on the office shelf; each improvement adds a version. Names only, never the skill's text.</p>
        ${rows ? `<ol class="lib-list" aria-label="Skills">${rows}</ol>` : `<p class="lib-empty">No skills yet. When Hermes creates or improves one (<code>skill_manage</code>), a book appears on the shelf.</p>`}
        ${removed ? `<p class="lib-note">${removed} removed or archived skill${removed === 1 ? "" : "s"} taken off the shelf.</p>` : ""}
        <div class="lib-mem"><b>Memory</b> <span>${m ? `${m.writes} write${m.writes === 1 ? "" : "s"}${m.lastWriteAt ? ` (last ${ago(m.lastWriteAt)})` : ""} · ${m.recalls} recall${m.recalls === 1 ? "" : "s"}${m.lastRecallAt ? ` (last ${ago(m.lastRecallAt)})` : ""}` : "nothing yet"}</span><small>The filing cabinet glows when Hermes writes to memory (amber) or recalls past sessions (blue). The contents never leave your server.</small></div>`;
    }
    const html = summary + body;
    if (html === this.last) return;
    this.last = html;
    this.el.innerHTML = html;
  }

  /** opens the panel (from a click on the shelf), optionally highlighting one skill */
  open(skill?: string) {
    this.highlight = skill ?? "";
    const d = this.el as HTMLDetailsElement;
    d.open = true;
    this.render(this.lib, true, true);
    this.el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    if (skill) this.el.querySelector<HTMLElement>(`.lib-row[data-skill="${CSS.escape(skill)}"]`)?.scrollIntoView({ block: "nearest" });
  }

  get labels(): string[] { return this.lib ? shelf(this.lib).map(bookLabel) : []; }
}
