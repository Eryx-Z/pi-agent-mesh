import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, ScrollView, SelectList, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import type { TaskManager } from "./tasks.ts";
import type { TaskRecord } from "./store.ts";

export type TaskAction = "Message" | "Answer question" | "Cancel" | "Continue";
export interface DashboardAction { id: string; action: TaskAction }
export type DashboardPane = "overview" | "prompt" | "activity" | "trace";
export interface DashboardState {
  selectedId?: string;
  pane: DashboardPane;
  detailFocus: boolean;
  views: Map<string, { top: number; follow: boolean }>;
}
export const dashboardState = (): DashboardState => ({ pane: "prompt", detailFocus: false, views: new Map() });
type Content = { summary: (record: TaskRecord) => string; detail: (record: TaskRecord, pane: DashboardPane) => string };
const inline = (text: string): string => stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();

// Stable within each attention group: streaming updates must not reorder peers.
export function dashboardRecords(records: Iterable<TaskRecord>): TaskRecord[] {
  const priority = (r: TaskRecord) => r.questions.some(q => !q.responseSent) ? 0
    : r.state === "failed" || (!r.stopped && r.state !== "running" && r.state !== "waiting") ? 1
    : r.state === "running" || r.state === "waiting" ? 2 : 3;
  return [...records].sort((a, b) => priority(a) - priority(b));
}

export class TaskDashboard {
  private timer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;
  private completed = false;
  private scroll = new ScrollView({ render: () => [], invalidate() {} }, { follow: "end", scrollbar: "hidden" });
  private viewport = 1;
  private layout: { text: string; width: number; lines: string[] } | undefined;
  constructor(
    private manager: Pick<TaskManager, "records">,
    readonly state: DashboardState,
    private tui: Pick<TUI, "requestRender" | "terminal">,
    private theme: Theme,
    private keys: Pick<KeybindingsManager, "matches">,
    private done: (action: DashboardAction | undefined) => void,
    private content: Content,
  ) {
    this.timer = setInterval(() => { if (!this.disposed) this.tui.requestRender(); }, 500);
    this.timer.unref();
  }
  private records(): TaskRecord[] {
    const records = dashboardRecords(this.manager.records.values());
    if (!records.some(r => r.id === this.state.selectedId)) this.state.selectedId = records[0]?.id;
    return records;
  }
  private view() {
    const id = this.state.selectedId;
    if (!id) return undefined;
    const key = `${id}:${this.state.pane}`;
    let view = this.state.views.get(key);
    if (!view) { view = { top: 0, follow: this.state.pane === "activity" }; this.state.views.set(key, view); }
    return view;
  }
  private finish(action?: DashboardAction): void {
    if (this.completed) return;
    this.completed = true;
    this.dispose();
    this.done(action);
  }
  handleInput(data: string): void {
    if (this.disposed) return;
    const selectedBefore = this.state.selectedId;
    const records = this.records();
    if (this.keys.matches(data, "tui.select.cancel") || matchesKey(data, "escape")) { this.finish(); return; }
    if (["1", "2", "3", "4"].includes(data)) {
      this.state.pane = data === "1" ? "overview" : data === "2" ? "prompt" : data === "3" ? "activity" : "trace";
    } else if (this.keys.matches(data, "tui.select.confirm") || matchesKey(data, "tab")) {
      this.state.detailFocus = !this.state.detailFocus;
    } else {
      const action: TaskAction | undefined = data === "m" ? "Message" : data === "a" ? "Answer question"
        : data === "c" ? "Continue" : data === "x" ? "Cancel" : undefined;
      // If a record disappeared between render and input, route its original ID so
      // the native action reports an error rather than acting on an unseen fallback.
      const actionId = selectedBefore ?? this.state.selectedId;
      if (action && actionId) { this.finish({ id: actionId, action }); return; }
      const up = this.keys.matches(data, "tui.select.up"), down = this.keys.matches(data, "tui.select.down");
      const pageUp = this.keys.matches(data, "tui.select.pageUp"), pageDown = this.keys.matches(data, "tui.select.pageDown");
      const view = this.view();
      if (view && (pageUp || pageDown || matchesKey(data, "home") || matchesKey(data, "end") || (this.state.detailFocus && (up || down)))) {
        if (matchesKey(data, "end")) { view.follow = this.state.pane === "activity" || this.state.pane === "trace"; this.scroll.scrollToEnd(); }
        else {
          view.follow = false;
          const top = matchesKey(data, "home") ? 0 : this.scroll.scrollTop + (pageUp ? -this.viewport : pageDown ? this.viewport : up ? -1 : 1);
          this.scroll.scrollTo(top, { disableFollow: true });
        }
        view.top = this.scroll.scrollTop;
      } else if (!this.state.detailFocus && (up || down) && records.length) {
        const index = records.findIndex(r => r.id === this.state.selectedId);
        this.state.selectedId = records[Math.max(0, Math.min(records.length - 1, index + (up ? -1 : 1)))]!.id;
      }
    }
    this.tui.requestRender();
  }
  render(width: number): string[] {
    if (width <= 0) return [];
    const height = Math.max(1, this.tui.terminal.rows);
    const records = this.records(), record = records.find(r => r.id === this.state.selectedId);
    const th = this.theme;
    const fit = (text: string, w = width) => truncateToWidth(text, w);
    const pad = (text: string, w: number) => { const s = fit(text, w); return s + " ".repeat(Math.max(0, w - visibleWidth(s))); };
    const framed = width >= 16 && height >= 16;
    const contentWidth = framed ? width - 4 : width;
    const room = framed ? height - 9 : Math.max(1, height - 4);
    const wide = framed && width >= 90;
    const listWidth = wide ? Math.min(34, Math.floor(contentWidth * 0.3)) : contentWidth;
    const listHeight = framed ? (wide ? room - 1 : Math.min(4, Math.max(1, records.length), room - 4)) : 0;
    const detailWidth = Math.max(1, wide ? contentWidth - listWidth - 3 : contentWidth);
    const detailHeight = Math.max(1, framed ? (wide ? room - 1 : room - listHeight - 3) : room);
    const list = new SelectList(records.map(r => ({ value: r.id, label: this.content.summary(r) })), Math.max(1, listHeight), {
      selectedPrefix: s => th.fg("accent", s), selectedText: s => th.fg("accent", s),
      description: s => th.fg("muted", s), scrollInfo: s => th.fg("muted", s), noMatch: s => th.fg("muted", s),
    });
    list.setSelectedIndex(Math.max(0, records.findIndex(r => r.id === this.state.selectedId)));
    const left = records.length ? list.render(listWidth).slice(0, listHeight) : ["No subagent tasks yet"];
    const text = record ? this.content.detail(record, this.state.pane) : "Select a task to view details";
    if (!this.layout || this.layout.text !== text || this.layout.width !== detailWidth) {
      this.layout = { text, width: detailWidth, lines: wrapTextWithAnsi(text, detailWidth) };
    }
    const lines = this.layout.lines;
    this.viewport = Math.max(1, detailHeight);
    const view = this.view();
    // Suppress ScrollView's automatic resume-at-bottom: only End restores follow after manual scrolling.
    this.scroll.scrollTo(view?.top ?? 0, { disableFollow: !view?.follow });
    this.scroll.updateLayout(lines.length, this.viewport, () => {});
    if (view?.follow) this.scroll.scrollToEnd();
    else this.scroll.scrollTo(view?.top ?? 0, { disableFollow: true });
    if (view) view.top = this.scroll.scrollTop;
    const right = lines.slice(this.scroll.scrollTop, this.scroll.scrollTop + detailHeight);
    const position = `${this.scroll.scrollTop + 1}/${lines.length}`;
    const model = inline(record?.loadout.model ?? "unknown");
    const tabs = (["overview", "prompt", "activity", "trace"] as const).map((pane, index) => {
      const label = `${index + 1} ${pane[0].toUpperCase()}${pane.slice(1)}`;
      return th.fg(pane === this.state.pane ? "accent" : "muted", label);
    }).join(th.fg("muted", " · "));
    const shortcuts = tabs;
    const scrolling = view?.follow ? "Following latest" : position;
    const focus = ` · Focus: ${this.state.detailFocus ? "Detail" : "Tasks"}`;
    const role = record?.version === 3 && record.rolePlan;
    const title = record ? role ? this.content.summary(record) : `${inline(record.name)} · ${record.state}` : "Subagents";
    const header = th.fg("accent", fit(title, Math.max(0, contentWidth - visibleWidth(focus)))) + th.fg("muted", focus);
    const modelLine = th.fg("muted", `Model: ${model}${role && record ? ` · Context: ${record.context} · Access: ${record.access}` : ""}`);
    const paneTitle = `${this.state.pane[0].toUpperCase()}${this.state.pane.slice(1)}`;
    if (!framed) {
      // Tiny terminals prioritize useful text and keyboard access over decoration.
      const compact = [header, modelLine, shortcuts, ...right, th.fg("muted", "Tab focus · 1/2/3/4 view · Esc close")];
      // Cover every terminal cell, including blank rows, so the transcript cannot show through.
      return Array.from({ length: height }, (_, i) => pad(compact[i] ?? "", width));
    }
    const border = (s: string) => th.fg("border", s);
    const row = (s: string) => border("│") + " " + pad(s, contentWidth) + " " + border("│");
    const divider = border(`├${"─".repeat(width - 2)}┤`);
    const taskLabel = th.fg(this.state.detailFocus ? "muted" : "accent", `Tasks · ${records.length}`);
    const detailLabel = th.fg(this.state.detailFocus ? "accent" : "muted", `${paneTitle} · ${scrolling}`);
    const leftRows = Array.from({ length: listHeight }, (_, i) => left[i] ?? "");
    const rightRows = Array.from({ length: detailHeight }, (_, i) => right[i] ?? "");
    // One outer frame only: a single divider separates the two content regions.
    const columns = (l: string, r: string) => row(pad(l, listWidth) + border(" │ ") + pad(r, detailWidth));
    const body = wide
      ? [columns(taskLabel, detailLabel), ...leftRows.map((line, i) => columns(line, rightRows[i]!))]
      : [row(taskLabel), ...leftRows.map(row), divider, row(detailLabel), ...rightRows.map(row)];
    return [
      border(`╭─ Subagents ${"─".repeat(width - 14)}╮`),
      row(header), row(modelLine), row(shortcuts), divider,
      ...body, divider,
      row(th.fg("muted", "↑↓ select/scroll · Tab focus · PgUp/PgDn · Home/End")),
      row(th.fg("muted", "m message · a answer · c continue · x cancel · Esc close")),
      border(`╰${"─".repeat(width - 2)}╯`),
    ];
  }
  invalidate(): void { this.layout = undefined; this.scroll.invalidate(); }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  close(): void { this.finish(); }
}

// Includes interactions temporarily outside the overlay in a native dialog.
const sessions = new Set<{ close: () => void }>();
export function closeDashboards(): void { for (const session of [...sessions]) session.close(); }
export async function taskDashboard(
  manager: TaskManager, ctx: ExtensionContext, content: Content,
  perform: (id: string, action: TaskAction) => Promise<void>,
): Promise<void> {
  const state = dashboardState();
  let closed = false, component: TaskDashboard | undefined;
  const session = { close() { closed = true; component?.close(); } };
  sessions.add(session);
  try {
    while (!closed) {
      let action: DashboardAction | undefined;
      try {
        action = await ctx.ui.custom<DashboardAction | undefined>((tui, theme, keys, done) => {
          component = new TaskDashboard(manager, state, tui, theme, keys, done, content);
          return component;
        }, { overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 } });
      } finally { component?.dispose(); component = undefined; }
      if (!action || closed) break;
      // Native editors/confirmation dialogs must never be nested inside a focused overlay.
      try { await perform(action.id, action.action); }
      catch (error) { ctx.ui.notify(`Subagent action failed: ${String(error)}`, "error"); }
    }
  } finally { session.close(); sessions.delete(session); }
}
