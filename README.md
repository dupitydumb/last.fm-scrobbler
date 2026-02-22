Last.fm Scrobbler Plugin
=========================

Description
-----------
Scrobbles tracks played in Audion to your Last.fm account. Sends "now playing" updates immediately when a track starts and scrobbles (records plays) once the track has met Last.fm's scrobbling criteria (minimum play time and percentage of track played). Offline scrobbles are queued and synced when a connection is available.

Features
--------
- Automatic "Now Playing" updates when a track starts.
- Automatic scrobbling after the track has been played long enough.
- Offline queue with automatic periodic flushing and manual sync.
- One-time history import to send existing library plays as backdated scrobbles.
- Tauri-safe authentication flow (token paste method).

Installation
------------
This plugin is included in the `plugin-examples` folder of the Audion repository. To use it in Audion, open the Plugins panel and load or enable the "Last.fm Scrobbler" plugin.

Authentication (Tauri-safe)
---------------------------
1. Click "Open Last.fm" in the plugin panel — this opens the Last.fm auth page in your system browser.
2. Authorise the application; Last.fm will display a page whose URL contains `?token=YOUR_TOKEN`.
3. Copy the token value (the part after `token=`) and paste it into the plugin token input.
4. Click "Connect" to obtain a permanent session key stored by the plugin.

Behavior and Scrobbling Rules
-----------------------------
The plugin follows Last.fm's scrobbling rules:
- `track.updateNowPlaying` is sent immediately when a track starts.
- `track.scrobble` is sent after min(duration × 50%, 4 minutes) of actual play time.
- A minimum of 30 seconds of real play time is required to scrobble.
- Tracks shorter than 30 seconds are never scrobbled.
- If playback is paused, the scrobble timer is paused and resumes when playback continues.
- If playback finishes or the track changes after the scrobble threshold was reached, the scrobble is sent.

Offline Queue
-------------
If scrobbling fails (network or API error), the plugin stores scrobbles locally in an offline queue. The queue is automatically flushed every 15 seconds when connected. You can also manually trigger a sync from the plugin panel.

History Import
--------------
The plugin can import your existing Audion library as backdated scrobbles. This is a manual, one-time operation from the plugin panel and requires `library:read` permission. Imported scrobbles are sent in batches and spaced 5 minutes apart to create a plausible listening history.

Privacy and API Keys
--------------------
The plugin uses an embedded API key and secret to sign write requests as is common for desktop scrobblers. Only your Last.fm `session_key` is stored (in plugin storage) after you authenticate; the token you paste is exchanged for a session key by the plugin.

Troubleshooting
---------------
- If scrobbles are not appearing, ensure the plugin shows as "Connected" and that you have an active internet connection.
- Check the offline queue size in the plugin panel — queued scrobbles will sync when possible.
- The plugin logs to the console for debugging; open the developer console in Audion to view messages.

Files
-----
- `index.js` — plugin implementation and UI.

License
-------
This plugin is provided as an example for Audion; follow the repository license.
