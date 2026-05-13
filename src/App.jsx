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
  return `${min}:${String(sec).padStart(2, "0")}`;
}

function parseTime(value) {
  const raw = String(value || "").trim().replace(",", ".");
  if (!raw) return 0;
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.round(Number(raw) * 1000);
  const parts = raw.split(":").map(Number);
  if (parts.some(Number.isNaN)) return 0;
  if (parts.length === 2) return Math.round((parts[0] * 60 + parts[1]) * 1000);
  if (parts.length === 3) return Math.round((parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000);
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
  const redirectUri = useMemo(() => window.location.origin + window.location.pathname, []);

  const [clientId, setClientId] = useState(() => localStorage.getItem("spotify_client_id") || "");
  const [token, setToken] = useState(() => localStorage.getItem("spotify_access_token") || "");
  const [expiresAt, setExpiresAt] = useState(() => Number(localStorage.getItem("spotify_expires_at") || 0));

  const [player, setPlayer] = useState(null);
  const [deviceId, setDeviceId] = useState("");
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState("Wpisz Client ID i zaloguj się.");
  const [busy, setBusy] = useState(false);

  const [track, setTrack] = useState(null);
  const [paused, setPaused] = useState(true);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);

  const [aInput, setAInput] = useState("30");
  const [bInput, setBInput] = useState("45");
  const [loopOn, setLoopOn] = useState(false);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const tokenRef = useRef(token);
  const playerRef = useRef(player);
  const lastSeekRef = useRef(0);
  const pollRef = useRef(null);

  const aMs = useMemo(() => parseTime(aInput), [aInput]);
  const bMs = useMemo(() => parseTime(bInput), [bInput]);
  const validLoop = bMs > aMs + 500;
  const timelineMax = Math.max(60, duration / 1000, bMs / 1000 + 5);

  const cover =
    track?.album?.images?.[0]?.url ||
    track?.album?.images?.[1]?.url ||
    "";

  const remaining = duration ? duration - position : 0;
  const progressPct = duration ? Math.min(100, (position / duration) * 100) : 0;
  const loopLeft = timelineMax ? Math.min(100, (aMs / 1000 / timelineMax) * 100) : 0;
  const loopWidth = timelineMax ? Math.max(0, ((bMs - aMs) / 1000 / timelineMax) * 100) : 0;
  const tokenExpired = token && Date.now() > expiresAt;

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
        name: "AB Loop Player",
        getOAuthToken: (cb) => cb(tokenRef.current),
        volume: 0.8,
      });

      nextPlayer.addListener("ready", ({ device_id }) => {
        setDeviceId(device_id);
        setConnected(true);
        setStatus("Player gotowy. Kliknij „Use Player”.");
      });

      nextPlayer.addListener("not_ready", () => {
        setConnected(false);
        setStatus("Player nie jest gotowy.");
      });

      nextPlayer.addListener("authentication_error", ({ message }) => setStatus(`Błąd auth: ${message}`));
      nextPlayer.addListener("account_error", ({ message }) => setStatus(`Problem z kontem: ${message}. Wymaga Spotify Premium.`));
      nextPlayer.addListener("playback_error", ({ message }) => setStatus(`Błąd odtwarzania: ${message}`));

      nextPlayer.addListener("player_state_changed", (state) => {
        if (!state) return;
        const current = state.track_window.current_track;
        setTrack(current);
        setDuration(current?.duration_ms || 0);
        setPosition(state.position || 0);
        setPaused(Boolean(state.paused));
      });

      nextPlayer.connect().then((ok) => {
        if (!ok) setStatus("Nie udało się połączyć ze Spotify SDK.");
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

    return () => {
      mounted = false;
    };
  }, [token, expiresAt]);

  useEffect(() => {
    if (!player || !token) return;

    clearInterval(pollRef.current);

    pollRef.current = setInterval(async () => {
      const state = await player.getCurrentState().catch(() => null);
      if (!state) return;

      const now = state.position || 0;
      setPosition(now);
      setPaused(Boolean(state.paused));

      if (!loopOn && duration && now >= duration - 900) {
        try {
          await player.pause();
          await apiFetch(`/me/player/seek?position_ms=${Math.max(0, duration - 1200)}`, tokenRef.current, {
            method: "PUT"
          });
        } catch (err) {
          console.error(err);
        }
        return;
      }

      if (!loopOn || state.paused || !validLoop) return;

      if (now >= bMs && Date.now() - lastSeekRef.current > 650) {
        lastSeekRef.current = Date.now();
        try {
          await apiFetch(`/me/player/seek?position_ms=${aMs}`, tokenRef.current, { method: "PUT" });
        } catch (err) {
          setStatus(`Seek error: ${err.message}`);
        }
      }
    }, 180);

    return () => clearInterval(pollRef.current);
  }, [player, token, loopOn, aMs, bMs, validLoop]);

  useEffect(() => {
    function onKey(e) {
      if (e.target?.tagName === "INPUT") return;

      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      }

      if (e.key.toLowerCase() === "l") {
        setLoopOn((x) => !x);
      }

      if (e.key.toLowerCase() === "a") {
        setAInput((position / 1000).toFixed(1));
      }

      if (e.key.toLowerCase() === "b") {
        setBInput((position / 1000).toFixed(1));
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [position]);

  async function login() {
    if (!clientId.trim()) {
      setStatus("Najpierw wklej Client ID.");
      setShowSettings(true);
      return;
    }

    const verifier = randomString();
    const challenge = base64Url(await sha256(verifier));

    localStorage.setItem("spotify_client_id", clientId.trim());
    localStorage.setItem("spotify_code_verifier", verifier);

    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId.trim(),
      scope: SCOPES,
      redirect_uri: redirectUri,
      code_challenge_method: "S256",
      code_challenge: challenge,
    });

    window.location.href = `${AUTH_URL}?${params.toString()}`;
  }

  function logout() {
    player?.disconnect?.();
    localStorage.removeItem("spotify_access_token");
    localStorage.removeItem("spotify_expires_at");
    localStorage.removeItem("spotify_code_verifier");
    setToken("");
    setExpiresAt(0);
    setPlayer(null);
    setDeviceId("");
    setConnected(false);
    setTrack(null);
    setStatus("Wylogowano.");
  }

  async function transferPlayback() {
    if (!token) {
      setStatus("Najpierw zaloguj się do Spotify.");
      return;
    }

    setBusy(true);

    try {
      if (player) {
        await player.activateElement().catch(() => {});
        await player.connect().catch(() => {});
      }

      let targetDeviceId = deviceId;

      if (!targetDeviceId) {
        const devicesData = await apiFetch("/me/player/devices", token);
        const sdkDevice = devicesData?.devices?.find((device) =>
          device.name === "AB Loop Player" ||
          device.name === "Spotify A-B Loop Lite" ||
          device.name?.toLowerCase().includes("ab loop")
        );

        targetDeviceId = sdkDevice?.id || "";
        if (targetDeviceId) setDeviceId(targetDeviceId);
      }

      if (!targetDeviceId) {
        throw new Error("Nie znaleziono urządzenia AB Loop Player. Odśwież stronę i spróbuj ponownie.");
      }

      await apiFetch("/me/player", token, {
        method: "PUT",
        body: JSON.stringify({
          device_ids: [targetDeviceId],
          play: false
        }),
      });

      setConnected(true);
      setStatus("Połączono z AB Loop Player. Wybierz utwór albo kliknij Play.");
    } catch (err) {
      setStatus(`Nie udało się połączyć: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function togglePlay() {
    await player?.togglePlay?.();
  }

  async function jumpTo(ms) {
    if (!token) return;
    await apiFetch(`/me/player/seek?position_ms=${Math.max(0, ms)}`, token, { method: "PUT" });
  }

  async function jumpToA() {
    if (!token || !validLoop) return;
    await jumpTo(aMs);
  }

  function moveA(value) {
    setAInput(value);
  }

  function moveB(value) {
    setBInput(value);
  }

  async function seekToARelease(value) {
    if (!token) return;
    const nextMs = parseTime(value);
    await jumpTo(nextMs);
  }

  async function seekToBRelease(value) {
    if (!token) return;
    const nextMs = parseTime(value);
    await jumpTo(nextMs);
  }

  function clearLoop() {
    setAInput("0");
    setBInput(duration ? String(Math.floor(duration / 1000)) : "45");
    setLoopOn(false);
  }

  async function searchTracks(event) {
    event?.preventDefault?.();

    if (!token || !query.trim()) return;

    setSearching(true);
    try {
      const data = await apiFetch(
        `/search?type=track&limit=12&q=${encodeURIComponent(query.trim())}`,
        token
      );
      setResults(data?.tracks?.items || []);
    } catch (err) {
      setStatus(`Search error: ${err.message}`);
    } finally {
      setSearching(false);
    }
  }

  async function playTrack(uri) {
    if (!token) {
      setStatus("Najpierw zaloguj się do Spotify.");
      setShowSettings(true);
      return;
    }

    try {
      let targetDeviceId = deviceId;

      if (!targetDeviceId) {
        await transferPlayback();
        targetDeviceId = deviceId;
      }

      await apiFetch(`/me/player/play?device_id=${targetDeviceId || deviceId}`, token, {
        method: "PUT",
        body: JSON.stringify({ uris: [uri] }),
      });

      setStatus("Odtwarzam wybrany utwór.");
      setShowSearch(false);
    } catch (err) {
      setStatus(`Play error: ${err.message}. Kliknij Connect i spróbuj ponownie.`);
    }
  }

  return (
    <main className="phoneStage">
      <div
        className="background"
        style={{ backgroundImage: cover ? `url(${cover})` : undefined }}
      />

      <section className="phonePlayer">
        <header className="statusBar">
          <span>AB Loop</span>
          <span>{token ? "Spotify" : "Offline"}</span>
        </header>

        <nav className="topNav">
          <button className="iconBtn" onClick={() => setShowSearch((x) => !x)}>⌄</button>
          <strong>Playing Song</strong>
          <button className="iconBtn" onClick={() => setShowSettings((x) => !x)}>⋯</button>
        </nav>

        {showSearch && (
          <section className="overlayPanel searchPanel">
            <form onSubmit={searchTracks} className="searchForm">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search songs..."
              />
              <button disabled={!token || searching || !query.trim()}>
                {searching ? "..." : "Search"}
              </button>
            </form>

            <div className="searchResults">
              {results.length === 0 ? (
                <p className="muted">Wyszukaj utwór w Spotify.</p>
              ) : (
                results.map((item) => (
                  <button
                    key={item.id}
                    className="resultRow"
                    onClick={() => playTrack(item.uri)}
                  >
                    {item.album?.images?.[2]?.url || item.album?.images?.[0]?.url ? (
                      <img src={item.album?.images?.[2]?.url || item.album?.images?.[0]?.url} alt="" />
                    ) : (
                      <span />
                    )}
                    <b>{item.name}</b>
                    <small>{item.artists?.map((artist) => artist.name).join(", ")}</small>
                  </button>
                ))
              )}
            </div>
          </section>
        )}

        {showSettings && (
          <section className="overlayPanel settingsPanel">
            <label>Spotify Client ID</label>
            <input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="Client ID"
            />

            <p className="muted tiny">
              Redirect URI:<br />
              {redirectUri}
            </p>

            <div className="settingsActions">
              {!token ? (
                <button onClick={login} disabled={busy}>Login Spotify</button>
              ) : (
                <button className="danger" onClick={logout}>Logout</button>
              )}

              <button className="secondary" onClick={transferPlayback} disabled={!token || !deviceId || busy}>
                Use Player
              </button>
            </div>

            <p className={tokenExpired ? "error" : "ok"}>
              {tokenExpired ? "Token wygasł." : status}
            </p>
          </section>
        )}

        <div className="visualSpace" />

        <section className="songInfo">
          <div className="miniArtWrap">
            {cover ? <img src={cover} alt="" /> : <div className="emptyArt" />}
          </div>

          <div className="songText">
            <h1>{track?.name || "Brak utworu"}</h1>
            <p>{track?.artists?.map((artist) => artist.name).join(", ") || "Wybierz utwór z wyszukiwarki"}</p>
          </div>

          <button className="addBtn" onClick={() => setShowSearch(true)}>＋</button>
        </section>

        <section className="mainTimeline">
          <div className="timeLine">
            <div className="normalProgress" style={{ width: `${progressPct}%` }} />
            <div className="loopShade" style={{ left: `${loopLeft}%`, width: `${loopWidth}%` }} />
          </div>

          <input
            aria-label="Punkt A"
            type="range"
            min="0"
            max={timelineMax}
            step="0.1"
            value={aMs / 1000}
            onChange={(e) => moveA(e.target.value)}
            onMouseUp={(e) => seekToARelease(e.target.value)}
            onTouchEnd={(e) => seekToARelease(e.target.value)}
            className="abRange aRange"
          />

          <input
            aria-label="Punkt B"
            type="range"
            min="0"
            max={timelineMax}
            step="0.1"
            value={bMs / 1000}
            onChange={(e) => moveB(e.target.value)}
            onMouseUp={(e) => seekToBRelease(e.target.value)}
            onTouchEnd={(e) => seekToBRelease(e.target.value)}
            className="abRange bRange"
          />

          <div className="abMarker aMarker" style={{ left: `${loopLeft}%` }}>A</div>
          <div className="abMarker bMarker" style={{ left: `${loopLeft + loopWidth}%` }}>B</div>

          <div className="timeLabels">
            <span>{msToTime(position)}</span>
            <span>-{msToTime(remaining)}</span>
          </div>
        </section>

        <section className="controlRow">
          <button className="iconText" onClick={clearLoop}>↝</button>
          <button className="skipBtn" onClick={jumpToA}>◀</button>
          <button className="playBtn" onClick={togglePlay} disabled={!connected}>
            {paused ? "▶" : "Ⅱ"}
          </button>
          <button className="skipBtn" onClick={() => jumpTo(bMs)}>▶</button>
          <button
            className={`loopBtn ${loopOn ? "active" : ""}`}
            onClick={() => setLoopOn((x) => !x)}
            disabled={!token || !validLoop}
          >
            ↻
          </button>
        </section>

        <section className="deviceRow">
          <span>🎧</span>
          <b>{connected ? "AB LOOP PLAYER" : "NOT CONNECTED"}</b>
          <button onClick={transferPlayback} disabled={!token || !deviceId || busy}>
            Connect
          </button>
        </section>

        <section className="abControls">
          <button onClick={() => setAInput((position / 1000).toFixed(1))}>
            Set A <b>{msToTime(aMs)}</b>
          </button>
          <button onClick={() => setBInput((position / 1000).toFixed(1))}>
            Set B <b>{msToTime(bMs)}</b>
          </button>
        </section>

        <section className="songDna">
          <div>
            <b>AB Loop</b>
            <span>Beta</span>
          </div>
          <p>Space = play/pause · A/B = ustaw punkty · L = loop</p>
        </section>
      </section>
    </main>
  );
}
