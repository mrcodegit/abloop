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

      if (!loopOn || state.paused || !validLoop) return;

      if (now >= bMs && Date.now() - lastSeekRef.current > 650) {
        lastSeekRef.current = Date.now();
        try {
          await apiFetch(`/me/player/seek?position_ms=${aMs}`, tokenRef.current, {
            method: "PUT",
          });
        } catch (err) {
          setStatus(`Seek error: ${err.message}`);
        }
      }
    }, 180);

    return () => clearInterval(pollRef.current);
  }, [player, token, loopOn, aMs, bMs, validLoop]);

  async function login() {
    if (!clientId.trim()) {
      setStatus("Najpierw wklej Client ID.");
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
    if (!deviceId) return;

    setBusy(true);
    try {
      await apiFetch("/me/player", token, {
        method: "PUT",
        body: JSON.stringify({
          device_ids: [deviceId],
          play: false,
        }),
      });
      setStatus("OK. Teraz włącz piosenkę w Spotify albo kliknij Play.");
    } catch (err) {
      setStatus(`Nie udało się użyć playera: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function togglePlay() {
    await player?.togglePlay?.();
  }

  async function jumpToA() {
    if (!token || !validLoop) return;
    await apiFetch(`/me/player/seek?position_ms=${aMs}`, token, { method: "PUT" });
  }

  function setAHere() {
    setAInput((position / 1000).toFixed(1));
  }

  function setBHere() {
    setBInput((position / 1000).toFixed(1));
  }

  const progressPct = duration ? Math.min(100, (position / duration) * 100) : 0;
  const loopLeft = duration ? Math.min(100, (aMs / duration) * 100) : 0;
  const loopWidth = duration ? Math.max(0, ((bMs - aMs) / duration) * 100) : 0;
  const tokenExpired = token && Date.now() > expiresAt;

  return (
    <main className="app">
      <h1>Spotify A-B Loop Lite</h1>
      <p>
        Lekka wersja z prawdziwym Spotify: React + Vite, bez Tailwind i bez shadcn.
      </p>

      <section className="card">
        <label>Spotify Client ID</label>
        <input
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder="Wklej Client ID z Spotify Developer Dashboard"
        />

        <p className="small">
          W Spotify Developer Dashboard dodaj Redirect URI:
          <br />
          <span className="mono">{redirectUri}</span>
        </p>

        <div className="row">
          {!token ? (
            <button onClick={login} disabled={busy}>
              Login Spotify
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
            Użyj tego playera
          </button>

          <button
            className="secondary"
            onClick={togglePlay}
            disabled={!connected}
          >
            {paused ? "Play" : "Pause"}
          </button>
        </div>

        <p className={tokenExpired ? "error" : "ok"}>{tokenExpired ? "Token wygasł. Zaloguj się ponownie." : status}</p>
      </section>

      <section className="card">
        <div className="track">
          {track?.album?.images?.[0]?.url ? (
            <img className="cover" src={track.album.images[0].url} alt="Album cover" />
          ) : (
            <div className="cover" />
          )}

          <div>
            <p className="small">Aktualny utwór</p>
            <h2>{track?.name || "Brak utworu"}</h2>
            <p>{track?.artists?.map((artist) => artist.name).join(", ") || "Włącz piosenkę w Spotify."}</p>

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

            <div className="rangeBox">
              <div className="rangeLabels">
                <span>A: {msToTime(aMs)}</span>
                <span>B: {msToTime(bMs)}</span>
              </div>

              <label className="small">Przesuń start pętli A</label>
              <input
                type="range"
                min="0"
                max={Math.max(1, duration / 1000)}
                step="0.1"
                value={aMs / 1000}
                onChange={(e) => setAInput(e.target.value)}
              />

              <label className="small">Przesuń koniec pętli B</label>
              <input
                type="range"
                min="0"
                max={Math.max(1, duration / 1000)}
                step="0.1"
                value={bMs / 1000}
                onChange={(e) => setBInput(e.target.value)}
              />
            </div>

            <p className="small">
              {msToTime(position)} / {msToTime(duration)}
            </p>
          </div>
        </div>
      </section>

      <section className="card">
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

        <div className="row">
          <button
            onClick={() => setLoopOn((x) => !x)}
            disabled={!token || !validLoop}
          >
            {loopOn ? "Loop ON" : "Loop OFF"}
          </button>

          <button
            className="secondary"
            onClick={jumpToA}
            disabled={!token || !validLoop}
          >
            Skocz do A
          </button>
        </div>
      </section>

      <section className="card">
        <h3>Jak odpalić</h3>
        <pre className="mono">{`npm install
npm run dev`}</pre>

        <h3>Wymagania</h3>
        <p>
          Musisz mieć Spotify Premium. W aplikacji Spotify Developer dodaj dokładnie taki Redirect URI,
          jaki widzisz wyżej. Przy lokalnym Vite zwykle będzie to <span className="mono">http://localhost:5173/</span>.
        </p>
      </section>
    </main>
  );
}
