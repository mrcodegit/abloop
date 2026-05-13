# Spotify A-B Loop Lite

Lekka wersja z prawdziwą integracją Spotify.

## Wymagania

- Node.js 20 albo 22 LTS
- Spotify Premium
- Spotify Developer App

## Start

```bash
npm install
npm run dev
```

Otwórz adres z terminala, zwykle:

```txt
http://localhost:5173/
```

## Spotify setup

1. Wejdź do Spotify Developer Dashboard.
2. Create App.
3. W ustawieniach aplikacji dodaj Redirect URI dokładnie taki sam jak w aplikacji, zwykle:

```txt
http://localhost:5173/
```

Uwaga: slash na końcu ma znaczenie. Najbezpieczniej skopiować URI z aplikacji.

4. Skopiuj Client ID.
5. Wklej Client ID w aplikacji.
6. Kliknij Login Spotify.
7. Kliknij „Użyj tego playera”.
8. Włącz piosenkę i ustaw A/B.

## Format czasu

Możesz wpisywać:

```txt
30
45.5
1:12
1:12.5
```

## Uwaga

Spotify Web Playback SDK działa tylko na Spotify Premium.
