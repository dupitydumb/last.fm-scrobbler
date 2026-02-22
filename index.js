// ═══════════════════════════════════════════════════════════════════════════
// LAST.FM SCROBBLER  v2.0  —  Audion Plugin
// ═══════════════════════════════════════════════════════════════════════════
//
// SCROBBLING RULES  (https://www.last.fm/api/scrobbling)
//   • track.updateNowPlaying  — send immediately when a track starts
//   • track.scrobble          — send after min(duration × 50%, 4 min) of
//                               *actual* play time has elapsed
//   • Minimum 30 s of real play time required before any scrobble is accepted
//   • Tracks shorter than 30 s are never scrobbled
//   • Up to 50 scrobbles per batch API call
//
// AUTH  (Last.fm web auth — Tauri-safe)
//   Tauri webviews have no real URL bar so window.location.search is always
//   empty — the normal redirect-callback flow doesn't work.  Instead:
//     1. "Open Last.fm" button opens the auth page in the SYSTEM browser
//     2. User authorises, Last.fm shows a page with ?token=XXX in the URL
//     3. User copies that token and pastes it into the input field here
//     4. Plugin calls auth.getSession(token) → permanent session_key stored
//
// HISTORY IMPORT
//   After connecting, the panel offers to import your existing Audion library
//   to Last.fm as backdated scrobbles.  Uses api.library.getTracks() (needs
//   the library:read permission) to get all tracks, then sends them in batches
//   of 50 with timestamps spaced 5 minutes apart going back in time.
//   The user chooses whether to run this — it's never automatic.
//
// API SIGNATURES
//   MD5(sorted param names+values concatenated + api_secret).
//   The api_secret is embedded client-side.  This is the standard approach
//   for every desktop scrobbler (foobar2000, Clementine, etc.) and is
//   explicitly supported by Last.fm's authentication model.
//
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  "use strict";

  // ── Credentials ─────────────────────────────────────────────────────────
  // Get your own at https://www.last.fm/api/account/create
  const API_KEY    = "a12a4fd56a0aad267afc582c37612df0";
  const API_SECRET = "2bdb82a141465ed0b3ffd1abd7ce907b";
  const API_ROOT   = "https://ws.audioscrobbler.com/2.0/";

  // ── Thresholds ───────────────────────────────────────────────────────────
  const MIN_DURATION_S  = 30;      // never scrobble tracks shorter than this
  const MAX_PLAY_S      = 240;     // 4-minute play-time cap for scrobble trigger
  const SCROBBLE_PCT    = 0.50;    // trigger at 50% of duration
  const QUEUE_MAX       = 500;     // max size of offline retry queue
  const FLUSH_MS        = 15_000;  // flush offline queue every 15 s
  const IMPORT_BATCH    = 50;      // scrobbles per API call during history import
  const IMPORT_DELAY_MS = 1_200;   // ms pause between import batches (rate-limit safety)
  const IMPORT_SPACING  = 5 * 60; // seconds between backdated timestamps

  // ═══════════════════════════════════════════════════════════════════════
  // MD5  (pure JS, synchronous — needed for Last.fm API signatures)
  // ═══════════════════════════════════════════════════════════════════════
  function md5(str) {
    function safeAdd(x, y) {
      const l = (x & 0xffff) + (y & 0xffff);
      return (((x >> 16) + (y >> 16) + (l >> 16)) << 16) | (l & 0xffff);
    }
    const RL  = (n, c) => (n << c) | (n >>> (32 - c));
    const FF  = (a,b,c,d,x,s,t) => safeAdd(RL(safeAdd(safeAdd(a,(b&c)|(~b&d)),safeAdd(x,t)),s),b);
    const GG  = (a,b,c,d,x,s,t) => safeAdd(RL(safeAdd(safeAdd(a,(b&d)|(c&~d)),safeAdd(x,t)),s),b);
    const HH  = (a,b,c,d,x,s,t) => safeAdd(RL(safeAdd(safeAdd(a,b^c^d),safeAdd(x,t)),s),b);
    const II  = (a,b,c,d,x,s,t) => safeAdd(RL(safeAdd(safeAdd(a,c^(b|~d)),safeAdd(x,t)),s),b);

    const utf8  = unescape(encodeURIComponent(str));
    const bytes = Array.from(utf8, c => c.charCodeAt(0));
    const len8  = bytes.length;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    const bits = len8 * 8;
    bytes.push(bits&255,(bits>>8)&255,(bits>>16)&255,(bits>>24)&255,0,0,0,0);

    let a=0x67452301, b=0xefcdab89, c=0x98badcfe, d=0x10325476;
    for (let i = 0; i < bytes.length; i += 64) {
      const W = Array.from({length:16}, (_,j) =>
        bytes[i+j*4] | (bytes[i+j*4+1]<<8) | (bytes[i+j*4+2]<<16) | (bytes[i+j*4+3]<<24));
      let [A,B,C,D] = [a,b,c,d];
      // Round 1
      a=FF(a,b,c,d,W[0],7,-680876936);  d=FF(d,a,b,c,W[1],12,-389564586);
      c=FF(c,d,a,b,W[2],17,606105819);  b=FF(b,c,d,a,W[3],22,-1044525330);
      a=FF(a,b,c,d,W[4],7,-176418897);  d=FF(d,a,b,c,W[5],12,1200080426);
      c=FF(c,d,a,b,W[6],17,-1473231341);b=FF(b,c,d,a,W[7],22,-45705983);
      a=FF(a,b,c,d,W[8],7,1770035416);  d=FF(d,a,b,c,W[9],12,-1958414417);
      c=FF(c,d,a,b,W[10],17,-42063);    b=FF(b,c,d,a,W[11],22,-1990404162);
      a=FF(a,b,c,d,W[12],7,1804603682); d=FF(d,a,b,c,W[13],12,-40341101);
      c=FF(c,d,a,b,W[14],17,-1502002290);b=FF(b,c,d,a,W[15],22,1236535329);
      // Round 2
      a=GG(a,b,c,d,W[1],5,-165796510);  d=GG(d,a,b,c,W[6],9,-1069501632);
      c=GG(c,d,a,b,W[11],14,643717713); b=GG(b,c,d,a,W[0],20,-373897302);
      a=GG(a,b,c,d,W[5],5,-701558691);  d=GG(d,a,b,c,W[10],9,38016083);
      c=GG(c,d,a,b,W[15],14,-660478335);b=GG(b,c,d,a,W[4],20,-405537848);
      a=GG(a,b,c,d,W[9],5,568446438);   d=GG(d,a,b,c,W[14],9,-1019803690);
      c=GG(c,d,a,b,W[3],14,-187363961); b=GG(b,c,d,a,W[8],20,1163531501);
      a=GG(a,b,c,d,W[13],5,-1444681467);d=GG(d,a,b,c,W[2],9,-51403784);
      c=GG(c,d,a,b,W[7],14,1735328473); b=GG(b,c,d,a,W[12],20,-1926607734);
      // Round 3
      a=HH(a,b,c,d,W[5],4,-378558);     d=HH(d,a,b,c,W[8],11,-2022574463);
      c=HH(c,d,a,b,W[11],16,1839030562);b=HH(b,c,d,a,W[14],23,-35309556);
      a=HH(a,b,c,d,W[1],4,-1530992060); d=HH(d,a,b,c,W[4],11,1272893353);
      c=HH(c,d,a,b,W[7],16,-155497632); b=HH(b,c,d,a,W[10],23,-1094730640);
      a=HH(a,b,c,d,W[13],4,681279174);  d=HH(d,a,b,c,W[0],11,-358537222);
      c=HH(c,d,a,b,W[3],16,-722521979); b=HH(b,c,d,a,W[6],23,76029189);
      a=HH(a,b,c,d,W[9],4,-640364487);  d=HH(d,a,b,c,W[12],11,-421815835);
      c=HH(c,d,a,b,W[15],16,530742520); b=HH(b,c,d,a,W[2],23,-995338651);
      // Round 4
      a=II(a,b,c,d,W[0],6,-198630844);  d=II(d,a,b,c,W[7],10,1126891415);
      c=II(c,d,a,b,W[14],15,-1416354905);b=II(b,c,d,a,W[5],21,-57434055);
      a=II(a,b,c,d,W[12],6,1700485571); d=II(d,a,b,c,W[3],10,-1894986606);
      c=II(c,d,a,b,W[10],15,-1051523);  b=II(b,c,d,a,W[1],21,-2054922799);
      a=II(a,b,c,d,W[8],6,1873313359);  d=II(d,a,b,c,W[15],10,-30611744);
      c=II(c,d,a,b,W[6],15,-1560198380);b=II(b,c,d,a,W[13],21,1309151649);
      a=II(a,b,c,d,W[4],6,-145523070);  d=II(d,a,b,c,W[11],10,-1120210379);
      c=II(c,d,a,b,W[2],15,718787259);  b=II(b,c,d,a,W[9],21,-343485551);
      a=safeAdd(a,A); b=safeAdd(b,B); c=safeAdd(c,C); d=safeAdd(d,D);
    }
    return [a,b,c,d]
      .map(n => Array.from({length:4}, (_,i) => ('0'+((n>>(i*8))&0xff).toString(16)).slice(-2)).join(''))
      .join('');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PLUGIN
  // ═══════════════════════════════════════════════════════════════════════
  const LastFmScrobbler = {
    name: "Last.fm Scrobbler",
    api:  null,

    // ── Auth state ──
    sessionKey:  null,
    username:    null,
    isConnected: false,

    // ── Current track playback state ──
    currentTrack:   null,   // { title, artist, album, duration, timestamp }
    playedSecs:     0,      // seconds of actual playback accumulated
    resumedAt:      null,   // Date.now() when play last resumed; null when paused
    scrobbled:      false,  // has current track been scrobbled?
    npSent:         false,  // has now-playing been sent for current track?
    scrobbleTimer:  null,

    // ── Offline queue  [ { artist, track, album, duration, timestamp } ] ──
    offlineQueue: [],
    flushTimer:   null,
    flushing:     false,

    // ── Session stats ──
    sessionCount:    0,
    recentScrobbles: [],   // max 10, shown in panel

    // ── History import state ──
    importing:       false,
    importTotal:     0,
    importDone:      0,
    importCancelled: false,

    // ─────────────────────────────────────────────────────────────────────
    // LIFECYCLE
    // ─────────────────────────────────────────────────────────────────────
    async init(api) {
      this.api = api;
      await this.loadState();
      this.injectStyles();
      this.buildPanel();
      this.createBarButton();

      if (this.sessionKey) {
        this.isConnected = true;
        this.renderBody();
        console.log(`[LastFM] Session restored for @${this.username}`);
      }
    },

    start() {
      this.registerEvents();
      this.flushTimer = setInterval(() => this.flushQueue(), FLUSH_MS);
    },

    stop() {
      // Freeze clock so playedSecs is accurate if plugin restarts
      this._freezeClock();
      clearInterval(this.flushTimer);
      clearTimeout(this.scrobbleTimer);
      this.flushTimer   = null;
      this.scrobbleTimer = null;
    },

    destroy() {
      this.stop();
      document.getElementById("lfm-styles")?.remove();
      document.getElementById("lfm-overlay")?.remove();
      document.getElementById("lfm-panel")?.remove();
    },

    // ─────────────────────────────────────────────────────────────────────
    // PERSISTENCE
    // ─────────────────────────────────────────────────────────────────────
    async loadState() {
      if (!this.api?.storage?.get) return;
      try {
        const sk  = await this.api.storage.get("lfm-sk");
        const usr = await this.api.storage.get("lfm-user");
        const q   = await this.api.storage.get("lfm-queue");
        if (sk)  this.sessionKey  = sk;
        if (usr) this.username    = usr;
        if (q)   this.offlineQueue = JSON.parse(q);
      } catch (e) { console.warn("[LastFM] loadState:", e); }
    },

    async saveState() {
      if (!this.api?.storage?.set) return;
      try {
        // Always write — empty string clears stored value
        await this.api.storage.set("lfm-sk",    this.sessionKey  || "");
        await this.api.storage.set("lfm-user",  this.username    || "");
        await this.api.storage.set("lfm-queue", JSON.stringify(this.offlineQueue.slice(-QUEUE_MAX)));
      } catch (e) { console.error("[LastFM] saveState:", e); }
    },

    // ─────────────────────────────────────────────────────────────────────
    // LAST.FM API CALLS
    // ─────────────────────────────────────────────────────────────────────

    /** Build the required api_sig for write methods */
    sign(params) {
      const str = Object.keys(params)
        .filter(k => k !== "format")
        .sort()
        .map(k  => `${k}${params[k]}`)
        .join("") + API_SECRET;
      return md5(str);
    },

    /** POST — all write methods (scrobble, nowPlaying, auth.getSession) */
    async post(params) {
      const signed = { ...params, api_sig: this.sign(params), format: "json" };
      const resp = await this.api.fetch(API_ROOT, {
        method:  "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body:    new URLSearchParams(signed).toString(),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (data.error) throw new Error(`LFM error ${data.error}: ${data.message}`);
      return data;
    },

    /** GET — read-only methods (user.getInfo, user.getRecentTracks) */
    async get(params) {
      const qs   = new URLSearchParams({ ...params, api_key: API_KEY, format: "json" });
      const resp = await this.api.fetch(`${API_ROOT}?${qs}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (data.error) throw new Error(`LFM error ${data.error}: ${data.message}`);
      return data;
    },

    // ─────────────────────────────────────────────────────────────────────
    // AUTH  (Tauri-safe: manual token paste instead of URL callback)
    // ─────────────────────────────────────────────────────────────────────

    openAuthPage() {
      // Opens in the SYSTEM browser, not in the Tauri webview.
      // Last.fm will show a page with the token in the URL bar after login.
      const url = `https://www.last.fm/api/auth/?api_key=${API_KEY}`;
      if (window.__TAURI__?.opener?.openUrl) {
        window.__TAURI__.opener.openUrl(url);
      } else {
        window.open(url, "_blank");
      }
    },

    async connectWithToken(token) {
      token = (token || "").trim();
      if (!token) { this.toast("Please paste a token first", true); return; }

      this.setConnectStatus("Connecting to Last.fm…");
      try {
        const data = await this.post({ method: "auth.getSession", api_key: API_KEY, token });
        this.sessionKey  = data.session.key;
        this.username    = data.session.name;
        this.isConnected = true;
        await this.saveState();
        this.renderBody();
        this.toast(`Connected as @${this.username} ✓`);
        console.log(`[LastFM] Authenticated as @${this.username}`);
        // Kick off profile fetch and show import prompt
        this.refreshProfile();
      } catch (err) {
        console.error("[LastFM] Auth failed:", err);
        this.setConnectStatus("Failed — check the token and try again.");
        this.toast("Connection failed", true);
      }
    },

    async disconnect() {
      this.sessionKey     = null;
      this.username       = null;
      this.isConnected    = false;
      this.currentTrack   = null;
      this.offlineQueue   = [];
      this.sessionCount   = 0;
      this.recentScrobbles = [];
      await this.saveState();
      this.renderBody();
      this.toast("Disconnected from Last.fm");
    },

    // ─────────────────────────────────────────────────────────────────────
    // PLAYBACK CLOCK  (accurate elapsed-time accounting across pauses)
    // ─────────────────────────────────────────────────────────────────────

    /** Commit any elapsed time since last resume into playedSecs */
    _freezeClock() {
      if (this.resumedAt !== null) {
        this.playedSecs += (Date.now() - this.resumedAt) / 1000;
        this.resumedAt   = null;
      }
    },

    /** Seconds of play time still needed to hit the scrobble threshold */
    _secsToThreshold() {
      if (!this.currentTrack) return Infinity;
      const dur = this.currentTrack.duration;
      const threshold = dur > 0 ? Math.min(dur * SCROBBLE_PCT, MAX_PLAY_S) : MAX_PLAY_S;
      return Math.max(0, threshold - this.playedSecs);
    },

    // ─────────────────────────────────────────────────────────────────────
    // TRACK LIFECYCLE EVENTS
    // ─────────────────────────────────────────────────────────────────────

    onTrackChange(newTrack, previousTrack) {
      // Before switching, check if previous track earned a late scrobble
      if (previousTrack && !this.scrobbled && this.currentTrack) {
        this._freezeClock();
        const dur = this.currentTrack.duration;
        const threshold = dur > 0 ? Math.min(dur * SCROBBLE_PCT, MAX_PLAY_S) : MAX_PLAY_S;
        if (this.playedSecs >= MIN_DURATION_S && this.playedSecs >= threshold) {
          this._fireScrobble();
        }
      }

      clearTimeout(this.scrobbleTimer);
      this.scrobbleTimer = null;

      // Skip radio streams and tracks with no title
      if (!newTrack?.title || newTrack?.source_type === "radio") {
        this.currentTrack = null;
        this._setNpBar(false);
        return;
      }

      this.currentTrack = {
        title:     newTrack.title   || "",
        artist:    newTrack.artist  || "",
        album:     newTrack.album   || "",
        duration:  newTrack.duration || 0,
        timestamp: Math.floor(Date.now() / 1000),
      };
      this.playedSecs  = 0;
      this.resumedAt   = Date.now();
      this.scrobbled   = false;
      this.npSent      = false;

      // Skip tracks too short to qualify
      if (this.currentTrack.duration > 0 && this.currentTrack.duration < MIN_DURATION_S) {
        console.log(`[LastFM] Track too short (${this.currentTrack.duration}s), skipping`);
        this.currentTrack = null;
        return;
      }

      this.sendNowPlaying();
      this.scheduleScrobble();
    },

    onPlayPause(isPlaying) {
      if (isPlaying) {
        // Resumed — start the clock
        if (this.resumedAt === null && this.currentTrack) {
          this.resumedAt = Date.now();
          this.scheduleScrobble();
        }
      } else {
        // Paused — freeze the clock and cancel timer
        this._freezeClock();
        clearTimeout(this.scrobbleTimer);
        this.scrobbleTimer = null;
      }
    },

    scheduleScrobble() {
      clearTimeout(this.scrobbleTimer);
      if (this.scrobbled || !this.currentTrack || !this.isConnected) return;

      const delayMs = this._secsToThreshold() * 1000;
      if (delayMs <= 0) { this._fireScrobble(); return; }

      this.scrobbleTimer = setTimeout(() => {
        this._freezeClock();
        this.resumedAt = Date.now(); // restart clock after snapshot
        this._fireScrobble();
      }, delayMs);
    },

    // ─────────────────────────────────────────────────────────────────────
    // NOW PLAYING
    // ─────────────────────────────────────────────────────────────────────
    async sendNowPlaying() {
      if (!this.isConnected || !this.currentTrack || this.npSent) return;
      const { title, artist, album, duration } = this.currentTrack;
      try {
        await this.post({
          method:   "track.updateNowPlaying",
          api_key:  API_KEY,
          sk:       this.sessionKey,
          track:    title,
          artist,
          album:    album    || "",
          duration: duration || "",
        });
        this.npSent = true;
        this._setNpBar(true);
        console.log(`[LastFM] ▶ ${artist} — ${title}`);
      } catch (err) {
        // updateNowPlaying is best-effort; a failure never blocks scrobbling
        console.warn("[LastFM] updateNowPlaying failed:", err);
      }
    },

    // ─────────────────────────────────────────────────────────────────────
    // SCROBBLE
    // ─────────────────────────────────────────────────────────────────────
    _fireScrobble() {
      if (this.scrobbled || !this.currentTrack) return;
      this.scrobbled = true;   // set sync so double-fire is impossible

      const { title, artist, album, duration, timestamp } = this.currentTrack;

      // Final guard — must have actually played enough
      const total = this.playedSecs + (this.resumedAt ? (Date.now() - this.resumedAt) / 1000 : 0);
      if (total < MIN_DURATION_S) {
        console.log(`[LastFM] Skipped — only ${total.toFixed(1)}s played`);
        this._setNpBar(false);
        return;
      }

      console.log(`[LastFM] ✓ Scrobble: ${artist} — ${title} (${total.toFixed(1)}s played)`);
      const entry = { artist, track: title, album: album || "", duration: duration || "", timestamp };

      this.sendBatch([entry]).then(ok => {
        if (ok) {
          this.sessionCount++;
          this.recentScrobbles.unshift({ title, artist, album, at: new Date() });
          if (this.recentScrobbles.length > 10) this.recentScrobbles.pop();
          this._updateStats();
          this._updateRecentList();
        } else {
          // Store for retry
          this.offlineQueue.push(entry);
          if (this.offlineQueue.length > QUEUE_MAX) this.offlineQueue.shift();
          this.saveState();
          this._updateStats();
          console.log(`[LastFM] Offline queue size: ${this.offlineQueue.length}`);
        }
      });

      this._setNpBar(false);
    },

    /** Send up to 50 scrobbles in one batch POST. Returns true on success. */
    async sendBatch(entries) {
      if (!this.isConnected || !entries.length) return false;
      const slice  = entries.slice(0, IMPORT_BATCH);
      const params = { method: "track.scrobble", api_key: API_KEY, sk: this.sessionKey };
      slice.forEach((e, i) => {
        params[`artist[${i}]`]    = e.artist;
        params[`track[${i}]`]     = e.track;
        params[`album[${i}]`]     = e.album    || "";
        params[`duration[${i}]`]  = e.duration || "";
        params[`timestamp[${i}]`] = e.timestamp;
      });
      try {
        const data     = await this.post(params);
        const accepted = parseInt(data.scrobbles?.["@attr"]?.accepted ?? "0", 10);
        const ignored  = parseInt(data.scrobbles?.["@attr"]?.ignored  ?? "0", 10);
        console.log(`[LastFM] Batch: ${accepted} accepted, ${ignored} ignored`);
        // Return true if the server processed the request (even if all ignored — those won't retry)
        return true;
      } catch (err) {
        console.error("[LastFM] sendBatch failed:", err);
        return false;
      }
    },

    // ─────────────────────────────────────────────────────────────────────
    // OFFLINE QUEUE FLUSH
    // ─────────────────────────────────────────────────────────────────────
    async flushQueue() {
      if (this.flushing || !this.isConnected || !this.offlineQueue.length) return;
      this.flushing = true;
      try {
        const batch = this.offlineQueue.slice(0, IMPORT_BATCH);
        const ok    = await this.sendBatch(batch);
        if (ok) {
          const n = batch.length;
          this.offlineQueue.splice(0, n);
          await this.saveState();
          if (n) {
            this.toast(`Synced ${n} offline scrobble${n > 1 ? "s" : ""} to Last.fm`);
            this._updateStats();
          }
        }
      } finally {
        this.flushing = false;
      }
    },

    // ─────────────────────────────────────────────────────────────────────
    // HISTORY IMPORT
    // Reads api.library.getTracks() and sends all eligible tracks as
    // backdated scrobbles (one per track, timestamps spaced 5 min apart).
    // ─────────────────────────────────────────────────────────────────────
    async startImport() {
      if (this.importing) return;
      if (!this.api?.library?.getTracks) {
        this.toast("library:read permission required for import", true);
        return;
      }

      this.importing       = true;
      this.importCancelled = false;
      this.importDone      = 0;
      this.importTotal     = 0;
      this._renderImportProgress();

      try {
        this._setImportStatus("Reading library…");
        const allTracks = await this.api.library.getTracks();

        if (!allTracks?.length) {
          this._setImportStatus("No tracks found in library.");
          return;
        }

        // Filter: must have title + artist, duration ≥ 30 s, not radio
        const eligible = allTracks.filter(t =>
          t.title && t.artist &&
          (t.duration || 0) >= MIN_DURATION_S &&
          t.source_type !== "radio"
        );

        this.importTotal = eligible.length;
        this._setImportStatus(`Found ${this.importTotal} tracks to import…`);
        this._renderImportProgress();

        if (!this.importTotal) {
          this._setImportStatus("No eligible tracks found (need title + artist + ≥30s duration).");
          return;
        }

        // Build backdated entries: most recent first, 5 min apart
        const nowTs = Math.floor(Date.now() / 1000);
        const entries = eligible.map((t, i) => ({
          artist:    t.artist,
          track:     t.title,
          album:     t.album    || "",
          duration:  t.duration || "",
          timestamp: nowTs - (i * IMPORT_SPACING),
        }));

        let totalSent = 0;
        for (let i = 0; i < entries.length; i += IMPORT_BATCH) {
          if (this.importCancelled) break;

          const batch = entries.slice(i, i + IMPORT_BATCH);
          const ok    = await this.sendBatch(batch);
          if (ok) {
            totalSent += batch.length;
          }

          this.importDone = Math.min(i + batch.length, entries.length);
          this._setImportStatus(`Importing… ${this.importDone} / ${this.importTotal}`);
          this._renderImportProgress();

          // Pause between batches to respect Last.fm rate limits
          if (i + IMPORT_BATCH < entries.length) {
            await new Promise(r => setTimeout(r, IMPORT_DELAY_MS));
          }
        }

        await this.saveState();

        if (this.importCancelled) {
          this._setImportStatus(`Import cancelled — ${totalSent} tracks sent.`);
          this.toast(`Import cancelled (${totalSent} sent)`);
        } else {
          this._setImportStatus(`✓ Done — ${totalSent} tracks imported to Last.fm.`);
          this.toast(`Imported ${totalSent} tracks to Last.fm`);
        }

      } catch (err) {
        console.error("[LastFM] Import error:", err);
        this._setImportStatus(`Error: ${err.message}`);
        this.toast("Import failed", true);
      } finally {
        this.importing       = false;
        this.importCancelled = false;
        this._renderImportProgress();
      }
    },

    cancelImport() {
      this.importCancelled = true;
      this._setImportStatus("Cancelling…");
    },

    // ─────────────────────────────────────────────────────────────────────
    // PLAYER EVENTS
    // ─────────────────────────────────────────────────────────────────────
    registerEvents() {
      // Track whether the player is playing so we can detect resume vs initial play
      let isPlaying = false;

      this.api.on("trackChange", ({ track, previousTrack }) => {
        this.onTrackChange(track, previousTrack);
        isPlaying = true;
      });

      this.api.on("playbackState", ({ isPlaying: nowPlaying }) => {
        if (nowPlaying !== isPlaying) {
          isPlaying = nowPlaying;
          this.onPlayPause(nowPlaying);
        }
      });
    },

    // ─────────────────────────────────────────────────────────────────────
    // LAST.FM DATA
    // ─────────────────────────────────────────────────────────────────────
    async fetchUserInfo() {
      try {
        return (await this.get({ method: "user.getInfo", user: this.username })).user;
      } catch { return null; }
    },

    async fetchRecentTracks() {
      try {
        return (await this.get({
          method: "user.getRecentTracks", user: this.username, limit: "10", extended: "0",
        })).recenttracks?.track || [];
      } catch { return []; }
    },

    async refreshProfile() {
      const [user, recent] = await Promise.all([this.fetchUserInfo(), this.fetchRecentTracks()]);

      if (user) {
        const el = document.getElementById("lfm-total");
        if (el) el.textContent = `${Number(user.playcount || 0).toLocaleString()} total scrobbles`;

        const av = document.getElementById("lfm-avatar");
        if (av) {
          const img = user.image?.find(i => i.size === "medium" || i.size === "large");
          if (img?.["#text"]) av.innerHTML = `<img src="${this.esc(img["#text"])}" alt="">`;
        }
      }

      // Populate recent list from Last.fm if session list is still empty
      if (recent.length > 0 && this.recentScrobbles.length === 0) {
        this.recentScrobbles = recent.slice(0, 10).map(t => ({
          title:  t.name                 || "",
          artist: t.artist?.["#text"]    || "",
          album:  t.album?.["#text"]     || "",
          at:     t.date ? new Date(Number(t.date.uts) * 1000) : new Date(),
        }));
        this._updateRecentList();
      }
    },

    // ─────────────────────────────────────────────────────────────────────
    // STYLES
    // ─────────────────────────────────────────────────────────────────────
    injectStyles() {
      if (document.getElementById("lfm-styles")) return;
      const s = document.createElement("style");
      s.id = "lfm-styles";
      s.textContent = `
        #lfm-overlay {
          position:fixed;inset:0;background:rgba(0,0,0,.72);backdrop-filter:blur(6px);
          z-index:10000;opacity:0;visibility:hidden;transition:opacity .2s;
        }
        #lfm-overlay.open{opacity:1;visibility:visible;}
        #lfm-panel {
          position:fixed;top:50%;right:0;
          transform:translateY(-50%) translateX(100%);
          width:350px;max-width:96vw;height:100vh;
          background:var(--bg-elevated,#181818);
          border-left:1px solid var(--border-color,#2e2e2e);
          z-index:10001;display:flex;flex-direction:column;
          box-shadow:-20px 0 50px rgba(0,0,0,.5);
          transition:transform .28s cubic-bezier(0,0,.2,1);overflow:hidden;
        }
        #lfm-panel.open{transform:translateY(-50%) translateX(0);}
        .lfm-hdr {
          padding:15px 15px 11px;border-bottom:1px solid var(--border-color,#2a2a2a);
          display:flex;align-items:center;gap:10px;flex-shrink:0;
        }
        .lfm-logo {
          width:30px;height:30px;border-radius:50%;background:#d51007;flex-shrink:0;
          display:flex;align-items:center;justify-content:center;
          color:#fff;font-weight:900;font-size:12px;letter-spacing:-.5px;
        }
        .lfm-hdr-info{flex:1;overflow:hidden;}
        .lfm-hdr-title{font-size:15px;font-weight:700;color:var(--text-primary,#fff);}
        .lfm-hdr-sub{font-size:11px;color:var(--text-secondary,#888);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
        .lfm-x {
          background:none;border:none;color:var(--text-secondary,#aaa);cursor:pointer;
          width:28px;height:28px;border-radius:50%;display:flex;align-items:center;
          justify-content:center;font-size:16px;transition:background .15s;flex-shrink:0;
        }
        .lfm-x:hover{background:var(--bg-highlight,#2a2a2a);color:#fff;}
        #lfm-np-bar {
          padding:8px 15px;display:none;flex-shrink:0;
          background:linear-gradient(to right,rgba(213,16,7,.12),rgba(213,16,7,.04));
          border-bottom:1px solid rgba(213,16,7,.2);align-items:center;gap:8px;
        }
        #lfm-np-bar.on{display:flex;}
        .lfm-pulse{width:8px;height:8px;border-radius:50%;background:#d51007;flex-shrink:0;animation:lfm-p 1.4s ease-in-out infinite;}
        @keyframes lfm-p{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.8)}}
        #lfm-np-text{font-size:12px;color:var(--text-secondary,#aaa);flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}
        .lfm-live{font-size:9px;font-weight:800;letter-spacing:.8px;padding:2px 6px;border-radius:10px;background:#d51007;color:#fff;}
        .lfm-body{flex:1;overflow-y:auto;background:var(--bg-base,#111);}
        .lfm-body::-webkit-scrollbar{width:4px;}
        .lfm-body::-webkit-scrollbar-thumb{background:#2a2a2a;border-radius:2px;}
        .lfm-sec{padding:15px;border-bottom:1px solid var(--border-color,#2a2a2a);}
        .lfm-sec:last-child{border-bottom:none;}
        .lfm-lbl{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:1.2px;color:var(--text-subdued,#555);margin-bottom:10px;}
        /* Connect screen */
        .lfm-cnx{padding:32px 18px;display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center;}
        .lfm-big-logo{width:60px;height:60px;background:#d51007;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:900;font-size:22px;letter-spacing:-2px;box-shadow:0 8px 24px rgba(213,16,7,.4);}
        .lfm-cnx h2{font-size:18px;font-weight:700;color:var(--text-primary,#fff);margin:0;}
        .lfm-cnx p{font-size:13px;color:var(--text-secondary,#aaa);line-height:1.6;margin:0;}
        .lfm-steps{text-align:left;width:100%;display:flex;flex-direction:column;gap:9px;}
        .lfm-step{display:flex;align-items:flex-start;gap:9px;font-size:13px;color:var(--text-secondary,#aaa);line-height:1.5;}
        .lfm-step-n{width:20px;height:20px;border-radius:50%;background:#d51007;color:#fff;font-size:11px;font-weight:700;flex-shrink:0;display:flex;align-items:center;justify-content:center;}
        .lfm-inp{width:100%;padding:9px 11px;border-radius:8px;font-size:13px;background:var(--bg-surface,#1e1e1e);border:1px solid var(--border-color,#333);color:var(--text-primary,#fff);outline:none;box-sizing:border-box;transition:border-color .15s;}
        .lfm-inp:focus{border-color:#d51007;}
        .lfm-inp::placeholder{color:var(--text-subdued,#555);}
        #lfm-cnx-status{font-size:12px;color:var(--text-secondary,#888);min-height:14px;white-space:pre-wrap;}
        /* Buttons */
        .lfm-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:9px 14px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;transition:filter .15s;border:1px solid var(--border-color,#333);background:var(--bg-surface,#1e1e1e);color:var(--text-primary,#fff);width:100%;}
        .lfm-btn:hover:not(:disabled){filter:brightness(1.2);}
        .lfm-btn:disabled{opacity:.4;cursor:not-allowed;}
        .lfm-btn.red{background:#d51007;border-color:#d51007;color:#fff;}
        .lfm-btn.danger{color:#e74c3c;border-color:rgba(231,76,60,.3);}
        /* Profile */
        .lfm-prof{display:flex;align-items:center;gap:12px;padding:12px;background:var(--bg-elevated,#181818);border:1px solid var(--border-color,#2a2a2a);border-radius:10px;}
        .lfm-avatar{width:48px;height:48px;border-radius:50%;flex-shrink:0;background:#d51007;overflow:hidden;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:18px;}
        .lfm-avatar img{width:100%;height:100%;object-fit:cover;}
        .lfm-prof-name{font-size:14px;font-weight:700;color:var(--text-primary,#fff);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
        .lfm-prof-link{font-size:11px;color:#d51007;text-decoration:none;display:inline-block;margin-top:2px;}
        .lfm-prof-link:hover{text-decoration:underline;}
        #lfm-total{font-size:11px;color:var(--text-subdued,#555);margin-top:2px;}
        /* Stats */
        .lfm-stats{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px;}
        .lfm-stat{background:var(--bg-elevated,#181818);border:1px solid var(--border-color,#2a2a2a);border-radius:8px;padding:10px;text-align:center;}
        .lfm-stat-val{font-size:20px;font-weight:700;color:var(--text-primary,#fff);}
        .lfm-stat-val.red{color:#d51007;}
        .lfm-stat-lbl{font-size:11px;color:var(--text-subdued,#555);margin-top:2px;}
        /* Queue badge */
        .lfm-q{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-secondary,#aaa);padding:8px 11px;background:var(--bg-elevated,#181818);border:1px solid var(--border-color,#2a2a2a);border-radius:8px;margin-top:10px;}
        .lfm-q-n{font-weight:700;color:#f39c12;}
        .lfm-q-flush{padding:4px 9px!important;width:auto!important;font-size:11px!important;}
        /* Recent list */
        .lfm-row{display:flex;align-items:center;gap:9px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.04);}
        .lfm-row:last-child{border-bottom:none;}
        .lfm-row-n{width:18px;font-size:11px;color:var(--text-subdued,#555);text-align:right;flex-shrink:0;}
        .lfm-row-info{flex:1;overflow:hidden;}
        .lfm-row-title{font-size:13px;font-weight:500;color:var(--text-primary,#fff);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
        .lfm-row-artist{font-size:11px;color:var(--text-secondary,#888);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
        .lfm-row-time{font-size:11px;color:var(--text-subdued,#555);flex-shrink:0;}
        /* Import */
        .lfm-prog-wrap{height:4px;background:var(--bg-highlight,#2a2a2a);border-radius:2px;overflow:hidden;margin:8px 0;}
        #lfm-prog-fill{height:100%;background:#d51007;border-radius:2px;transition:width .3s;width:0%;}
        #lfm-import-status{font-size:12px;color:var(--text-secondary,#888);min-height:14px;}
        /* Player bar button */
        .lfm-bar-btn{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:20px;border:1px solid var(--border-color,#404040);background:transparent;color:#fff;cursor:pointer;font-size:12px;font-weight:600;transition:border-color .15s,background .15s;position:relative;}
        .lfm-bar-btn:hover{background:var(--bg-highlight,#2a2a2a);border-color:#d51007;}
        .lfm-dot{position:absolute;top:3px;right:3px;width:6px;height:6px;background:#d51007;border-radius:50%;display:none;}
        .lfm-bar-btn.on .lfm-dot{display:block;}
        /* Toast */
        .lfm-toast{position:fixed;bottom:88px;left:50%;transform:translateX(-50%);background:#222;color:#fff;padding:8px 16px;border-radius:8px;z-index:10010;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.4);opacity:0;transition:opacity .25s;pointer-events:none;white-space:nowrap;}
        .lfm-toast.err{background:#c0392b;}
        @media(max-width:768px){#lfm-panel{width:100vw;}}
      `;
      document.head.appendChild(s);
    },

    // ─────────────────────────────────────────────────────────────────────
    // PANEL  (shell built once; body re-rendered on state change)
    // ─────────────────────────────────────────────────────────────────────
    buildPanel() {
      const ov = document.createElement("div");
      ov.id    = "lfm-overlay";
      ov.onclick = () => this.close();
      document.body.appendChild(ov);

      const p = document.createElement("div");
      p.id = "lfm-panel";
      p.innerHTML = `
        <div class="lfm-hdr">
          <div class="lfm-logo">lfm</div>
          <div class="lfm-hdr-info">
            <div class="lfm-hdr-title">Last.fm Scrobbler</div>
            <div class="lfm-hdr-sub" id="lfm-hdr-sub">Not connected</div>
          </div>
          <button class="lfm-x" id="lfm-x">✕</button>
        </div>
        <div id="lfm-np-bar">
          <div class="lfm-pulse"></div>
          <div id="lfm-np-text">Scrobbling…</div>
          <span class="lfm-live">LIVE</span>
        </div>
        <div class="lfm-body" id="lfm-body"></div>
      `;
      document.body.appendChild(p);
      p.querySelector("#lfm-x").onclick = () => this.close();
      this.renderBody();
    },

    renderBody() {
      const body = document.getElementById("lfm-body");
      if (!body) return;

      // Update header subtitle
      const sub = document.getElementById("lfm-hdr-sub");
      if (sub) sub.textContent = this.isConnected ? `@${this.username}` : "Not connected";

      // Update player bar button state
      document.getElementById("lfm-bar-btn")?.classList.toggle("on", this.isConnected);

      body.innerHTML = this.isConnected ? this._tmplConnected() : this._tmplConnect();
      this._bindEvents();

      if (this.isConnected) {
        this._updateRecentList();
        this._updateStats();
        this.refreshProfile();
      }
    },

    _tmplConnect() {
      return `
        <div class="lfm-cnx">
          <div class="lfm-big-logo">lfm</div>
          <h2>Connect to Last.fm</h2>
          <p>Scrobble everything you play in Audion and build your listening history.</p>
          <div class="lfm-steps">
            <div class="lfm-step">
              <span class="lfm-step-n">1</span>
              <span>Click <strong>Open Last.fm</strong> — authorise Audion in your browser.</span>
            </div>
            <div class="lfm-step">
              <span class="lfm-step-n">2</span>
              <span>After authorising, the browser's URL bar will contain
                <code style="font-size:11px;color:#aaa">?token=<strong>abc123…</strong></code>.
                Copy just the token value (the part after <code style="font-size:11px">token=</code>).</span>
            </div>
            <div class="lfm-step">
              <span class="lfm-step-n">3</span>
              <span>Paste it below and click <strong>Connect</strong>.</span>
            </div>
          </div>
          <button class="lfm-btn red" id="lfm-open-btn">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12s5.37 12 12 12 12-5.37 12-12S18.63 0 12 0zm-1.31 17.44-3.06-1.86c-.5-.3-.83-.84-.83-1.44V9.91c0-.6.33-1.14.83-1.44l3.06-1.86c.5-.3 1.11-.3 1.61 0l3.06 1.86c.5.3.83.84.83 1.44v4.24c0 .6-.33 1.14-.83 1.44l-3.06 1.86c-.25.15-.53.22-.81.22s-.56-.07-.8-.22z"/></svg>
            Open Last.fm →
          </button>
          <input class="lfm-inp" id="lfm-token" placeholder="Paste token here…" type="text" />
          <button class="lfm-btn" id="lfm-connect-btn">Connect</button>
          <div id="lfm-cnx-status"></div>
        </div>
      `;
    },

    _tmplConnected() {
      const q = this.offlineQueue.length;
      return `
        <div class="lfm-sec">
          <div class="lfm-lbl">Account</div>
          <div class="lfm-prof">
            <div class="lfm-avatar" id="lfm-avatar">${(this.username||"?")[0].toUpperCase()}</div>
            <div style="flex:1;overflow:hidden;">
              <div class="lfm-prof-name">@${this.esc(this.username||"")}</div>
              <a class="lfm-prof-link" href="https://www.last.fm/user/${encodeURIComponent(this.username||"")}" target="_blank">View profile ↗</a>
              <div id="lfm-total">Loading…</div>
            </div>
          </div>
          <div class="lfm-stats">
            <div class="lfm-stat">
              <div class="lfm-stat-val red" id="lfm-sess">${this.sessionCount}</div>
              <div class="lfm-stat-lbl">This session</div>
            </div>
            <div class="lfm-stat">
              <div class="lfm-stat-val" id="lfm-qlen">${q}</div>
              <div class="lfm-stat-lbl">Offline queue</div>
            </div>
          </div>
          ${q > 0 ? `<div class="lfm-q">
            ⏳ <span><span class="lfm-q-n">${q}</span> scrobble${q>1?"s":""} waiting to sync</span>
            <button class="lfm-btn lfm-q-flush" id="lfm-flush-btn">Sync now</button>
          </div>` : ""}
        </div>

        <div class="lfm-sec">
          <div class="lfm-lbl">Recent Scrobbles</div>
          <div id="lfm-recent">
            <div style="font-size:12px;color:var(--text-subdued,#555);text-align:center;padding:16px 0;">
              No scrobbles this session yet
            </div>
          </div>
          <button class="lfm-btn" id="lfm-refresh-btn" style="margin-top:10px;">↻ Refresh from Last.fm</button>
        </div>

        <div class="lfm-sec">
          <div class="lfm-lbl">Import Play History</div>
          <p style="font-size:12px;color:var(--text-secondary,#aaa);margin:0 0 10px;line-height:1.6;">
            Send your existing Audion library to Last.fm as backdated scrobbles.
            Each track is sent once, with timestamps spaced 5 minutes apart.
            This is a one-time operation — you can cancel it at any time.
          </p>
          <button class="lfm-btn" id="lfm-import-btn" ${this.importing ? "disabled" : ""}>
            ${this.importing ? "Importing…" : "Import Audion library → Last.fm"}
          </button>
          <button class="lfm-btn danger" id="lfm-cancel-btn" style="display:${this.importing ? "flex" : "none"};margin-top:6px;">
            Cancel import
          </button>
          <div class="lfm-prog-wrap" style="display:${this.importing ? "block" : "none"};">
            <div id="lfm-prog-fill"></div>
          </div>
          <div id="lfm-import-status"></div>
        </div>

        <div class="lfm-sec">
          <button class="lfm-btn danger" id="lfm-disc-btn">Disconnect account</button>
        </div>
      `;
    },

    _bindEvents() {
      const G = id => document.getElementById(id);

      if (!this.isConnected) {
        G("lfm-open-btn")?.addEventListener("click", () => this.openAuthPage());
        G("lfm-connect-btn")?.addEventListener("click", () => this.connectWithToken(G("lfm-token")?.value));
        G("lfm-token")?.addEventListener("keydown", e => {
          if (e.key === "Enter") this.connectWithToken(e.target.value);
        });
      } else {
        G("lfm-disc-btn")?.addEventListener("click",    () => this.disconnect());
        G("lfm-refresh-btn")?.addEventListener("click", () => this.refreshProfile());
        G("lfm-flush-btn")?.addEventListener("click",   () => this.flushQueue());
        G("lfm-import-btn")?.addEventListener("click",  () => this.startImport());
        G("lfm-cancel-btn")?.addEventListener("click",  () => this.cancelImport());
      }
    },

    // ─────────────────────────────────────────────────────────────────────
    // GRANULAR UI UPDATES  (avoid full re-render on every scrobble)
    // ─────────────────────────────────────────────────────────────────────
    _setNpBar(on) {
      const bar  = document.getElementById("lfm-np-bar");
      const text = document.getElementById("lfm-np-text");
      if (!bar) return;
      bar.classList.toggle("on", on);
      if (on && this.currentTrack && text) {
        text.textContent = `${this.currentTrack.artist} — ${this.currentTrack.title}`;
      }
    },

    _updateStats() {
      const s = document.getElementById("lfm-sess");
      const q = document.getElementById("lfm-qlen");
      if (s) s.textContent = String(this.sessionCount);
      if (q) q.textContent = String(this.offlineQueue.length);
    },

    _updateRecentList() {
      const list = document.getElementById("lfm-recent");
      if (!list || !this.recentScrobbles.length) return;
      list.innerHTML = this.recentScrobbles.map((s, i) => `
        <div class="lfm-row">
          <span class="lfm-row-n">${i + 1}</span>
          <div class="lfm-row-info">
            <div class="lfm-row-title">${this.esc(s.title)}</div>
            <div class="lfm-row-artist">${this.esc(s.artist)}</div>
          </div>
          <span class="lfm-row-time">${this._ago(s.at)}</span>
        </div>
      `).join("");
    },

    _renderImportProgress() {
      const btn  = document.getElementById("lfm-import-btn");
      const can  = document.getElementById("lfm-cancel-btn");
      const wrap = document.querySelector(".lfm-prog-wrap");
      const fill = document.getElementById("lfm-prog-fill");

      if (btn)  { btn.disabled = this.importing; btn.textContent = this.importing ? "Importing…" : "Import Audion library → Last.fm"; }
      if (can)  can.style.display  = this.importing ? "flex" : "none";
      if (wrap) wrap.style.display = this.importing ? "block" : "none";
      if (fill && this.importTotal > 0) {
        fill.style.width = `${Math.round((this.importDone / this.importTotal) * 100)}%`;
      }
    },

    _setImportStatus(msg) {
      const el = document.getElementById("lfm-import-status");
      if (el) el.textContent = msg;
    },

    setConnectStatus(msg) {
      const el = document.getElementById("lfm-cnx-status");
      if (el) el.textContent = msg;
    },

    // ─────────────────────────────────────────────────────────────────────
    // PLAYER BAR BUTTON
    // ─────────────────────────────────────────────────────────────────────
    createBarButton() {
      if (document.getElementById("lfm-bar-btn")) return;
      const btn = document.createElement("button");
      btn.id        = "lfm-bar-btn";
      btn.className = `lfm-bar-btn${this.isConnected ? " on" : ""}`;
      btn.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 0C5.37 0 0 5.37 0 12s5.37 12 12 12 12-5.37 12-12S18.63 0 12 0zm-1.31 17.44-3.06-1.86c-.5-.3-.83-.84-.83-1.44V9.91c0-.6.33-1.14.83-1.44l3.06-1.86c.5-.3 1.11-.3 1.61 0l3.06 1.86c.5.3.83.84.83 1.44v4.24c0 .6-.33 1.14-.83 1.44l-3.06 1.86c-.25.15-.53.22-.81.22s-.56-.07-.8-.22z"/>
        </svg>
        Scrobble
        <span class="lfm-dot"></span>
      `;
      btn.onclick = () => this.open();
      this.api?.ui?.registerSlot?.("playerbar:menu", btn);
    },

    open()  { document.getElementById("lfm-overlay")?.classList.add("open");    document.getElementById("lfm-panel")?.classList.add("open"); },
    close() { document.getElementById("lfm-overlay")?.classList.remove("open"); document.getElementById("lfm-panel")?.classList.remove("open"); },

    // ─────────────────────────────────────────────────────────────────────
    // UTILITIES
    // ─────────────────────────────────────────────────────────────────────
    esc(s) {
      return String(s || "")
        .replace(/&/g,"&amp;").replace(/</g,"&lt;")
        .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    },

    _ago(date) {
      const s = Math.floor((Date.now() - new Date(date)) / 1000);
      if (s < 60)    return "just now";
      if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
      if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
      return `${Math.floor(s / 86400)}d ago`;
    },

    toast(msg, err = false) {
      const el = document.createElement("div");
      el.className   = `lfm-toast${err ? " err" : ""}`;
      el.textContent = msg;
      document.body.appendChild(el);
      requestAnimationFrame(() => el.style.opacity = "1");
      setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 300); }, 2800);
    },
  };

  // Register with Audion
  if (typeof Audion !== "undefined" && Audion.register) {
    Audion.register(LastFmScrobbler);
  } else {
    window.AudionPlugin = LastFmScrobbler;
  }

})();
