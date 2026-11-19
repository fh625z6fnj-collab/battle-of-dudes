# Dude Battle Arena - online play

Files: `index.html` / `dude-arena.html` (the game, same build), `server.js` (tiny lobby + relay server, no npm packages), `package.json`.

## 1. Try it on your own computer
1. Install Node.js 18 or newer.
2. In this folder run: `node server.js`
3. Open `http://localhost:3000` in two browser tabs (or two windows).
4. Tab 1: click the globe (top-left of the main menu) -> CREATE MATCH -> pick 1v1 or CO-OP -> you land in a **SQUAD LOBBY** with a 4-character code.
5. Tab 2: globe -> GAME CODE -> type the code -> JOIN -> both players are in the lobby.
6. The host presses the big yellow **PLAY** button to start the match.

Opening the game by double-click (file://) still works for offline play, but the online screens will tell you the server is needed.

## 2. Let friends join over the internet
The server must be reachable from the internet, and everyone must open the game through the server's URL (the page and the websocket come from the same address).

**Quick test (no hosting):** run `node server.js`, then in another terminal run `npx ngrok http 3000` (or `cloudflared tunnel --url http://localhost:3000`). Send your friend the https link it prints.

**Permanent hosting (Render, Railway, Fly.io, etc.):**
1. Put this folder in a GitHub repo.
2. Create a new "Web Service" from the repo. Start command: `node server.js`. The host sets the `PORT` variable; the server already reads it.
3. Open the https URL the host gives you. Share it plus the game code.

## 3. What's in this online build
* **Squad lobby (Fortnite-style)** - after CREATE or JOIN you both sit in a lobby: player cards with your level and loadout, mode picker, the room code chip up top. The host picks the mode; the guest sees the host's settings live.
* **Lobby persists between matches** - when a match ends (last round, dungeon cleared) everybody lands back in the same lobby together. Nobody gets dumped to the main menu until they press LEAVE.
* **Return to lobby** - there is a button on the result screens; leaving a match never yanks you to the main menu. If your friend quits mid-match you keep playing; a red banner appears and one click takes you back to the lobby.
* **1v1 round system (pop matches)** - in the lobby the host chooses FIRST TO 1 / 3 / 5. Lose a round, spectate for 3 seconds, the next round starts automatically with identical state on both screens. The server decides ties, so scores can't disagree. A final VICTORY / DEFEAT banner shows, then everyone is back in the lobby.
* **Spectator mode** - when you're eliminated in a 1v1 you don't get a dead screen: your camera locks onto your opponent and follows them (SPECTATOR MODE banner), including between rounds.
* **3-second revive system (co-op)** - when you fall in co-op you're DOWN, not out: a 3-second countdown revives you automatically at full health with brief spawn protection (right next to your ally if they're alive). Your partner sees "ALLY IS DOWN - REVIVING". No more ending the run because someone got clipped.
* **Synced enemies** - in co-op the host broadcasts enemy position/health snapshots twice a second and the guest smoothly converges onto them, so both players fight the same enemies in the same places instead of drifting apart.
* **Friends list** - in the ONLINE tab (and from the lobby): add friends by gamertag, see who's online / in a lobby, invite them straight into your lobby (they get a JOIN banner), remove them. Friend data lives in the server's memory while it runs.

## 4. How the modes work
* **1v1 duel (rounds)**: each player controls their own character. Shots, melee swings and fireballs are relayed; when someone drops to 0 HP the round ends, the server scores it, both players see the same result, and the next round (or the result screen) follows automatically.
* **Co-op dungeon**: both players get the same dungeon (same random seed from the server). The host also streams enemy snapshots so both screens match. Every hit is shared so enemy health and kills stay in sync. You see your partner, their shots, and their revive state.
* Free hosting plans often sleep when idle, so the first load can take about 30 seconds.
