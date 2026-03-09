from __future__ import annotations

import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from openai import OpenAI

from app.config import get_settings

SYSTEM_SUMMARY_PROMPT = (
    "You are a meeting notes assistant. "
    "Return concise and well-structured Korean output with these sections: "
    "1) 핵심 요약, 2) 주요 논의 사항, 3) 결정 사항, 4) 액션 아이템. "
    "If any section has no data, write '없음'."
)

CHAT_TRANSCRIBE_PROMPT = (
    "너는 강의 전사 교정기다. "
    "요약하지 말고 전사문을 그대로 정리해라. "
    "내용 추가/삭제 금지, 고유명사/용어 유지, 영어 단어를 한글 발음으로 바꾸지 마라. "
    "띄어쓰기/문장부호/명백한 인식 오류만 교정해라."
)

CHAT_SUMMARY_PROMPT = (
    "너는 강의 노트 정리 도우미다. "
    "입력 전사문에 있는 정보만 사용해서 요약해라. "
    "없는 사실을 추가하지 말고, 형식은 반드시 한국어로 아래 4개 섹션을 사용해라: "
    "1) 핵심 요약, 2) 핵심 개념, 3) 예시/부연 설명, 4) 시험 대비 포인트. "
    "정보가 부족한 섹션만 '없음'으로 써라."
)


class OpenAIService:
    def __init__(self) -> None:
        settings = get_settings()
        self.settings = settings
        self.client = OpenAI(
            api_key=settings.openai_api_key,
            timeout=settings.openai_timeout_seconds,
            max_retries=settings.openai_max_retries,
        )

    def transcribe_file(self, file_path: str) -> str:
        source_path = Path(file_path)
        max_upload_bytes = self.settings.transcribe_max_file_mb * 1024 * 1024

        if self.settings.transcribe_force_chunking:
            return self._transcribe_large_file(source_path, max_upload_bytes)

        if source_path.stat().st_size <= max_upload_bytes:
            try:
                return self._transcribe_single_file(source_path)
            except Exception as exc:
                if _should_retry_with_chunking(exc):
                    return self._transcribe_large_file(source_path, max_upload_bytes)
                raise

        return self._transcribe_large_file(source_path, max_upload_bytes)

    def summarize_transcript(self, transcript: str) -> str:
        response = self.client.responses.create(
            model=self.settings.summary_model,
            instructions=SYSTEM_SUMMARY_PROMPT,
            input=transcript,
        )

        output_text = getattr(response, "output_text", None)
        if isinstance(output_text, str) and output_text.strip():
            return output_text.strip()

        extracted = _extract_text_from_response(response)
        return extracted.strip() if extracted.strip() else "요약 생성 실패"

    def transcribe_with_chat(self, file_path: str) -> str:
        raw = self.transcribe_file(file_path)
        try:
            response = self.client.responses.create(
                model=self.settings.chat_transcribe_model,
                instructions=CHAT_TRANSCRIBE_PROMPT,
                input=f"다음 전사 원문을 교정해줘.\n<TRANSCRIPT>\n{raw}\n</TRANSCRIPT>",
            )
        except Exception as exc:
            # If refinement input is too large, keep raw transcription instead of failing the job.
            if _should_skip_refinement(exc):
                return raw
            raise
        output_text = getattr(response, "output_text", None)
        if isinstance(output_text, str) and output_text.strip():
            candidate = _cleanup_transcript_tags(output_text.strip())
            return raw if _looks_like_bad_transcribe_refinement(raw, candidate) else candidate
        extracted = _extract_text_from_response(response)
        candidate = _cleanup_transcript_tags(extracted.strip())
        if not candidate:
            return raw
        return raw if _looks_like_bad_transcribe_refinement(raw, candidate) else candidate

    def summarize_with_chat(self, transcript: str) -> str:
        response = self.client.responses.create(
            model=self.settings.chat_summary_model,
            instructions=CHAT_SUMMARY_PROMPT,
            input=(
                "아래 강의 전사문만 바탕으로 요약해줘.\n"
                "전사문에 없는 내용은 절대 넣지 마.\n"
                f"<TRANSCRIPT>\n{transcript}\n</TRANSCRIPT>"
            ),
        )
        output_text = getattr(response, "output_text", None)
        if isinstance(output_text, str) and output_text.strip():
            candidate = output_text.strip()
            if _looks_like_empty_summary(candidate):
                return self.summarize_transcript(transcript)
            return candidate
        extracted = _extract_text_from_response(response)
        candidate = extracted.strip()
        if not candidate:
            return "요약 생성 실패"
        if _looks_like_empty_summary(candidate):
            return self.summarize_transcript(transcript)
        return candidate

    def _transcribe_single_file(self, file_path: Path) -> str:
        with file_path.open("rb") as audio_file:
            result = self.client.audio.transcriptions.create(
                model=self.settings.transcribe_model,
                file=audio_file,
            )

        text = getattr(result, "text", None)
        if isinstance(text, str) and text.strip():
            return text.strip()

        return str(result)

    def _transcribe_large_file(self, source_path: Path, max_upload_bytes: int) -> str:
        with tempfile.TemporaryDirectory(prefix="audio_chunks_") as tmp_dir:
            chunk_paths = self._split_audio_with_ffmpeg(source_path, Path(tmp_dir))
            transcripts = self._transcribe_chunks_parallel(chunk_paths, max_upload_bytes)

            if not transcripts:
                raise RuntimeError("Large file transcription produced no text.")

            return "\n".join(transcripts)

    def _transcribe_chunks_parallel(self, chunk_paths: list[Path], max_upload_bytes: int) -> list[str]:
        if not chunk_paths:
            return []

        workers = max(1, min(self.settings.transcribe_parallel_chunks, len(chunk_paths)))
        ordered_texts: list[str] = [""] * len(chunk_paths)

        if workers == 1:
            for index, chunk_path in enumerate(chunk_paths):
                ordered_texts[index] = self._transcribe_chunk(chunk_path, max_upload_bytes)
        else:
            with ThreadPoolExecutor(max_workers=workers) as executor:
                futures = {
                    executor.submit(self._transcribe_chunk, chunk_path, max_upload_bytes): index
                    for index, chunk_path in enumerate(chunk_paths)
                }
                for future in as_completed(futures):
                    index = futures[future]
                    ordered_texts[index] = future.result()

        return [text for text in ordered_texts if text]

    def _transcribe_chunk(self, chunk_path: Path, max_upload_bytes: int) -> str:
        if chunk_path.stat().st_size > max_upload_bytes:
            raise RuntimeError(
                f"Chunk {chunk_path.name} exceeds upload limit "
                f"({self.settings.transcribe_max_file_mb}MB). "
                "Reduce TRANSCRIBE_CHUNK_MINUTES or bitrate."
            )

        return self._transcribe_single_file(chunk_path).strip()

    def _split_audio_with_ffmpeg(self, source_path: Path, output_dir: Path) -> list[Path]:
        chunk_minutes = max(self.settings.transcribe_chunk_minutes, 1)
        chunk_seconds = chunk_minutes * 60
        output_pattern = output_dir / "chunk_%03d.m4a"

        ffmpeg_cmd = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(source_path),
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "aac",
            "-b:a",
            self.settings.transcribe_chunk_bitrate,
            "-f",
            "segment",
            "-segment_time",
            str(chunk_seconds),
            "-reset_timestamps",
            "1",
            str(output_pattern),
        ]

        try:
            subprocess.run(ffmpeg_cmd, check=True, capture_output=True, text=True)
        except FileNotFoundError as exc:
            raise RuntimeError(
                "ffmpeg is required for large-file transcription but was not found."
            ) from exc
        except subprocess.CalledProcessError as exc:
            error_text = (exc.stderr or "").strip() or str(exc)
            raise RuntimeError(f"ffmpeg split failed: {error_text}") from exc

        chunks = sorted(output_dir.glob("chunk_*.m4a"))
        if not chunks:
            raise RuntimeError("Failed to split audio into chunks.")

        return chunks


def _extract_text_from_response(response: Any) -> str:
    parts: list[str] = []
    output = getattr(response, "output", None)
    if not isinstance(output, list):
        return ""

    for item in output:
        content = getattr(item, "content", None)
        if not isinstance(content, list):
            continue
        for block in content:
            text = getattr(block, "text", None)
            if isinstance(text, str):
                parts.append(text)

    return "\n".join(parts)


def _looks_like_bad_transcribe_refinement(raw: str, refined: str) -> bool:
    raw_ascii = sum(1 for ch in raw if ch.isascii() and ch.isalpha())
    refined_ascii = sum(1 for ch in refined if ch.isascii() and ch.isalpha())

    if raw_ascii == 0:
        return False

    # If English character signal drops too much, it likely transliterated terms.
    return refined_ascii < (raw_ascii * 0.4)


def _cleanup_transcript_tags(text: str) -> str:
    return text.replace("<TRANSCRIPT>", "").replace("</TRANSCRIPT>", "").strip()


def _looks_like_empty_summary(text: str) -> bool:
    normalized = text.replace(" ", "")
    return normalized.count("없음") >= 3


def _should_retry_with_chunking(error: Exception) -> bool:
    message = str(error).lower()
    return "input_too_large" in message or "too large for this model" in message


def _should_skip_refinement(error: Exception) -> bool:
    message = str(error).lower()
    return (
        "input_too_large" in message
        or "too large for this model" in message
        or "maximum context length" in message
        or "context length" in message
    )
