# WP/Connect arcade stations — run-sheet

Two stations for the WP/Connect × DigiCon 2026 gaming block: **FLIP MATCH** (`flip-match/`) and
**WP FLAPPY CHALLENGE** (`wp-bird/` - the folder, URL and game id keep the old `wp-bird` name on purpose). Both are plain static folders (no build step) and talk to CCE Play through
the identical `station.js` in each — keep those two files byte-identical.

How it works on the night: the TV shows a QR **before** anyone plays → the attendee scans it from
`cceplay.com/playlab/wpconnect` (or their camera app) → their username appears on the TV and START
unlocks → they play → the TV posts the run → it lands on the public leaderboard and ticks their quest.

The arcade has an **opening window** set in the CCE Play admin (*WP/Connect → Arcade*). Outside it
the TVs show "ARCADE CLOSED - opens <time>" instead of a QR, phones cannot check in, and the public
page says when it opens. The TV re-asks every minute, so it opens itself on time. A run already in
progress when the window closes still saves.

---

## 1. Setup (before doors)

- **Serve each game folder from its own station PC**, never from a remote host. Any static server
  works; the repo's `.claude/launch.json` has `wpconnect-flip-match` (port 5511) and
  `wpconnect-wp-bird` (5512) entries, which are just `python -m http.server`.
- Open the game in the station browser in **kiosk mode** (`--kiosk`). Lock down DevTools so nobody
  at the plinth can reach `admin.html`, view-source or the console: set the Chrome/Edge policy
  `DeveloperToolsAvailability = 2` under `HKLM\SOFTWARE\Policies\Google\Chrome` (or `...\Microsoft\Edge`).
  The station key sits in that browser's localStorage — treat the PC like it holds the key.
- **The keyboard stays in the staffer's pocket.** Attendees only need touch (WP Flappy Challenge) or the hand
  tracker / touch (Flip Match). Every staff key below is a keyboard key on purpose.
- On first load the **Station setup** overlay asks for the key: paste `KIOSK_API_KEY` (the same secret
  the LOCK & LOADOUT kiosk uses; it lives in Render's env for the backend). Leave *Station label*
  blank, or type a short name (`FLIP`, `FLAPPY`) — it shows on the TV and on players' phones.
- Wifi down at setup? The overlay says so and won't store a bad key. WP Flappy Challenge's layout script is
  vendored (`wp-bird/vendor/tailwind-3.4.17.js`) so a cold reload during an outage still boots.

## 2. Flip Match config

- Settle **Board size**, **Brand images**, **Preview seconds** and **Card face colour** in
  `flip-match/admin.html` (passcode `FLIP2026`) **before doors**. If you change the defaults
  (4 × 4 board = 8 pairs, 4 brand images repeating round-robin, 3 s preview, black card faces),
  *Export* the config and *Import* it on the backup device — the config lives in that browser only.
- Nobody opens `admin.html` during the block. The board ranks a **bigger board first** (pairs =
  cards ÷ 2), then fewest moves, then fastest time — so a run on a 2 × 2 board (2 pairs) can never
  outrank one on a 4 × 4 (8 pairs) — but a mid-event board change still splits the board into two
  tiers. Only **Board size** moves a run between tiers; **Brand images** never affects ranking.
  Settle it before doors.

## 2b. WP Flappy Challenge config

- `wp-bird/admin.html` (passcode `BIRD2026`) sets the menu **Title**, the menu
  **Logo** and the "Presented by" **Mark**, and the **Bird skins** gallery: up to 12 brand images.
  **Every run the bird wears one of them at random** (the same one for the whole run); an empty
  gallery means the default amber bird. Every upload is made the **same size**: transparent margins are
  trimmed and the logo is fitted into a 512 x 512 square with even padding, so no brand looks bigger
  or smaller on the bird than another (the hit circle never changes anyway). Skins uploaded before this
  rule show a **Make all skins the same size** button - press it, then Save. **Bird wears** picks a
  random brand each run (default) or one fixed skin. **Flap keys** lists the
  keyboard keys that flap - and press Start / restart - so an arcade button box wired to one key runs
  the whole station (default `W`; `N` stays the staff skip). Same rules as Flip Match:
  browser-only storage, same origin as the game, *Export* / *Import* to copy to the backup device.

## 3. Staff keys (on the game's start screen)

| Key | Does |
| --- | --- |
| `N` | Skip the current code and mint a fresh QR. Also the answer to "that's not my name on the screen". |

The station also heals itself: an unscanned QR rotates after 5 min (`?idle=<s>`), a scanned-but-never-
started claim is released after 2 min (`?claimIdle=<s>`), a failed mint retries on its own, and a
failed result post retries three times. **Screen stuck? Press `N`. Do not reload during a wifi outage.**

## 4. Rehearsal

- Smoke-test with a **throwaway CCE Play account**, not a real attendee's — every finished run lands
  on the public board.
- If rehearsal runs must not show on the night: press **Reset board** for each game in the CCE Play
  admin before doors (the rehearsal rows move to "Previous period"). Or, with Atlas access (the live
  URI is the commented-out one in `CCE-Play-Server/.env`), delete them - runs carry `createdAt`, so
  in the Mongo shell:
  ```js
  db.wpconnect_arcade_runs.deleteMany({ createdAt: { $lt: ISODate("2026-09-25T09:00:00Z") } })
  ```
  (09:00 UTC = 5 PM PHT on Sep 25). **This is destructive — check the count with `find(...).count()` first.**

## 5. If a row must go

**Use the CCE Play admin first** (*WP/Connect → Arcade*): each board has a **Remove run** button per
row, and **Reset board** starts a fresh period without deleting anything (older periods stay
browsable from the period dropdown). The Mongo shell is the fallback:

Collections: `wpconnect_arcade_runs` (leaderboard rows) and `wpconnect_arcade_sessions` (one per QR).
- Pull one run: `db.wpconnect_arcade_runs.deleteOne({ _id: ObjectId("...") })`.
- Clear a player from one board: `db.wpconnect_arcade_runs.deleteMany({ userId: ObjectId("..."), game: "wp-bird" })`.
- A bad username is fixed on the user record; the board reads it live and refreshes within 15 s.

## 6. Naming the winner

The public board shows **username + avatar only** by design. To reach someone: read the username off
the board and look them up in the CCE Play admin's user search, then record the handover on the
organizer's sheet. There is no in-app claim flow yet — see *Open questions*.

## 7. Projector

Put the boards on the talk projector / a spare screen during the gaming block:
`https://cceplay.com/playlab/wpconnect#leaderboards` (refreshes itself every 15 s).

## 8. Comms

Attendees need a CCE Play account **before** they scan (a scan by a logged-out phone bounces to
register and then completes — but registering while holding a 5-minute code is a bad first minute).
Pre-event email + a queue poster QR to `cceplay.com/register`: *"Create your CCE Play account before
the gaming block."*

## 9. After the session

Rotate (or unset) `KIOSK_API_KEY` on Render to freeze the boards. **The LOCK & LOADOUT kiosk shares
that key** — re-enter the new one there if it is deployed.

## 10. Open questions for the organizer

1. Is there a prize for the gaming block, and does **board rank** or **finishing both stations** earn
   it? (The page copy is hedged until this is answered; the seeder's `--description` flag updates
   the live card text without a Mongo shell.)
2. Do the stations / the board return for **DigiCon Oct 15–16**? If yes: set the new opening window
   in the admin and press **Reset board** on both boards before doors.

## Free play (no QR)

`wp-bird/trial.html` opens WP Flappy Challenge in **free play**: no QR, no station key, and nothing is
posted to CCE Play - the run is simply dropped. It is the same game file (`index.html?trial=1`) with
the network script swapped for a stub, so skins, flap keys and branding from `admin.html` all apply.
Use it to try a config or to let people play for fun; the leaderboard only takes runs from the real
station screen.

## Local testing

```
python -m http.server 5511 -d WPCONNECT/flip-match
```
then open `http://localhost:5511/?api=http://localhost:8000/api&debug&input=mouse` with the backend running
locally (`KIOSK_API_KEY` in its `.env`). `?input=mouse` lets the mouse drive Flip Match's hand cursor.
