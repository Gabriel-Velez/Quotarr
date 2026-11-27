# Quotarr

A self-hosted dashboard that groups Radarr movies and Sonarr series by their Seerr requester, with Jellyfin sign-in, persistent manual reassignment, request history, and per-profile storage caps.

## Screenshots

NOTE: These screenshots use anonymized sample data.
When run it will be populated with actual movie and series images

![Quotarr storage overview](docs/screenshots/dashboard.png)

![Quotarr settings](docs/screenshots/settings.png)

## Run locally

1. Install Node.js 20 or newer.
2. From this folder, run `npm start`.
3. Open [http://127.0.0.1:4173](http://127.0.0.1:4173).
4. Open **Settings**, enter each service's base URL and API key, then choose **Save & sync profiles**.

The app binds to `127.0.0.1` by default. Set `PORT` to change the port. Use the Jellyfin username and password associated with a Seerr account to sign in. Quotarr verifies the login through Seerr and keeps the Seerr session in memory; passwords are not stored. Seerr's admin permission is required for Settings and reassignment; other signed-in users can view the overview and request history. Sessions expire after 12 hours or when the app restarts.

## Run with Docker

1. Install Docker with the Compose plugin.
2. From this folder, run `docker compose up -d --build`.
3. Open [http://127.0.0.1:4173](http://127.0.0.1:4173).

Compose keeps settings and API keys in the persistent `quotarr-data` volume. Use `docker compose down` to stop the app; the volume is preserved. The published port binds to `127.0.0.1` by default. Configure Seerr, Radarr, and Sonarr with addresses reachable from inside the container (for example, `host.docker.internal` for services running on the Docker host). For trusted LAN access, set `QUOTARR_BIND_ADDRESS=0.0.0.0` and `ALLOWED_HOSTS` to the exact hostnames or IP addresses you will use in a `.env` file beside `compose.yaml`. Do not expose the app directly to the internet; use a trusted VPN or HTTPS reverse proxy for remote access.

## Updates

Administrators can use **Settings → Updates → Check for updates** to compare the installed app files with GitHub's latest source. If they match, Quotarr reports that it is up to date; otherwise, it shows the latest commit and update command for the installation type. This is a check only; it does not download files or restart the app. Stop Quotarr before updating. For an npm installation, run `git pull`, `npm install`, and `npm start`. For Docker, run `git pull` and `docker compose up -d --build`; the existing data volume and settings are preserved.

## Versioning

Each push to `main` automatically increments the patch version in `package.json` and `package-lock.json`, creates a matching `v` tag, and pushes a version commit. Existing `main` commits are tagged without rewriting history: development commits use sequential `v0.0.x` tags, and the current `1.0.0` commit is tagged `v1.0.0`. The workflow requires GitHub Actions to have permission to write repository contents.

## Service setup

Use the base address for each service, including a reverse-proxy subpath if applicable (for example `http://media-box:7878/radarr`). Create API keys in each service's settings. The dashboard reads Seerr users and requests, Radarr movies, and Sonarr series; it does not modify those services.

Titles are matched by TMDB ID for movies and TVDB ID for series. Multiple Seerr requests for the same title appear once in request history; the oldest request represents that title. Each profile can expand its request list, search, sort by date added or size, and page through it; page size is configurable in Settings (25 by default). Profile order can be changed by dragging the handle: Seerr administrators save the order globally, while other users save their order in their browser. The signed-in user's profile stays at the top. Requests not yet in Radarr or Sonarr appear with no disk size. Manually assigned library titles without a matching Seerr request also appear in that profile's list, labeled as manual assignments. Items without a matching Seerr profile go to the configurable default category. Manual assignments are stored locally with both Seerr's original requester and the administrator-selected profile, and the selected profile is applied consistently to library items and request history. Storage amounts come from `sizeOnDisk` in Radarr and Sonarr.

Each profile's sort control orders both its dashboard poster tiles and expanded request list by date added or size. The **Reassign media** section in Settings supports title search, requester/type filters, sorting by date added or size, and bulk assignment of selected or filtered items. Dashboard poster tiles scroll horizontally when needed; hovering a tile shows its poster, title, request date, size, and release date.

Profile caps are entered in GB. A blank or zero cap means unlimited. Connection settings, caps, and overrides are stored in `data/settings.json`; API keys are not returned to the browser. The `profileNames` map records Seerr profile IDs alongside their usernames so numeric IDs in assignments and caps are easier to identify. Quotarr refreshes this map when it syncs dashboard data. Keep that file private and back it up if you want to preserve settings.

## Notifications

Administrators can configure storage-cap alerts in **Settings → Notifications**. Quotarr checks profile usage every five minutes and immediately after a storage cap is changed. It can alert at a configurable threshold (80% by default) and when a profile reaches its cap. Alerts are sent once per level and become eligible again after usage drops below that level. Profiles without a storage cap are not monitored.

The global **Enable notifications** switch pauses all notification delivery and disables the provider and rule controls without removing their saved settings.

Supported providers are Email (SMTP), Web Push, Discord, Gotify, ntfy.sh, Pushbullet, Pushover, Slack, Telegram, and generic Webhook. Use **Add a service** to add one or more instances, including multiple configurations of the same provider; save settings and use **Send test** on an instance to check delivery. Removing an instance saves the change immediately. Web Push subscriptions are per browser and service instance, and require a secure origin (HTTPS, or localhost). SMTP and push-provider credentials are stored in the private settings file and are never returned to the browser. The first run generates VAPID keys for Web Push; keep the settings file when backing up the application so existing browser subscriptions continue to work.

By default, the app only accepts the `localhost` and loopback hostnames. For a trusted LAN deployment, set `HOST=0.0.0.0` and `ALLOWED_HOSTS` to the exact host/IP clients will use (comma-separated if needed). Do not expose the app directly to the internet; use a trusted VPN or HTTPS reverse proxy for remote access.

Poster thumbnails use the services' remote poster URLs where available. If a service has no remote poster URL, the item remains a labeled placeholder.

## Tests

Run `npm test` for assignment, profile-order, authentication, and request-history tests.
