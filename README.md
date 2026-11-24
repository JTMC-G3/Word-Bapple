# Word Bapple

A party word game. Go around the circle naming words that start with the letter in the bubble, starting with **A**. If you run out of time, you're out, and the letter moves on to **B**. Last player standing wins.

## Two ways to play
- **Same room**: pass one phone or laptop around.
- **Online**: everyone plays from their own device. One person creates a game and shares the 4-letter code.

## Run it in GitHub Codespaces
1. Open the repo in a Codespace. The dev container starts the server automatically (`npm start`) on port 3000.
2. Open the **Ports** tab, right-click port 3000 and set **Port Visibility → Public**. Otherwise only you can open it.
3. Share the forwarded `https://...app.github.dev` address with your friends.

Run it anywhere else with Node 18 or newer:

```sh
npm start          # or: node server.js
PORT=8080 npm start
```

No `npm install` needed. The server has no dependencies.

## Dictionary
Words are checked on the server, so nobody can sneak in a made-up word:
1. First against `words.txt`, a bundled list of 274,000 English words. This is instant.
2. Words not on that list are looked up with the [Free Dictionary API](https://dictionaryapi.dev/), so newer or rarer words can still count. Results are cached.

If the API can't be reached, only words on the bundled list count. Set `DICT_API=off` to use only the list.

## Rules
1. Name a real English word that starts with the current letter.
2. No repeats on the same letter.
3. Run out of time, or press **I'm stuck**, and you're out.
4. When someone is out, the next letter starts.
5. Last player standing wins.

Options:
- **Start on letter**: begin on any letter A–Z, or pick **Random letter**.
- **New letter after every word**: the letter moves on (A, B, C…) every time someone says a word, not only when someone is out.
- Seconds per turn, a clock that speeds up every word, and skipping Q/X/Z. In same-room mode you can also choose **Say it** (say the word out loud and tap) and use **Challenge** to vote out a fake word.

The word list comes from the [`word-list`](https://github.com/sindresorhus/word-list) package (MIT license, see `WORDS-LICENSE.txt`).
