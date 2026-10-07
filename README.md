# Realm Clash online server

This small program runs online 1v1 matches for Realm Clash: quick-match queue, private rooms with 5-letter codes, live input sync between the two players, and an Elo ranking with a top-20 leaderboard.

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
6. Click **Create Web Service** and wait until it says **Live**.
7. Copy the address at the top, for example `https://realm-clash-server.onrender.com`, and change `https` to `wss`:
   `wss://realm-clash-server.onrender.com`

## Connect the game

Open the game on Netlify → **Online 1v1** → paste the `wss://…` address → **Connect**.
The address is remembered in your browser. To fill it in for everyone, open `index.html`, find `const DEFAULT_SERVER='';` and put your address between the quotes, then upload the site again.

## Good to know

- On Render's free plan the server goes to sleep after about 15 minutes without players. The first connection after that takes up to a minute while it wakes up.
- The ranking is stored in `ratings.json` on the server. On the free plan that file is wiped when the server restarts or redeploys, so the leaderboard starts fresh. A paid plan with a disk keeps it.
- Quick match is ranked (rating changes). Private rooms are friendly (no rating change).
- Test on your own computer: install Node.js, run `npm install` then `npm start` in this folder, and connect the game to `ws://localhost:8080`.
