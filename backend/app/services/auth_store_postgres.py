from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import time
import uuid
from threading import Lock

import psycopg
from psycopg.rows import dict_row

EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
PBKDF2_ITERATIONS = 200_000
DEFAULT_OAUTH_STATE_TTL_SECONDS = 10 * 60


class AuthStorePostgres:
    def __init__(self, database_url: str, session_ttl_hours: int = 24 * 30) -> None:
        self.database_url = database_url.strip()
        if not self.database_url:
            raise ValueError("AUTH_DATABASE_URL is required for Postgres auth store")
        self.session_ttl_seconds = max(int(session_ttl_hours * 3600), 3600)
        self._lock = Lock()
        self._initialize()

    def _connect(self) -> psycopg.Connection:
        return psycopg.connect(self.database_url, row_factory=dict_row)

    def _initialize(self) -> None:
        with self._lock:
            with self._connect() as conn:
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

    def _cleanup_expired_sessions(self, cur: psycopg.Cursor) -> None:
        cur.execute("DELETE FROM sessions WHERE expires_at <= %s", (time.time(),))

    def _cleanup_expired_oauth_states(self, cur: psycopg.Cursor) -> None:
        cur.execute("DELETE FROM oauth_states WHERE expires_at <= %s", (time.time(),))

    def create_user(self, email: str, password: str, display_name: str | None = None) -> dict[str, str]:
        normalized_email = self._normalize_email(email)
        if not EMAIL_PATTERN.match(normalized_email):
            raise ValueError("유효한 이메일을 입력해주세요.")
        if len(password) < 6:
            raise ValueError("비밀번호는 최소 6자 이상이어야 합니다.")

        clean_name = (display_name or normalized_email.split("@")[0]).strip() or "user"
        user_id = str(uuid.uuid4())
        created_at = time.time()
        salt_hex = secrets.token_hex(16)
        password_hash = self._hash_password(password, salt_hex)

        try:
            with self._lock:
                with self._connect() as conn:
                    with conn.cursor() as cur:
                        cur.execute(
                            """
                            INSERT INTO users (id, email, password_salt, password_hash, display_name, created_at)
                            VALUES (%s, %s, %s, %s, %s, %s)
                            """,
                            (user_id, normalized_email, salt_hex, password_hash, clean_name, created_at),
                        )
                    conn.commit()
        except psycopg.Error as exc:
            # unique_violation
            if getattr(exc, "sqlstate", "") == "23505":
                raise ValueError("이미 가입한 이메일입니다.") from exc
            raise

        return {"id": user_id, "email": normalized_email, "display_name": clean_name}

    def authenticate(self, email: str, password: str) -> dict[str, str] | None:
        normalized_email = self._normalize_email(email)
        with self._lock:
            with self._connect() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT id, email, display_name, password_salt, password_hash FROM users WHERE email = %s",
                        (normalized_email,),
                    )
                    row = cur.fetchone()
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
                with conn.cursor() as cur:
                    self._cleanup_expired_sessions(cur)
                    cur.execute(
                        """
                        INSERT INTO sessions (token, user_id, created_at, expires_at)
                        VALUES (%s, %s, %s, %s)
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
                with conn.cursor() as cur:
                    self._cleanup_expired_sessions(cur)
                    cur.execute(
                        """
                        SELECT u.id, u.email, u.display_name
                        FROM sessions s
                        JOIN users u ON u.id = s.user_id
                        WHERE s.token = %s
                        """,
                        (token,),
                    )
                    row = cur.fetchone()
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
                with conn.cursor() as cur:
                    cur.execute("DELETE FROM sessions WHERE token = %s", (token,))
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
                with conn.cursor() as cur:
                    self._cleanup_expired_oauth_states(cur)
                    cur.execute(
                        """
                        INSERT INTO oauth_states (state, provider, mobile_redirect_uri, created_at, expires_at)
                        VALUES (%s, %s, %s, %s, %s)
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
                with conn.cursor() as cur:
                    self._cleanup_expired_oauth_states(cur)
                    cur.execute(
                        """
                        SELECT mobile_redirect_uri
                        FROM oauth_states
                        WHERE state = %s AND provider = %s AND expires_at > %s
                        """,
                        (clean_state, clean_provider, time.time()),
                    )
                    row = cur.fetchone()
                    cur.execute("DELETE FROM oauth_states WHERE state = %s", (clean_state,))
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
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        SELECT u.id, u.email, u.display_name
                        FROM social_identities s
                        JOIN users u ON u.id = s.user_id
                        WHERE s.provider = %s AND s.provider_user_id = %s
                        """,
                        (clean_provider, clean_provider_user_id),
                    )
                    existing = cur.fetchone()
                    if existing is not None:
                        return {
                            "id": str(existing["id"]),
                            "email": str(existing["email"]),
                            "display_name": str(existing["display_name"]),
                        }

                    cur.execute(
                        "SELECT id, email, display_name FROM users WHERE email = %s",
                        (normalized_email,),
                    )
                    user_row = cur.fetchone()
                    if user_row is None:
                        user_id = str(uuid.uuid4())
                        created_at = time.time()
                        salt_hex = secrets.token_hex(16)
                        random_password = secrets.token_urlsafe(32)
                        password_hash = self._hash_password(random_password, salt_hex)
                        cur.execute(
                            """
                            INSERT INTO users (id, email, password_salt, password_hash, display_name, created_at)
                            VALUES (%s, %s, %s, %s, %s, %s)
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

                    cur.execute(
                        """
                        INSERT INTO social_identities (provider, provider_user_id, user_id, created_at)
                        VALUES (%s, %s, %s, %s)
                        ON CONFLICT (provider, provider_user_id) DO NOTHING
                        """,
                        (clean_provider, clean_provider_user_id, user["id"], time.time()),
                    )
                conn.commit()
                return user
