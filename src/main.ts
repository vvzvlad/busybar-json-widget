import { textWidth } from "@busy-app/busy-lib";
import { formatHM } from "@shared/datetime";
import { createScreen, type Element } from "./screen";
import { loadValues, type SettingsValues } from "./settings";
import manifest from "./appmeta/manifest.json";

/** The name the app draws under; the device clears elements by this id. */
const APP = manifest.id;

const WHITE = "#FFFFFFFF";
const GRAY = "#A0A0A0FF";
const YELLOW = "#FFC000FF";
const RED = "#FF2020FF";
/** A value the last request did not bring, kept from an earlier one, is drawn at this brightness. */
const DIM = 0.4;
/** The area under the chart's line is its colour at this brightness. */
const FILL = 0.25;

/** A plain-text answer is cut to this many characters. */
const MAX_TEXT = 100;
/** Pixels between the label and a text after it. */
const TEXT_GAP = 3;

/** Numbers kept in the history: one per poll, a column each of the chart. */
const HISTORY = 72;
/** localStorage key of the last good value and the history, a Kept as JSON. */
const KEPT_KEY = "kept";

/** The chart view: the label and the value small on the top line, the chart in the rows from CHART_TOP down. */
const CHART_TOP = 7;
const CHART_H = 16 - CHART_TOP;
const COLUMNS = 72;

/** The back display: the right edge of the numbers, a gap off the firmware's status bar, and the tops of the three rows under the value. */
const BACK_RIGHT = 146;
const BACK_ROWS = [42, 54, 66];

/** The no-connection picture, the same in every app; the text beside it starts this far right of it. */
const OFFLINE = ["! XPM2", "5 5 2 1", ". c none", "r c #FF3030", "r...r", ".r.r.", "..r..", ".r.r.", "r...r"].join("\n");
const OFFLINE_W = 6;

/**
 * Fonts that are never measured. Once textWidth is imported, busy-cli bundles into the heap the glyph map of every
 * font a literal `font:` names; one named by a constant is left out. Only `small`, of the label and the unit, is measured.
 */
const NUMBER_FONT = "extra_large";
const TEXT_FONT = "normal";

type Settings = {
  url: string;
  /** "text": the whole answer is the value, `path` is not used. */
  format: "json" | "text";
  path: string;
  label: string;
  unit: string;
  intervalS: number;
  /** 0: off. */
  yellow: number;
  red: number;
  /** Sent as the Authorization header when not empty. */
  auth: string;
};

/**
 * Where the value stands: no answer yet in this run (what is shown was kept from an earlier one), brought by the last
 * request, or the last request failed.
 */
type Freshness = "waiting" | "live" | "lost";

/** What is kept in localStorage, for a start without a connection. */
interface Kept {
  /** The source they came from, as sourceOf() writes it: what was kept for another source is not shown. */
  source: string;
  /** The last good value: a number, or a plain-text answer that is none. */
  value: number | string;
  /** When it came, ms since the epoch. */
  time: number;
  /** The last HISTORY numbers, oldest first; a text that is no number adds none. */
  values: number[];
}

/** The settings, with the defaults of settings.json for any value the bar does not return. */
function settingsFrom(values: SettingsValues | null): Settings {
  const text = (key: string, fallback: string) => (typeof values?.[key] === "string" ? (values[key] as string) : fallback);
  const int = (key: string, fallback: number) => (typeof values?.[key] === "number" ? (values[key] as number) : fallback);
  return {
    url: text("url", "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"),
    format: text("format", "json") === "text" ? "text" : "json",
    path: text("path", "bitcoin.usd"),
    label: text("label", "BTC"),
    unit: text("unit", ""),
    intervalS: int("interval_s", 60),
    yellow: int("yellow", 0),
    red: int("red", 0),
    auth: text("auth", ""),
  };
}

/** Follows a path of keys and list indexes ("data.result[0].value[1]") into parsed JSON; NaN when it is no number. */
function pick(json: unknown, path: string): number {
  let node = json;
  for (const key of path.match(/[^.[\]]+/g) ?? []) {
    node = node !== null && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined;
  }
  // Prometheus and others send numbers as strings.
  if (typeof node === "string" && node.trim() !== "") return Number(node);
  return typeof node === "number" ? node : NaN;
}

/** A plain-text answer, trimmed: a number when it is one, else the text cut to MAX_TEXT characters. */
function fromText(body: string): number | string {
  // The firmware draws a line break as a new line: a multi-line body becomes one line that can scroll.
  // Cut before the copies are made: only MAX_TEXT characters reach the screen.
  const text = body.slice(0, 10 * MAX_TEXT).replace(/\s+/g, " ").trim();
  const n = text === "" ? NaN : Number(text);
  return isFinite(n) ? n : text.slice(0, MAX_TEXT);
}

/** 1234567.8 → "1,234,568"; below 1000 up to two decimals: 23.46. */
function format(value: number): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs < 1000) return `${sign}${Math.round(abs * 100) / 100}`;
  let text = String(Math.round(abs));
  for (let i = text.length - 3; i > 0; i -= 3) text = `${text.slice(0, i)},${text.slice(i)}`;
  return `${sign}${text}`;
}

/** A colour, "#RRGGBBAA", at k of its brightness. */
function shade(color: string, k: number): string {
  let out = "#";
  for (let i = 1; i < 7; i += 2) out += Math.round(parseInt(color.slice(i, i + 2), 16) * k).toString(16).padStart(2, "0");
  return out + color.slice(7);
}

/** A colour as drawn: dimmed unless the last request brought the value. */
function fresh(color: string, freshness: Freshness): string {
  return freshness === "live" ? color : shade(color, DIM);
}

/** The colour of the thresholds for a number: red from `red`, yellow from `yellow`; white for anything else. */
function thresholdColor(s: Settings, value: number | string | null): string {
  return typeof value !== "number" ? WHITE : s.red > 0 && value >= s.red ? RED : s.yellow > 0 && value >= s.yellow ? YELLOW : WHITE;
}

/** The no-connection picture with its top left corner at x, y. */
function offline(x: number, y: number): Element {
  return { id: "offline", type: "xpmbitmap", data: OFFLINE, x, y, align: "top_left" };
}

/**
 * A text after the label and the unit, in a font with lowercase. The bar scrolls it in the room left only when it is
 * wider; one that fits stands still (emulator, firmware 1.3.1). After a failed request the unit's line starts with the
 * no-connection picture.
 */
function line(s: Settings, text: string, color: string, lost: boolean): Element {
  const left = Math.max(textWidth(s.label, "small"), (lost ? OFFLINE_W : 0) + textWidth(s.unit, "small"));
  const x = left > 0 ? left + TEXT_GAP : 0;
  return {
    id: "value",
    type: "text",
    text,
    font: TEXT_FONT,
    color,
    x,
    y: 8,
    align: "mid_left",
    width: 72 - x,
    scroll_rate: 1200,
    scroll_start_delay: 1500,
    scroll_repeat_delay: 1500,
  };
}

/**
 * The front display: a number large, right-aligned, or a text that is no number after the label; the label small on
 * the left, with the unit under it. Only the label and the unit are measured, with busy-lib's glyph map of the small
 * font; the layout engine and the other maps stay out of the 128 KiB heap, which is left for the answer. A value the
 * last request did not bring is dimmed, and after a failed request the no-connection picture comes before the unit.
 */
function frame(s: Settings, value: number | string | null, freshness: Freshness): Element[] {
  const lost = freshness === "lost";
  const color = fresh(thresholdColor(s, value), freshness);
  const gray = fresh(GRAY, freshness);
  const out: Element[] = [
    typeof value === "string"
      ? line(s, value, color, lost)
      : { id: "value", type: "text", text: value === null ? "--" : format(value), font: NUMBER_FONT, color, x: 72, y: 8, align: "mid_right" },
    { id: "label", type: "text", text: s.label, font: "small", color: gray, x: 0, y: s.unit === "" && !lost ? 8 : 4, align: "mid_left" },
  ];
  if (s.unit !== "") {
    out.push({ id: "unit", type: "text", text: s.unit, font: "small", color: gray, x: lost ? OFFLINE_W : 0, y: 12, align: "mid_left" });
  }
  if (lost) out.push(offline(0, 10));
  return out;
}

/** The label cut at its end to fit `room` px in the small font, so that a long one stops short of the value. */
function fit(label: string, room: number): string {
  let out = label;
  while (out.length > 0 && textWidth(out, "small") > room) out = out.slice(0, -1);
  return out;
}

/**
 * The history as the chart's line over the 72 columns, the newest number on the right: the history's low on the
 * chart's bottom row and its high on the top one; -1 in the columns left of the oldest.
 */
function chartLine(values: number[]): number[] {
  const low = Math.min(...values);
  const high = Math.max(...values);
  const line: number[] = [];
  for (let x = 0; x < COLUMNS; x++) {
    const v = values[x - (COLUMNS - values.length)];
    line.push(v === undefined ? -1 : high > low ? Math.round(((high - v) / (high - low)) * (CHART_H - 1)) : CHART_H >> 1);
  }
  return line;
}

/**
 * The line over the 72 columns as XPM2, in `color`, the area under it in a darker shade. In each column the line runs
 * from its row up or down to next to the row of the column before, so that a steep move stays one stroke.
 */
function chartXpm(line: number[], color: string): string {
  const rows = ["! XPM2", `${COLUMNS} ${CHART_H} 3 1`, ". c none", `l c ${color.slice(0, 7)}`, `f c ${shade(color, FILL).slice(0, 7)}`];
  for (let r = 0; r < CHART_H; r++) {
    let out = "";
    for (let x = 0; x < COLUMNS; x++) {
      const y = x < line.length ? line[x] : -1;
      const before = x > 0 && line[x - 1] >= 0 ? line[x - 1] : y;
      const top = before < y ? before + 1 : y;
      const bottom = before > y ? before - 1 : y;
      out += y < 0 || r < top ? "." : r <= bottom ? "l" : "f";
    }
    rows.push(out);
  }
  return rows.join("\n");
}

/**
 * The chart view, on OK: the history's chart on the whole width of the display in the colour of the thresholds for
 * the value, under a top line with the label and the value with its unit, small. Dimmed as the value is, and after a
 * failed request the no-connection picture comes before the label.
 */
function chartFrame(s: Settings, value: number | string | null, values: number[], freshness: Freshness): Element[] {
  const lost = freshness === "lost";
  const color = fresh(thresholdColor(s, value), freshness);
  const text = typeof value === "number" ? `${format(value)}${s.unit === "" ? "" : ` ${s.unit}`}` : fit(value ?? "--", 72 - TEXT_GAP);
  const label = fit(s.label, 72 - textWidth(text, "small") - (lost ? OFFLINE_W : 0) - TEXT_GAP);
  const out: Element[] = [
    { id: "label", type: "text", text: label, font: "small", color: fresh(GRAY, freshness), x: lost ? OFFLINE_W : 0, y: 3, align: "mid_left" },
    { id: "value", type: "text", text, font: "small", color, x: 72, y: 3, align: "mid_right" },
  ];
  if (values.length > 0) {
    out.push({ id: "chart", type: "xpmbitmap", data: chartXpm(chartLine(values), color), x: 0, y: CHART_TOP, align: "top_left" });
  }
  if (lost) out.push(offline(0, 1));
  return out;
}

/**
 * The back display: the value large on the right with the label and the unit small on the left, as on the front; under
 * it the history's min and max and the time the value came. In white, since its grays turn yellow and red into two dim
 * shades; dimmed as on the front.
 */
function backFrame(s: Settings, value: number | string | null, values: number[], time: number, freshness: Freshness): Element[] {
  const white = fresh(WHITE, freshness);
  const gray = fresh(GRAY, freshness);
  let main: Element;
  if (typeof value === "string") {
    const x = Math.max(textWidth(s.label, "small"), textWidth(s.unit, "small")) + TEXT_GAP;
    main = { id: "bvalue", type: "text", text: value, font: TEXT_FONT, color: white, x, y: 18, align: "mid_left", width: BACK_RIGHT - x, scroll_rate: 1200, scroll_start_delay: 1500, scroll_repeat_delay: 1500, display: "back" };
  } else {
    main = { id: "bvalue", type: "text", text: value === null ? "--" : format(value), font: NUMBER_FONT, color: white, x: BACK_RIGHT, y: 18, align: "mid_right", display: "back" };
  }
  const out: Element[] = [main, { id: "blabel", type: "text", text: s.label, font: "small", color: gray, x: 0, y: s.unit === "" ? 18 : 13, align: "mid_left", display: "back" }];
  if (s.unit !== "") out.push({ id: "bunit", type: "text", text: s.unit, font: "small", color: gray, x: 0, y: 23, align: "mid_left", display: "back" });
  const rows: [string, string][] = [
    ["Min", values.length > 0 ? format(Math.min(...values)) : "--"],
    ["Max", values.length > 0 ? format(Math.max(...values)) : "--"],
    ["Updated", time > 0 ? formatHM(new Date(time)) : "--"],
  ];
  rows.forEach(([caption, text], i) => {
    out.push(
      { id: `bcap${i}`, type: "text", text: caption, font: "small", color: gray, x: 0, y: BACK_ROWS[i], align: "top_left", display: "back" },
      { id: `brow${i}`, type: "text", text, font: "small", color: white, x: BACK_RIGHT, y: BACK_ROWS[i], align: "top_right", display: "back" },
    );
  });
  return out;
}

/** The url, format and path a value comes from. */
function sourceOf(s: Settings): string {
  return `${s.format} ${s.url} ${s.path}`;
}

/** The last good value and the history kept in localStorage, and the JSON they were read from; null without any. */
function kept(): { kept: Kept | null; json: string | null } {
  try {
    const json = localStorage.getItem(KEPT_KEY);
    return { kept: json ? (JSON.parse(json) as Kept) : null, json };
  } catch {
    return { kept: null, json: null };
  }
}

/**
 * Entry point, called at the end of the file: the device runs this script from top to bottom and starts nothing by itself.
 */
function main(): void {
  const report = (err: unknown) => console.error(`${APP}: ${err instanceof Error ? err.message : String(err)}`);
  const screen = createScreen(APP, report);

  let settings: Settings | null = null;
  /** The last good value: a number, or a plain-text answer that is none; kept from an earlier run, null without any. */
  let value: number | string | null = null;
  /** When the value came, ms since the epoch; 0 without one. */
  let time = 0;
  /** The last HISTORY numbers, oldest first. */
  let values: number[] = [];
  let freshness: Freshness = "waiting";
  /** What localStorage holds under KEPT_KEY, so that only a change is written. */
  let saved: string | null = null;
  /** The front shows the history's chart instead of the value. */
  let charting = false;
  let loading = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  const draw = () => {
    if (stopped || !settings) return;
    const front = charting ? chartFrame(settings, value, values, freshness) : frame(settings, value, freshness);
    screen.draw(front.concat(backFrame(settings, value, values, time, freshness)));
  };

  /** Writes the value and the history to localStorage when they differ from what it holds. */
  function keep(s: Settings): void {
    const json = JSON.stringify({ source: sourceOf(s), value, time, values });
    if (json === saved) return;
    try {
      localStorage.setItem(KEPT_KEY, json);
      saved = json;
    } catch (err) {
      report(err);
    }
  }

  /**
   * One request; a tick while it is unanswered is skipped. A good answer becomes the value, a number joins the history,
   * and both are kept in localStorage; a failed one leaves the last good value on the displays, dimmed.
   */
  function refresh(s: Settings): void {
    if (loading || stopped) return;
    loading = true;
    const headers: Record<string, string> = s.auth !== "" ? { Authorization: s.auth } : {};
    void fetch(s.url, { headers })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return s.format === "text" ? res.text() : res.json();
      })
      .then((body: unknown) => {
        if (s.format === "text") {
          value = fromText(body as string);
        } else {
          const n = pick(body, s.path);
          if (!isFinite(n)) throw new Error(`no number at ${s.path}`);
          value = n;
        }
        time = Date.now();
        if (typeof value === "number") {
          values.push(value);
          if (values.length > HISTORY) values.shift();
        }
        freshness = "live";
        keep(s);
      })
      .catch((err: unknown) => {
        freshness = "lost";
        report(err);
      })
      .then(() => {
        loading = false;
        draw();
      });
  }

  // The listener keeps the app alive; a long Back is handled by the firmware and quits it. OK turns the chart on and off.
  const unbind = listen("input", (event) => {
    if (stopped || event.action !== "short") return;
    if (event.key === "ok") {
      charting = !charting;
      draw();
      return;
    }
    if (event.key !== "back") return;
    // Back leaves the app: with the timer cleared and the handler detached, nothing keeps it alive.
    stopped = true;
    if (timer !== undefined) clearInterval(timer);
    // Not detached from inside the handler itself: the unbind would stop the app while this handler still runs.
    setTimeout(unbind, 0);
  });

  void loadValues()
    .then((fields) => {
      const s = settingsFrom(fields);
      settings = s;
      // The value and the history of an earlier run from the same source, dimmed until the first answer.
      const stored = kept();
      saved = stored.json;
      if (stored.kept && stored.kept.source === sourceOf(s)) ({ value, time, values } = stored.kept);
      draw();
      if (stopped) return;
      refresh(s);
      timer = setInterval(() => refresh(s), s.intervalS * 1000);
    })
    .catch(report);
}

main();
