# Scam or Steal

Find the best-value used PC. Add listings, and the app ranks them by real performance per euro.

**Live:** https://upsylon3.github.io/pc-value-lab/

## How to use it

1. **Add a PC** – search its CPU and GPU, enter the price. That's all that's required.
2. **Unknown RAM or SSD?** Tick "I don't know" and the app assumes 16 GB DDR4 / 1000 GB SSD. Assumed values are marked with `~` in the results.
3. **Setup included?** Tick it on a listing and the app takes the setup's value (default €150, change it in Settings or per listing) off the price, so the PC is ranked at its real price.
4. **Compare** – the best deal rises to the top. Sort by value, power, price and more, star your favourites, and mark listings that went offline as unavailable.

## What the scores mean

- **Performance** – CPU, GPU, RAM and storage compared with a yardstick PC (100%), then weighted by what a typical 2026 build spends on each part (today roughly GPU 41%, CPU 16%, RAM 35%, storage 8%). RAM and storage are valued at market price per GB, so DDR5 counts for more than DDR4 by what it really costs.
- **Value** – performance divided by price (minus an included setup), shown from 0 to 100 (100 = best deal among the available listings).
- Looks can optionally influence the score (off by default).

## Ranking filters

[#ranking-filters](#ranking-filters)

- **Available only** – hides listings marked unavailable (paused, sold). Combines with All / Favourites / DDR5 only.
- **Logically worth only** – hides any listing that costs more than a more powerful one. Listings at the same price all stay, so sorted by power the prices only go down the list.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | the whole app |
| `builtin-parts.js` | built-in CPU/GPU benchmark list |
| `config.js` | shared-database connection (Supabase URL + key) |
| `setup.sql` | one-time database setup |
| `favicon.png` | icon |

## Data and privacy

- **Your listings** never leave your browser (`localStorage`). Use Settings → Export backup to move them between devices.
- **CPU/GPU scores** are shared: when someone adds a part that isn't in the list, it's saved to the shared database and every visitor gets it automatically. This only works once the database below is connected. Until then, parts are saved on the device only.
- Nothing personal is collected. No accounts.

## One-time setup: shared database + admin

The site is static (GitHub Pages), so shared data lives in a free [Supabase](https://supabase.com) project.

1. Create a Supabase project.
2. Open the **SQL Editor**, paste `setup.sql`, change `YOUR_PASSPHRASE` to your own passphrase, then run it.
3. Go to **Project Settings → API** and copy the project URL and the publishable (anon) key into `config.js`.
4. Commit `index.html`, `builtin-parts.js`, `config.js` and `favicon.png` to the repo root.

The URL and anon key are meant to be public, so committing `config.js` is fine. The database is protected by row-level security. Visitors can read parts and add new ones, but can't edit or delete anything.

## Admin (no GitHub push needed)

Open the **Admin** link in the page footer and enter your passphrase to:

- **Publish the default yardstick** – set the reference CPU/GPU in Settings, then publish it. Every visitor starts with it from then on.
- **Edit or delete shared parts** – fix a wrong score or remove junk entries.

Visitors who choose their own yardstick in Settings keep their own; "Reset to default" returns them to yours.

## Roadmap

[#roadmap](#roadmap)

- **Accounts** – sign in so your listings follow you between devices, instead of exporting and importing a backup file. Planned on the existing Supabase project (login by email link, each person sees only their own listings). The "no accounts" line under Data and privacy will change with it.
- **Import from ads** – paste a list of ad links (or the ad text) and get price, link and any CPU / GPU / RAM / storage found in the title or description filled in, leaving blanks where it is unsure. A pass over Leboncoin favourites is not possible from the site itself, since favourites sit behind your login.

## Updating the market model

[#updating-the-market-model](#updating-the-market-model)

RAM, SSD, GPU and CPU prices sit in the `MARKET` block at the top of the script in `index.html` (with the sources in the comment above it). Change the numbers and the date; the weights and the DDR3 / DDR4 / DDR5 values follow. Only the ratios matter, so US dollars are fine even if you use euros in the app.

## Updating the built-in parts list

Edit `builtin-parts.js` (format: `[name, score]` pairs under `cpus` and `gpus`). Anything added through the app or the admin tab overrides the built-in entry with the same name.

## Run locally

Open `index.html` in a browser. No build step, no dependencies. Without `config.js` values it runs fully offline.

## Notes

Benchmark values are PassMark CPU Mark / G3D Mark and are only as current as the data in the list. Add or correct entries whenever you need to.
