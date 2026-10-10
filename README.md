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

- **Available only** – hides listings marked unavailable (paused, sold). Combines with All / Favourites / DDR5 only.
- **Logically worth only** – hides any listing that costs more than a more powerful one. Listings at the same price all stay, so sorted by power the prices only go down the list.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | the whole app |
| `builtin-parts.js` | built-in CPU/GPU benchmark list |
| `config.js` | shared-database connection (Supabase URL + key) |
| `setup.sql` | database setup (safe to run again) |
| `scripts/supabase-keepalive.mjs` | keeps the free Supabase project awake |
| `.github/workflows/supabase-keepalive.yml` | runs that script every day |
| `favicon.png` | icon |

## Data and privacy

- **Your listings** stay in your browser (`localStorage`) unless you sign in to an account (see Accounts). Settings → Export backup always works, for moving or sharing listings. Import adds the backup's listings to yours and never deletes anything.
- **CPU/GPU scores** are shared: when someone adds a part that isn't in the list, it's saved to the shared database and every visitor gets it automatically. This only works once the database below is connected. Until then, parts are saved on the device only.
- Accounts are optional. Nothing personal is collected beyond the email and password of an account you choose to create.

## One-time setup: shared database + admin

The site is static (GitHub Pages), so shared data lives in a free [Supabase](https://supabase.com) project.

1. Create a Supabase project.
2. Open the **SQL Editor**, paste `setup.sql`, change `YOUR_PASSPHRASE` to your own passphrase, then run it. Running it again later is safe: it only adds what is missing, and never changes an existing passphrase.
3. Go to **Project Settings → API** and copy the project URL and the publishable (anon) key into `config.js`.
4. Commit `index.html`, `builtin-parts.js`, `config.js` and `favicon.png` to the repo root.

The URL and anon key are meant to be public, so committing `config.js` is fine. The database is protected by row-level security. Visitors can read parts and add new ones, but can't edit or delete anything.

## Admin (no GitHub push needed)

Open the **Admin** link in the page footer and enter your passphrase to:

- **Publish the default yardstick** – set the reference CPU/GPU in Settings, then publish it. Every visitor starts with it from then on.
- **Edit or delete shared parts** – fix a wrong score or remove junk entries.

Visitors who choose their own yardstick in Settings keep their own; "Reset to default" returns them to yours.

## Accounts

Optional. Settings → Account lets you create an account (email + password) so your listings follow you between devices. No email is ever sent. Without an account nothing changes.

- Each account owns one private row in the database. Row-level security means you can only read or change your own.
- Every listing has an id and a last-edited time. When two devices have been edited apart, the newest version of each listing wins, a listing only one device has is kept, and a deletion on one device reaches the others.
- The first time you sign in, the listings already on that device are added to your account. The same listing on two devices is not doubled.
- **Sign out** asks whether to also remove the listings from this device. They stay in your account.
- There is no password reset yet. Keep an exported backup.

To switch it on, run the latest `setup.sql` once, then in Supabase go to **Authentication → Sign In / Providers → Email** and switch **Confirm email** off. If it stays on, a new account has to be confirmed from an email first.

## Keeping Supabase awake

The free tier pauses a project after about a week without any use. `.github/workflows/supabase-keepalive.yml` sends one small request every day, which is enough to prevent it.

If a project is paused anyway, the same workflow can restore it, if you give it permission:

1. In Supabase, open **Account → Access Tokens** and generate a token.
2. In the GitHub repo, go to **Settings → Secrets and variables → Actions**, add a secret named `SUPABASE_ACCESS_TOKEN` with that token.

If the project cannot be reached and cannot be restored, the run fails and GitHub emails you. A paused project can only be restored for 90 days. GitHub also switches off scheduled workflows after 60 days without any repository activity, so if the Actions tab shows it disabled, re-enable it. You can run it by hand from there at any time.

## Roadmap

- **Import from ads** – paste a list of ad links (or the ad text) and get price, link and any CPU / GPU / RAM / storage found in the title or description filled in, leaving blanks where it is unsure. A pass over Leboncoin favourites is not possible from the site itself, since favourites sit behind your login.

## Updating the market model

RAM, SSD, GPU and CPU prices sit in the `MARKET` block at the top of the script in `index.html` (with the sources in the comment above it). Change the numbers and the date; the weights and the DDR3 / DDR4 / DDR5 values follow. Only the ratios matter, so US dollars are fine even if you use euros in the app.

## Updating the built-in parts list

Edit `builtin-parts.js` (format: `[name, score]` pairs under `cpus` and `gpus`). Anything added through the app or the admin tab overrides the built-in entry with the same name.

## Run locally

Open `index.html` in a browser. No build step, no dependencies. Without `config.js` values it runs fully offline.

## Notes

Benchmark values are PassMark CPU Mark / G3D Mark and are only as current as the data in the list. Add or correct entries whenever you need to.
