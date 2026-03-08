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
                conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)")
                conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)")
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
