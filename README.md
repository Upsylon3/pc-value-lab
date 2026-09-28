# PC Value Lab

A small browser-based tool for comparing used PCs by hardware, performance, price, and personal preference.

## What it does

- Compares CPU and GPU performance against a reference PC.
- Scores RAM and storage separately.
- Lets you change the weighting used for the overall score.
- Keeps a separate **Value / price** measure for bargain hunting.
- Lets you mark listings as favourites and filter to your shortlist.
- Stores listings and custom CPU/GPU references in the browser with `localStorage`.
- Exports and imports the comparison data as JSON.
- Works as a single static page: no server and no build step required.

## Data and privacy

The app does not need an account or backend. Listings are stored in the browser that you use to open the page. Export a JSON backup when you want to move the data to another browser or device.

The repository itself does not contain your saved listings unless you deliberately commit an exported JSON file. Do not commit a backup if it contains information you want to keep private.

## Run locally

Open `index.html` in a browser.

For a local web server, any static server will work; no package installation is required.

## GitHub Pages

This repository is ready to publish with GitHub Pages using the `main` branch and the repository root as the publishing source.

Once Pages is enabled, the site is served from `index.html` at the published Pages URL.

## Notes

This is a client-side calculator, so the scoring model is intentionally transparent in the page source. Benchmark values in the built-in reference lists are only as current as the data included in the file; add or edit custom references when needed.
