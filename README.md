# Wedding Album Picker

A family app for shortlisting wedding photos, one event at a time.

- **Site** (`index.html`, GitHub Pages): the picking screen. Works on iPad, phone and computer.
- **Server** (`worker/`, Cloudflare Worker + D1): stores events, a small preview of every photo, and who kept which photo. Every request needs the family password.

How photos flow:

1. On the iPad with the disk, photos are chosen from an event folder. The app makes a large preview kept on that iPad and a small one (about 640 px) sent to the database. Originals never leave the disk.
2. Anyone with the family link or password browses the photos and presses Keep. Picks are recorded per person.
3. On the iPad, new picks are saved into the Shortlisted folder on the disk through the share sheet.

## Deploying the server

In the Cloudflare dashboard, open the `album-shortlist` Worker > Settings > Build, and connect this repository (branch `main`, deploy command `npx wrangler deploy`, root directory left as `/`). `wrangler.toml` points at `worker/worker.js`, binds the D1 database as `DB`, and serves the app's static files from the same Worker, so the Worker address is the app address.

Then add a secret named `KEY` (Settings > Variables and Secrets) holding the family password.

The tables are created automatically on first use.
