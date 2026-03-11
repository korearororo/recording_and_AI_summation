from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import sqlite3
import time
import uuid
from pathlib import Path
from threading import Lock

EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
PBKDF2_ITERATIONS = 200_000
DEFAULT_OAUTH_STATE_TTL_SECONDS = 10 * 60


class AuthStore:
    def __init__(self, db_path: Path, session_ttl_hours: int = 24 * 30) -> None:
        self.db_path = db_path
        self.session_ttl_seconds = max(int(session_ttl_hours * 3600), 3600)
        self._lock = Lock()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        return conn

    def _initialize(self) -> None:
        with self._lock:
            with self._connect() as conn:
                conn.execute("PRAGMA foreign_keys = ON")
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS users (
                        id TEXT PRIMARY KEY,
                        email TEXT UNIQUE NOT NULL,
                        password_salt TEXT NOT NULL,
                        password_hash TEXT NOT NULL,
                        display_name TEXT NOT NULL,
                        created_at REAL NOT NULL
                    )
                    """
                )
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS sessions (
                        token TEXT PRIMARY KEY,
                        user_id TEXT NOT NULL,
                        created_at REAL NOT NULL,
                        expires_at REAL NOT NULL,
                        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
                    )
                    """
                )
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS social_identities (
                        provider TEXT NOT NULL,
                        provider_user_id TEXT NOT NULL,
                        user_id TEXT NOT NULL,
                        created_at REAL NOT NULL,
                        PRIMARY KEY (provider, provider_user_id),
                        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
                    )
                    """
                )
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS oauth_states (
                        state TEXT PRIMARY KEY,
                        provider TEXT NOT NULL,
                        mobile_redirect_uri TEXT NOT NULL,
                        created_at REAL NOT NULL,
                        expires_at REAL NOT NULL
                    )
                    """
                )
                conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)")
                conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)")
                conn.execute("CREATE INDEX IF NOT EXISTS idx_social_identities_user_id ON social_identities(user_id)")
                conn.execute("CREATE INDEX IF NOT EXISTS idx_oauth_states_expires_at ON oauth_states(expires_at)")
                conn.commit()

    def _normalize_email(self, email: str) -> str:
        return email.strip().lower()

    def _hash_password(self, password: str, salt_hex: str) -> str:
        digest = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            bytes.fromhex(salt_hex),
            PBKDF2_ITERATIONS,
        )
        return digest.hex()

    def _cleanup_expired_sessions(self, conn: sqlite3.Connection) -> None:
        conn.execute("DELETE FROM sessions WHERE expires_at <= ?", (time.time(),))

    def _cleanup_expired_oauth_states(self, conn: sqlite3.Connection) -> None:
        conn.execute("DELETE FROM oauth_states WHERE expires_at <= ?", (time.time(),))

    def create_user(self, email: str, password: str, display_name: str | None = None) -> dict[str, str]:
        normalized_email = self._normalize_email(email)
        if not EMAIL_PATTERN.match(normalized_email):
            raise ValueError("유효한 이메일을 입력해주세요.")
        if len(password) < 6:
            raise ValueError("비밀번호는 최소 6자 이상이어야 합니다.")

        clean_name = (display_name or normalized_email.split("@")[0]).strip()
        if not clean_name:
            clean_name = "user"

        user_id = str(uuid.uuid4())
        created_at = time.time()
        salt_hex = secrets.token_hex(16)
        password_hash = self._hash_password(password, salt_hex)

        try:
            with self._lock:
                with self._connect() as conn:
                    conn.execute(
                        """
                        INSERT INTO users (id, email, password_salt, password_hash, display_name, created_at)
                        VALUES (?, ?, ?, ?, ?, ?)
                        """,
                        (user_id, normalized_email, salt_hex, password_hash, clean_name, created_at),
                    )
                    conn.commit()
        except sqlite3.IntegrityError as exc:
            raise ValueError("이미 가입된 이메일입니다.") from exc

        return {"id": user_id, "email": normalized_email, "display_name": clean_name}

    def authenticate(self, email: str, password: str) -> dict[str, str] | None:
        normalized_email = self._normalize_email(email)
        with self._lock:
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT id, email, display_name, password_salt, password_hash FROM users WHERE email = ?",
                    (normalized_email,),
                ).fetchone()
                if row is None:
                    return None

                expected_hash = self._hash_password(password, str(row["password_salt"]))
                if not hmac.compare_digest(expected_hash, str(row["password_hash"])):
                    return None

                return {
                    "id": str(row["id"]),
                    "email": str(row["email"]),
                    "display_name": str(row["display_name"]),
                }

    def create_session(self, user_id: str) -> tuple[str, float]:
        token = secrets.token_urlsafe(48)
        now = time.time()
        expires_at = now + self.session_ttl_seconds
        with self._lock:
            with self._connect() as conn:
                self._cleanup_expired_sessions(conn)
                conn.execute(
                    """
                    INSERT INTO sessions (token, user_id, created_at, expires_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (token, user_id, now, expires_at),
                )
                conn.commit()
        return token, expires_at

    def get_user_by_token(self, token: str) -> dict[str, str] | None:
        if not token:
            return None

        with self._lock:
            with self._connect() as conn:
                self._cleanup_expired_sessions(conn)
                row = conn.execute(
                    """
                    SELECT u.id, u.email, u.display_name, s.expires_at
                    FROM sessions s
                    JOIN users u ON u.id = s.user_id
                    WHERE s.token = ?
                    """,
                    (token,),
                ).fetchone()
                if row is None:
                    return None
                return {
                    "id": str(row["id"]),
                    "email": str(row["email"]),
                    "display_name": str(row["display_name"]),
                }

    def invalidate_session(self, token: str) -> None:
        if not token:
            return
        with self._lock:
            with self._connect() as conn:
                conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
                conn.commit()

    def create_oauth_state(
        self,
        provider: str,
        mobile_redirect_uri: str,
        ttl_seconds: int = DEFAULT_OAUTH_STATE_TTL_SECONDS,
    ) -> str:
        clean_provider = provider.strip().lower()
        redirect = mobile_redirect_uri.strip()
        if not clean_provider:
            raise ValueError("provider is required")
        if not redirect:
            raise ValueError("mobile_redirect_uri is required")

        state = secrets.token_urlsafe(32)
        now = time.time()
        expires_at = now + max(int(ttl_seconds), 60)
        with self._lock:
            with self._connect() as conn:
                self._cleanup_expired_oauth_states(conn)
                conn.execute(
                    """
                    INSERT INTO oauth_states (state, provider, mobile_redirect_uri, created_at, expires_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (state, clean_provider, redirect, now, expires_at),
                )
                conn.commit()
        return state

    def consume_oauth_state(self, state: str, provider: str) -> str | None:
        clean_state = state.strip()
        clean_provider = provider.strip().lower()
        if not clean_state or not clean_provider:
            return None

        with self._lock:
            with self._connect() as conn:
                self._cleanup_expired_oauth_states(conn)
                row = conn.execute(
                    """
                    SELECT mobile_redirect_uri
                    FROM oauth_states
                    WHERE state = ? AND provider = ? AND expires_at > ?
                    """,
                    (clean_state, clean_provider, time.time()),
                ).fetchone()
                conn.execute("DELETE FROM oauth_states WHERE state = ?", (clean_state,))
                conn.commit()
                if row is None:
                    return None
                return str(row["mobile_redirect_uri"])

    def find_or_create_social_user(
        self,
        provider: str,
        provider_user_id: str,
        email: str | None,
        display_name: str | None = None,
    ) -> dict[str, str]:
        clean_provider = provider.strip().lower()
        clean_provider_user_id = provider_user_id.strip()
        if not clean_provider or not clean_provider_user_id:
            raise ValueError("provider and provider_user_id are required")

        normalized_email = self._normalize_email(email or "")
        if not EMAIL_PATTERN.match(normalized_email):
            normalized_email = f"{clean_provider}_{clean_provider_user_id}@social.local"
        clean_name = (display_name or normalized_email.split("@")[0]).strip() or "user"

        with self._lock:
            with self._connect() as conn:
                existing = conn.execute(
                    """
                    SELECT u.id, u.email, u.display_name
                    FROM social_identities s
                    JOIN users u ON u.id = s.user_id
                    WHERE s.provider = ? AND s.provider_user_id = ?
                    """,
                    (clean_provider, clean_provider_user_id),
                ).fetchone()
                if existing is not None:
                    return {
                        "id": str(existing["id"]),
                        "email": str(existing["email"]),
                        "display_name": str(existing["display_name"]),
                    }

                user_row = conn.execute(
                    "SELECT id, email, display_name FROM users WHERE email = ?",
                    (normalized_email,),
                ).fetchone()
                if user_row is None:
                    user_id = str(uuid.uuid4())
                    created_at = time.time()
                    # Social-only account still needs a stored hash for local schema compatibility.
                    salt_hex = secrets.token_hex(16)
                    random_password = secrets.token_urlsafe(32)
                    password_hash = self._hash_password(random_password, salt_hex)
                    conn.execute(
                        """
                        INSERT INTO users (id, email, password_salt, password_hash, display_name, created_at)
                        VALUES (?, ?, ?, ?, ?, ?)
                        """,
                        (user_id, normalized_email, salt_hex, password_hash, clean_name, created_at),
                    )
                    user = {"id": user_id, "email": normalized_email, "display_name": clean_name}
                else:
                    user = {
                        "id": str(user_row["id"]),
                        "email": str(user_row["email"]),
                        "display_name": str(user_row["display_name"]),
                    }

                conn.execute(
                    """
                    INSERT OR IGNORE INTO social_identities (provider, provider_user_id, user_id, created_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (clean_provider, clean_provider_user_id, user["id"], time.time()),
                )
                conn.commit()
                return user
