import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import {
  RecordingPresets,
  requestNotificationPermissionsAsync,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';

type ProcessMode = 'api' | 'chat';
type SubjectTag = 'major' | 'general' | 'exam';

type SubjectTagStyle = {
  label: string;
  icon: string;
  bg: string;
  border: string;
  text: string;
};

type SubjectMeta = {
  id: string;
  name: string;
  tag?: SubjectTag;
  createdAt: number;
};

type SubjectItem = {
  id: string;
  name: string;
  tag: SubjectTag;
  hasRecording: boolean;
  hasTranscript: boolean;
  hasSummary: boolean;
  updatedAt: number;
};

type RecordingItem = {
  id: string;
  title: string;
  recordingFile: File;
  transcriptFile: File;
  summaryFile: File;
  updatedAt: number;
  isLegacy: boolean;
};

type SubjectPaths = {
  dir: Directory;
  meta: File;
  recordingsDir: Directory;
  transcriptsDir: Directory;
  summariesDir: Directory;
  legacyRecording: File;
  legacyTranscript: File;
  legacySummary: File;
};

const FALLBACK_API_URL = Platform.OS === 'android' ? 'http://10.0.2.2:8000' : 'http://localhost:8000';

const SUBJECTS_ROOT = new Directory(Paths.document, 'subjects');
const LECTURE_RECORDING_PRESET = {
  ...RecordingPresets.HIGH_QUALITY,
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 32000,
  android: {
    ...RecordingPresets.HIGH_QUALITY.android,
    extension: '.m4a',
    outputFormat: 'mpeg4',
    audioEncoder: 'aac',
  },
  ios: {
    ...RecordingPresets.HIGH_QUALITY.ios,
    audioQuality: RecordingPresets.LOW_QUALITY.ios.audioQuality,
  },
};
const SUBJECT_TAG_STYLES: Record<SubjectTag, SubjectTagStyle> = {
  major: { label: '전공', icon: '🎓', bg: '#E0F2FE', border: '#7DD3FC', text: '#0C4A6E' },
  general: { label: '교양', icon: '📚', bg: '#ECFCCB', border: '#A3E635', text: '#365314' },
  exam: { label: '시험과목', icon: '📝', bg: '#FCE7F3', border: '#F9A8D4', text: '#831843' },
};

export default function App() {
  const recorder = useAudioRecorder(LECTURE_RECORDING_PRESET as any);
  const recorderState = useAudioRecorderState(recorder, 250);

  const [subjects, setSubjects] = useState<SubjectItem[]>([]);
  const [selectedSubjectId, setSelectedSubjectId] = useState<string | null>(null);
  const [newSubjectName, setNewSubjectName] = useState('');
  const [newSubjectTag, setNewSubjectTag] = useState<SubjectTag>('major');

  const [recordingUri, setRecordingUri] = useState<string | null>(null);
  const [recordings, setRecordings] = useState<RecordingItem[]>([]);
  const [selectedRecordingId, setSelectedRecordingId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState('');
  const [summary, setSummary] = useState('');

  const [transcribeMode, setTranscribeMode] = useState<ProcessMode>('api');
  const [summaryMode, setSummaryMode] = useState<ProcessMode>('api');

  const [statusMessage, setStatusMessage] = useState('준비 완료');
  const [isBusy, setIsBusy] = useState(false);
  const [libraryPath, setLibraryPath] = useState('');
  const [librarySavedFiles, setLibrarySavedFiles] = useState<string[]>([]);

  const apiBaseUrl =
    process.env.EXPO_PUBLIC_API_BASE_URL ??
    (Platform.OS === 'android'
      ? process.env.EXPO_PUBLIC_API_BASE_URL_ANDROID
      : process.env.EXPO_PUBLIC_API_BASE_URL_IOS) ??
    FALLBACK_API_URL;

  const selectedSubject = useMemo(
    () => subjects.find((subject) => subject.id === selectedSubjectId) ?? null,
    [selectedSubjectId, subjects],
  );

  const selectedPaths = useMemo(() => {
    if (!selectedSubjectId) {
      return null;
    }
    return getSubjectPaths(selectedSubjectId);
  }, [selectedSubjectId]);

  const selectedRecording = useMemo(
    () => recordings.find((item) => item.id === selectedRecordingId) ?? null,
    [recordings, selectedRecordingId],
  );

  const isRecording = recorderState.isRecording;
  const durationSeconds = Math.floor(recorderState.durationMillis / 1000);
  const recordButtonDisabled = !selectedSubject && !isRecording;

  const displayTime = useMemo(() => {
    const minutes = Math.floor(durationSeconds / 60)
      .toString()
      .padStart(2, '0');
    const seconds = (durationSeconds % 60).toString().padStart(2, '0');
    return `${minutes}:${seconds}`;
  }, [durationSeconds]);

  useEffect(() => {
    void initialize();
  }, []);

  useEffect(() => {
    if (!selectedSubjectId) {
      setRecordingUri(null);
      setRecordings([]);
      setSelectedRecordingId(null);
      setTranscript('');
      setSummary('');
      setLibraryPath('');
      setLibrarySavedFiles([]);
      return;
    }

    setLibraryPath('');
    setLibrarySavedFiles([]);
    void loadSubjectFiles(selectedSubjectId, selectedRecordingId);
  }, [selectedSubjectId]);

  const initialize = async () => {
    ensureSubjectsRoot();
    await loadSubjects();
  };

  const ensurePermissions = async () => {
    const mic = await requestRecordingPermissionsAsync();
    if (!mic.granted) {
      throw new Error('마이크 권한이 필요합니다.');
    }

    if (Platform.OS === 'android') {
      try {
        await requestNotificationPermissionsAsync();
      } catch {
        // Notification permission request failure should not block recording start.
      }
    }
  };

  const createSubject = async () => {
    const name = newSubjectName.trim();
    if (!name) {
      setStatusMessage('과목명을 입력해주세요.');
      return;
    }

    try {
      ensureSubjectsRoot();

      const id = `subject-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const paths = getSubjectPaths(id);
      paths.dir.create({ idempotent: true, intermediates: true });
      ensureRecordingDirs(paths);

      const meta: SubjectMeta = {
        id,
        name,
        tag: newSubjectTag,
        createdAt: Date.now(),
      };
      writeText(paths.meta, JSON.stringify(meta, null, 2));

      setNewSubjectName('');
      setNewSubjectTag('major');
      setSelectedSubjectId(id);
      await loadSubjects(id);
      setStatusMessage(`과목 '${name}' 생성 완료 (${SUBJECT_TAG_STYLES[newSubjectTag].label})`);
    } catch (error) {
      setStatusMessage(`과목 생성 실패: ${formatError(error)}`);
    }
  };

  const openDirectory = (subjectId: string) => {
    setSelectedSubjectId(subjectId);
    const picked = subjects.find((subject) => subject.id === subjectId);
    const tag = picked ? SUBJECT_TAG_STYLES[picked.tag].label : '';
    setStatusMessage(`디렉토리 열림: ${picked?.name ?? subjectId}${tag ? ` (${tag})` : ''}`);
  };

  const selectRecording = async (recordingId: string) => {
    if (!selectedSubjectId) {
      return;
    }
    const items = listRecordingItems(getSubjectPaths(selectedSubjectId));
    await loadSubjectFiles(selectedSubjectId, recordingId);
    const picked = items.find((item) => item.id === recordingId);
    if (picked) {
      setStatusMessage(`녹음 파일 선택: ${picked.title}`);
    }
  };

  const startRecording = async () => {
    if (!selectedSubjectId) {
      setStatusMessage('먼저 과목을 선택해주세요.');
      return;
    }

    try {
      setStatusMessage('권한 확인 중...');
      await ensurePermissions();
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        shouldPlayInBackground: true,
        allowsBackgroundRecording: true,
        interruptionMode: 'doNotMix',
      });

      await recorder.prepareToRecordAsync(LECTURE_RECORDING_PRESET as any);
      recorder.record();
      setStatusMessage('녹음 중 (백그라운드 지속)');
    } catch (error) {
      setStatusMessage(`녹음 시작 실패: ${formatError(error)}`);
    }
  };

  const stopRecording = async () => {
    if (!selectedPaths) {
      setStatusMessage('과목을 선택해주세요.');
      return;
    }

    try {
      setStatusMessage('녹음 저장 중...');
      await recorder.stop();

      const uri = recorder.uri ?? recorder.getStatus().url;
      if (!uri) {
        throw new Error('저장된 녹음 파일 경로를 찾지 못했습니다.');
      }

      const source = new File(uri);
      if (!source.exists) {
        throw new Error('녹음 원본 파일을 찾지 못했습니다.');
      }

      ensureRecordingDirs(selectedPaths);
      const recordingFileName = `recording-${Date.now()}.m4a`;
      const targetRecording = new File(selectedPaths.recordingsDir, recordingFileName);
      if (targetRecording.exists) {
        targetRecording.delete();
      }
      source.copy(targetRecording);

      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        shouldPlayInBackground: false,
        interruptionMode: 'mixWithOthers',
      });

      await refreshSelectedSubject(recordingFileName);
      setStatusMessage(`녹음 완료: ${recordingFileName}`);
    } catch (error) {
      setStatusMessage(`녹음 중지 실패: ${formatError(error)}`);
    }
  };

  const runTranscriptionApi = async () => {
    if (!selectedSubject || !selectedRecording) {
      setStatusMessage('전사할 녹음 파일을 선택해주세요.');
      return;
    }
    if (!selectedRecording.recordingFile.exists) {
      setStatusMessage('선택한 녹음 파일이 없습니다.');
      return;
    }

    let uploadFile: File | null = null;
    let uploadUri = selectedRecording.recordingFile.uri;
    const startedAt = Date.now();
    try {
      setIsBusy(true);
      setStatusMessage('API 전사 중...');
      if (isRecording) {
        uploadFile = createRecordingSnapshot(selectedRecording.recordingFile);
        uploadUri = uploadFile.uri;
      }

      const formData = new FormData();
      formData.append(
        'file',
        {
          uri: uploadUri,
          name: `recording-${Date.now()}.m4a`,
          type: 'audio/m4a',
        } as any,
      );

      const response = await fetch(`${apiBaseUrl}/api/transcribe`, {
        method: 'POST',
        body: formData,
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.detail ?? '전사 실패');
      }

      const value = (data?.transcript ?? '').trim();
      writeText(selectedRecording.transcriptFile, value);
      setTranscript(value);
      await refreshSelectedSubject(selectedRecording.id);
      const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
      setStatusMessage(`전사 저장 완료 (${elapsedSeconds}초)`);
    } catch (error) {
      setStatusMessage(`전사 실패: ${formatError(error)}`);
    } finally {
      if (uploadFile?.exists) {
        uploadFile.delete();
      }
      setIsBusy(false);
    }
  };

  const runTranscriptionChatApi = async () => {
    if (!selectedSubject || !selectedRecording) {
      setStatusMessage('전사할 녹음 파일을 선택해주세요.');
      return;
    }
    if (!selectedRecording.recordingFile.exists) {
      setStatusMessage('선택한 녹음 파일이 없습니다.');
      return;
    }

    let uploadFile: File | null = null;
    let uploadUri = selectedRecording.recordingFile.uri;
    const startedAt = Date.now();
    try {
      setIsBusy(true);
      setStatusMessage('대화형 AI 전사 중...');
      if (isRecording) {
        uploadFile = createRecordingSnapshot(selectedRecording.recordingFile);
        uploadUri = uploadFile.uri;
      }

      const formData = new FormData();
      formData.append(
        'file',
        {
          uri: uploadUri,
          name: `recording-${Date.now()}.m4a`,
          type: 'audio/m4a',
        } as any,
      );

      const response = await fetch(`${apiBaseUrl}/api/transcribe-chat`, {
        method: 'POST',
        body: formData,
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.detail ?? '대화형 전사 실패');
      }

      const value = (data?.transcript ?? '').trim();
      writeText(selectedRecording.transcriptFile, value);
      setTranscript(value);
      await refreshSelectedSubject(selectedRecording.id);
      const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
      setStatusMessage(`대화형 AI 전사 저장 완료 (${elapsedSeconds}초)`);
    } catch (error) {
      setStatusMessage(`대화형 전사 실패: ${formatError(error)}`);
    } finally {
      if (uploadFile?.exists) {
        uploadFile.delete();
      }
      setIsBusy(false);
    }
  };

  const runSummaryApi = async () => {
    if (!selectedSubject || !selectedRecording) {
      setStatusMessage('요약할 녹음 파일을 선택해주세요.');
      return;
    }

    const sourceTranscript = transcript.trim();
    if (!sourceTranscript) {
      setStatusMessage('먼저 전사 텍스트를 준비해주세요.');
      return;
    }

    try {
      setIsBusy(true);
      setStatusMessage('API 요약 중...');

      const response = await fetch(`${apiBaseUrl}/api/summarize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: sourceTranscript }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.detail ?? '요약 실패');
      }

      const value = (data?.summary ?? '').trim();
      writeText(selectedRecording.summaryFile, value);
      setSummary(value);
      await refreshSelectedSubject(selectedRecording.id);
      setStatusMessage('요약 저장 완료');
    } catch (error) {
      setStatusMessage(`요약 실패: ${formatError(error)}`);
    } finally {
      setIsBusy(false);
    }
  };

  const runSummaryChatApi = async () => {
    if (!selectedSubject || !selectedRecording) {
      setStatusMessage('요약할 녹음 파일을 선택해주세요.');
      return;
    }

    const sourceTranscript = transcript.trim();
    if (!sourceTranscript) {
      setStatusMessage('먼저 전사 텍스트를 준비해주세요.');
      return;
    }

    try {
      setIsBusy(true);
      setStatusMessage('대화형 AI 요약 중...');

      const response = await fetch(`${apiBaseUrl}/api/summarize-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: sourceTranscript }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.detail ?? '대화형 요약 실패');
      }

      const value = (data?.summary ?? '').trim();
      writeText(selectedRecording.summaryFile, value);
      setSummary(value);
      await refreshSelectedSubject(selectedRecording.id);
      setStatusMessage('대화형 AI 요약 저장 완료');
    } catch (error) {
      setStatusMessage(`대화형 요약 실패: ${formatError(error)}`);
    } finally {
      setIsBusy(false);
    }
  };

  const refreshSelectedSubject = async (preferredRecordingId?: string | null) => {
    if (!selectedSubjectId) {
      return;
    }
    await loadSubjectFiles(selectedSubjectId, preferredRecordingId);
    await loadSubjects(selectedSubjectId);
  };

  const syncSubjectToLibrary = async () => {
    if (!selectedSubject || !selectedRecording) {
      setStatusMessage('과목을 선택해주세요.');
      return;
    }

    try {
      setIsBusy(true);
      setStatusMessage('PC 라이브러리 동기화 중...');

      const formData = new FormData();
      formData.append('subject_id', selectedSubject.id);
      formData.append('subject_name', selectedSubject.name);
      formData.append('subject_tag', selectedSubject.tag);

      const selectedBaseName = recordingDisplayName(selectedRecording);
      const hasRecording = appendFileIfExists(
        formData,
        'recording',
        selectedRecording.recordingFile,
        selectedBaseName,
        'audio/m4a',
      );
      const hasTranscript = appendFileIfExists(
        formData,
        'transcript',
        selectedRecording.transcriptFile,
        `${stripAudioExtension(selectedBaseName)}.txt`,
        'text/plain',
      );
      const hasSummary = appendFileIfExists(
        formData,
        'summary',
        selectedRecording.summaryFile,
        `${stripAudioExtension(selectedBaseName)}.summary.txt`,
        'text/plain',
      );
      const hasAnyFile = hasRecording || hasTranscript || hasSummary;

      if (!hasAnyFile) {
        setStatusMessage('동기화할 파일이 없습니다.');
        return;
      }

      const response = await fetch(`${apiBaseUrl}/api/library/sync`, {
        method: 'POST',
        body: formData,
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.detail ?? '라이브러리 동기화 실패');
      }

      const targetPath = typeof data?.target_dir === 'string' ? data.target_dir : '';
      const savedFiles = Array.isArray(data?.saved_files)
        ? data.saved_files.filter((value: unknown): value is string => typeof value === 'string')
        : [];

      setLibraryPath(targetPath);
      setLibrarySavedFiles(savedFiles);
      setStatusMessage(`PC 라이브러리 동기화 완료 (${savedFiles.join(', ') || 'meta.json'})`);
    } catch (error) {
      setStatusMessage(`라이브러리 동기화 실패: ${formatError(error)}`);
    } finally {
      setIsBusy(false);
    }
  };

  const exportSubjectFile = async (kind: 'recording' | 'transcript' | 'summary') => {
    if (!selectedSubject || !selectedRecording) {
      setStatusMessage('파일을 선택해주세요.');
      return;
    }

    const target =
      kind === 'recording'
        ? selectedRecording.recordingFile
        : kind === 'transcript'
          ? selectedRecording.transcriptFile
          : selectedRecording.summaryFile;

    if (!target.exists) {
      setStatusMessage(`${kind} 파일이 아직 없습니다.`);
      return;
    }

    try {
      const available = await Sharing.isAvailableAsync();
      if (!available) {
        Alert.alert('공유 불가', '이 기기에서는 파일 공유를 지원하지 않습니다.');
        return;
      }
      await Sharing.shareAsync(target.uri);
      setStatusMessage(`${kind} 파일 공유창을 열었습니다.`);
    } catch (error) {
      setStatusMessage(`파일 공유 실패: ${formatError(error)}`);
    }
  };

  const loadSubjects = async (preferredId?: string) => {
    ensureSubjectsRoot();

    const entries = SUBJECTS_ROOT.list();
    const rows: SubjectItem[] = [];

    for (const entry of entries) {
      if (!(entry instanceof Directory)) {
        continue;
      }

      const id = entry.name;
      const paths = getSubjectPaths(id);
      const meta = await readMeta(paths.meta);
      const recordings = listRecordingItems(paths);

      const updatedAt =
        Math.max(recordings[0]?.updatedAt ?? 0, meta?.createdAt ?? 0, paths.meta.modificationTime ?? 0) || 0;
      const hasRecording = recordings.some((item) => item.recordingFile.exists);
      const hasTranscript = recordings.some((item) => item.transcriptFile.exists);
      const hasSummary = recordings.some((item) => item.summaryFile.exists);

      rows.push({
        id,
        name: meta?.name ?? id,
        tag: meta?.tag ?? 'major',
        hasRecording,
        hasTranscript,
        hasSummary,
        updatedAt,
      });
    }

    rows.sort((a, b) => b.updatedAt - a.updatedAt);
    setSubjects(rows);

    const desiredId = preferredId ?? selectedSubjectId;
    if (desiredId && rows.some((subject) => subject.id === desiredId)) {
      if (selectedSubjectId !== desiredId) {
        setSelectedSubjectId(desiredId);
      }
      return;
    }

    if (!selectedSubjectId && rows.length > 0) {
      setSelectedSubjectId(rows[0].id);
    }
  };

  const loadSubjectFiles = async (subjectId: string, preferredRecordingId?: string | null) => {
    const paths = getSubjectPaths(subjectId);
    const items = listRecordingItems(paths);
    setRecordings(items);

    if (items.length === 0) {
      setSelectedRecordingId(null);
      setRecordingUri(null);
      setTranscript('');
      setSummary('');
      return;
    }

    const desiredId = preferredRecordingId ?? selectedRecordingId;
    const picked = items.find((item) => item.id === desiredId) ?? items[0];
    setSelectedRecordingId(picked.id);
    setRecordingUri(picked.recordingFile.uri);

    const transcriptValue = picked.transcriptFile.exists ? await picked.transcriptFile.text() : '';
    setTranscript(transcriptValue);

    const summaryValue = picked.summaryFile.exists ? await picked.summaryFile.text() : '';
    setSummary(summaryValue);
  };

  return (
    <LinearGradient colors={['#F7F9FC', '#EAF1FB', '#DCE9FF']} style={styles.background}>
      <SafeAreaView style={styles.safeArea}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.title}>Campus Lecture Binder</Text>
          <Text style={styles.subtitle}>수업별 디렉토리로 녹음 · 전사 · 요약 관리</Text>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>1) 디렉토리 만들기/열기</Text>
            <View style={styles.row}>
              <TextInput
                placeholder="예: 선형대수"
                placeholderTextColor="#94A3B8"
                style={styles.input}
                value={newSubjectName}
                onChangeText={setNewSubjectName}
              />
              <Pressable style={styles.smallButton} onPress={createSubject}>
                <Text style={styles.smallButtonText}>디렉토리 만들기</Text>
              </Pressable>
            </View>
            <View style={styles.tagSelectWrap}>
              <Text style={styles.tagSelectLabel}>태그 선택</Text>
              <View style={styles.tagSelectRow}>
                {(Object.keys(SUBJECT_TAG_STYLES) as SubjectTag[]).map((tag) => {
                  const tagStyle = SUBJECT_TAG_STYLES[tag];
                  const active = newSubjectTag === tag;
                  return (
                    <Pressable
                      key={tag}
                      style={[
                        styles.tagOptionButton,
                        { backgroundColor: tagStyle.bg, borderColor: tagStyle.border },
                        active && styles.tagOptionButtonActive,
                      ]}
                      onPress={() => setNewSubjectTag(tag)}
                    >
                      <Text style={[styles.tagOptionText, { color: tagStyle.text }]}>
                        {tagStyle.icon} {tagStyle.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
            <Text style={styles.helper}>목록에서 '디렉토리 열기'를 누르면 해당 수업으로 이동합니다.</Text>
            <View style={styles.subjectList}>
              {subjects.length === 0 ? <Text style={styles.helper}>생성된 과목이 없습니다.</Text> : null}
              {subjects.map((subject) => (
                <View key={subject.id} style={styles.subjectRow}>
                  <Pressable
                    style={[styles.subjectItem, selectedSubjectId === subject.id && styles.subjectItemActive]}
                    onPress={() => openDirectory(subject.id)}
                  >
                    <Text style={styles.subjectName}>{subject.name}</Text>
                    <View
                      style={[
                        styles.tagBadge,
                        {
                          backgroundColor: SUBJECT_TAG_STYLES[subject.tag].bg,
                          borderColor: SUBJECT_TAG_STYLES[subject.tag].border,
                        },
                      ]}
                    >
                      <Text style={[styles.tagBadgeText, { color: SUBJECT_TAG_STYLES[subject.tag].text }]}>
                        {SUBJECT_TAG_STYLES[subject.tag].icon} {SUBJECT_TAG_STYLES[subject.tag].label}
                      </Text>
                    </View>
                    <Text style={styles.subjectMeta}>
                      {subject.hasRecording ? 'REC' : '-'} / {subject.hasTranscript ? 'TXT' : '-'} /{' '}
                      {subject.hasSummary ? 'SUM' : '-'}
                    </Text>
                  </Pressable>
                  <Pressable style={styles.openButton} onPress={() => openDirectory(subject.id)}>
                    <Text style={styles.openButtonText}>디렉토리 열기</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>2) 선택 과목 녹음/저장</Text>
            <Text style={styles.helper}>선택 과목: {selectedSubject?.name ?? '없음'}</Text>
            {selectedSubject ? (
              <View
                style={[
                  styles.selectedTagBadge,
                  {
                    backgroundColor: SUBJECT_TAG_STYLES[selectedSubject.tag].bg,
                    borderColor: SUBJECT_TAG_STYLES[selectedSubject.tag].border,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.selectedTagBadgeText,
                    {
                      color: SUBJECT_TAG_STYLES[selectedSubject.tag].text,
                    },
                  ]}
                >
                  {SUBJECT_TAG_STYLES[selectedSubject.tag].icon} {SUBJECT_TAG_STYLES[selectedSubject.tag].label}
                </Text>
              </View>
            ) : null}
            <Text style={styles.timer}>{displayTime}</Text>
            <Pressable
              style={[
                styles.recordButton,
                isRecording ? styles.stopButton : styles.startButton,
                recordButtonDisabled && styles.disabledButton,
              ]}
              onPress={isRecording ? stopRecording : startRecording}
              disabled={recordButtonDisabled}
            >
              <Text style={styles.recordButtonText}>
                {isRecording ? '녹음 중지 및 저장' : selectedSubject ? '녹음 시작' : '디렉토리 먼저 열기'}
              </Text>
            </Pressable>
            <Text style={styles.helper}>백그라운드 녹음은 Dev Build/Release 환경에서 더 안정적입니다.</Text>
            {!selectedSubject ? (
              <Text style={styles.warnText}>녹음을 시작하려면 먼저 과목 디렉토리를 열어주세요.</Text>
            ) : null}
            <Text style={styles.helper}>녹음 파일 선택: {selectedRecording?.title ?? '없음'}</Text>
            <Text style={styles.helper}>
              선택 파일 크기: {formatBytes(selectedRecording?.recordingFile.size ?? 0)}
            </Text>
            <Text style={styles.filePath} numberOfLines={1}>
              녹음 파일: {recordingUri ?? '없음'}
            </Text>
            <View style={styles.recordingList}>
              {recordings.length === 0 ? <Text style={styles.helper}>저장된 녹음 파일이 없습니다.</Text> : null}
              {recordings.map((item) => (
                <Pressable
                  key={item.id}
                  style={[styles.recordingItem, selectedRecordingId === item.id && styles.recordingItemActive]}
                  onPress={() => void selectRecording(item.id)}
                >
                  <Text style={styles.recordingTitle}>{item.title}</Text>
                  <Text style={styles.recordingMeta}>
                    {item.recordingFile.exists ? 'REC' : '-'} / {item.transcriptFile.exists ? 'TXT' : '-'} /{' '}
                    {item.summaryFile.exists ? 'SUM' : '-'}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>3) 전사 방식 선택</Text>
            <ModeToggle mode={transcribeMode} onChange={setTranscribeMode} />
            {transcribeMode === 'api' ? (
              <Pressable
                style={[styles.actionButton, (!selectedRecording || isBusy) && styles.disabledButton]}
                onPress={runTranscriptionApi}
                disabled={!selectedRecording || isBusy}
              >
                <Text style={styles.actionButtonText}>API 전사 실행</Text>
              </Pressable>
            ) : (
              <Pressable
                style={[styles.actionButton, (!selectedRecording || isBusy) && styles.disabledButton]}
                onPress={runTranscriptionChatApi}
                disabled={!selectedRecording || isBusy}
              >
                <Text style={styles.actionButtonText}>대화형 AI 전사 실행</Text>
              </Pressable>
            )}
            <Text style={styles.previewTitle}>전사 미리보기</Text>
            <Text style={styles.bodyText}>{transcript || '전사 결과 없음'}</Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>4) 요약 방식 선택</Text>
            <ModeToggle mode={summaryMode} onChange={setSummaryMode} />
            {summaryMode === 'api' ? (
              <Pressable
                style={[styles.actionButton, (!selectedRecording || isBusy) && styles.disabledButton]}
                onPress={runSummaryApi}
                disabled={!selectedRecording || isBusy}
              >
                <Text style={styles.actionButtonText}>API 요약 실행</Text>
              </Pressable>
            ) : (
              <Pressable
                style={[styles.actionButton, (!selectedRecording || isBusy) && styles.disabledButton]}
                onPress={runSummaryChatApi}
                disabled={!selectedRecording || isBusy}
              >
                <Text style={styles.actionButtonText}>대화형 AI 요약 실행</Text>
              </Pressable>
            )}
            <Text style={styles.previewTitle}>요약 미리보기</Text>
            <Text style={styles.bodyText}>{summary || '요약 결과 없음'}</Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>5) 저장 상태</Text>
            <Text style={styles.helper}>각 과목 폴더의 recordings/transcripts/summaries에 파일별로 저장됩니다.</Text>
            <Pressable
              style={[styles.actionButton, (!selectedRecording || isBusy) && styles.disabledButton]}
              onPress={syncSubjectToLibrary}
              disabled={!selectedRecording || isBusy}
            >
              <Text style={styles.actionButtonText}>PC 라이브러리 동기화</Text>
            </Pressable>
            <Text style={styles.helper}>선택 파일: {selectedRecording?.title ?? '없음'}</Text>
            <Text style={styles.filePath} numberOfLines={1}>
              PC 라이브러리 경로: {libraryPath || '미동기화'}
            </Text>
            {librarySavedFiles.length > 0 ? (
              <Text style={styles.helper}>동기화 파일: {librarySavedFiles.join(', ')}</Text>
            ) : null}
            <Text style={styles.filePath} numberOfLines={1}>
              폴더: {selectedPaths?.dir.uri ?? '과목 미선택'}
            </Text>
            <View style={styles.fileActionGrid}>
              <Pressable
                style={[styles.fileActionButton, (!selectedRecording?.recordingFile.exists || isBusy) && styles.disabledButton]}
                onPress={() => exportSubjectFile('recording')}
                disabled={!selectedRecording?.recordingFile.exists || isBusy}
              >
                <Text style={styles.fileActionText}>녹음 내보내기</Text>
              </Pressable>
              <Pressable
                style={[
                  styles.fileActionButton,
                  (!selectedRecording?.transcriptFile.exists || isBusy) && styles.disabledButton,
                ]}
                onPress={() => exportSubjectFile('transcript')}
                disabled={!selectedRecording?.transcriptFile.exists || isBusy}
              >
                <Text style={styles.fileActionText}>전사 내보내기</Text>
              </Pressable>
              <Pressable
                style={[styles.fileActionButton, (!selectedRecording?.summaryFile.exists || isBusy) && styles.disabledButton]}
                onPress={() => exportSubjectFile('summary')}
                disabled={!selectedRecording?.summaryFile.exists || isBusy}
              >
                <Text style={styles.fileActionText}>요약 내보내기</Text>
              </Pressable>
            </View>
            <Text style={styles.status}>상태: {statusMessage}</Text>
            <Text style={styles.apiInfo}>API: {apiBaseUrl}</Text>
            {isBusy ? <ActivityIndicator color="#2563EB" style={styles.loader} /> : null}
          </View>
        </ScrollView>
      </SafeAreaView>
    </LinearGradient>
  );
}

type ModeToggleProps = {
  mode: ProcessMode;
  onChange: (mode: ProcessMode) => void;
};

function ModeToggle({ mode, onChange }: ModeToggleProps) {
  return (
    <View style={styles.toggleRow}>
      <Pressable
        style={[styles.toggleButton, mode === 'api' && styles.toggleButtonActive]}
        onPress={() => onChange('api')}
      >
        <Text style={styles.toggleText}>API 자동</Text>
      </Pressable>
      <Pressable
        style={[styles.toggleButton, mode === 'chat' && styles.toggleButtonActive]}
        onPress={() => onChange('chat')}
      >
        <Text style={styles.toggleText}>대화형 AI API</Text>
      </Pressable>
    </View>
  );
}

function getSubjectPaths(subjectId: string): SubjectPaths {
  const dir = new Directory(SUBJECTS_ROOT, subjectId);
  const recordingsDir = new Directory(dir, 'recordings');
  const transcriptsDir = new Directory(dir, 'transcripts');
  const summariesDir = new Directory(dir, 'summaries');
  return {
    dir,
    meta: new File(dir, 'meta.json'),
    recordingsDir,
    transcriptsDir,
    summariesDir,
    legacyRecording: new File(dir, 'recording.m4a'),
    legacyTranscript: new File(dir, 'transcript.txt'),
    legacySummary: new File(dir, 'summary.txt'),
  };
}

function ensureRecordingDirs(paths: SubjectPaths) {
  if (!paths.recordingsDir.exists) {
    paths.recordingsDir.create({ idempotent: true, intermediates: true });
  }
  if (!paths.transcriptsDir.exists) {
    paths.transcriptsDir.create({ idempotent: true, intermediates: true });
  }
  if (!paths.summariesDir.exists) {
    paths.summariesDir.create({ idempotent: true, intermediates: true });
  }
}

function stripAudioExtension(fileName: string): string {
  return fileName.replace(/\.[^/.]+$/, '');
}

function recordingDisplayName(item: RecordingItem): string {
  return item.recordingFile.name || item.title || item.id;
}

function listRecordingItems(paths: SubjectPaths): RecordingItem[] {
  const items: RecordingItem[] = [];

  if (paths.recordingsDir.exists) {
    const entries = paths.recordingsDir.list();
    for (const entry of entries) {
      if (!(entry instanceof File)) {
        continue;
      }
      const lowerName = entry.name.toLowerCase();
      const isAudio = ['.m4a', '.mp3', '.wav', '.aac', '.webm', '.3gp', '.mp4'].some((ext) =>
        lowerName.endsWith(ext),
      );
      if (!isAudio) {
        continue;
      }

      const base = stripAudioExtension(entry.name);
      const transcriptFile = new File(paths.transcriptsDir, `${base}.txt`);
      const summaryFile = new File(paths.summariesDir, `${base}.txt`);
      const updatedAt =
        Math.max(entry.modificationTime ?? 0, transcriptFile.modificationTime ?? 0, summaryFile.modificationTime ?? 0) || 0;

      items.push({
        id: entry.name,
        title: entry.name,
        recordingFile: entry,
        transcriptFile,
        summaryFile,
        updatedAt,
        isLegacy: false,
      });
    }
  }

  if (paths.legacyRecording.exists) {
    const updatedAt =
      Math.max(
        paths.legacyRecording.modificationTime ?? 0,
        paths.legacyTranscript.modificationTime ?? 0,
        paths.legacySummary.modificationTime ?? 0,
      ) || 0;
    items.push({
      id: 'legacy-recording.m4a',
      title: 'recording.m4a',
      recordingFile: paths.legacyRecording,
      transcriptFile: paths.legacyTranscript,
      summaryFile: paths.legacySummary,
      updatedAt,
      isLegacy: true,
    });
  }

  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return items;
}

function createRecordingSnapshot(source: File): File {
  if (!source.exists) {
    throw new Error('전사할 녹음 파일이 없습니다.');
  }

  const snapshotsDir = new Directory(Paths.cache, 'upload-snapshots');
  if (!snapshotsDir.exists) {
    snapshotsDir.create({ idempotent: true, intermediates: true });
  }

  const snapshot = new File(snapshotsDir, `recording-${Date.now()}.m4a`);
  if (snapshot.exists) {
    snapshot.delete();
  }
  source.copy(snapshot);
  return snapshot;
}

function appendFileIfExists(formData: FormData, key: string, source: File, name: string, type: string): boolean {
  if (!source.exists) {
    return false;
  }

  formData.append(
    key,
    {
      uri: source.uri,
      name,
      type,
    } as any,
  );
  return true;
}

async function readMeta(file: File): Promise<SubjectMeta | null> {
  if (!file.exists) {
    return null;
  }

  try {
    const raw = await file.text();
    return JSON.parse(raw) as SubjectMeta;
  } catch {
    return null;
  }
}

function ensureSubjectsRoot() {
  if (!SUBJECTS_ROOT.exists) {
    SUBJECTS_ROOT.create({ idempotent: true, intermediates: true });
  }
}

function writeText(file: File, value: string) {
  if (file.exists) {
    file.delete();
  }
  file.create({ intermediates: true });
  file.write(value);
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return '알 수 없는 오류';
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) {
    return '0 B';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

const styles = StyleSheet.create({
  background: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    gap: 12,
  },
  title: {
    fontSize: 30,
    fontWeight: '800',
    color: '#0F172A',
    letterSpacing: -0.4,
  },
  subtitle: {
    marginTop: -4,
    marginBottom: 6,
    fontSize: 14,
    color: '#334155',
  },
  card: {
    backgroundColor: 'rgba(255,255,255,0.9)',
    borderWidth: 1,
    borderColor: 'rgba(37,99,235,0.16)',
    borderRadius: 16,
    padding: 14,
    shadowColor: '#0F172A',
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  sectionTitle: {
    color: '#1D4ED8',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 10,
  },
  row: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  input: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#BFDBFE',
    color: '#0F172A',
    backgroundColor: '#F8FAFF',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  smallButton: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#1D4ED8',
    borderRadius: 12,
    minWidth: 116,
    alignItems: 'center',
  },
  smallButtonText: {
    color: '#EFF6FF',
    fontWeight: '800',
    fontSize: 12,
  },
  tagSelectWrap: {
    marginTop: 10,
  },
  tagSelectLabel: {
    color: '#334155',
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 6,
  },
  tagSelectRow: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
  },
  tagOptionButton: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  tagOptionButtonActive: {
    borderWidth: 2,
  },
  tagOptionText: {
    fontSize: 12,
    fontWeight: '700',
  },
  subjectList: {
    marginTop: 10,
    gap: 8,
  },
  subjectRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'stretch',
  },
  subjectItem: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#DBEAFE',
    padding: 10,
    backgroundColor: '#F8FBFF',
  },
  subjectItemActive: {
    borderColor: '#2563EB',
    backgroundColor: '#E9F2FF',
  },
  subjectName: {
    color: '#0F172A',
    fontWeight: '700',
    fontSize: 14,
  },
  subjectMeta: {
    color: '#475569',
    marginTop: 3,
    fontSize: 12,
  },
  tagBadge: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginTop: 6,
  },
  tagBadgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  openButton: {
    minWidth: 92,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#93C5FD',
    backgroundColor: '#EEF6FF',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 8,
  },
  openButtonText: {
    color: '#0C4A6E',
    fontSize: 12,
    fontWeight: '800',
  },
  timer: {
    fontSize: 36,
    fontWeight: '700',
    color: '#0F172A',
    letterSpacing: 1,
    textAlign: 'center',
    marginBottom: 10,
  },
  selectedTagBadge: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginTop: 8,
    marginBottom: 4,
  },
  selectedTagBadgeText: {
    fontSize: 12,
    fontWeight: '800',
  },
  recordButton: {
    paddingVertical: 12,
    borderRadius: 14,
    alignItems: 'center',
  },
  startButton: {
    backgroundColor: '#0EA5E9',
  },
  stopButton: {
    backgroundColor: '#DC2626',
  },
  recordButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  helper: {
    marginTop: 8,
    color: '#475569',
    fontSize: 12,
  },
  warnText: {
    marginTop: 6,
    color: '#B91C1C',
    fontSize: 12,
    fontWeight: '700',
  },
  filePath: {
    marginTop: 8,
    color: '#2563EB',
    fontSize: 12,
  },
  recordingList: {
    marginTop: 10,
    gap: 8,
  },
  recordingItem: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#C7D2FE',
    backgroundColor: '#EEF2FF',
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  recordingItemActive: {
    borderColor: '#1D4ED8',
    backgroundColor: '#DBEAFE',
  },
  recordingTitle: {
    color: '#0F172A',
    fontWeight: '700',
    fontSize: 13,
  },
  recordingMeta: {
    marginTop: 4,
    color: '#334155',
    fontSize: 12,
  },
  fileActionGrid: {
    marginTop: 8,
    gap: 8,
  },
  fileActionButton: {
    backgroundColor: '#DBEAFE',
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#93C5FD',
  },
  fileActionText: {
    color: '#1E3A8A',
    fontSize: 13,
    fontWeight: '800',
  },
  toggleRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
  },
  toggleButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#BFDBFE',
    borderRadius: 12,
    paddingVertical: 9,
    alignItems: 'center',
    backgroundColor: '#F8FAFF',
  },
  toggleButtonActive: {
    borderColor: '#2563EB',
    backgroundColor: '#E0ECFF',
  },
  toggleText: {
    color: '#1E293B',
    fontSize: 12,
    fontWeight: '700',
  },
  actionButton: {
    backgroundColor: '#2563EB',
    borderRadius: 12,
    paddingVertical: 11,
    alignItems: 'center',
  },
  actionButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
  },
  textArea: {
    minHeight: 110,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
    color: '#F8FAFC',
    backgroundColor: 'rgba(255,255,255,0.08)',
    paddingHorizontal: 10,
    paddingVertical: 9,
    textAlignVertical: 'top',
    marginTop: 8,
    marginBottom: 8,
  },
  previewTitle: {
    marginTop: 10,
    marginBottom: 6,
    color: '#1D4ED8',
    fontWeight: '700',
    fontSize: 13,
  },
  bodyText: {
    color: '#0F172A',
    lineHeight: 21,
    fontSize: 13,
  },
  disabledButton: {
    opacity: 0.45,
  },
  status: {
    color: '#0F172A',
    marginTop: 8,
    fontSize: 13,
  },
  apiInfo: {
    color: '#2563EB',
    marginTop: 4,
    fontSize: 12,
  },
  loader: {
    marginTop: 10,
  },
});
