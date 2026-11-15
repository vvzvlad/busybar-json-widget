# JSON Widget

A number or a line of text from any JSON or plain-text endpoint on your BUSY Bar, colored by your thresholds.

A JavaScript app for [BUSY Bar](https://busy.app). Work in progress.

## What it does

- Set a URL and the path to a field, such as `data.result[0].value[1]` for a Prometheus query or `results[0].series[0].values[0][1]` for InfluxDB 1.x, or take the whole answer as plain text.
- The front display shows your label, the number in large digits colored by the yellow and red thresholds; a plain-text answer that is no number follows the label and scrolls when it is long.
- OK switches the front display to a chart of the last 72 readings, with the latest value above it.
- The back display shows the number, the minimum and maximum of the history and the time of the last reading.
- Without a connection the last value stays, dimmed, with a red cross next to it.
- Settings: URL, answer format (JSON or plain text), field path, label and unit, interval, yellow and red thresholds, an optional Authorization header.

## Data

Whatever endpoint you point it at.

## Build

Node 24 and npm:

```sh
npm ci
npm run build         # dist/io.github.vvzvlad.jsonwidget.tgz
npm run app:install   # install it on a BUSY Bar connected over USB
npm run app:run       # start it
```

## License

[MIT](LICENSE)
