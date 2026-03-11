from __future__ import annotations

import io
import json
import time
from dataclasses import dataclass
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2 import service_account
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload, MediaIoBaseUpload

FOLDER_MIME = "application/vnd.google-apps.folder"
DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive"]


@dataclass
class UploadPayload:
    kind: str
    file_name: str
    content: bytes
    content_type: str


class GoogleDriveLibraryStore:
    def __init__(
        self,
        service_account_json: str = "",
        root_folder_id: str = "",
        oauth_client_id: str = "",
        oauth_client_secret: str = "",
        oauth_refresh_token: str = "",
    ) -> None:
        creds = self._build_credentials(
            service_account_json=service_account_json,
            oauth_client_id=oauth_client_id,
            oauth_client_secret=oauth_client_secret,
            oauth_refresh_token=oauth_refresh_token,
        )
        self._drive = build("drive", "v3", credentials=creds, cache_discovery=False)
        root_id = root_folder_id.strip()
        if root_id:
            self._root_folder_id = root_id
        else:
            self._root_folder_id = self._find_or_create_folder("root", "RecordingAI-Library")

    def _build_credentials(
        self,
        service_account_json: str,
        oauth_client_id: str,
        oauth_client_secret: str,
        oauth_refresh_token: str,
    ):
        client_id = oauth_client_id.strip()
        client_secret = oauth_client_secret.strip()
        refresh_token = oauth_refresh_token.strip()
        if client_id and client_secret and refresh_token:
            creds = Credentials(
                token=None,
                refresh_token=refresh_token,
                token_uri="https://oauth2.googleapis.com/token",
                client_id=client_id,
                client_secret=client_secret,
                scopes=DRIVE_SCOPES,
            )
            creds.refresh(Request())
            return creds

        if service_account_json.strip():
            info = self._load_service_account_info(service_account_json)
            return service_account.Credentials.from_service_account_info(info, scopes=DRIVE_SCOPES)

        raise ValueError(
            "Google Drive credentials are missing. "
            "Set GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON or OAuth settings "
            "(GOOGLE_DRIVE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN)."
        )

    def sync_subject(
        self,
        user_id: str,
        subject_id: str,
        subject_name: str,
        meta: dict[str, object],
        uploads: list[UploadPayload],
        entry_key: str | None = None,
    ) -> tuple[str, list[str]]:
        user_folder_id = self._find_or_create_folder(self._root_folder_id, f"user_{self._safe_segment(user_id)}")
        subject_folder_id = self._find_or_create_subject_folder(user_folder_id, subject_id, subject_name)

        saved_files: list[str] = []
        resolved_entry_key = self._safe_segment(entry_key or "")
        if not resolved_entry_key:
            for payload in uploads:
                stem = Path(payload.file_name or "").stem.strip()
                if stem:
                    resolved_entry_key = self._safe_segment(stem)
                    break
        if not resolved_entry_key:
            resolved_entry_key = self._safe_segment("item")

        entry_dir_id = self._find_or_create_folder(subject_folder_id, resolved_entry_key)

        for payload in uploads:
            if payload.kind not in {"recording", "transcript", "translation", "summary"}:
                continue
            stored_name = f"{payload.kind}__{payload.file_name}"
            self._upload_or_replace_file(
                parent_id=entry_dir_id,
                file_name=stored_name,
                content=payload.content,
                content_type=payload.content_type,
            )
            saved_files.append(f"entries/{resolved_entry_key}/{payload.kind}/{payload.file_name}")

        meta_bytes = json.dumps(meta, ensure_ascii=False, indent=2).encode("utf-8")
        self._upload_or_replace_file(
            parent_id=subject_folder_id,
            file_name="meta.json",
            content=meta_bytes,
            content_type="application/json",
        )

        return f"drive://folder/{subject_folder_id}", saved_files

    def list_subjects(self, user_id: str) -> dict[str, object]:
        user_folder_name = f"user_{self._safe_segment(user_id)}"
        user_folder = self._find_folder(self._root_folder_id, user_folder_name)
        if user_folder is None:
            return {"root_dir": f"drive://folder/{self._root_folder_id}", "subjects": []}

        user_folder_id = str(user_folder["id"])
        subjects: list[dict[str, object]] = []
        for folder in self._list_child_folders(user_folder_id):
            folder_name = str(folder.get("name") or "")
            subject_folder_id = str(folder["id"])
            meta = self._read_meta_json(subject_folder_id)
            grouped = self._collect_subject_files(subject_folder_id)
            recordings = grouped["recordings"]
            transcripts = grouped["transcripts"]
            translations = grouped["translations"]
            summaries = grouped["summaries"]

            subject_id = str(meta.get("id") or folder_name.split("__")[-1] or folder_name)
            subject_name = str(meta.get("name") or subject_id)
            subjects.append(
                {
                    "folder": folder_name,
                    "path": f"drive://folder/{subject_folder_id}",
                    "subject_id": subject_id,
                    "subject_name": subject_name,
                    "subject_tag": str(meta.get("tag") or ""),
                    "subject_icon": str(meta.get("icon") or ""),
                    "subject_color": str(meta.get("color") or ""),
                    "subject_order": str(meta.get("order") or ""),
                    "recording": len(recordings) > 0,
                    "transcript": len(transcripts) > 0,
                    "translation": len(translations) > 0,
                    "summary": len(summaries) > 0,
                    "recordings": recordings,
                    "transcripts": transcripts,
                    "translations": translations,
                    "summaries": summaries,
                }
            )

        subjects.sort(key=lambda item: str(item.get("folder") or ""))
        return {"root_dir": f"drive://folder/{user_folder_id}", "subjects": subjects}

    def download_subject_file(self, user_id: str, subject_id: str, kind: str, file_name: str) -> tuple[bytes, str, str]:
        user_folder = self._find_folder(self._root_folder_id, f"user_{self._safe_segment(user_id)}")
        if user_folder is None:
            raise FileNotFoundError("user folder not found")
        user_folder_id = str(user_folder["id"])

        subject_folder = self._find_subject_folder(user_folder_id, subject_id)
        if subject_folder is None:
            raise FileNotFoundError("subject not found")
        subject_folder_id = str(subject_folder["id"])

        if kind not in {"recording", "transcript", "translation", "summary"}:
            raise ValueError("kind must be one of: recording, transcript, translation, summary")

        # New structure: subject/<entry>/<kind>__<filename>
        target_file = self._find_file_in_entry_folders(subject_folder_id, f"{kind}__{file_name}")
        # Backward compatibility: subject/<kind-folder>/<filename>
        if target_file is None:
            kind_to_dir = {
                "recording": "recordings",
                "transcript": "transcripts",
                "translation": "translations",
                "summary": "summaries",
            }
            subfolder = self._find_folder(subject_folder_id, kind_to_dir[kind])
            if subfolder is not None:
                target_file = self._find_file(str(subfolder["id"]), file_name)
        if target_file is None:
            raise FileNotFoundError("file not found")

        file_id = str(target_file["id"])
        content = self._download_file(file_id)
        content_type = str(target_file.get("mimeType") or "application/octet-stream")
        return content, file_name, content_type

    def archive_and_clear_user_library(self, user_id: str) -> dict[str, object]:
        user_folder_name = f"user_{self._safe_segment(user_id)}"
        user_folder = self._find_folder(self._root_folder_id, user_folder_name)
        if user_folder is None:
            return {"archive_dir": "", "moved_items": 0}

        user_folder_id = str(user_folder["id"])
        archive_name = f"archive_{user_folder_name}_{int(time.time())}"
        archive_id = self._find_or_create_folder(self._root_folder_id, archive_name)

        query = f"'{self._escape_query(user_folder_id)}' in parents and trashed = false"
        items = self._list_files(query, fields="files(id,name,mimeType,parents)")
        moved = 0
        for item in items:
            file_id = str(item.get("id") or "")
            if not file_id:
                continue
            self._drive.files().update(
                fileId=file_id,
                addParents=archive_id,
                removeParents=user_folder_id,
                fields="id",
                supportsAllDrives=True,
            ).execute()
            moved += 1

        return {"archive_dir": f"drive://folder/{archive_id}", "moved_items": moved}

    def _load_service_account_info(self, raw: str) -> dict[str, object]:
        value = raw.strip()
        if not value:
            raise ValueError("GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON is empty")
        if value.startswith("{"):
            parsed = json.loads(value)
            if not isinstance(parsed, dict):
                raise ValueError("service account JSON must be an object")
            return parsed

        file_path = Path(value).expanduser().resolve()
        if not file_path.exists():
            raise ValueError("service account JSON path does not exist")
        parsed = json.loads(file_path.read_text(encoding="utf-8"))
        if not isinstance(parsed, dict):
            raise ValueError("service account file must contain an object")
        return parsed

    def _safe_segment(self, value: str) -> str:
        cleaned = "".join(ch if ch.isalnum() or ch in ("-", "_", " ") else "_" for ch in value)
        collapsed = "_".join(cleaned.split())
        return (collapsed[:80] or "untitled").strip("_")

    def _escape_query(self, value: str) -> str:
        return value.replace("\\", "\\\\").replace("'", "\\'")

    def _list_child_folders(self, parent_id: str) -> list[dict[str, object]]:
        query = (
            f"'{self._escape_query(parent_id)}' in parents and trashed = false "
            f"and mimeType = '{FOLDER_MIME}'"
        )
        return self._list_files(query, fields="files(id,name)")

    def _list_files(self, query: str, fields: str) -> list[dict[str, object]]:
        items: list[dict[str, object]] = []
        page_token: str | None = None
        while True:
            response = (
                self._drive.files()
                .list(
                    q=query,
                    spaces="drive",
                    fields=f"nextPageToken,{fields}",
                    includeItemsFromAllDrives=True,
                    supportsAllDrives=True,
                    pageSize=1000,
                    pageToken=page_token,
                )
                .execute()
            )
            files = response.get("files", [])
            if isinstance(files, list):
                for entry in files:
                    if isinstance(entry, dict):
                        items.append(entry)
            page_token = response.get("nextPageToken")
            if not page_token:
                break
        return items

    def _find_folder(self, parent_id: str, name: str) -> dict[str, object] | None:
        escaped_parent = self._escape_query(parent_id)
        escaped_name = self._escape_query(name)
        query = (
            f"'{escaped_parent}' in parents and trashed = false and mimeType = '{FOLDER_MIME}' "
            f"and name = '{escaped_name}'"
        )
        items = self._list_files(query, fields="files(id,name)")
        return items[0] if items else None

    def _find_or_create_folder(self, parent_id: str, name: str) -> str:
        existing = self._find_folder(parent_id, name)
        if existing is not None:
            return str(existing["id"])

        body = {"name": name, "mimeType": FOLDER_MIME, "parents": [parent_id]}
        created = (
            self._drive.files()
            .create(body=body, fields="id,name", supportsAllDrives=True)
            .execute()
        )
        return str(created["id"])

    def _find_subject_folder(self, user_folder_id: str, subject_id: str) -> dict[str, object] | None:
        suffix = f"__{self._safe_segment(subject_id)}"
        for folder in self._list_child_folders(user_folder_id):
            name = str(folder.get("name") or "")
            if name.endswith(suffix):
                return folder
        return None

    def _find_or_create_subject_folder(self, user_folder_id: str, subject_id: str, subject_name: str) -> str:
        existing = self._find_subject_folder(user_folder_id, subject_id)
        if existing is not None:
            return str(existing["id"])
        folder_name = f"{self._safe_segment(subject_name or subject_id)}__{self._safe_segment(subject_id)}"
        return self._find_or_create_folder(user_folder_id, folder_name)

    def _find_file_in_entry_folders(self, subject_folder_id: str, stored_name: str) -> dict[str, object] | None:
        for entry_folder in self._list_child_folders(subject_folder_id):
            entry_name = str(entry_folder.get("name") or "")
            if entry_name in {"recordings", "transcripts", "translations", "summaries"}:
                continue
            found = self._find_file(str(entry_folder["id"]), stored_name)
            if found is not None:
                return found
        return None

    def _collect_subject_files(self, subject_folder_id: str) -> dict[str, list[str]]:
        grouped: dict[str, set[str]] = {
            "recordings": set(),
            "transcripts": set(),
            "translations": set(),
            "summaries": set(),
        }

        for entry_folder in self._list_child_folders(subject_folder_id):
            entry_name = str(entry_folder.get("name") or "")
            if entry_name in {"recordings", "transcripts", "translations", "summaries"}:
                continue
            files = self._list_files(
                query=(
                    f"'{self._escape_query(str(entry_folder['id']))}' in parents and trashed = false "
                    f"and mimeType != '{FOLDER_MIME}'"
                ),
                fields="files(name)",
            )
            for file_item in files:
                raw_name = str(file_item.get("name") or "")
                if "__" not in raw_name:
                    continue
                kind, original = raw_name.split("__", 1)
                if not original:
                    continue
                if kind == "recording":
                    grouped["recordings"].add(original)
                elif kind == "transcript":
                    grouped["transcripts"].add(original)
                elif kind == "translation":
                    grouped["translations"].add(original)
                elif kind == "summary":
                    grouped["summaries"].add(original)

        # Backward compatibility for old flat-kind structure.
        grouped["recordings"].update(self._list_files_in_subfolder(subject_folder_id, "recordings"))
        grouped["transcripts"].update(self._list_files_in_subfolder(subject_folder_id, "transcripts"))
        grouped["translations"].update(self._list_files_in_subfolder(subject_folder_id, "translations"))
        grouped["summaries"].update(self._list_files_in_subfolder(subject_folder_id, "summaries"))

        return {
            "recordings": sorted(grouped["recordings"]),
            "transcripts": sorted(grouped["transcripts"]),
            "translations": sorted(grouped["translations"]),
            "summaries": sorted(grouped["summaries"]),
        }

    def _find_file(self, parent_id: str, file_name: str) -> dict[str, object] | None:
        escaped_parent = self._escape_query(parent_id)
        escaped_name = self._escape_query(file_name)
        query = (
            f"'{escaped_parent}' in parents and trashed = false and mimeType != '{FOLDER_MIME}' "
            f"and name = '{escaped_name}'"
        )
        items = self._list_files(query, fields="files(id,name,mimeType)")
        return items[0] if items else None

    def _upload_or_replace_file(self, parent_id: str, file_name: str, content: bytes, content_type: str) -> str:
        existing = self._find_file(parent_id, file_name)
        media = MediaIoBaseUpload(io.BytesIO(content), mimetype=content_type or "application/octet-stream", resumable=False)
        if existing is not None:
            updated = (
                self._drive.files()
                .update(
                    fileId=str(existing["id"]),
                    media_body=media,
                    fields="id",
                    supportsAllDrives=True,
                )
                .execute()
            )
            return str(updated["id"])

        body = {"name": file_name, "parents": [parent_id]}
        created = (
            self._drive.files()
            .create(body=body, media_body=media, fields="id", supportsAllDrives=True)
            .execute()
        )
        return str(created["id"])

    def _download_file(self, file_id: str) -> bytes:
        request = self._drive.files().get_media(fileId=file_id, supportsAllDrives=True)
        output = io.BytesIO()
        downloader = MediaIoBaseDownload(output, request)
        done = False
        while not done:
            _, done = downloader.next_chunk()
        return output.getvalue()

    def _read_meta_json(self, subject_folder_id: str) -> dict[str, object]:
        meta_file = self._find_file(subject_folder_id, "meta.json")
        if meta_file is None:
            return {}
        try:
            payload = self._download_file(str(meta_file["id"])).decode("utf-8")
            parsed = json.loads(payload)
            if isinstance(parsed, dict):
                return parsed
            return {}
        except Exception:
            return {}

    def _list_files_in_subfolder(self, subject_folder_id: str, subfolder_name: str) -> list[str]:
        subfolder = self._find_folder(subject_folder_id, subfolder_name)
        if subfolder is None:
            return []
        subfolder_id = str(subfolder["id"])
        query = (
            f"'{self._escape_query(subfolder_id)}' in parents and trashed = false "
            f"and mimeType != '{FOLDER_MIME}'"
        )
        items = self._list_files(query, fields="files(name)")
        names = [str(item.get("name") or "") for item in items if str(item.get("name") or "")]
        names.sort()
        return names
