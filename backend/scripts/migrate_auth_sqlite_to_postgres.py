from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path

import psycopg


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Migrate auth data from SQLite to PostgreSQL.")
    parser.add_argument("--sqlite-path", required=True, help="Path to source SQLite auth.db")
    parser.add_argument("--postgres-url", required=True, help="PostgreSQL connection URL")
    return parser.parse_args()


def load_sqlite_rows(sqlite_path: Path) -> dict[str, list[tuple]]:
    conn = sqlite3.connect(str(sqlite_path))
    try:
        return {
            "users": conn.execute(
                "SELECT id, email, password_salt, password_hash, display_name, created_at FROM users"
            ).fetchall(),
            "sessions": conn.execute(
                "SELECT token, user_id, created_at, expires_at FROM sessions"
            ).fetchall(),
            "social_identities": conn.execute(
                "SELECT provider, provider_user_id, user_id, created_at FROM social_identities"
            ).fetchall(),
            "oauth_states": conn.execute(
                "SELECT state, provider, mobile_redirect_uri, created_at, expires_at FROM oauth_states"
            ).fetchall(),
        }
    finally:
        conn.close()


def ensure_postgres_schema(conn: psycopg.Connection) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                password_salt TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                display_name TEXT NOT NULL,
                created_at DOUBLE PRECISION NOT NULL
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                created_at DOUBLE PRECISION NOT NULL,
                expires_at DOUBLE PRECISION NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS social_identities (
                provider TEXT NOT NULL,
                provider_user_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                created_at DOUBLE PRECISION NOT NULL,
                PRIMARY KEY (provider, provider_user_id),
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS oauth_states (
                state TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                mobile_redirect_uri TEXT NOT NULL,
                created_at DOUBLE PRECISION NOT NULL,
                expires_at DOUBLE PRECISION NOT NULL
            )
            """
        )
        cur.execute("CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_social_identities_user_id ON social_identities(user_id)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_oauth_states_expires_at ON oauth_states(expires_at)")
    conn.commit()


def migrate(rows: dict[str, list[tuple]], postgres_url: str) -> dict[str, int]:
    with psycopg.connect(postgres_url) as conn:
        ensure_postgres_schema(conn)
        with conn.cursor() as cur:
            for row in rows["users"]:
                cur.execute(
                    """
                    INSERT INTO users (id, email, password_salt, password_hash, display_name, created_at)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    ON CONFLICT (id) DO UPDATE SET
                        email = EXCLUDED.email,
                        password_salt = EXCLUDED.password_salt,
                        password_hash = EXCLUDED.password_hash,
                        display_name = EXCLUDED.display_name,
                        created_at = EXCLUDED.created_at
                    """,
                    row,
                )

            for row in rows["sessions"]:
                cur.execute(
                    """
                    INSERT INTO sessions (token, user_id, created_at, expires_at)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT (token) DO UPDATE SET
                        user_id = EXCLUDED.user_id,
                        created_at = EXCLUDED.created_at,
                        expires_at = EXCLUDED.expires_at
                    """,
                    row,
                )

            for row in rows["social_identities"]:
                cur.execute(
                    """
                    INSERT INTO social_identities (provider, provider_user_id, user_id, created_at)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT (provider, provider_user_id) DO UPDATE SET
                        user_id = EXCLUDED.user_id,
                        created_at = EXCLUDED.created_at
                    """,
                    row,
                )

            for row in rows["oauth_states"]:
                cur.execute(
                    """
                    INSERT INTO oauth_states (state, provider, mobile_redirect_uri, created_at, expires_at)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (state) DO UPDATE SET
                        provider = EXCLUDED.provider,
                        mobile_redirect_uri = EXCLUDED.mobile_redirect_uri,
                        created_at = EXCLUDED.created_at,
                        expires_at = EXCLUDED.expires_at
                    """,
                    row,
                )

        conn.commit()

    return {
        "users": len(rows["users"]),
        "sessions": len(rows["sessions"]),
        "social_identities": len(rows["social_identities"]),
        "oauth_states": len(rows["oauth_states"]),
    }


def main() -> None:
    args = parse_args()
    sqlite_path = Path(args.sqlite_path).expanduser().resolve()
    if not sqlite_path.exists():
        raise SystemExit(f"SQLite file not found: {sqlite_path}")

    rows = load_sqlite_rows(sqlite_path)
    stats = migrate(rows, args.postgres_url)

    print("Migration completed.")
    for key, value in stats.items():
        print(f"{key}: {value}")


if __name__ == "__main__":
    main()
