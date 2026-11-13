import { createScreen, type Element } from "./screen";
import { loadValues, type SettingsValues } from "./settings";
import manifest from "./appmeta/manifest.json";

/** The name the app draws under; the device clears elements by this id. */
const APP = manifest.id;

const WHITE = "#FFFFFFFF";
const GRAY = "#A0A0A0FF";
const YELLOW = "#FFC000FF";
const RED = "#FF2020FF";

type Settings = {
  url: string;
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

/** The settings, with the defaults of settings.json for any value the bar does not return. */
function settingsFrom(values: SettingsValues | null): Settings {
  const text = (key: string, fallback: string) => (typeof values?.[key] === "string" ? (values[key] as string) : fallback);
  const int = (key: string, fallback: number) => (typeof values?.[key] === "number" ? (values[key] as number) : fallback);
  return {
    url: text("url", "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"),
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

/** 1234567.8 → "1,234,568"; below 1000 up to two decimals: 23.46. */
function format(value: number): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs < 1000) return `${sign}${Math.round(abs * 100) / 100}`;
  let text = String(Math.round(abs));
  for (let i = text.length - 3; i > 0; i -= 3) text = `${text.slice(0, i)},${text.slice(i)}`;
  return `${sign}${text}`;
}

/**
 * The front display: the number large, right-aligned; the label small on the left, with the unit under it. Nothing
 * here needs a text measured, so the bar's layout engine and its font tables stay out of the 128 KiB heap, which is
 * left for the JSON answer.
 */
function frame(s: Settings, value: number | null): Element[] {
  const color = value === null ? WHITE : s.red > 0 && value >= s.red ? RED : s.yellow > 0 && value >= s.yellow ? YELLOW : WHITE;
  const out: Element[] = [
    { id: "value", type: "text", text: value === null ? "--" : format(value), font: "extra_large", color, x: 72, y: 8, align: "mid_right" },
    { id: "label", type: "text", text: s.label, font: "small", color: GRAY, x: 0, y: s.unit === "" ? 8 : 4, align: "mid_left" },
  ];
  if (s.unit !== "") out.push({ id: "unit", type: "text", text: s.unit, font: "small", color: GRAY, x: 0, y: 12, align: "mid_left" });
  return out;
}

/**
 * Entry point, called at the end of the file: the device runs this script from top to bottom and starts nothing by itself.
 */
function main(): void {
  const report = (err: unknown) => console.error(`${APP}: ${err instanceof Error ? err.message : String(err)}`);
  const screen = createScreen(APP, report);

  let settings: Settings | null = null;
  /** The last number read; null until the first answer and after a failed request. */
  let value: number | null = null;
  let loading = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  const draw = () => {
    if (!stopped && settings) screen.draw(frame(settings, value));
  };

  /** One request; a tick while it is unanswered is skipped. */
  function refresh(s: Settings): void {
    if (loading || stopped) return;
    loading = true;
    const headers: Record<string, string> = s.auth !== "" ? { Authorization: s.auth } : {};
    void fetch(s.url, { headers })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json: unknown) => {
        const n = pick(json, s.path);
        if (!isFinite(n)) throw new Error(`no number at ${s.path}`);
        value = n;
      })
      .catch((err: unknown) => {
        value = null;
        report(err);
      })
      .then(() => {
        loading = false;
        draw();
      });
  }

  // The listener keeps the app alive; a long Back is handled by the firmware and quits it.
  const unbind = listen("input", (event) => {
    if (stopped || event.key !== "back" || event.action !== "short") return;
    // Back leaves the app: with the timer cleared and the handler detached, nothing keeps it alive.
    stopped = true;
    if (timer !== undefined) clearInterval(timer);
    // Not detached from inside the handler itself: the unbind would stop the app while this handler still runs.
    setTimeout(unbind, 0);
  });

  void loadValues()
    .then((values) => {
      const s = settingsFrom(values);
      settings = s;
      draw();
      if (stopped) return;
      refresh(s);
      timer = setInterval(() => refresh(s), s.intervalS * 1000);
    })
    .catch(report);
}

main();
