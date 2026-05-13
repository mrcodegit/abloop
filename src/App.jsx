import { useEffect, useMemo, useRef, useState } from "react";

const AUTH_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const API = "https://api.spotify.com/v1";

const SCOPES = [
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
].join(" ");

function msToTime(ms) {
  const safe = Math.max(0, Math.floor(ms || 0));
  const min = Math.floor(safe / 60000);
  const sec = Math.floor((safe % 60000) / 1000);
  const dec = Math.floor((safe % 1000) / 100);
  return `${min}:${String(sec).padStart(2, "0")}.${dec}`;
}

function parseTime(value) {
  const raw = String(value || "").trim().replace(",", ".");
  if (!raw) return 0;

  if (/^\d+(\.\d+)?$/.test(raw)) {
    return Math.round(Number(raw) * 1000);
  }

  const parts = raw.split(":").map(Number);
  if (parts.some(Number.isNaN)) return 0;

  if (parts.length === 2) {
    return Math.round((parts[0] * 60 + parts[1]) * 1000);
  }

  if (parts.length === 3) {
    return Math.round((parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000);
  }

  return 0;
}

function randomString(length = 80) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  return crypto.subtle.digest("SHA-256", data);
}

function base64Url(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function apiFetch(path, token, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (response.status === 204) return null;

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${response.status} ${response.statusText}${text ? ` — ${text}` : ""}`);
  }

  return response.json();
}

export default function App() {
  const redirectUri = useMemo(
    () => window.location.origin + window.location.pathname,
    []
  );

  const [clientId, setClientId] = useState(
    () => localStorage.getItem("spotify_client_id") || ""
  );
  const [token, setToken] = useState(
    () => localStorage.getItem("spotify_access_token") || ""
  );
  const [expiresAt, setExpiresAt] = useState(
    () => Number(localStorage.getItem("spotify_expires_at") || 0)
  );

  const [player, setPlayer] = useState(null);
  const [deviceId, setDeviceId] = useState("");
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState("Wpisz Client ID i zaloguj się.");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);

  const [track, setTrack] = useState(null);
  const [paused, setPaused] = useState(true);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);

  const [aInput, setAInput] = useState("30");
  const [bInput, setBInput] = useState("45");
  const [loopOn, setLoopOn] = useState(false);

  const tokenRef = useRef(token);
  const playerRef = useRef(player);
  const lastSeekRef = useRef(0);
  const pollRef = useRef(null);

  const aMs = useMemo(() => parseTime(aInput), [aInput]);
  const bMs = useMemo(() => parseTime(bInput), [bInput]);
  const validLoop = bMs > aMs + 500;

  useEffect(() => {
    tokenRef.current = token;
    playerRef.current = player;
  }, [token, player]);

  useEffect(() => {
    localStorage.setItem("spotify_client_id", clientId);
  }, [clientId]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const error = params.get("error");

    if (error) {
      setStatus(`Spotify login error: ${error}`);
      window.history.replaceState({}, document.title, redirectUri);
      return;
    }

    if (!code) return;

    const verifier = localStorage.getItem("spotify_code_verifier");
    const savedClientId = localStorage.getItem("spotify_client_id");

    if (!verifier || !savedClientId) {
      setStatus("Brakuje PKCE verifier. Kliknij login ponownie.");
      return;
    }

    async function exchangeCode() {
      setBusy(true);
      try {
        const body = new URLSearchParams({
          client_id: savedClientId,
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        });

        const response = await fetch(TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });

        if (!response.ok) throw new Error(await response.text());

        const data = await response.json();
        const expiry = Date.now() + data.expires_in * 1000;

        setToken(data.access_token);
        setExpiresAt(expiry);

        localStorage.setItem("spotify_access_token", data.access_token);
        localStorage.setItem("spotify_expires_at", String(expiry));
        localStorage.removeItem("spotify_code_verifier");

        setStatus("Zalogowano. Ładuję Spotify player...");
      } catch (err) {
        setStatus(`Nie udało się zalogować: ${err.message}`);
      } finally {
        setBusy(false);
        window.history.replaceState({}, document.title, redirectUri);
      }
    }

    exchangeCode();
  }, [redirectUri]);

  useEffect(() => {
    if (!token || Date.now() > expiresAt) return;
    if (playerRef.current) return;

    let mounted = true;

    function createPlayer() {
      if (!mounted || !window.Spotify || playerRef.current) return;

      const nextPlayer = new window.Spotify.Player({
        name: "Spotify A-B Loop Lite",
        getOAuthToken: (cb) => cb(tokenRef.current),
        volume: 0.8,
      });

      nextPlayer.addListener("ready", ({ device_id }) => {
        setDeviceId(device_id);
        setConnected(true);
        setStatus("Player gotowy. Kliknij „Użyj tego playera”.");
      });

      nextPlayer.addListener("not_ready", () => {
        setConnected(false);
        setStatus("Player nie jest gotowy.");
      });

      nextPlayer.addListener("authentication_error", ({ message }) => {
        setStatus(`Błąd auth: ${message}`);
      });

      nextPlayer.addListener("account_error", ({ message }) => {
        setStatus(`Problem z kontem: ${message}. Spotify Web Playback SDK wymaga Premium.`);
      });

      nextPlayer.addListener("playback_error", ({ message }) => {
        setStatus(`Błąd odtwarzania: ${message}`);
      });

      nextPlayer.addListener("player_state_changed", (state) => {
        if (!state) return;
        const current = state.track_window.current_track;

        setTrack(current);
        setDuration(current?.duration_ms || 0);
        setPosition(state.position || 0);
        setPaused(Boolean(state.paused));
      });

      nextPlayer.connect().then((ok) => {
        if (!ok) setStatus("Nie udało się połączyć z Spotify SDK.");
      });

      setPlayer(nextPlayer);
    }

    if (!document.getElementById("spotify-sdk")) {
      const script = document.createElement("script");
      script.id = "spotify-sdk";
      script.src = "https://sdk.scdn.co/spotify-player.js";
      script.async = true;
      document.body.appendChild(script);
    }

    window.onSpotifyWebPlaybackSDKReady = createPlayer;
    if (window.Spotify) createPlayer();

    return (
      <main className="spotifyShell">
        <aside className="sidebar">
          <div className="brandDot" />
          <h1>AB Loop</h1>
          <p>Spotify-inspired practice player</p>

          <div className="sideCard">
            <p className="small">Status</p>
            <p className={tokenExpired ? "error" : "ok"}>
              {tokenExpired ? "Token wygasł. Zaloguj się ponownie." : status}
            </p>
          </div>

          <div className="sideCard">
            <label>Spotify Client ID</label>
            <input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="Client ID"
            />

            <p className="small">
              Redirect URI:
              <br />
              <span className="mono">{redirectUri}</span>
            </p>

            <div className="row">
              {!token ? (
                <button onClick={login} disabled={busy}>
                  Login
                </button>
              ) : (
                <button className="danger" onClick={logout}>
                  Logout
                </button>
              )}

              <button
                className="secondary"
                onClick={transferPlayback}
                disabled={!token || !deviceId || busy}
              >
                Użyj playera
              </button>
            </div>
          </div>
        </aside>

        <section className="mainView">
          <header className="topBar">
            <form onSubmit={searchTracks} className="searchBar">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Czego chcesz posłuchać?"
              />
              <button disabled={!token || searching || !query.trim()}>
                {searching ? "Szukam..." : "Szukaj"}
              </button>
            </form>
          </header>

          <section className="hero">
            <div>
              <p className="eyebrow">A–B loop player</p>
              <h2>Wyszukaj utwór i ćwicz wybrany fragment.</h2>
              <p>
                Kliknij track, ustaw A/B na dolnym playerze i zapętlaj fragment.
              </p>
            </div>
          </section>

          <section className="results">
            <h3>Wyniki</h3>

            {results.length === 0 ? (
              <p className="emptyState">
                Wpisz nazwę piosenki, artysty albo albumu.
              </p>
            ) : (
              <div className="trackList">
                {results.map((item, index) => (
                  <button
                    key={item.id}
                    className="trackRow"
                    onClick={() => playTrack(item.uri)}
                  >
                    <span className="trackIndex">{index + 1}</span>

                    {item.album?.images?.[2]?.url || item.album?.images?.[0]?.url ? (
                      <img
                        src={item.album?.images?.[2]?.url || item.album?.images?.[0]?.url}
                        alt=""
                      />
                    ) : (
                      <span className="miniCover" />
                    )}

                    <span className="trackMeta">
                      <b>{item.name}</b>
                      <small>{item.artists?.map((artist) => artist.name).join(", ")}</small>
                    </span>

                    <span className="albumName">{item.album?.name}</span>
                    <span className="durationText">{msToTime(item.duration_ms)}</span>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="settingsPanel">
            <h3>Ustawienia pętli</h3>

            <div className="grid">
              <div>
                <label>A start</label>
                <input value={aInput} onChange={(e) => setAInput(e.target.value)} />
                <button className="secondary" onClick={setAHere} style={{ marginTop: 10 }}>
                  Ustaw A tutaj
                </button>
              </div>

              <div>
                <label>B koniec</label>
                <input value={bInput} onChange={(e) => setBInput(e.target.value)} />
                <button className="secondary" onClick={setBHere} style={{ marginTop: 10 }}>
                  Ustaw B tutaj
                </button>
              </div>
            </div>

            <p>
              Loop: <b>{msToTime(aMs)}</b> → <b>{msToTime(bMs)}</b>
            </p>
            {!validLoop && <p className="error">B musi być później niż A.</p>}
          </section>
        </section>

        <footer className="bottomPlayer">
          <div className="nowPlaying">
            {track?.album?.images?.[0]?.url ? (
              <img src={track.album.images[0].url} alt="" />
            ) : (
              <div className="footerCover" />
            )}

            <div>
              <b>{track?.name || "Brak utworu"}</b>
              <small>
                {track?.artists?.map((artist) => artist.name).join(", ") ||
                  "Wybierz utwór z wyników"}
              </small>
            </div>
          </div>

          <div className="footerCenter">
            <div className="playerButtons compact">
              <button className="secondary" onClick={togglePlay} disabled={!connected}>
                {paused ? "Play" : "Pause"}
              </button>

              <button onClick={() => setLoopOn((x) => !x)} disabled={!token || !validLoop}>
                {loopOn ? "Loop ON" : "Loop OFF"}
              </button>

              <button className="secondary" onClick={jumpToA} disabled={!token || !validLoop}>
                A
              </button>
            </div>

            <div className="timeline footerTimeline">
              <div className="progress">
                <div
                  className="loopRange"
                  style={{ left: `${loopLeft}%`, width: `${loopWidth}%` }}
                />
                <div
                  className="progressFill"
                  style={{ width: `${progressPct}%` }}
                />
              </div>

              <input
                aria-label="Punkt A"
                type="range"
                min="0"
                max={timelineMax}
                step="0.1"
                value={aMs / 1000}
                onChange={(e) => setAInput(e.target.value)}
                className="timelineRange rangeA"
              />

              <input
                aria-label="Punkt B"
                type="range"
                min="0"
                max={timelineMax}
                step="0.1"
                value={bMs / 1000}
                onChange={(e) => setBInput(e.target.value)}
                className="timelineRange rangeB"
              />

              <div className="marker markerA" style={{ left: `${loopLeft}%` }}>
                A
              </div>

              <div className="marker markerB" style={{ left: `${loopLeft + loopWidth}%` }}>
                B
              </div>
            </div>

            <div className="footerTime">
              <span>{msToTime(position)}</span>
              <span>A {msToTime(aMs)} · B {msToTime(bMs)}</span>
              <span>{msToTime(duration)}</span>
            </div>
          </div>
        </footer>
      </main>
    );
  })