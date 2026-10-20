# Realm Clash online server

This small program runs online 1v1 matches for Realm Clash: quick-match queue, private rooms with 5-letter codes, live input sync between the two players, an Elo ranking with a top-20 leaderboard, and friend codes + gift chests between players.

## Put it online for free (Render)

1. Create a free account at https://github.com and make a new repository (for example `realm-clash-server`).
2. Upload the three files from this folder: `server.js`, `package.json`, `README.md` (drag them onto the repository page and click **Commit**).
3. Create a free account at https://render.com and click **New → Web Service**.
4. Connect your GitHub account and pick the `realm-clash-server` repository.
5. Settings:
   - Runtime: **Node**
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: **Free**
   - Region: **Frankfurt (EU Central)** — the closest to Israel. The default (Oregon, US) adds about a quarter of a second of delay to every move.
6. Click **Create Web Service** and wait until it says **Live**.
7. Copy the address at the top, for example `https://realm-clash-server.onrender.com`, and change `https` to `wss`:
   `wss://realm-clash-server.onrender.com`

## Keep accounts forever (free, 5 minutes)

Players can sign in (top-right button in the game) with a username and password, and their level, coins and items are saved on this server.
On Render's free plan files are wiped whenever the server restarts, so connect a free database:

1. Create a free account at https://upstash.com → **Create Database** (type Redis, any region near Frankfurt, free plan).
2. On the database page, open the **REST API** section and copy `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
3. In Render → your service → **Environment** → add both as environment variables with exactly those names → **Save** (the server restarts).
4. The Render log should now say `Storage: Upstash`. Accounts and the leaderboard are now kept forever.

## Connect the game

Open the game on Netlify → **Online 1v1** → paste the `wss://…` address → **Connect**.
The address is remembered in your browser. To fill it in for everyone, open `index.html`, find `const DEFAULT_SERVER='';` and put your address between the quotes, then upload the site again.

## Good to know

- Online fights use lockstep: both computers run the exact same fight, step by step, from both players' button presses. The two browsers also try to connect directly to each other (WebRTC); when that works the server only introduces the players and the delay is tiny. The small text under the timer shows `Direct` or `Server` and the ping.
- If your server is already on Render in another region, create a new Web Service in Frankfurt (Render can't move an existing one) and use its new address.
- Both players need the latest version of the game (refresh the page); an old version can't play against the new one.

- On Render's free plan the server goes to sleep after about 15 minutes without players. The first connection after that takes up to a minute while it wakes up.
- The ranking is stored in `ratings.json` on the server. On the free plan that file is wiped when the server restarts or redeploys, so the leaderboard starts fresh. A paid plan with a disk keeps it.
- Quick match is ranked (rating changes). Private rooms are friendly (no rating change).
- Test on your own computer: install Node.js, run `npm install` then `npm start` in this folder, and connect the game to `ws://localhost:8080`.
