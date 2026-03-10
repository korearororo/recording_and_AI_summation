from __future__ import annotations

import argparse
import json
import urllib.parse

import requests


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate Google Drive OAuth refresh token.")
    parser.add_argument("--client-id", required=True, help="OAuth Client ID")
    parser.add_argument("--client-secret", required=True, help="OAuth Client Secret")
    parser.add_argument(
        "--redirect-uri",
        default="urn:ietf:wg:oauth:2.0:oob",
        help="OAuth redirect URI configured in GCP (default: OOB)",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    auth_params = {
        "client_id": args.client_id,
        "redirect_uri": args.redirect_uri,
        "response_type": "code",
        "scope": "https://www.googleapis.com/auth/drive",
        "access_type": "offline",
        "prompt": "consent",
    }
    auth_url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode(auth_params)
    print("1) Open this URL in browser and authorize:")
    print(auth_url)
    print("")
    code = input("2) Paste authorization code here: ").strip()
    if not code:
        raise SystemExit("Authorization code is required.")

    token_resp = requests.post(
        "https://oauth2.googleapis.com/token",
        data={
            "code": code,
            "client_id": args.client_id,
            "client_secret": args.client_secret,
            "redirect_uri": args.redirect_uri,
            "grant_type": "authorization_code",
        },
        timeout=60,
    )
    try:
        payload = token_resp.json()
    except Exception:
        payload = {"raw": token_resp.text}

    if token_resp.status_code >= 400:
        print("Token exchange failed:")
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        raise SystemExit(1)

    refresh_token = str(payload.get("refresh_token") or "").strip()
    access_token = str(payload.get("access_token") or "").strip()
    if not refresh_token:
        print("No refresh_token returned. Ensure prompt=consent and first-time consent.")
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        raise SystemExit(1)

    print("")
    print("GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN=" + refresh_token)
    print("Access token (for quick test): " + access_token)


if __name__ == "__main__":
    main()
