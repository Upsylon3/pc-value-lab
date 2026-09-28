# PC Value Lab

Find the best-value used PC. Add listings, and the app ranks them by real performance per euro.

**Live:** https://upsylon3.github.io/pc-value-lab/

## How to use it

1. **Add a PC** – search its CPU and GPU, enter the price. That's all that's required.
2. **Unknown RAM or SSD?** Tick "I don't know" and the app assumes 16 GB DDR4 / 1000 GB SSD. Assumed values are marked with `~` in the results.
3. **Compare** – the best deal rises to the top. Sort by value, power, price and more, or star your favourites.

## What the scores mean

- **Performance** – CPU, GPU, RAM and storage compared with a yardstick PC (100%), then weighted. Pick a profile in Settings (Balanced / Gaming / Work) or fine-tune under "Advanced".
- **Value** – performance divided by price, shown from 0 to 100 (100 = best deal in your list).
- DDR4 is slightly penalised against DDR5 (adjustable). Looks can optionally influence the score (off by default).

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

## Updating the built-in parts list

Edit `builtin-parts.js` (format: `[name, score]` pairs under `cpus` and `gpus`). Anything added through the app or the admin tab overrides the built-in entry with the same name.

## Run locally

Open `index.html` in a browser. No build step, no dependencies. Without `config.js` values it runs fully offline.

## Notes

Benchmark values are PassMark CPU Mark / G3D Mark and are only as current as the data in the list. Add or correct entries whenever you need to.
