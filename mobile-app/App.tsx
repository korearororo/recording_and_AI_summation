import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Modal,
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
import Constants from 'expo-constants';
import { Directory, File, Paths } from 'expo-file-system';
import * as Linking from 'expo-linking';
import * as DocumentPicker from 'expo-document-picker';
import * as Notifications from 'expo-notifications';
import * as Sharing from 'expo-sharing';
import * as WebBrowser from 'expo-web-browser';
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
  icon?: string;
  color?: string;
  order?: number;
  createdAt: number;
};

type SubjectItem = {
  id: string;
  name: string;
  tag: SubjectTag;
  icon: string;
  color: string;
  order: number;
  hasRecording: boolean;
  hasTranscript: boolean;
  hasTranslation: boolean;
  hasSummary: boolean;
  updatedAt: number;
  previewFiles: string[];
};

type RecordingItem = {
  id: string;
  title: string;
  recordingFile: File;
  transcriptFile: File;
  translationFile: File;
  summaryFile: File;
  updatedAt: number;
  isLegacy: boolean;
};

type SubjectPaths = {
  dir: Directory;
  meta: File;
  recordingsDir: Directory;
  transcriptsDir: Directory;
  translationsDir: Directory;
  summariesDir: Directory;
  legacyRecording: File;
  legacyTranscript: File;
  legacyTranslation: File;
  legacySummary: File;
};

type PendingJob = {
  jobId: string;
  jobType: 'transcribe' | 'translate' | 'summarize';
  mode: ProcessMode;
  subjectId: string;
  recordingId: string;
  fileName: string;
};

type AuthUserProfile = {
  id: string;
  email: string;
  display_name: string;
};

type SocialProvider = 'kakao' | 'google' | 'naver';

type CloudFileMeta = {
  name: string;
  fileId: string;
  md5: string;
  size: number;
  updatedAt: number;
};

type CloudSubjectSnapshot = {
  subjectId: string;
  subjectName: string;
  subjectTag: string;
  subjectIcon: string;
  subjectColor: string;
  subjectOrder: number | null;
  recordings: CloudFileMeta[];
  transcripts: CloudFileMeta[];
  translations: CloudFileMeta[];
  summaries: CloudFileMeta[];
};

type LocalMd5CacheEntry = {
  size: number;
  mtime: number;
  md5: string;
};

type LocalMd5Cache = Record<string, LocalMd5CacheEntry>;

const PROD_API_URL = 'https://recording-ai-backend.onrender.com';
const FALLBACK_API_URL = PROD_API_URL;
const PENDING_JOBS_FILE = new File(Paths.document, 'pending-jobs.json');
const AUTH_SESSION_FILE = new File(Paths.document, 'auth-session.json');
const TEMP_RECORDINGS_ROOT = new Directory(Paths.cache, 'temp-recordings');
const CLOUD_MD5_CACHE_FILE = new File(Paths.document, 'cloud-md5-cache.json');
const FOLDER_ICON_OPTIONS = ['📁', '📘', '📗', '📕', '🧪', '💻', '📊', '🎵'];
const FOLDER_COLOR_OPTIONS = ['#DBEAFE', '#E9D5FF', '#FCE7F3', '#DCFCE7', '#FEF3C7', '#E0F2FE', '#F1F5F9'];
const DEFAULT_FOLDER_ICON = '📁';
const DEFAULT_FOLDER_COLOR = '#DBEAFE';
const CLOUD_UPLOAD_CONCURRENCY = 1;
const CLOUD_RESTORE_CONCURRENCY = 2;
const SOCIAL_PROVIDER_LABELS: Record<SocialProvider, string> = {
  kakao: '카카오',
  google: '구글',
  naver: '네이버',
};

WebBrowser.maybeCompleteAuthSession();

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

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
  const [folderModalVisible, setFolderModalVisible] = useState(false);
  const [folderModalMode, setFolderModalMode] = useState<'create' | 'edit'>('create');
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderIcon, setNewFolderIcon] = useState(DEFAULT_FOLDER_ICON);
  const [newFolderColor, setNewFolderColor] = useState(DEFAULT_FOLDER_COLOR);
  const [fabOpen, setFabOpen] = useState(false);
  const [uploadModalVisible, setUploadModalVisible] = useState(false);
  const [uploadMode, setUploadMode] = useState<'file' | 'link'>('file');
  const [uploadFileUri, setUploadFileUri] = useState('');
  const [uploadName, setUploadName] = useState('');
  const [uploadVideoLink, setUploadVideoLink] = useState('');
  const [uploadTargetFolderId, setUploadTargetFolderId] = useState<string | null>(null);
  const [moveModalVisible, setMoveModalVisible] = useState(false);
  const [moveSourceFolderId, setMoveSourceFolderId] = useState<string | null>(null);
  const [moveTargetFolderId, setMoveTargetFolderId] = useState<string | null>(null);
  const [moveRecordingId, setMoveRecordingId] = useState<string | null>(null);
  const [recordingDraftUri, setRecordingDraftUri] = useState<string | null>(null);
  const [recordingSaveVisible, setRecordingSaveVisible] = useState(false);
  const [recordingSaveName, setRecordingSaveName] = useState('');
  const [recordingTargetFolderId, setRecordingTargetFolderId] = useState<string | null>(null);

  const [recordingUri, setRecordingUri] = useState<string | null>(null);
  const [recordings, setRecordings] = useState<RecordingItem[]>([]);
  const [selectedRecordingId, setSelectedRecordingId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState('');
  const [translation, setTranslation] = useState('');
  const [summary, setSummary] = useState('');
  const [screenMode, setScreenMode] = useState<'home' | 'subject' | 'detail' | 'record'>('home');
  const [editorVisible, setEditorVisible] = useState(false);
  const [editorTarget, setEditorTarget] = useState<'transcript' | 'translation' | 'summary' | null>(null);
  const [editorText, setEditorText] = useState('');
  const [editorOriginalText, setEditorOriginalText] = useState('');
  const [editorIsEditing, setEditorIsEditing] = useState(false);
  const [renameVisible, setRenameVisible] = useState(false);
  const [renameText, setRenameText] = useState('');
  const [expoPushToken, setExpoPushToken] = useState('');
  const [pendingJobs, setPendingJobs] = useState<PendingJob[]>([]);
  const pollingRef = useRef(false);

  const [transcribeMode, setTranscribeMode] = useState<ProcessMode>('chat');
  const [translationMode, setTranslationMode] = useState<ProcessMode>('chat');
  const [translationTargetLanguage, setTranslationTargetLanguage] = useState<'English' | 'Korean'>('English');
  const [summaryMode, setSummaryMode] = useState<ProcessMode>('chat');

  const [statusMessage, setStatusMessage] = useState('준비 완료');
  const [isBusy, setIsBusy] = useState(false);
  const [recordActionBusy, setRecordActionBusy] = useState(false);
  const [cloudSyncBusy, setCloudSyncBusy] = useState<'upload' | 'restore' | null>(null);
  const [cloudRootDir, setCloudRootDir] = useState('');
  const [libraryPath, setLibraryPath] = useState('');
  const [librarySavedFiles, setLibrarySavedFiles] = useState<string[]>([]);
  const [authModalVisible, setAuthModalVisible] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authDisplayName, setAuthDisplayName] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [authUser, setAuthUser] = useState<AuthUserProfile | null>(null);
  const [authBusy, setAuthBusy] = useState(false);

  const rawApiBaseUrl =
    process.env.EXPO_PUBLIC_API_BASE_URL ??
    (Platform.OS === 'android'
      ? process.env.EXPO_PUBLIC_API_BASE_URL_ANDROID
      : process.env.EXPO_PUBLIC_API_BASE_URL_IOS) ??
    FALLBACK_API_URL;
  const normalizedApiBaseUrl = normalizeApiBaseUrl(rawApiBaseUrl, FALLBACK_API_URL);
  const apiBaseUrl = !__DEV__
    ? PROD_API_URL
    : Platform.OS === 'android' && Constants.isDevice && normalizedApiBaseUrl.includes('10.0.2.2')
      ? PROD_API_URL
      : normalizedApiBaseUrl;

  const getAuthHeaders = (): Record<string, string> => {
    if (!authToken) {
      return {};
    }
    return { Authorization: `Bearer ${authToken}` };
  };

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
    if (pendingJobs.length === 0) {
      return;
    }
    const timer = setInterval(() => {
      void pollPendingJobs();
    }, 5000);
    void pollPendingJobs();
    return () => clearInterval(timer);
  }, [pendingJobs]);

  useEffect(() => {
    if (!selectedSubjectId) {
      setRecordingUri(null);
      setRecordings([]);
      setSelectedRecordingId(null);
      setTranscript('');
      setTranslation('');
      setSummary('');
      setLibraryPath('');
      setLibrarySavedFiles([]);
      return;
    }

    setLibraryPath('');
    setLibrarySavedFiles([]);
    void loadSubjectFiles(selectedSubjectId, selectedRecordingId);
  }, [selectedSubjectId]);

  useEffect(() => {
    if (Platform.OS !== 'android') {
      return;
    }

    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (editorVisible) {
        closeEditorModal();
        return true;
      }
      if (renameVisible) {
        setRenameVisible(false);
        return true;
      }
      if (authModalVisible) {
        setAuthModalVisible(false);
        return true;
      }
      if (folderModalVisible) {
        closeFolderModal();
        return true;
      }
      if (recordingSaveVisible) {
        cancelRecordingSave();
        return true;
      }
      if (uploadModalVisible) {
        setUploadModalVisible(false);
        return true;
      }
      if (moveModalVisible) {
        setMoveModalVisible(false);
        return true;
      }
      if (fabOpen) {
        setFabOpen(false);
        return true;
      }
      if (screenMode === 'detail') {
        setScreenMode('subject');
        return true;
      }
      if (screenMode === 'subject' || screenMode === 'record') {
        setScreenMode('home');
        return true;
      }
      return false;
    });

    return () => {
      subscription.remove();
    };
  }, [
    authModalVisible,
    editorVisible,
    fabOpen,
    folderModalVisible,
    moveModalVisible,
    recordingSaveVisible,
    renameVisible,
    screenMode,
    uploadModalVisible,
  ]);

  const initialize = async () => {
    ensureSubjectsRoot();
    await setupNotifications();
    await restoreAuthSession();
    await restorePendingJobs();
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
    const name = newFolderName.trim();
    if (!name) {
      setStatusMessage('폴더 이름을 입력해주세요.');
      return;
    }

    try {
      ensureSubjectsRoot();

      const id = `subject-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const paths = getSubjectPaths(id);
      paths.dir.create({ idempotent: true, intermediates: true });
      ensureRecordingDirs(paths);
      const nextOrder = Math.max(0, ...subjects.map((subject) => subject.order || 0)) + 1;

      const meta: SubjectMeta = {
        id,
        name,
        tag: 'major',
        icon: newFolderIcon || DEFAULT_FOLDER_ICON,
        color: normalizeFolderColor(newFolderColor),
        order: nextOrder,
        createdAt: Date.now(),
      };
      writeText(paths.meta, JSON.stringify(meta, null, 2));

      setFolderModalMode('create');
      setEditingFolderId(null);
      setNewFolderName('');
      setNewFolderIcon(DEFAULT_FOLDER_ICON);
      setNewFolderColor(DEFAULT_FOLDER_COLOR);
      setFolderModalVisible(false);
      setSelectedSubjectId(id);
      await loadSubjects(id);
      setStatusMessage(`폴더 생성 완료: ${newFolderIcon} ${name}`);
    } catch (error) {
      setStatusMessage(`폴더 생성 실패: ${formatError(error)}`);
    }
  };

  const updateSubject = async () => {
    const targetId = editingFolderId;
    if (!targetId) {
      setStatusMessage('수정할 폴더를 선택해주세요.');
      return;
    }

    const name = newFolderName.trim();
    if (!name) {
      setStatusMessage('폴더 이름을 입력해주세요.');
      return;
    }

    try {
      ensureSubjectsRoot();
      const paths = getSubjectPaths(targetId);
      if (!paths.dir.exists) {
        throw new Error('폴더가 존재하지 않습니다.');
      }
      const currentMeta = await readMeta(paths.meta);
      const meta: SubjectMeta = {
        id: targetId,
        name,
        tag: currentMeta?.tag ?? 'major',
        icon: newFolderIcon || DEFAULT_FOLDER_ICON,
        color: normalizeFolderColor(newFolderColor),
        order: normalizeSubjectOrder(currentMeta?.order) ?? Math.max(0, ...subjects.map((subject) => subject.order || 0)) + 1,
        createdAt: currentMeta?.createdAt ?? Date.now(),
      };
      writeText(paths.meta, JSON.stringify(meta, null, 2));

      setFolderModalMode('create');
      setEditingFolderId(null);
      setNewFolderName('');
      setNewFolderIcon(DEFAULT_FOLDER_ICON);
      setNewFolderColor(DEFAULT_FOLDER_COLOR);
      setFolderModalVisible(false);
      await loadSubjects(targetId);
      setStatusMessage(`폴더 수정 완료: ${meta.icon} ${name}`);
    } catch (error) {
      setStatusMessage(`폴더 수정 실패: ${formatError(error)}`);
    }
  };

  const openCreateFolderModal = () => {
    setFolderModalMode('create');
    setEditingFolderId(null);
    setNewFolderName('');
    setNewFolderIcon(DEFAULT_FOLDER_ICON);
    setNewFolderColor(DEFAULT_FOLDER_COLOR);
    setFolderModalVisible(true);
  };

  const closeFolderModal = () => {
    setFolderModalVisible(false);
    setFolderModalMode('create');
    setEditingFolderId(null);
  };

  const openEditFolderModal = (subject: SubjectItem) => {
    setFolderModalMode('edit');
    setEditingFolderId(subject.id);
    setNewFolderName(subject.name);
    setNewFolderIcon(subject.icon || DEFAULT_FOLDER_ICON);
    setNewFolderColor(normalizeFolderColor(subject.color || DEFAULT_FOLDER_COLOR));
    setFolderModalVisible(true);
  };

  const moveSubject = async (subjectId: string, direction: 'up' | 'down') => {
    const index = subjects.findIndex((subject) => subject.id === subjectId);
    if (index < 0) {
      return;
    }
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= subjects.length) {
      setStatusMessage(direction === 'up' ? '이미 맨 위 폴더입니다.' : '이미 맨 아래 폴더입니다.');
      return;
    }

    try {
      const reordered = [...subjects];
      const [moved] = reordered.splice(index, 1);
      reordered.splice(targetIndex, 0, moved);

      for (let i = 0; i < reordered.length; i += 1) {
        const subject = reordered[i];
        const paths = getSubjectPaths(subject.id);
        const currentMeta = await readMeta(paths.meta);
        const meta: SubjectMeta = {
          id: subject.id,
          name: currentMeta?.name ?? subject.name,
          tag: currentMeta?.tag ?? subject.tag,
          icon: currentMeta?.icon ?? subject.icon,
          color: normalizeFolderColor(currentMeta?.color ?? subject.color),
          order: i + 1,
          createdAt: currentMeta?.createdAt ?? Date.now(),
        };
        writeText(paths.meta, JSON.stringify(meta, null, 2));
      }

      await loadSubjects(subjectId);
      setStatusMessage(`폴더 순서 변경 완료: ${moved.name}`);
    } catch (error) {
      setStatusMessage(`폴더 순서 변경 실패: ${formatError(error)}`);
    }
  };

  const deleteSubject = async (subject: SubjectItem) => {
    Alert.alert('폴더 삭제 확인', `"${subject.name}" 폴더와 내부 파일을 모두 삭제할까요?`, [
      { text: '취소', style: 'cancel' },
      {
        text: '삭제',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            try {
              setIsBusy(true);
              const paths = getSubjectPaths(subject.id);
              removeDirectoryRecursive(paths.dir);
              if (selectedSubjectId === subject.id) {
                setSelectedSubjectId(null);
                setScreenMode('home');
              }
              await loadSubjects();
              setStatusMessage(`폴더 삭제 완료: ${subject.name}`);
            } catch (error) {
              setStatusMessage(`폴더 삭제 실패: ${formatError(error)}`);
            } finally {
              setIsBusy(false);
            }
          })();
        },
      },
    ]);
  };

  const openDirectory = (subjectId: string) => {
    setSelectedSubjectId(subjectId);
    setScreenMode('subject');
    const picked = subjects.find((subject) => subject.id === subjectId);
    setStatusMessage(`폴더 열림: ${picked?.name ?? subjectId}`);
  };

  const selectRecording = async (recordingId: string) => {
    if (!selectedSubjectId) {
      return;
    }
    const items = listRecordingItems(getSubjectPaths(selectedSubjectId));
    await loadSubjectFiles(selectedSubjectId, recordingId);
    const picked = items.find((item) => item.id === recordingId);
    if (picked) {
      setScreenMode('detail');
      setStatusMessage(`녹음 파일 선택: ${picked.title}`);
    }
  };

  const openMoveRecordingModal = (item: RecordingItem) => {
    if (!selectedSubjectId) {
      setStatusMessage('폴더를 먼저 선택해주세요.');
      return;
    }
    const candidates = subjects.filter((subject) => subject.id !== selectedSubjectId);
    if (candidates.length === 0) {
      setStatusMessage('이동할 다른 폴더가 없습니다.');
      return;
    }
    setMoveSourceFolderId(selectedSubjectId);
    setMoveRecordingId(item.id);
    setMoveTargetFolderId(candidates[0].id);
    setMoveModalVisible(true);
  };

  const closeMoveModal = () => {
    setMoveModalVisible(false);
    setMoveSourceFolderId(null);
    setMoveRecordingId(null);
    setMoveTargetFolderId(null);
  };

  const moveFileReplace = (source: File, destination: File) => {
    if (!source.exists) {
      return;
    }
    if (destination.exists) {
      destination.delete();
    }
    source.move(destination);
  };

  const moveRecordingToFolder = async () => {
    const sourceFolderId = moveSourceFolderId;
    const targetFolderId = moveTargetFolderId;
    const targetRecordingId = moveRecordingId;
    if (!sourceFolderId || !targetFolderId || !targetRecordingId) {
      setStatusMessage('이동할 파일/대상 폴더를 선택해주세요.');
      return;
    }
    if (sourceFolderId === targetFolderId) {
      setStatusMessage('같은 폴더로는 이동할 수 없습니다.');
      return;
    }

    try {
      setIsBusy(true);
      const sourcePaths = getSubjectPaths(sourceFolderId);
      const targetPaths = getSubjectPaths(targetFolderId);
      ensureRecordingDirs(sourcePaths);
      ensureRecordingDirs(targetPaths);
      const sourceItems = listRecordingItems(sourcePaths);
      const item = sourceItems.find((row) => row.id === targetRecordingId);
      if (!item || !item.recordingFile.exists) {
        throw new Error('이동할 녹음 파일을 찾지 못했습니다.');
      }

      const recordingName = item.recordingFile.name || item.title;
      const sourceBase = stripAudioExtension(recordingName);
      const conflict = new File(targetPaths.recordingsDir, recordingName);
      if (conflict.exists) {
        throw new Error('대상 폴더에 같은 이름의 녹음 파일이 이미 있습니다. 먼저 이름을 변경해주세요.');
      }

      const targetRecording = new File(targetPaths.recordingsDir, recordingName);
      const targetTranscript = new File(targetPaths.transcriptsDir, `${sourceBase}.txt`);
      const targetTranslation = new File(targetPaths.translationsDir, `${sourceBase}.txt`);
      const targetSummary = new File(targetPaths.summariesDir, `${sourceBase}.txt`);
      moveFileReplace(item.recordingFile, targetRecording);
      moveFileReplace(item.transcriptFile, targetTranscript);
      moveFileReplace(item.translationFile, targetTranslation);
      moveFileReplace(item.summaryFile, targetSummary);

      const sourceSubject = subjects.find((subject) => subject.id === sourceFolderId);
      const targetSubject = subjects.find((subject) => subject.id === targetFolderId);
      let cleanupRemoved = 0;

      if (authToken) {
        const moveResponse = await fetch(`${apiBaseUrl}/api/library/move`, {
          method: 'POST',
          headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from_subject_id: sourceFolderId,
            from_subject_name: sourceSubject?.name ?? sourceFolderId,
            to_subject_id: targetFolderId,
            to_subject_name: targetSubject?.name ?? targetFolderId,
            recording_name: recordingName,
          }),
        });
        const movePayload = await readJsonSafely(moveResponse);
        if (!moveResponse.ok) {
          throw new Error(getApiErrorMessage(movePayload, moveResponse, '서버 폴더 이동 실패'));
        }
        cleanupRemoved = Number(movePayload?.cleanup_removed_folders ?? 0);
      }

      await loadSubjects(sourceFolderId);
      await loadSubjectFiles(sourceFolderId);
      closeMoveModal();
      setStatusMessage(
        `파일 이동 완료: ${recordingName} (${sourceSubject?.name ?? sourceFolderId} → ${targetSubject?.name ?? targetFolderId})${
          cleanupRemoved > 0 ? ` / 빈 폴더 정리 ${cleanupRemoved}개` : ''
        }`,
      );
    } catch (error) {
      setStatusMessage(`파일 이동 실패: ${formatError(error)}`);
    } finally {
      setIsBusy(false);
    }
  };

  const setupNotifications = async () => {
    try {
      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('job-status', {
          name: '전사/번역/요약 상태',
          importance: Notifications.AndroidImportance.HIGH,
          vibrationPattern: [0, 250, 250, 250],
          sound: 'default',
        });
      }

      const existing = await Notifications.getPermissionsAsync();
      let finalStatus = existing.status;
      if (finalStatus !== 'granted') {
        const requested = await Notifications.requestPermissionsAsync();
        finalStatus = requested.status;
      }
      if (finalStatus !== 'granted') {
        setStatusMessage('알림 권한이 없어 백그라운드 완료 알림이 제한됩니다.');
        return;
      }

      const projectId =
        Constants.expoConfig?.extra?.eas?.projectId ??
        (Constants as any).easConfig?.projectId ??
        undefined;
      if (!projectId) {
        return;
      }
      const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
      setExpoPushToken(token);
    } catch (error) {
      setStatusMessage(`알림 설정 실패: ${formatError(error)}`);
    }
  };

  const notifyLocal = async (title: string, body: string) => {
    try {
      await Notifications.scheduleNotificationAsync({
        content: {
          title,
          body,
          sound: 'default',
        },
        trigger: null,
      });
    } catch {
      // Keep core flow even if local notification fails.
    }
  };

  const persistAuthSession = (token: string, user: AuthUserProfile | null) => {
    try {
      if (!token || !user) {
        if (AUTH_SESSION_FILE.exists) {
          AUTH_SESSION_FILE.delete();
        }
        return;
      }
      writeText(
        AUTH_SESSION_FILE,
        JSON.stringify(
          {
            access_token: token,
            user,
          },
          null,
          2,
        ),
      );
    } catch {
      // Session persistence failure should not block app usage.
    }
  };

  const clearAuthSession = () => {
    setAuthToken('');
    setAuthUser(null);
    persistAuthSession('', null);
  };

  const restoreAuthSession = async () => {
    if (!AUTH_SESSION_FILE.exists) {
      return;
    }

    try {
      const raw = await AUTH_SESSION_FILE.text();
      const parsed = JSON.parse(raw);
      const token = typeof parsed?.access_token === 'string' ? parsed.access_token : '';
      if (!token) {
        clearAuthSession();
        return;
      }

      const response = await fetch(`${apiBaseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const payload = await readJsonSafely(response);
      if (!response.ok) {
        clearAuthSession();
        return;
      }
      const user = normalizeAuthUser(payload);
      if (!user) {
        clearAuthSession();
        return;
      }
      setAuthToken(token);
      setAuthUser(user);
      persistAuthSession(token, user);
    } catch {
      clearAuthSession();
    }
  };

  const submitAuth = async () => {
    const email = authEmail.trim();
    const password = authPassword;
    if (!email || !password) {
      setStatusMessage('이메일/비밀번호를 입력해주세요.');
      return;
    }

    try {
      setAuthBusy(true);
      const endpoint = authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
      const body =
        authMode === 'register'
          ? {
              email,
              password,
              display_name: authDisplayName.trim() || undefined,
            }
          : {
              email,
              password,
            };

      const response = await fetch(`${apiBaseUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await readJsonSafely(response);
      if (!response.ok) {
        throw new Error(getApiErrorMessage(payload, response, '로그인 실패'));
      }

      const token = typeof payload?.access_token === 'string' ? payload.access_token : '';
      const user = normalizeAuthUser(payload?.user);
      if (!token || !user) {
        throw new Error('로그인 응답이 올바르지 않습니다.');
      }

      setAuthToken(token);
      setAuthUser(user);
      persistAuthSession(token, user);
      setAuthModalVisible(false);
      setAuthPassword('');
      setStatusMessage(`${user.display_name} 계정으로 로그인되었습니다.`);
    } catch (error) {
      setStatusMessage(`인증 실패: ${formatError(error)}`);
    } finally {
      setAuthBusy(false);
    }
  };

  const submitSocialAuth = async (provider: SocialProvider) => {
    try {
      setAuthBusy(true);
      if (!apiBaseUrl.startsWith('https://')) {
        throw new Error('소셜 로그인은 HTTPS 서버 주소가 필요합니다. 설정의 API URL을 확인해주세요.');
      }
      const redirectUri = Linking.createURL('auth/callback');
      const startUrl =
        `${apiBaseUrl}/api/auth/oauth/${provider}/start?mobile_redirect_uri=` + encodeURIComponent(redirectUri);

      const result = await WebBrowser.openAuthSessionAsync(startUrl, redirectUri);
      if (result.type !== 'success' || !result.url) {
        if (result.type === 'cancel' || result.type === 'dismiss') {
          setStatusMessage('소셜 로그인이 취소되었습니다.');
          return;
        }
        throw new Error('소셜 로그인 창을 완료하지 못했습니다.');
      }

      const parsed = Linking.parse(result.url);
      const query = (parsed.queryParams ?? {}) as Record<string, string | string[] | undefined>;
      const errorText = firstQueryValue(query.error);
      if (errorText) {
        throw new Error(decodeURIComponentSafe(errorText));
      }

      const token = firstQueryValue(query.access_token);
      if (!token) {
        throw new Error('소셜 로그인 토큰을 받지 못했습니다.');
      }

      const meResponse = await fetch(`${apiBaseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const mePayload = await readJsonSafely(meResponse);
      if (!meResponse.ok) {
        throw new Error(getApiErrorMessage(mePayload, meResponse, '소셜 로그인 실패'));
      }
      const user = normalizeAuthUser(mePayload);
      if (!user) {
        throw new Error('소셜 로그인 응답이 올바르지 않습니다.');
      }

      setAuthToken(token);
      setAuthUser(user);
      persistAuthSession(token, user);
      setAuthModalVisible(false);
      setAuthPassword('');
      setStatusMessage(`${SOCIAL_PROVIDER_LABELS[provider]} 계정으로 로그인되었습니다.`);
    } catch (error) {
      setStatusMessage(`소셜 인증 실패: ${formatError(error)}`);
    } finally {
      setAuthBusy(false);
    }
  };

  const logoutAuth = async () => {
    try {
      if (authToken) {
        await fetch(`${apiBaseUrl}/api/auth/logout`, {
          method: 'POST',
          headers: getAuthHeaders(),
        });
      }
    } catch {
      // Ignore logout call errors and clear local session anyway.
    } finally {
      clearAuthSession();
      setStatusMessage('로그아웃되었습니다.');
    }
  };

  const restorePendingJobs = async () => {
    if (!PENDING_JOBS_FILE.exists) {
      setPendingJobs([]);
      return;
    }
    try {
      const raw = await PENDING_JOBS_FILE.text();
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        setPendingJobs([]);
        return;
      }
      const jobs = parsed.filter((value): value is PendingJob => {
        return (
          typeof value?.jobId === 'string' &&
          (value?.jobType === 'transcribe' || value?.jobType === 'translate' || value?.jobType === 'summarize') &&
          typeof value?.subjectId === 'string' &&
          typeof value?.recordingId === 'string'
        );
      });
      setPendingJobs(jobs);
    } catch {
      setPendingJobs([]);
    }
  };

  const persistPendingJobs = (jobs: PendingJob[]) => {
    try {
      writeText(PENDING_JOBS_FILE, JSON.stringify(jobs));
    } catch {
      // If persistence fails, job polling still works for current session.
    }
  };

  const addPendingJob = (job: PendingJob) => {
    setPendingJobs((prev) => {
      const next = [...prev.filter((item) => item.jobId !== job.jobId), job];
      persistPendingJobs(next);
      return next;
    });
  };

  const removePendingJob = (jobId: string) => {
    setPendingJobs((prev) => {
      const next = prev.filter((item) => item.jobId !== jobId);
      persistPendingJobs(next);
      return next;
    });
  };

  const resolveFilesForPendingJob = (job: PendingJob) => {
    const paths = getSubjectPaths(job.subjectId);
    if (job.recordingId === 'legacy-recording.m4a') {
      return {
        transcriptFile: paths.legacyTranscript,
        translationFile: paths.legacyTranslation,
        summaryFile: paths.legacySummary,
      };
    }
    const base = stripAudioExtension(job.recordingId);
    return {
      transcriptFile: new File(paths.transcriptsDir, `${base}.txt`),
      translationFile: new File(paths.translationsDir, `${base}.txt`),
      summaryFile: new File(paths.summariesDir, `${base}.txt`),
    };
  };

  const jobActionText = (jobType: PendingJob['jobType']) =>
    jobType === 'transcribe' ? '전사' : jobType === 'translate' ? '번역' : '요약';

  const jobFailTitle = (jobType: PendingJob['jobType']) =>
    jobType === 'transcribe' ? '전사 실패' : jobType === 'translate' ? '번역 실패' : '요약 실패';

  const pollPendingJobs = async () => {
    if (pollingRef.current || pendingJobs.length === 0) {
      return;
    }
    pollingRef.current = true;

    try {
      for (const job of pendingJobs) {
        try {
          const jobStatusUrl = `${apiBaseUrl}/api/jobs/${job.jobId}`;
          const response = await fetch(jobStatusUrl);
          const data = await readJsonSafely(response);
          if (!response.ok) {
            const message = getApiErrorMessage(data, response, '작업 상태 조회 실패', jobStatusUrl);
            if (response.status === 404) {
              setStatusMessage(
                `${job.fileName} 상태 조회 실패: ${message}. 서버 재시작/배포로 작업이 유실되었을 수 있어 다시 실행이 필요합니다.`,
              );
              await notifyLocal(
                jobFailTitle(job.jobType),
                `${job.fileName} ${jobActionText(job.jobType)} 작업이 서버에서 사라졌습니다.`,
              );
              removePendingJob(job.jobId);
            } else {
              setStatusMessage(`${job.fileName} 상태 조회 실패: ${message}`);
            }
            continue;
          }

          const status = typeof data?.status === 'string' ? data.status : '';
          if (status === 'completed') {
            const files = resolveFilesForPendingJob(job);
            if (job.jobType === 'transcribe') {
              const value = typeof data?.transcript === 'string' ? data.transcript.trim() : '';
              writeText(files.transcriptFile, value);
              if (selectedRecordingId === job.recordingId) {
                setTranscript(value);
              }
              await notifyLocal('전사 완료', `${job.fileName} 전사가 완료되었습니다.`);
              setStatusMessage(`전사 완료 (${job.fileName})`);
            } else if (job.jobType === 'translate') {
              const value = typeof data?.translation === 'string' ? data.translation.trim() : '';
              writeText(files.translationFile, value);
              if (selectedRecordingId === job.recordingId) {
                setTranslation(value);
              }
              await notifyLocal('번역 완료', `${job.fileName} 번역이 완료되었습니다.`);
              setStatusMessage(`번역 완료 (${job.fileName})`);
            } else {
              const value = typeof data?.summary === 'string' ? data.summary.trim() : '';
              writeText(files.summaryFile, value);
              if (selectedRecordingId === job.recordingId) {
                setSummary(value);
              }
              await notifyLocal('요약 완료', `${job.fileName} 요약이 완료되었습니다.`);
              setStatusMessage(`요약 완료 (${job.fileName})`);
            }
            removePendingJob(job.jobId);
            if (selectedSubjectId === job.subjectId) {
              await refreshSelectedSubject(job.recordingId);
            }
            continue;
          }

          if (status === 'failed') {
            const reason = typeof data?.error === 'string' ? data.error.trim() : '';
            const message = typeof data?.message === 'string' ? data.message.trim() : '';
            const defaultMessage = `${job.fileName} ${jobActionText(job.jobType)} 실패`;
            const detail = reason || message || '서버에서 상세 원인을 받지 못했습니다.';
            setStatusMessage(`${defaultMessage}: ${detail}`);
            await notifyLocal(
              jobFailTitle(job.jobType),
              `${job.fileName} ${jobActionText(job.jobType)} 실패: ${detail}`,
            );
            removePendingJob(job.jobId);
          }
        } catch (error) {
          setStatusMessage(`${job.fileName} 상태 조회 오류: ${formatError(error)}`);
        }
      }
    } finally {
      pollingRef.current = false;
    }
  };

  const closeEditorModal = () => {
    setEditorVisible(false);
    setEditorIsEditing(false);
  };

  const openFullTextViewer = (target: 'transcript' | 'translation' | 'summary', value: string) => {
    setEditorTarget(target);
    setEditorText(value);
    setEditorOriginalText(value);
    setEditorIsEditing(false);
    setEditorVisible(true);
  };

  const openTranscriptEditor = () => {
    openFullTextViewer('transcript', transcript);
  };

  const openSummaryEditor = () => {
    openFullTextViewer('summary', summary);
  };

  const openTranslationEditor = () => {
    openFullTextViewer('translation', translation);
  };

  const startEditorEditing = () => {
    if (!editorTarget) {
      return;
    }
    setEditorIsEditing(true);
  };

  const cancelEditorEditing = () => {
    setEditorText(editorOriginalText);
    setEditorIsEditing(false);
  };

  const openRenameModal = () => {
    if (!selectedRecording) {
      setStatusMessage('이름 변경할 파일을 선택해주세요.');
      return;
    }
    setRenameText(stripAudioExtension(selectedRecording.title));
    setRenameVisible(true);
  };

  const saveEditedText = async () => {
    if (!selectedRecording || !editorTarget) {
      return;
    }

    try {
      if (editorTarget === 'transcript') {
        writeText(selectedRecording.transcriptFile, editorText);
        setTranscript(editorText);
      } else if (editorTarget === 'translation') {
        writeText(selectedRecording.translationFile, editorText);
        setTranslation(editorText);
      } else {
        writeText(selectedRecording.summaryFile, editorText);
        setSummary(editorText);
      }
      await refreshSelectedSubject(selectedRecording.id);
      setEditorOriginalText(editorText);
      closeEditorModal();
      setStatusMessage(
        editorTarget === 'transcript' ? '전사 내용 저장 완료' : editorTarget === 'translation' ? '번역 내용 저장 완료' : '요약 내용 저장 완료',
      );
    } catch (error) {
      setStatusMessage(`편집 저장 실패: ${formatError(error)}`);
    }
  };

  const deleteCurrentRecording = () => {
    if (!selectedRecording) {
      setStatusMessage('삭제할 파일을 선택해주세요.');
      return;
    }

    Alert.alert('삭제 확인', '정말 삭제하시겠습니까?', [
      { text: '취소', style: 'cancel' },
      {
        text: '삭제',
        style: 'destructive',
        onPress: async () => {
          try {
            setIsBusy(true);
            if (selectedRecording.recordingFile.exists) {
              selectedRecording.recordingFile.delete();
            }
            if (selectedRecording.transcriptFile.exists) {
              selectedRecording.transcriptFile.delete();
            }
            if (selectedRecording.translationFile.exists) {
              selectedRecording.translationFile.delete();
            }
            if (selectedRecording.summaryFile.exists) {
              selectedRecording.summaryFile.delete();
            }
            await refreshSelectedSubject();
            setScreenMode('subject');
            setStatusMessage(`삭제 완료: ${selectedRecording.title}`);
          } catch (error) {
            setStatusMessage(`삭제 실패: ${formatError(error)}`);
          } finally {
            setIsBusy(false);
          }
        },
      },
    ]);
  };

  const renameCurrentRecording = async () => {
    if (!selectedRecording || !selectedSubjectId) {
      setStatusMessage('이름 변경할 파일을 선택해주세요.');
      return;
    }

    const nextBaseName = stripAudioExtension(renameText.trim());
    if (!nextBaseName) {
      setStatusMessage('파일 이름을 입력해주세요.');
      return;
    }
    if (/[\\/:*?"<>|]/.test(nextBaseName)) {
      setStatusMessage('파일 이름에 사용할 수 없는 문자가 있습니다.');
      return;
    }

    try {
      setIsBusy(true);
      const paths = getSubjectPaths(selectedSubjectId);
      ensureRecordingDirs(paths);

      const extensionMatch = selectedRecording.recordingFile.name.match(/\.[^/.]+$/);
      const extension = extensionMatch?.[0] ?? '.m4a';
      const nextRecordingName = `${nextBaseName}${extension}`;

      const nextRecordingFile = new File(paths.recordingsDir, nextRecordingName);
      const nextTranscriptFile = new File(paths.transcriptsDir, `${nextBaseName}.txt`);
      const nextTranslationFile = new File(paths.translationsDir, `${nextBaseName}.txt`);
      const nextSummaryFile = new File(paths.summariesDir, `${nextBaseName}.txt`);

      const sameRecordingName = selectedRecording.recordingFile.name === nextRecordingName;
      const sameTranscriptName = selectedRecording.transcriptFile.name === `${nextBaseName}.txt`;
      const sameTranslationName = selectedRecording.translationFile.name === `${nextBaseName}.txt`;
      const sameSummaryName = selectedRecording.summaryFile.name === `${nextBaseName}.txt`;
      if (sameRecordingName && sameTranscriptName && sameTranslationName && sameSummaryName) {
        setRenameVisible(false);
        setStatusMessage('파일 이름이 동일합니다.');
        return;
      }

      if (!sameRecordingName && nextRecordingFile.exists) {
        throw new Error('같은 이름의 녹음 파일이 이미 있습니다.');
      }
      if (!sameTranscriptName && nextTranscriptFile.exists) {
        throw new Error('같은 이름의 전사 파일이 이미 있습니다.');
      }
      if (!sameTranslationName && nextTranslationFile.exists) {
        throw new Error('같은 이름의 번역 파일이 이미 있습니다.');
      }
      if (!sameSummaryName && nextSummaryFile.exists) {
        throw new Error('같은 이름의 요약 파일이 이미 있습니다.');
      }

      if (selectedRecording.recordingFile.exists && !sameRecordingName) {
        selectedRecording.recordingFile.copy(nextRecordingFile);
        selectedRecording.recordingFile.delete();
      }
      if (selectedRecording.transcriptFile.exists && !sameTranscriptName) {
        selectedRecording.transcriptFile.copy(nextTranscriptFile);
        selectedRecording.transcriptFile.delete();
      }
      if (selectedRecording.translationFile.exists && !sameTranslationName) {
        selectedRecording.translationFile.copy(nextTranslationFile);
        selectedRecording.translationFile.delete();
      }
      if (selectedRecording.summaryFile.exists && !sameSummaryName) {
        selectedRecording.summaryFile.copy(nextSummaryFile);
        selectedRecording.summaryFile.delete();
      }

      await refreshSelectedSubject(nextRecordingName);
      setRenameVisible(false);
      setStatusMessage(`파일 이름 변경 완료: ${nextRecordingName}`);
    } catch (error) {
      setStatusMessage(`파일 이름 변경 실패: ${formatError(error)}`);
    } finally {
      setIsBusy(false);
    }
  };

  const startRecording = async () => {
    try {
      setRecordActionBusy(true);
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
      await recorder.record();
      setStatusMessage('녹음 중 (백그라운드 지속)');
    } catch (error) {
      setStatusMessage(`녹음 시작 실패: ${formatError(error)}`);
    } finally {
      setRecordActionBusy(false);
    }
  };

  const stopRecording = async () => {
    try {
      setRecordActionBusy(true);
      setStatusMessage('녹음 종료 중...');
      await recorder.stop();

      const uri = recorder.uri ?? recorder.getStatus().url;
      if (!uri) {
        throw new Error('저장된 녹음 파일 경로를 찾지 못했습니다.');
      }

      const source = new File(uri);
      if (!source.exists) {
        throw new Error('녹음 원본 파일을 찾지 못했습니다.');
      }

      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        shouldPlayInBackground: false,
        interruptionMode: 'mixWithOthers',
      });

      setRecordingDraftUri(uri);
      setRecordingSaveName(`recording-${Date.now()}`);
      setRecordingTargetFolderId(selectedSubjectId ?? subjects[0]?.id ?? null);
      setRecordingSaveVisible(true);
      setStatusMessage('녹음 완료. 파일명/저장 폴더를 선택해주세요.');
    } catch (error) {
      setStatusMessage(`녹음 중지 실패: ${formatError(error)}`);
    } finally {
      setRecordActionBusy(false);
    }
  };

  const saveRecordedDraft = async () => {
    if (!recordingDraftUri) {
      setStatusMessage('저장할 녹음이 없습니다.');
      return;
    }
    if (!recordingTargetFolderId) {
      setStatusMessage('저장할 폴더를 선택해주세요.');
      return;
    }

    try {
      const baseName = sanitizeFileBaseName(recordingSaveName) || `recording-${Date.now()}`;
      const fileName = `${baseName}.m4a`;
      const source = new File(recordingDraftUri);
      if (!source.exists) {
        throw new Error('임시 녹음 파일을 찾지 못했습니다.');
      }

      const targetPaths = getSubjectPaths(recordingTargetFolderId);
      ensureRecordingDirs(targetPaths);
      const targetRecording = new File(targetPaths.recordingsDir, fileName);
      if (targetRecording.exists) {
        targetRecording.delete();
      }
      source.copy(targetRecording);

      setRecordingDraftUri(null);
      setRecordingSaveVisible(false);
      setSelectedSubjectId(recordingTargetFolderId);
      await loadSubjects(recordingTargetFolderId);
      await loadSubjectFiles(recordingTargetFolderId, fileName);
      setScreenMode('subject');
      setStatusMessage(`녹음 저장 완료: ${fileName}`);
    } catch (error) {
      setStatusMessage(`녹음 저장 실패: ${formatError(error)}`);
    }
  };

  const cancelRecordingSave = () => {
    if (!recordingDraftUri) {
      setRecordingSaveVisible(false);
      return;
    }

    try {
      ensureTempRecordingsRoot();
      const source = new File(recordingDraftUri);
      if (source.exists) {
        const tempFile = new File(TEMP_RECORDINGS_ROOT, `temp-${Date.now()}.m4a`);
        if (tempFile.exists) {
          tempFile.delete();
        }
        source.copy(tempFile);
      }
      setStatusMessage('저장을 취소하여 임시 파일로 보관했습니다.');
    } catch (error) {
      setStatusMessage(`임시 저장 실패: ${formatError(error)}`);
    } finally {
      setRecordingDraftUri(null);
      setRecordingSaveVisible(false);
      setScreenMode('home');
    }
  };

  const pickRecordingFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['audio/*', 'video/*'],
        multiple: false,
        copyToCacheDirectory: true,
      });
      if (result.canceled) {
        return;
      }
      const asset = result.assets[0];
      setUploadMode('file');
      setUploadFileUri(asset.uri);
      setUploadName(asset.name || `import-${Date.now()}`);
      if (!uploadTargetFolderId) {
        setUploadTargetFolderId(selectedSubjectId ?? subjects[0]?.id ?? null);
      }
    } catch (error) {
      setStatusMessage(`파일 선택 실패: ${formatError(error)}`);
    }
  };

  const saveUploadedRecording = async () => {
    if (!uploadTargetFolderId) {
      setStatusMessage('저장할 폴더를 선택해주세요.');
      return;
    }

    try {
      const targetPaths = getSubjectPaths(uploadTargetFolderId);
      ensureRecordingDirs(targetPaths);

      let targetName = '';
      if (uploadMode === 'file') {
        if (!uploadFileUri) {
          setStatusMessage('업로드할 파일을 먼저 선택해주세요.');
          return;
        }
        const source = new File(uploadFileUri);
        if (!source.exists) {
          throw new Error('선택한 파일을 읽을 수 없습니다.');
        }
        const sourceName = uploadName || source.name || `import-${Date.now()}.m4a`;
        const extension = sourceName.match(/\.[^/.]+$/)?.[0] ?? '.m4a';
        const base = sanitizeFileBaseName(stripAudioExtension(sourceName)) || `import-${Date.now()}`;
        targetName = `${base}${extension}`;
        const target = new File(targetPaths.recordingsDir, targetName);
        if (target.exists) {
          target.delete();
        }
        source.copy(target);
      } else {
        const link = uploadVideoLink.trim();
        if (!link) {
          setStatusMessage('영상 링크를 입력해주세요.');
          return;
        }
        const base = sanitizeFileBaseName(uploadName) || `video-link-${Date.now()}`;
        targetName = `${base}.url`;
        const target = new File(targetPaths.recordingsDir, targetName);
        writeText(target, link);
      }

      setUploadModalVisible(false);
      setUploadFileUri('');
      setUploadName('');
      setUploadVideoLink('');
      setUploadTargetFolderId(null);
      setSelectedSubjectId(uploadTargetFolderId);
      await loadSubjects(uploadTargetFolderId);
      await loadSubjectFiles(uploadTargetFolderId, targetName);
      setScreenMode('subject');
      setStatusMessage(`파일 추가 완료: ${targetName}`);
    } catch (error) {
      setStatusMessage(`파일 추가 실패: ${formatError(error)}`);
    }
  };

  const runTranscriptionApi = async () => {
    if (!selectedSubject || !selectedRecording) {
      setStatusMessage('전사할 녹음 파일을 선택해주세요.');
      return;
    }
    if (selectedRecording.recordingFile.name.toLowerCase().endsWith('.url')) {
      setStatusMessage('영상 링크 파일은 현재 전사를 직접 지원하지 않습니다. 오디오 파일을 추가해주세요.');
      return;
    }
    if (!selectedRecording.recordingFile.exists) {
      setStatusMessage('선택한 녹음 파일이 없습니다.');
      return;
    }

    let uploadFile: File | null = null;
    let uploadUri = selectedRecording.recordingFile.uri;
    try {
      setIsBusy(true);
      setStatusMessage('API 전사 요청 중...');
      if (isRecording) {
        uploadFile = createRecordingSnapshot(selectedRecording.recordingFile);
        uploadUri = uploadFile.uri;
      }

      const formData = new FormData();
      formData.append(
        'file',
        {
          uri: uploadUri,
          name: selectedRecording.recordingFile.name || `recording-${Date.now()}.m4a`,
          type: 'audio/m4a',
        } as any,
      );
      formData.append('mode', 'api');
      formData.append('file_name', selectedRecording.title);
      if (expoPushToken) {
        formData.append('expo_push_token', expoPushToken);
      }

      const createJobUrl = `${apiBaseUrl}/api/jobs/transcribe`;
      const response = await fetch(createJobUrl, {
        method: 'POST',
        body: formData,
      });
      const jobPayload = await readJsonSafely(response);
      if (response.ok) {
        const jobId = typeof jobPayload?.job_id === 'string' ? jobPayload.job_id : '';
        if (!jobId) {
          throw new Error('전사 잡 ID를 받지 못했습니다.');
        }

        addPendingJob({
          jobId,
          jobType: 'transcribe',
          mode: 'api',
          subjectId: selectedSubject.id,
          recordingId: selectedRecording.id,
          fileName: selectedRecording.title,
        });
        await notifyLocal('전사 시작', `${selectedRecording.title} 전사중`);
        setStatusMessage(`전사 백그라운드 시작 (${selectedRecording.title})`);
        return;
      }

      if (response.status !== 404) {
        throw new Error(getApiErrorMessage(jobPayload, response, '전사 잡 생성 실패', createJobUrl));
      }

      const legacyForm = new FormData();
      legacyForm.append(
        'file',
        {
          uri: uploadUri,
          name: selectedRecording.recordingFile.name || `recording-${Date.now()}.m4a`,
          type: 'audio/m4a',
        } as any,
      );
      const legacyUrl = `${apiBaseUrl}/api/transcribe`;
      const legacyResponse = await fetch(legacyUrl, {
        method: 'POST',
        body: legacyForm,
      });
      const legacyPayload = await readJsonSafely(legacyResponse);
      if (!legacyResponse.ok) {
        throw new Error(getApiErrorMessage(legacyPayload, legacyResponse, '전사 실패', legacyUrl));
      }

      const transcriptValue = typeof legacyPayload?.transcript === 'string' ? legacyPayload.transcript.trim() : '';
      writeText(selectedRecording.transcriptFile, transcriptValue);
      setTranscript(transcriptValue);
      await refreshSelectedSubject(selectedRecording.id);
      await notifyLocal('전사 완료', `${selectedRecording.title} 전사가 완료되었습니다.`);
      setStatusMessage(`전사 완료 (${selectedRecording.title})`);
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
    if (selectedRecording.recordingFile.name.toLowerCase().endsWith('.url')) {
      setStatusMessage('영상 링크 파일은 현재 전사를 직접 지원하지 않습니다. 오디오 파일을 추가해주세요.');
      return;
    }
    if (!selectedRecording.recordingFile.exists) {
      setStatusMessage('선택한 녹음 파일이 없습니다.');
      return;
    }

    let uploadFile: File | null = null;
    let uploadUri = selectedRecording.recordingFile.uri;
    try {
      setIsBusy(true);
      setStatusMessage('대화형 AI 전사 요청 중...');
      if (isRecording) {
        uploadFile = createRecordingSnapshot(selectedRecording.recordingFile);
        uploadUri = uploadFile.uri;
      }

      const formData = new FormData();
      formData.append(
        'file',
        {
          uri: uploadUri,
          name: selectedRecording.recordingFile.name || `recording-${Date.now()}.m4a`,
          type: 'audio/m4a',
        } as any,
      );
      formData.append('mode', 'chat');
      formData.append('file_name', selectedRecording.title);
      if (expoPushToken) {
        formData.append('expo_push_token', expoPushToken);
      }

      const createJobUrl = `${apiBaseUrl}/api/jobs/transcribe`;
      const response = await fetch(createJobUrl, {
        method: 'POST',
        body: formData,
      });
      const jobPayload = await readJsonSafely(response);
      if (response.ok) {
        const jobId = typeof jobPayload?.job_id === 'string' ? jobPayload.job_id : '';
        if (!jobId) {
          throw new Error('전사 잡 ID를 받지 못했습니다.');
        }

        addPendingJob({
          jobId,
          jobType: 'transcribe',
          mode: 'chat',
          subjectId: selectedSubject.id,
          recordingId: selectedRecording.id,
          fileName: selectedRecording.title,
        });
        await notifyLocal('전사 시작', `${selectedRecording.title} 전사중`);
        setStatusMessage(`전사 백그라운드 시작 (${selectedRecording.title})`);
        return;
      }

      if (response.status !== 404) {
        throw new Error(getApiErrorMessage(jobPayload, response, '대화형 전사 잡 생성 실패', createJobUrl));
      }

      const legacyForm = new FormData();
      legacyForm.append(
        'file',
        {
          uri: uploadUri,
          name: selectedRecording.recordingFile.name || `recording-${Date.now()}.m4a`,
          type: 'audio/m4a',
        } as any,
      );
      const legacyUrl = `${apiBaseUrl}/api/transcribe-chat`;
      const legacyResponse = await fetch(legacyUrl, {
        method: 'POST',
        body: legacyForm,
      });
      const legacyPayload = await readJsonSafely(legacyResponse);
      if (!legacyResponse.ok) {
        throw new Error(getApiErrorMessage(legacyPayload, legacyResponse, '대화형 전사 실패', legacyUrl));
      }

      const transcriptValue = typeof legacyPayload?.transcript === 'string' ? legacyPayload.transcript.trim() : '';
      writeText(selectedRecording.transcriptFile, transcriptValue);
      setTranscript(transcriptValue);
      await refreshSelectedSubject(selectedRecording.id);
      await notifyLocal('전사 완료', `${selectedRecording.title} 전사가 완료되었습니다.`);
      setStatusMessage(`전사 완료 (${selectedRecording.title})`);
    } catch (error) {
      setStatusMessage(`대화형 전사 실패: ${formatError(error)}`);
    } finally {
      if (uploadFile?.exists) {
        uploadFile.delete();
      }
      setIsBusy(false);
    }
  };

  const runTranslateApi = async () => {
    if (!selectedSubject || !selectedRecording) {
      setStatusMessage('번역할 파일을 선택해주세요.');
      return;
    }

    const sourceTranscript = transcript.trim();
    if (!sourceTranscript) {
      setStatusMessage('먼저 전사 텍스트를 준비해주세요.');
      return;
    }

    try {
      setIsBusy(true);
      setStatusMessage('API 번역 요청 중...');

      const response = await fetch(`${apiBaseUrl}/api/jobs/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: sourceTranscript,
          target_language: translationTargetLanguage,
          mode: 'api',
          file_name: selectedRecording.title,
          expo_push_token: expoPushToken || undefined,
        }),
      });
      const jobPayload = await readJsonSafely(response);
      if (response.ok) {
        const jobId = typeof jobPayload?.job_id === 'string' ? jobPayload.job_id : '';
        if (!jobId) {
          throw new Error('번역 잡 ID를 받지 못했습니다.');
        }

        addPendingJob({
          jobId,
          jobType: 'translate',
          mode: 'api',
          subjectId: selectedSubject.id,
          recordingId: selectedRecording.id,
          fileName: selectedRecording.title,
        });
        await notifyLocal('번역 시작', `${selectedRecording.title} 번역중`);
        setStatusMessage(`번역 백그라운드 시작 (${selectedRecording.title})`);
        return;
      }

      if (response.status !== 404) {
        throw new Error(getApiErrorMessage(jobPayload, response, '번역 잡 생성 실패'));
      }

      const legacyResponse = await fetch(`${apiBaseUrl}/api/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: sourceTranscript,
          target_language: translationTargetLanguage,
        }),
      });
      const legacyPayload = await readJsonSafely(legacyResponse);
      if (!legacyResponse.ok) {
        throw new Error(getApiErrorMessage(legacyPayload, legacyResponse, '번역 실패'));
      }

      const value = typeof legacyPayload?.translation === 'string' ? legacyPayload.translation.trim() : '';
      writeText(selectedRecording.translationFile, value);
      setTranslation(value);
      await refreshSelectedSubject(selectedRecording.id);
      await notifyLocal('번역 완료', `${selectedRecording.title} 번역이 완료되었습니다.`);
      setStatusMessage(`번역 완료 (${selectedRecording.title})`);
    } catch (error) {
      setStatusMessage(`번역 실패: ${formatError(error)}`);
    } finally {
      setIsBusy(false);
    }
  };

  const runTranslateChatApi = async () => {
    if (!selectedSubject || !selectedRecording) {
      setStatusMessage('번역할 파일을 선택해주세요.');
      return;
    }

    const sourceTranscript = transcript.trim();
    if (!sourceTranscript) {
      setStatusMessage('먼저 전사 텍스트를 준비해주세요.');
      return;
    }

    try {
      setIsBusy(true);
      setStatusMessage('대화형 AI 번역 요청 중...');

      const response = await fetch(`${apiBaseUrl}/api/jobs/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: sourceTranscript,
          target_language: translationTargetLanguage,
          mode: 'chat',
          file_name: selectedRecording.title,
          expo_push_token: expoPushToken || undefined,
        }),
      });
      const jobPayload = await readJsonSafely(response);
      if (response.ok) {
        const jobId = typeof jobPayload?.job_id === 'string' ? jobPayload.job_id : '';
        if (!jobId) {
          throw new Error('번역 잡 ID를 받지 못했습니다.');
        }

        addPendingJob({
          jobId,
          jobType: 'translate',
          mode: 'chat',
          subjectId: selectedSubject.id,
          recordingId: selectedRecording.id,
          fileName: selectedRecording.title,
        });
        await notifyLocal('번역 시작', `${selectedRecording.title} 번역중`);
        setStatusMessage(`번역 백그라운드 시작 (${selectedRecording.title})`);
        return;
      }

      if (response.status !== 404) {
        throw new Error(getApiErrorMessage(jobPayload, response, '대화형 번역 잡 생성 실패'));
      }

      const legacyResponse = await fetch(`${apiBaseUrl}/api/translate-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: sourceTranscript,
          target_language: translationTargetLanguage,
        }),
      });
      const legacyPayload = await readJsonSafely(legacyResponse);
      if (!legacyResponse.ok) {
        throw new Error(getApiErrorMessage(legacyPayload, legacyResponse, '대화형 번역 실패'));
      }

      const value = typeof legacyPayload?.translation === 'string' ? legacyPayload.translation.trim() : '';
      writeText(selectedRecording.translationFile, value);
      setTranslation(value);
      await refreshSelectedSubject(selectedRecording.id);
      await notifyLocal('번역 완료', `${selectedRecording.title} 번역이 완료되었습니다.`);
      setStatusMessage(`번역 완료 (${selectedRecording.title})`);
    } catch (error) {
      setStatusMessage(`대화형 번역 실패: ${formatError(error)}`);
    } finally {
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
      setStatusMessage('API 요약 요청 중...');

      const response = await fetch(`${apiBaseUrl}/api/jobs/summarize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript: sourceTranscript,
          mode: 'api',
          file_name: selectedRecording.title,
          expo_push_token: expoPushToken || undefined,
        }),
      });
      const jobPayload = await readJsonSafely(response);
      if (response.ok) {
        const jobId = typeof jobPayload?.job_id === 'string' ? jobPayload.job_id : '';
        if (!jobId) {
          throw new Error('요약 잡 ID를 받지 못했습니다.');
        }

        addPendingJob({
          jobId,
          jobType: 'summarize',
          mode: 'api',
          subjectId: selectedSubject.id,
          recordingId: selectedRecording.id,
          fileName: selectedRecording.title,
        });
        await notifyLocal('요약 시작', `${selectedRecording.title} 요약중`);
        setStatusMessage(`요약 백그라운드 시작 (${selectedRecording.title})`);
        return;
      }

      if (response.status !== 404) {
        throw new Error(getApiErrorMessage(jobPayload, response, '요약 잡 생성 실패'));
      }

      const legacyResponse = await fetch(`${apiBaseUrl}/api/summarize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: sourceTranscript }),
      });
      const legacyPayload = await readJsonSafely(legacyResponse);
      if (!legacyResponse.ok) {
        throw new Error(getApiErrorMessage(legacyPayload, legacyResponse, '요약 실패'));
      }

      const summaryValue = typeof legacyPayload?.summary === 'string' ? legacyPayload.summary.trim() : '';
      writeText(selectedRecording.summaryFile, summaryValue);
      setSummary(summaryValue);
      await refreshSelectedSubject(selectedRecording.id);
      await notifyLocal('요약 완료', `${selectedRecording.title} 요약이 완료되었습니다.`);
      setStatusMessage(`요약 완료 (${selectedRecording.title})`);
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
      setStatusMessage('대화형 AI 요약 요청 중...');

      const response = await fetch(`${apiBaseUrl}/api/jobs/summarize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript: sourceTranscript,
          mode: 'chat',
          file_name: selectedRecording.title,
          expo_push_token: expoPushToken || undefined,
        }),
      });
      const jobPayload = await readJsonSafely(response);
      if (response.ok) {
        const jobId = typeof jobPayload?.job_id === 'string' ? jobPayload.job_id : '';
        if (!jobId) {
          throw new Error('요약 잡 ID를 받지 못했습니다.');
        }

        addPendingJob({
          jobId,
          jobType: 'summarize',
          mode: 'chat',
          subjectId: selectedSubject.id,
          recordingId: selectedRecording.id,
          fileName: selectedRecording.title,
        });
        await notifyLocal('요약 시작', `${selectedRecording.title} 요약중`);
        setStatusMessage(`요약 백그라운드 시작 (${selectedRecording.title})`);
        return;
      }

      if (response.status !== 404) {
        throw new Error(getApiErrorMessage(jobPayload, response, '대화형 요약 잡 생성 실패'));
      }

      const legacyResponse = await fetch(`${apiBaseUrl}/api/summarize-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: sourceTranscript }),
      });
      const legacyPayload = await readJsonSafely(legacyResponse);
      if (!legacyResponse.ok) {
        throw new Error(getApiErrorMessage(legacyPayload, legacyResponse, '대화형 요약 실패'));
      }

      const summaryValue = typeof legacyPayload?.summary === 'string' ? legacyPayload.summary.trim() : '';
      writeText(selectedRecording.summaryFile, summaryValue);
      setSummary(summaryValue);
      await refreshSelectedSubject(selectedRecording.id);
      await notifyLocal('요약 완료', `${selectedRecording.title} 요약이 완료되었습니다.`);
      setStatusMessage(`요약 완료 (${selectedRecording.title})`);
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

  const postLibrarySync = async (formData: FormData) => {
    if (!authToken) {
      throw new Error('먼저 로그인해주세요.');
    }

    let lastError: unknown = null;
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await fetch(`${apiBaseUrl}/api/library/sync`, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: formData,
        });
        const payload = await readJsonSafely(response);
        if (!response.ok) {
          throw new Error(getApiErrorMessage(payload, response, '서버 동기화 실패'));
        }
        return payload;
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) {
          const msg = formatError(error);
          const transient = /\((502|503|504)\b/.test(msg) || /\b(502|503|504)\b/.test(msg);
          await delay(transient ? 3000 * attempt : 1000 * attempt);
        }
      }
    }

    throw new Error(`서버 동기화 실패(재시도 ${maxAttempts}회): ${formatError(lastError)}`);
  };

  const uploadAllFoldersToCloud = async () => {
    if (!authToken) {
      setAuthMode('login');
      setAuthModalVisible(true);
      setStatusMessage('먼저 로그인해주세요.');
      return;
    }
    try {
      setIsBusy(true);
      setCloudSyncBusy('upload');
      setStatusMessage('서버 업로드 시작...');
      ensureSubjectsRoot();

      const cloudListResponse = await fetch(`${apiBaseUrl}/api/library`, {
        headers: getAuthHeaders(),
      });
      const cloudListPayload = await readJsonSafely(cloudListResponse);
      if (!cloudListResponse.ok) {
        throw new Error(getApiErrorMessage(cloudListPayload, cloudListResponse, '서버 목록 조회 실패'));
      }

      const cloudSubjects = normalizeCloudSubjectSnapshots(cloudListPayload?.subjects);
      const cloudRootPath = typeof cloudListPayload?.root_dir === 'string' ? cloudListPayload.root_dir : '';
      setCloudRootDir(cloudRootPath);
      const cloudSubjectById: Record<string, CloudSubjectSnapshot> = {};
      for (const subject of cloudSubjects) {
        cloudSubjectById[subject.subjectId] = subject;
      }
      const cloudMetaLookup = buildCloudMetaLookup(cloudSubjects);
      const md5Cache = await loadLocalMd5Cache();

      const dirs = SUBJECTS_ROOT.list().filter((entry): entry is Directory => entry instanceof Directory);
      if (dirs.length === 0) {
        setStatusMessage('업로드할 폴더가 없습니다.');
        return;
      }

      let uploadUnits = 0;
      let checkedParts = 0;
      let uploadedParts = 0;
      let skippedParts = 0;
      let syncedMetaCount = 0;
      let repairedParts = 0;
      let cleanupRemoved = 0;
      let missingAfterVerify = 0;
      const localPartsForVerification: Array<{
        subjectId: string;
        subjectName: string;
        subjectTag: string;
        subjectIcon: string;
        subjectColor: string;
        subjectOrder: number;
        kind: 'recording' | 'transcript' | 'translation' | 'summary';
        name: string;
        file: File;
        mimeType: string;
        md5: string;
      }> = [];
      for (const dir of dirs) {
        const subjectId = dir.name;
        const paths = getSubjectPaths(subjectId);
        const meta = await readMeta(paths.meta);
        const subjectName = meta?.name ?? subjectId;
        const subjectTag = meta?.tag ?? 'major';
        const subjectIcon = meta?.icon ?? DEFAULT_FOLDER_ICON;
        const subjectColor = meta?.color ?? DEFAULT_FOLDER_COLOR;
        const subjectOrder = normalizeSubjectOrder(meta?.order) ?? 999999;
        const remoteSubject = cloudSubjectById[subjectId];
        const shouldSyncMeta =
          !remoteSubject ||
          remoteSubject.subjectName !== subjectName ||
          remoteSubject.subjectTag !== subjectTag ||
          (remoteSubject.subjectIcon || DEFAULT_FOLDER_ICON) !== subjectIcon ||
          normalizeFolderColor(remoteSubject.subjectColor || DEFAULT_FOLDER_COLOR) !== normalizeFolderColor(subjectColor) ||
          (remoteSubject.subjectOrder ?? 999999) !== subjectOrder;

        if (shouldSyncMeta) {
          const metaForm = new FormData();
          metaForm.append('subject_id', subjectId);
          metaForm.append('subject_name', subjectName);
          metaForm.append('subject_tag', subjectTag);
          metaForm.append('subject_icon', subjectIcon);
          metaForm.append('subject_color', subjectColor);
          metaForm.append('subject_order', String(subjectOrder));
          await postLibrarySync(metaForm);
          syncedMetaCount += 1;
        }

        const items = listRecordingItems(paths);
        const uploadTasks: Array<() => Promise<void>> = [];
        for (const item of items) {
          const recordingName = item.recordingFile.name || item.title;
          const hasAny =
            item.recordingFile.exists ||
            item.transcriptFile.exists ||
            item.translationFile.exists ||
            item.summaryFile.exists;
          if (!hasAny) {
            continue;
          }

          const uploadParts: Array<{
            kind: 'recording' | 'transcript' | 'translation' | 'summary';
            name: string;
            file: File;
            mimeType: string;
            md5: string;
          }> = [];

          const queueIfChanged = (
            kind: 'recording' | 'transcript' | 'translation' | 'summary',
            name: string,
            file: File,
            mimeType: string,
          ) => {
            checkedParts += 1;
            const localMd5 = getFileMd5Cached(file, md5Cache);
            localPartsForVerification.push({
              subjectId,
              subjectName,
              subjectTag,
              subjectIcon,
              subjectColor,
              subjectOrder,
              kind,
              name,
              file,
              mimeType,
              md5: localMd5,
            });
            const remote = cloudMetaLookup[cloudLookupKey(subjectId, kind, name)];
            if (remote?.md5 && localMd5 && remote.md5 === localMd5) {
              skippedParts += 1;
              return;
            }
            uploadParts.push({ kind, name, file, mimeType, md5: localMd5 });
          };

          if (item.recordingFile.exists) {
            queueIfChanged('recording', recordingName, item.recordingFile, recordingMimeType(recordingName));
          }
          if (item.transcriptFile.exists) {
            const transcriptName = item.transcriptFile.name || `${stripAudioExtension(recordingName)}.txt`;
            queueIfChanged('transcript', transcriptName, item.transcriptFile, 'text/plain');
          }
          if (item.translationFile.exists) {
            const translationName = item.translationFile.name || `${stripAudioExtension(recordingName)}.txt`;
            queueIfChanged('translation', translationName, item.translationFile, 'text/plain');
          }
          if (item.summaryFile.exists) {
            const summaryName = item.summaryFile.name || `${stripAudioExtension(recordingName)}.txt`;
            queueIfChanged('summary', summaryName, item.summaryFile, 'text/plain');
          }

          if (uploadParts.length === 0) {
            continue;
          }

          uploadTasks.push(async () => {
            const unitForm = new FormData();
            unitForm.append('subject_id', subjectId);
            unitForm.append('subject_name', subjectName);
            unitForm.append('subject_tag', subjectTag);
            unitForm.append('subject_icon', subjectIcon);
            unitForm.append('subject_color', subjectColor);
            unitForm.append('subject_order', String(subjectOrder));

            for (const part of uploadParts) {
              unitForm.append(`${part.kind}_name`, part.name);
              if (part.md5) {
                unitForm.append(`${part.kind}_md5`, part.md5);
              }
              unitForm.append(
                part.kind,
                {
                  uri: part.file.uri,
                  name: part.name,
                  type: part.mimeType,
                } as any,
              );
            }

            await postLibrarySync(unitForm);
            uploadUnits += 1;
            uploadedParts += uploadParts.length;
          });
        }

        if (uploadTasks.length > 0) {
          await runTasksWithConcurrency(uploadTasks, CLOUD_UPLOAD_CONCURRENCY, (done, total) => {
            setStatusMessage(`서버 업로드 중... (${subjectName} ${done}/${total})`);
          });
        }
      }

      if (localPartsForVerification.length > 0) {
        setStatusMessage('서버 업로드 검증 중...');
        const verifyResponse = await fetch(`${apiBaseUrl}/api/library`, {
          headers: getAuthHeaders(),
        });
        const verifyPayload = await readJsonSafely(verifyResponse);
        if (!verifyResponse.ok) {
          throw new Error(getApiErrorMessage(verifyPayload, verifyResponse, '업로드 검증 목록 조회 실패'));
        }
        const verifySubjects = normalizeCloudSubjectSnapshots(verifyPayload?.subjects);
        const verifyLookup = buildCloudMetaLookup(verifySubjects);
        const repairTasks: Array<() => Promise<void>> = [];

        for (const part of localPartsForVerification) {
          const remote = verifyLookup[cloudLookupKey(part.subjectId, part.kind, part.name)];
          const remoteMd5 = (remote?.md5 || '').trim().toLowerCase();
          const localMd5 = (part.md5 || '').trim().toLowerCase();
          const needsRepair =
            !remote || (localMd5 && ((!remoteMd5 && !!remote) || (remoteMd5 && remoteMd5 !== localMd5)));
          if (!needsRepair) {
            continue;
          }

          repairTasks.push(async () => {
            if (!part.file.exists) {
              return;
            }
            const form = new FormData();
            form.append('subject_id', part.subjectId);
            form.append('subject_name', part.subjectName);
            form.append('subject_tag', part.subjectTag);
            form.append('subject_icon', part.subjectIcon);
            form.append('subject_color', part.subjectColor);
            form.append('subject_order', String(part.subjectOrder));
            form.append(`${part.kind}_name`, part.name);
            if (localMd5) {
              form.append(`${part.kind}_md5`, localMd5);
            }
            form.append(
              part.kind,
              {
                uri: part.file.uri,
                name: part.name,
                type: part.mimeType,
              } as any,
            );
            await postLibrarySync(form);
            repairedParts += 1;
          });
        }

        if (repairTasks.length > 0) {
          await runTasksWithConcurrency(repairTasks, 1, (done, total) => {
            setStatusMessage(`서버 업로드 보정 중... ${done}/${total}`);
          });
        }

        // Final verify pass to detect any remaining missing entries.
        const finalVerifyResponse = await fetch(`${apiBaseUrl}/api/library`, {
          headers: getAuthHeaders(),
        });
        const finalVerifyPayload = await readJsonSafely(finalVerifyResponse);
        if (finalVerifyResponse.ok) {
          const finalSubjects = normalizeCloudSubjectSnapshots(finalVerifyPayload?.subjects);
          const finalLookup = buildCloudMetaLookup(finalSubjects);
          const seenKeys = new Set<string>();
          for (const part of localPartsForVerification) {
            const key = cloudLookupKey(part.subjectId, part.kind, part.name);
            if (seenKeys.has(key)) {
              continue;
            }
            seenKeys.add(key);
            const remote = finalLookup[key];
            const localMd5 = (part.md5 || '').trim().toLowerCase();
            const remoteMd5 = (remote?.md5 || '').trim().toLowerCase();
            if (!remote) {
              missingAfterVerify += 1;
              continue;
            }
            if (localMd5 && remoteMd5 && localMd5 !== remoteMd5) {
              missingAfterVerify += 1;
            }
          }
        }
      }
      await saveLocalMd5Cache(md5Cache);

      try {
        const cleanupResponse = await fetch(`${apiBaseUrl}/api/library/cleanup-empty`, {
          method: 'POST',
          headers: getAuthHeaders(),
        });
        const cleanupPayload = await readJsonSafely(cleanupResponse);
        if (cleanupResponse.ok) {
          cleanupRemoved = Number(cleanupPayload?.removed_folders ?? 0);
        }
      } catch {
        // Cleanup failure should not mark whole upload as failed.
      }

      setStatusMessage(
        `서버 업로드 완료 (세트 ${uploadUnits}개, 파일 ${uploadedParts}/${checkedParts}개, 스킵 ${skippedParts}개, 보정 ${repairedParts}개, 검증누락 ${missingAfterVerify}개, 메타 ${syncedMetaCount}개, 빈폴더 정리 ${cleanupRemoved}개)${
          cloudRootPath ? ` / 저장위치: ${cloudRootPath}` : ''
        }`,
      );
    } catch (error) {
      setStatusMessage(`서버 업로드 실패: ${formatError(error)}`);
    } finally {
      setCloudSyncBusy(null);
      setIsBusy(false);
    }
  };

  const restoreAllFoldersFromCloud = async () => {
    if (!authToken) {
      setAuthMode('login');
      setAuthModalVisible(true);
      setStatusMessage('먼저 로그인해주세요.');
      return;
    }
    try {
      setIsBusy(true);
      setCloudSyncBusy('restore');
      setStatusMessage('서버 복원 시작...');

      const response = await fetch(`${apiBaseUrl}/api/library`, {
        headers: getAuthHeaders(),
      });
      const payload = await readJsonSafely(response);
      if (!response.ok) {
        throw new Error(getApiErrorMessage(payload, response, '서버 목록 조회 실패'));
      }

      const cloudSubjects = normalizeCloudSubjectSnapshots(payload?.subjects);
      const cloudRootPath = typeof payload?.root_dir === 'string' ? payload.root_dir : '';
      setCloudRootDir(cloudRootPath);
      if (cloudSubjects.length === 0) {
        setStatusMessage('서버에 저장된 폴더가 없습니다.');
        return;
      }

      let downloadedFiles = 0;
      let skippedFiles = 0;
      const failedFiles: string[] = [];
      let firstSubjectId: string | null = null;
      ensureSubjectsRoot();
      const md5Cache = await loadLocalMd5Cache();

      const downloadAndReplace = async (
        subjectId: string,
        kind: 'recording' | 'transcript' | 'translation' | 'summary',
        name: string,
        targetDir: Directory,
        expectedMd5?: string,
        remoteFileId?: string,
      ): Promise<boolean> => {
        const target = new File(targetDir, name);
        const temp = new File(targetDir, `.__tmp__${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
        const query = [
          `subject_id=${encodeURIComponent(subjectId)}`,
          `kind=${encodeURIComponent(kind)}`,
          `name=${encodeURIComponent(name)}`,
        ];
        if (remoteFileId && remoteFileId.trim()) {
          query.push(`file_id=${encodeURIComponent(remoteFileId.trim())}`);
        }
        const url = `${apiBaseUrl}/api/library/file?${query.join('&')}`;
        let lastError: unknown = null;

        const maxAttempts = 5;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          try {
            if (temp.exists) {
              temp.delete();
            }
            await downloadToFileWithAuth(url, temp, getAuthHeaders());
            if (!temp.exists) {
              throw new Error('다운로드 임시 파일을 찾지 못했습니다.');
            }
            if (target.exists) {
              target.delete();
            }
            temp.copy(target);
            temp.delete();
            if (expectedMd5) {
              updateFileMd5Cache(target, expectedMd5, md5Cache);
            } else {
              getFileMd5Cached(target, md5Cache);
            }
            return true;
          } catch (error) {
            lastError = error;
            if (temp.exists) {
              temp.delete();
            }
            if (attempt < maxAttempts) {
              const msg = formatError(error);
              const transient = /\((502|503|504)\b/.test(msg) || /\b(502|503|504)\b/.test(msg);
              await delay(transient ? 3000 * attempt : 1200 * attempt);
            }
          }
        }

        failedFiles.push(`[${subjectId}] ${kind}/${name} - ${formatError(lastError)}`);
        return false;
      };

      for (let index = 0; index < cloudSubjects.length; index += 1) {
        const entry = cloudSubjects[index];
        const subjectId = entry.subjectId.trim();
        if (!subjectId) {
          continue;
        }
        if (!firstSubjectId) {
          firstSubjectId = subjectId;
        }

        const subjectName = entry.subjectName || subjectId;
        const subjectTag = normalizeSubjectTag(entry.subjectTag || 'major');
        const subjectIcon = entry.subjectIcon || DEFAULT_FOLDER_ICON;
        const subjectColor = normalizeFolderColor(entry.subjectColor || DEFAULT_FOLDER_COLOR);
        const subjectOrder = entry.subjectOrder ?? index + 1;

        const paths = getSubjectPaths(subjectId);
        paths.dir.create({ idempotent: true, intermediates: true });
        ensureRecordingDirs(paths);
        const meta: SubjectMeta = {
          id: subjectId,
          name: subjectName,
          tag: subjectTag,
          icon: subjectIcon,
          color: subjectColor,
          order: subjectOrder,
          createdAt: Date.now(),
        };
        writeText(paths.meta, JSON.stringify(meta, null, 2));

        setStatusMessage(`서버 복원 중... (${index + 1}/${cloudSubjects.length}) ${subjectName}`);

        const restoreTasks: Array<() => Promise<boolean>> = [];
        const pushRestoreIfNeeded = (
          kind: 'recording' | 'transcript' | 'translation' | 'summary',
          fileMeta: CloudFileMeta,
          targetDir: Directory,
        ) => {
          const name = fileMeta.name;
          if (!name) {
            return;
          }
          const target = new File(targetDir, name);
          if (target.exists) {
            const remoteMd5 = fileMeta.md5.trim().toLowerCase();
            if (remoteMd5) {
              const localMd5 = getFileMd5Cached(target, md5Cache);
              if (localMd5 && localMd5 === remoteMd5) {
                skippedFiles += 1;
                return;
              }
            }
          }
          restoreTasks.push(() => downloadAndReplace(subjectId, kind, name, targetDir, fileMeta.md5, fileMeta.fileId));
        };

        for (const fileMeta of entry.recordings) {
          pushRestoreIfNeeded('recording', fileMeta, paths.recordingsDir);
        }
        for (const fileMeta of entry.transcripts) {
          pushRestoreIfNeeded('transcript', fileMeta, paths.transcriptsDir);
        }
        for (const fileMeta of entry.translations) {
          pushRestoreIfNeeded('translation', fileMeta, paths.translationsDir);
        }
        for (const fileMeta of entry.summaries) {
          pushRestoreIfNeeded('summary', fileMeta, paths.summariesDir);
        }

        if (restoreTasks.length > 0) {
          const results = await runTasksWithConcurrency(restoreTasks, CLOUD_RESTORE_CONCURRENCY, (done, total) => {
            setStatusMessage(`서버 복원 중... (${index + 1}/${cloudSubjects.length}) ${subjectName} ${done}/${total}`);
          });
          downloadedFiles += results.filter(Boolean).length;
        }

        const forceMissingTasks: Array<() => Promise<boolean>> = [];
        const ensureMissing = (
          kind: 'recording' | 'transcript' | 'translation' | 'summary',
          fileMeta: CloudFileMeta,
          targetDir: Directory,
        ) => {
          const name = fileMeta.name;
          if (!name) {
            return;
          }
          const target = new File(targetDir, name);
          if (!target.exists) {
            forceMissingTasks.push(() =>
              downloadAndReplace(subjectId, kind, name, targetDir, fileMeta.md5, fileMeta.fileId),
            );
          }
        };
        for (const fileMeta of entry.recordings) {
          ensureMissing('recording', fileMeta, paths.recordingsDir);
        }
        for (const fileMeta of entry.transcripts) {
          ensureMissing('transcript', fileMeta, paths.transcriptsDir);
        }
        for (const fileMeta of entry.translations) {
          ensureMissing('translation', fileMeta, paths.translationsDir);
        }
        for (const fileMeta of entry.summaries) {
          ensureMissing('summary', fileMeta, paths.summariesDir);
        }
        if (forceMissingTasks.length > 0) {
          const retryConcurrency = Math.max(1, Math.floor(CLOUD_RESTORE_CONCURRENCY / 2));
          const forceResults = await runTasksWithConcurrency(forceMissingTasks, retryConcurrency, (done, total) => {
            setStatusMessage(
              `서버 복원 재시도 중... (${index + 1}/${cloudSubjects.length}) ${subjectName} ${done}/${total}`,
            );
          });
          downloadedFiles += forceResults.filter(Boolean).length;
        }
      }

      await saveLocalMd5Cache(md5Cache);

      await loadSubjects(firstSubjectId ?? undefined);
      if (firstSubjectId) {
        await loadSubjectFiles(firstSubjectId);
      }
      setScreenMode('home');
      if (failedFiles.length > 0) {
        const firstFailure = failedFiles[0]?.slice(0, 320) ?? '';
        setStatusMessage(
          `서버 복원 완료 (다운로드 ${downloadedFiles}개, 스킵 ${skippedFiles}개, 실패 ${failedFiles.length}개)${firstFailure ? ` / 첫 실패: ${firstFailure}` : ''}`,
        );
      } else {
        setStatusMessage(`서버 복원 완료 (다운로드 ${downloadedFiles}개, 스킵 ${skippedFiles}개)`);
      }
    } catch (error) {
      setStatusMessage(`서버 복원 실패: ${formatError(error)}`);
    } finally {
      setCloudSyncBusy(null);
      setIsBusy(false);
    }
  };

  const archiveAndClearCloudLibrary = async () => {
    if (!authToken) {
      setAuthMode('login');
      setAuthModalVisible(true);
      setStatusMessage('먼저 로그인해주세요.');
      return;
    }

    Alert.alert('클라우드 비우기', '현재 서버 파일을 백업 폴더로 이동하고 서버 폴더를 비울까요?', [
      { text: '취소', style: 'cancel' },
      {
        text: '진행',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            try {
              setIsBusy(true);
              setStatusMessage('서버 파일 백업/정리 중...');
              const response = await fetch(`${apiBaseUrl}/api/library/archive`, {
                method: 'POST',
                headers: getAuthHeaders(),
              });
              const payload = await readJsonSafely(response);
              if (!response.ok) {
                throw new Error(getApiErrorMessage(payload, response, '서버 정리 실패'));
              }

              const moved = Number(payload?.moved_items ?? 0);
              const archiveDir = typeof payload?.archive_dir === 'string' ? payload.archive_dir : '';
              setStatusMessage(
                archiveDir
                  ? `서버 정리 완료 (이동 ${moved}개) - 백업: ${archiveDir}`
                  : `서버 정리 완료 (이동 ${moved}개)`,
              );
            } catch (error) {
              setStatusMessage(`서버 정리 실패: ${formatError(error)}`);
            } finally {
              setIsBusy(false);
            }
          })();
        },
      },
    ]);
  };

  const exportSubjectFile = async (kind: 'recording' | 'transcript' | 'translation' | 'summary') => {
    if (!selectedSubject || !selectedRecording) {
      setStatusMessage('파일을 선택해주세요.');
      return;
    }

    const target =
      kind === 'recording'
        ? selectedRecording.recordingFile
        : kind === 'transcript'
          ? selectedRecording.transcriptFile
          : kind === 'translation'
            ? selectedRecording.translationFile
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
      const hasTranslation = recordings.some((item) => item.translationFile.exists);
      const hasSummary = recordings.some((item) => item.summaryFile.exists);

      rows.push({
        id,
        name: meta?.name ?? id,
        tag: meta?.tag ?? 'major',
        icon: meta?.icon ?? DEFAULT_FOLDER_ICON,
        color: normalizeFolderColor(meta?.color ?? DEFAULT_FOLDER_COLOR),
        order: normalizeSubjectOrder(meta?.order) ?? Number.MAX_SAFE_INTEGER,
        hasRecording,
        hasTranscript,
        hasTranslation,
        hasSummary,
        updatedAt,
        previewFiles: recordings.slice(0, 3).map((item) => item.title),
      });
    }

    rows.sort((a, b) => {
      if (a.order !== b.order) {
        return a.order - b.order;
      }
      return b.updatedAt - a.updatedAt;
    });
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
      setTranslation('');
      setSummary('');
      return;
    }

    const desiredId = preferredRecordingId ?? selectedRecordingId;
    const picked = items.find((item) => item.id === desiredId) ?? items[0];
    setSelectedRecordingId(picked.id);
    setRecordingUri(picked.recordingFile.uri);

    const transcriptValue = picked.transcriptFile.exists ? await picked.transcriptFile.text() : '';
    setTranscript(transcriptValue);

    const translationValue = picked.translationFile.exists ? await picked.translationFile.text() : '';
    setTranslation(translationValue);

    const summaryValue = picked.summaryFile.exists ? await picked.summaryFile.text() : '';
    setSummary(summaryValue);
  };

  return (
    <LinearGradient colors={['#F7F9FC', '#EAF1FB', '#DCE9FF']} style={styles.background}>
      <SafeAreaView style={styles.safeArea}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.title}>Campus Lecture Binder</Text>
          <Text style={styles.subtitle}>폴더 → 파일 → 전사/번역/요약 상세</Text>
          <View style={styles.globalStatusCard}>
            <Text style={styles.status}>상태: {statusMessage}</Text>
            {pendingJobs.length > 0 ? (
              <Text style={styles.pendingInfo}>
                진행중 잡: {pendingJobs.map((job) => `${job.fileName} ${jobActionText(job.jobType)}`).join(', ')}
              </Text>
            ) : null}
            {isBusy ? <ActivityIndicator color="#2563EB" style={styles.loader} /> : null}
          </View>

          {screenMode === 'home' ? (
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>폴더 목록</Text>
              <Text style={styles.helper}>아래 폴더 박스를 누르면 내부 녹음 파일 목록이 열립니다.</Text>
              <View style={styles.authRow}>
                <Text style={styles.authText}>
                  {authUser ? `계정: ${authUser.display_name} (${authUser.email})` : '계정: 로그인 필요'}
                </Text>
                {authUser ? (
                  <Pressable style={styles.authButton} onPress={logoutAuth}>
                    <Text style={styles.authButtonText}>로그아웃</Text>
                  </Pressable>
                ) : (
                  <Pressable
                    style={styles.authButton}
                    onPress={() => {
                      setAuthMode('login');
                      setAuthModalVisible(true);
                    }}
                  >
                    <Text style={styles.authButtonText}>로그인</Text>
                  </Pressable>
                )}
              </View>
              <View style={styles.cloudSyncRow}>
                <Pressable
                  style={[styles.cloudSyncButton, isBusy && styles.disabledButton]}
                  onPress={uploadAllFoldersToCloud}
                  disabled={isBusy}
                >
                  <View style={styles.cloudSyncContent}>
                    <Text style={styles.cloudSyncButtonText}>
                      {cloudSyncBusy === 'upload' ? '서버 업로드 중...' : '서버 업로드'}
                    </Text>
                    {cloudSyncBusy === 'upload' ? (
                      <ActivityIndicator size="small" color="#1E3A8A" style={styles.cloudSyncSpinner} />
                    ) : null}
                  </View>
                </Pressable>
                <Pressable
                  style={[styles.cloudSyncButton, isBusy && styles.disabledButton]}
                  onPress={restoreAllFoldersFromCloud}
                  disabled={isBusy}
                >
                  <View style={styles.cloudSyncContent}>
                    <Text style={styles.cloudSyncButtonText}>
                      {cloudSyncBusy === 'restore' ? '복원 중...' : '서버에서 복원'}
                    </Text>
                    {cloudSyncBusy === 'restore' ? (
                      <ActivityIndicator size="small" color="#1E3A8A" style={styles.cloudSyncSpinner} />
                    ) : null}
                  </View>
                </Pressable>
              </View>
              {cloudRootDir ? (
                <View style={styles.cloudLocationRow}>
                  <Text style={styles.cloudLocationText}>클라우드 위치: {cloudRootDir}</Text>
                  {toDriveWebUrl(cloudRootDir) ? (
                    <Pressable
                      style={styles.cloudLocationButton}
                      onPress={() => {
                        const target = toDriveWebUrl(cloudRootDir);
                        if (target) {
                          void Linking.openURL(target);
                        }
                      }}
                    >
                      <Text style={styles.cloudLocationButtonText}>드라이브 열기</Text>
                    </Pressable>
                  ) : null}
                </View>
              ) : null}
              <Pressable
                style={[styles.cloudArchiveButton, isBusy && styles.disabledButton]}
                onPress={archiveAndClearCloudLibrary}
                disabled={isBusy}
              >
                <Text style={styles.cloudArchiveButtonText}>클라우드 비우기 (백업 이동)</Text>
              </Pressable>
              <View style={styles.subjectList}>
                {subjects.length === 0 ? <Text style={styles.helper}>저장된 폴더가 없습니다.</Text> : null}
                {subjects.map((subject) => (
                  <View key={subject.id} style={[styles.subjectItem, { borderColor: subject.color }]}>
                    <Pressable style={styles.subjectOpenArea} onPress={() => openDirectory(subject.id)}>
                      <View style={styles.subjectHeaderRow}>
                        <View style={[styles.folderIconBubble, { backgroundColor: subject.color }]}>
                          <Text style={styles.folderIconText}>{subject.icon}</Text>
                        </View>
                        <Text style={styles.subjectName}>{subject.name}</Text>
                      </View>
                      <Text style={styles.subjectMeta}>
                        {subject.hasRecording ? 'REC' : '-'} / {subject.hasTranscript ? 'TXT' : '-'} /{' '}
                        {subject.hasTranslation ? 'TRN' : '-'} / {subject.hasSummary ? 'SUM' : '-'}
                      </Text>
                      {subject.previewFiles.length > 0 ? (
                        <View style={styles.previewFileList}>
                          {subject.previewFiles.map((fileName) => (
                            <Text key={`${subject.id}-${fileName}`} style={styles.previewFileItem}>
                              · {fileName}
                            </Text>
                          ))}
                        </View>
                      ) : (
                        <Text style={styles.previewFileItem}>· 파일 없음</Text>
                      )}
                    </Pressable>
                    <View style={styles.subjectActionRow}>
                      <Pressable
                        style={[styles.subjectActionButton, (isBusy || subjects[0]?.id === subject.id) && styles.disabledButton]}
                        disabled={isBusy || subjects[0]?.id === subject.id}
                        onPress={() => void moveSubject(subject.id, 'up')}
                      >
                        <Text style={styles.subjectActionText}>위로</Text>
                      </Pressable>
                      <Pressable
                        style={[
                          styles.subjectActionButton,
                          (isBusy || subjects[subjects.length - 1]?.id === subject.id) && styles.disabledButton,
                        ]}
                        disabled={isBusy || subjects[subjects.length - 1]?.id === subject.id}
                        onPress={() => void moveSubject(subject.id, 'down')}
                      >
                        <Text style={styles.subjectActionText}>아래로</Text>
                      </Pressable>
                      <Pressable
                        style={[styles.subjectActionButton, isBusy && styles.disabledButton]}
                        disabled={isBusy}
                        onPress={() => openEditFolderModal(subject)}
                      >
                        <Text style={styles.subjectActionText}>수정</Text>
                      </Pressable>
                      <Pressable
                        style={[styles.subjectActionButton, styles.subjectDeleteAction, isBusy && styles.disabledButton]}
                        disabled={isBusy}
                        onPress={() => void deleteSubject(subject)}
                      >
                        <Text style={styles.subjectDeleteActionText}>삭제</Text>
                      </Pressable>
                    </View>
                  </View>
                ))}
              </View>
            </View>
          ) : null}

          {screenMode === 'subject' ? (
            <View style={styles.card}>
              <View style={styles.topRow}>
                <Pressable style={styles.openButton} onPress={() => setScreenMode('home')}>
                  <Text style={styles.openButtonText}>홈으로</Text>
                </Pressable>
                <Text style={styles.sectionTitleInline}>폴더: {selectedSubject?.name ?? '없음'}</Text>
              </View>
              <Text style={styles.helper}>파일 박스를 누르면 상세 창이 열립니다.</Text>
              <View style={styles.recordingList}>
                {recordings.length === 0 ? <Text style={styles.helper}>저장된 녹음 파일이 없습니다.</Text> : null}
                {recordings.map((item) => (
                  <View key={item.id} style={styles.recordingItem}>
                    <Pressable style={styles.recordingMainArea} onPress={() => void selectRecording(item.id)}>
                      <Text style={styles.recordingTitle}>{item.title}</Text>
                      <Text style={styles.recordingMeta}>
                        {item.recordingFile.exists ? 'REC' : '-'} / {item.transcriptFile.exists ? 'TXT' : '-'} /{' '}
                        {item.translationFile.exists ? 'TRN' : '-'} / {item.summaryFile.exists ? 'SUM' : '-'}
                      </Text>
                    </Pressable>
                    <View style={styles.recordingActionRow}>
                      <Pressable
                        style={[styles.recordingMoveButton, isBusy && styles.disabledButton]}
                        onPress={() => openMoveRecordingModal(item)}
                        disabled={isBusy}
                      >
                        <Text style={styles.recordingMoveButtonText}>폴더 이동</Text>
                      </Pressable>
                    </View>
                  </View>
                ))}
              </View>
            </View>
          ) : null}

          {screenMode === 'record' ? (
            <View style={styles.card}>
              <View style={styles.topRow}>
                <Pressable style={styles.openButton} onPress={() => setScreenMode('home')}>
                  <Text style={styles.openButtonText}>홈으로</Text>
                </Pressable>
                <Text style={styles.sectionTitleInline}>새 녹음</Text>
              </View>
              <Text style={styles.recordTimer}>{displayTime}</Text>
              <Text style={styles.helper}>
                {isRecording ? '녹음 중입니다. 백그라운드에서도 계속 녹음됩니다.' : '시작 버튼으로 녹음을 시작하세요.'}
              </Text>
              {!isRecording ? (
                <Pressable
                  style={[styles.actionButton, recordActionBusy && styles.disabledButton]}
                  onPress={startRecording}
                  disabled={recordActionBusy}
                >
                  <Text style={styles.actionButtonText}>녹음 시작</Text>
                </Pressable>
              ) : (
                <Pressable
                  style={[styles.deleteButton, recordActionBusy && styles.disabledButton]}
                  onPress={stopRecording}
                  disabled={recordActionBusy}
                >
                  <Text style={styles.deleteButtonText}>녹음 중지</Text>
                </Pressable>
              )}
              {recordingDraftUri ? (
                <Text style={styles.helper}>녹음이 완료되었습니다. 저장 정보를 입력해주세요.</Text>
              ) : null}
            </View>
          ) : null}

          {screenMode === 'detail' ? (
            <>
              <View style={styles.card}>
                <View style={styles.topRow}>
                  <Pressable style={styles.openButton} onPress={() => setScreenMode('subject')}>
                    <Text style={styles.openButtonText}>파일 목록</Text>
                  </Pressable>
                  <Text style={styles.sectionTitleInline}>상세: {selectedRecording?.title ?? '없음'}</Text>
                </View>
                <Text style={styles.helper}>선택 파일 크기: {formatBytes(selectedRecording?.recordingFile.size ?? 0)}</Text>
                <Text style={styles.filePath} numberOfLines={1}>
                  녹음 파일: {recordingUri ?? '없음'}
                </Text>
                <Pressable
                  style={[styles.renameButton, (!selectedRecording || isBusy) && styles.disabledButton]}
                  onPress={openRenameModal}
                  disabled={!selectedRecording || isBusy}
                >
                  <Text style={styles.renameButtonText}>파일 이름 변경</Text>
                </Pressable>
              </View>

              <View style={styles.card}>
                <Text style={styles.sectionTitle}>전사 방식 선택</Text>
                <ModeToggle mode={transcribeMode} onChange={setTranscribeMode} />
                {transcribeMode === 'chat' ? (
                  <Pressable
                    style={[styles.actionButton, (!selectedRecording || isBusy) && styles.disabledButton]}
                    onPress={runTranscriptionChatApi}
                    disabled={!selectedRecording || isBusy}
                  >
                    <Text style={styles.actionButtonText}>대화형 AI 전사 실행</Text>
                  </Pressable>
                ) : (
                  <Pressable
                    style={[styles.actionButton, (!selectedRecording || isBusy) && styles.disabledButton]}
                    onPress={runTranscriptionApi}
                    disabled={!selectedRecording || isBusy}
                  >
                    <Text style={styles.actionButtonText}>API 전사 실행</Text>
                  </Pressable>
                )}
                <View style={styles.previewRow}>
                  <Text style={styles.previewTitle}>전사 내용 (최대 10줄)</Text>
                  <Pressable style={styles.editChip} onPress={openTranscriptEditor}>
                    <Text style={styles.editChipText}>+</Text>
                  </Pressable>
                </View>
                <Text style={styles.bodyText}>{toTenLinePreview(transcript, '전사 결과 없음')}</Text>
              </View>

              <View style={styles.card}>
                <Text style={styles.sectionTitle}>번역 방식 선택</Text>
                <ModeToggle mode={translationMode} onChange={setTranslationMode} />
                <View style={styles.toggleRow}>
                  <Pressable
                    style={[styles.toggleButton, translationTargetLanguage === 'English' && styles.toggleButtonActive]}
                    onPress={() => setTranslationTargetLanguage('English')}
                  >
                    <Text style={styles.toggleText}>영어 번역</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.toggleButton, translationTargetLanguage === 'Korean' && styles.toggleButtonActive]}
                    onPress={() => setTranslationTargetLanguage('Korean')}
                  >
                    <Text style={styles.toggleText}>한국어 번역</Text>
                  </Pressable>
                </View>
                {translationMode === 'chat' ? (
                  <Pressable
                    style={[styles.actionButton, (!selectedRecording || isBusy) && styles.disabledButton]}
                    onPress={runTranslateChatApi}
                    disabled={!selectedRecording || isBusy}
                  >
                    <Text style={styles.actionButtonText}>대화형 AI 번역 실행</Text>
                  </Pressable>
                ) : (
                  <Pressable
                    style={[styles.actionButton, (!selectedRecording || isBusy) && styles.disabledButton]}
                    onPress={runTranslateApi}
                    disabled={!selectedRecording || isBusy}
                  >
                    <Text style={styles.actionButtonText}>API 번역 실행</Text>
                  </Pressable>
                )}
                <View style={styles.previewRow}>
                  <Text style={styles.previewTitle}>번역 내용 (최대 10줄)</Text>
                  <Pressable style={styles.editChip} onPress={openTranslationEditor}>
                    <Text style={styles.editChipText}>+</Text>
                  </Pressable>
                </View>
                <Text style={styles.bodyText}>{toTenLinePreview(translation, '번역 결과 없음')}</Text>
              </View>

              <View style={styles.card}>
                <Text style={styles.sectionTitle}>요약 방식 선택</Text>
                <ModeToggle mode={summaryMode} onChange={setSummaryMode} />
                {summaryMode === 'chat' ? (
                  <Pressable
                    style={[styles.actionButton, (!selectedRecording || isBusy) && styles.disabledButton]}
                    onPress={runSummaryChatApi}
                    disabled={!selectedRecording || isBusy}
                  >
                    <Text style={styles.actionButtonText}>대화형 AI 요약 실행</Text>
                  </Pressable>
                ) : (
                  <Pressable
                    style={[styles.actionButton, (!selectedRecording || isBusy) && styles.disabledButton]}
                    onPress={runSummaryApi}
                    disabled={!selectedRecording || isBusy}
                  >
                    <Text style={styles.actionButtonText}>API 요약 실행</Text>
                  </Pressable>
                )}
                <View style={styles.previewRow}>
                  <Text style={styles.previewTitle}>요약 내용 (최대 10줄)</Text>
                  <Pressable style={styles.editChip} onPress={openSummaryEditor}>
                    <Text style={styles.editChipText}>+</Text>
                  </Pressable>
                </View>
                <Text style={styles.bodyText}>{toTenLinePreview(summary, '요약 결과 없음')}</Text>
              </View>

              <View style={styles.card}>
                <Text style={styles.status}>상태: {statusMessage}</Text>
                <Text style={styles.apiInfo}>API: {apiBaseUrl}</Text>
                {pendingJobs.length > 0 ? (
                  <Text style={styles.pendingInfo}>
                    진행중 잡: {pendingJobs.map((job) => `${job.fileName} ${jobActionText(job.jobType)}`).join(', ')}
                  </Text>
                ) : null}
                {isBusy ? <ActivityIndicator color="#2563EB" style={styles.loader} /> : null}
                <Pressable
                  style={[styles.deleteButton, (!selectedRecording || isBusy) && styles.disabledButton]}
                  onPress={deleteCurrentRecording}
                  disabled={!selectedRecording || isBusy}
                >
                  <Text style={styles.deleteButtonText}>삭제</Text>
                </Pressable>
              </View>
            </>
          ) : null}
        </ScrollView>

        {screenMode === 'home' ? (
          <View style={styles.fabContainer} pointerEvents="box-none">
            {fabOpen ? (
              <View style={styles.fabMenu}>
                <Pressable
                  style={styles.fabMenuItem}
                  onPress={() => {
                    setFabOpen(false);
                    setScreenMode('record');
                    setStatusMessage('새 녹음을 시작합니다.');
                  }}
                >
                  <Text style={styles.fabMenuText}>새 녹음</Text>
                </Pressable>
                <Pressable
                  style={styles.fabMenuItem}
                  onPress={() => {
                    setFabOpen(false);
                    openCreateFolderModal();
                  }}
                >
                  <Text style={styles.fabMenuText}>새 폴더 추가</Text>
                </Pressable>
                <Pressable
                  style={styles.fabMenuItem}
                  onPress={() => {
                    setFabOpen(false);
                    setUploadMode('file');
                    setUploadFileUri('');
                    setUploadName('');
                    setUploadVideoLink('');
                    setUploadTargetFolderId(selectedSubjectId ?? subjects[0]?.id ?? null);
                    setUploadModalVisible(true);
                  }}
                >
                  <Text style={styles.fabMenuText}>녹음 파일 추가</Text>
                </Pressable>
              </View>
            ) : null}
            <Pressable style={styles.fabButton} onPress={() => setFabOpen((prev) => !prev)}>
              <Text style={styles.fabButtonText}>{fabOpen ? '×' : '+'}</Text>
            </Pressable>
          </View>
        ) : null}
      </SafeAreaView>

      <Modal visible={editorVisible} transparent animationType="slide" onRequestClose={closeEditorModal}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, styles.editorModalCard]}>
            <View style={styles.editorHeader}>
              <Text style={styles.modalTitle}>
                {editorTarget === 'summary'
                  ? editorIsEditing
                    ? '요약 편집'
                    : '요약 전체 보기'
                  : editorTarget === 'translation'
                    ? editorIsEditing
                      ? '번역 편집'
                      : '번역 전체 보기'
                    : editorIsEditing
                      ? '전사 편집'
                      : '전사 전체 보기'}
              </Text>
              {!editorIsEditing ? (
                <Pressable style={styles.editorHeaderButton} onPress={startEditorEditing}>
                  <Text style={styles.editorHeaderButtonText}>편집</Text>
                </Pressable>
              ) : null}
            </View>
            {editorIsEditing ? (
              <TextInput
                value={editorText}
                onChangeText={setEditorText}
                multiline
                scrollEnabled
                style={styles.modalInput}
                placeholder="내용을 입력하세요"
                placeholderTextColor="#94A3B8"
              />
            ) : (
              <ScrollView style={styles.viewerScroll} contentContainerStyle={styles.viewerContent}>
                <Text style={styles.viewerText}>{editorText.trim() || '내용이 없습니다.'}</Text>
              </ScrollView>
            )}
            <View style={styles.modalActions}>
              {editorIsEditing ? (
                <>
                  <Pressable style={[styles.modalButton, styles.modalCancel]} onPress={cancelEditorEditing}>
                    <Text style={styles.modalButtonText}>취소</Text>
                  </Pressable>
                  <Pressable style={[styles.modalButton, styles.modalSave]} onPress={() => void saveEditedText()}>
                    <Text style={styles.modalButtonText}>저장</Text>
                  </Pressable>
                </>
              ) : (
                <Pressable style={[styles.modalButton, styles.modalSave]} onPress={closeEditorModal}>
                  <Text style={styles.modalButtonText}>닫기</Text>
                </Pressable>
              )}
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={renameVisible} transparent animationType="fade" onRequestClose={() => setRenameVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>파일 이름 변경</Text>
            <TextInput
              value={renameText}
              onChangeText={setRenameText}
              style={styles.renameInput}
              placeholder="예: 선형대수_1주차"
              placeholderTextColor="#94A3B8"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={styles.helper}>녹음/전사/번역/요약 파일명이 함께 변경됩니다.</Text>
            <View style={styles.modalActions}>
              <Pressable style={[styles.modalButton, styles.modalCancel]} onPress={() => setRenameVisible(false)}>
                <Text style={styles.modalButtonText}>취소</Text>
              </Pressable>
              <Pressable
                style={[styles.modalButton, styles.modalSave, isBusy && styles.disabledButton]}
                onPress={() => void renameCurrentRecording()}
                disabled={isBusy}
              >
                <Text style={styles.modalButtonText}>변경</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={authModalVisible} transparent animationType="fade" onRequestClose={() => setAuthModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{authMode === 'register' ? '회원가입' : '로그인'}</Text>
            <View style={styles.toggleRow}>
              <Pressable
                style={[styles.toggleButton, authMode === 'login' && styles.toggleButtonActive]}
                onPress={() => setAuthMode('login')}
              >
                <Text style={styles.toggleText}>로그인</Text>
              </Pressable>
              <Pressable
                style={[styles.toggleButton, authMode === 'register' && styles.toggleButtonActive]}
                onPress={() => setAuthMode('register')}
              >
                <Text style={styles.toggleText}>회원가입</Text>
              </Pressable>
            </View>
            {authMode === 'register' ? (
              <TextInput
                value={authDisplayName}
                onChangeText={setAuthDisplayName}
                style={styles.renameInput}
                placeholder="표시 이름"
                placeholderTextColor="#94A3B8"
              />
            ) : null}
            <TextInput
              value={authEmail}
              onChangeText={setAuthEmail}
              style={styles.renameInput}
              placeholder="이메일"
              placeholderTextColor="#94A3B8"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
            />
            <TextInput
              value={authPassword}
              onChangeText={setAuthPassword}
              style={styles.renameInput}
              placeholder="비밀번호 (6자 이상)"
              placeholderTextColor="#94A3B8"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
            />
            <Text style={styles.modalLabel}>소셜 로그인 / 회원가입</Text>
            <View style={styles.socialAuthRow}>
              <Pressable
                style={[styles.socialAuthButton, styles.socialKakao, authBusy && styles.disabledButton]}
                onPress={() => void submitSocialAuth('kakao')}
                disabled={authBusy}
              >
                <Text style={[styles.socialAuthButtonText, styles.socialKakaoText]}>카카오</Text>
              </Pressable>
              <Pressable
                style={[styles.socialAuthButton, styles.socialGoogle, authBusy && styles.disabledButton]}
                onPress={() => void submitSocialAuth('google')}
                disabled={authBusy}
              >
                <Text style={[styles.socialAuthButtonText, styles.socialGoogleText]}>구글</Text>
              </Pressable>
              <Pressable
                style={[styles.socialAuthButton, styles.socialNaver, authBusy && styles.disabledButton]}
                onPress={() => void submitSocialAuth('naver')}
                disabled={authBusy}
              >
                <Text style={[styles.socialAuthButtonText, styles.socialNaverText]}>네이버</Text>
              </Pressable>
            </View>
            <View style={styles.modalActions}>
              <Pressable style={[styles.modalButton, styles.modalCancel]} onPress={() => setAuthModalVisible(false)}>
                <Text style={styles.modalButtonText}>취소</Text>
              </Pressable>
              <Pressable
                style={[styles.modalButton, styles.modalSave, authBusy && styles.disabledButton]}
                onPress={() => void submitAuth()}
                disabled={authBusy}
              >
                <Text style={styles.modalButtonText}>{authMode === 'register' ? '가입' : '로그인'}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={folderModalVisible}
        transparent
        animationType="fade"
        onRequestClose={closeFolderModal}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{folderModalMode === 'edit' ? '폴더 수정' : '새 폴더 추가'}</Text>
            <TextInput
              value={newFolderName}
              onChangeText={setNewFolderName}
              style={styles.renameInput}
              placeholder="폴더 이름"
              placeholderTextColor="#94A3B8"
            />
            <Text style={styles.modalLabel}>아이콘</Text>
            <TextInput
              value={newFolderIcon}
              onChangeText={(value) => setNewFolderIcon(value || DEFAULT_FOLDER_ICON)}
              style={styles.renameInput}
              placeholder="예: 📁"
              placeholderTextColor="#94A3B8"
              maxLength={2}
            />
            <View style={styles.optionWrap}>
              {FOLDER_ICON_OPTIONS.map((icon) => (
                <Pressable
                  key={icon}
                  style={[styles.optionChip, newFolderIcon === icon && styles.optionChipActive]}
                  onPress={() => setNewFolderIcon(icon)}
                >
                  <Text style={styles.optionChipText}>{icon}</Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.modalLabel}>색상</Text>
            <TextInput
              value={newFolderColor}
              onChangeText={(value) => setNewFolderColor(value || DEFAULT_FOLDER_COLOR)}
              style={styles.renameInput}
              placeholder="#DBEAFE"
              placeholderTextColor="#94A3B8"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <View style={styles.optionWrap}>
              {FOLDER_COLOR_OPTIONS.map((color) => (
                <Pressable
                  key={color}
                  style={[styles.colorChip, { backgroundColor: color }, newFolderColor === color && styles.colorChipActive]}
                  onPress={() => setNewFolderColor(color)}
                />
              ))}
            </View>
            <View style={styles.modalActions}>
              <Pressable
                style={[styles.modalButton, styles.modalCancel]}
                onPress={closeFolderModal}
              >
                <Text style={styles.modalButtonText}>취소</Text>
              </Pressable>
              <Pressable
                style={[styles.modalButton, styles.modalSave]}
                onPress={() => void (folderModalMode === 'edit' ? updateSubject() : createSubject())}
              >
                <Text style={styles.modalButtonText}>{folderModalMode === 'edit' ? '수정' : '생성'}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={recordingSaveVisible} transparent animationType="fade" onRequestClose={cancelRecordingSave}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>녹음 저장</Text>
            <TextInput
              value={recordingSaveName}
              onChangeText={setRecordingSaveName}
              style={styles.renameInput}
              placeholder="파일 이름"
              placeholderTextColor="#94A3B8"
            />
            <Text style={styles.modalLabel}>저장 폴더</Text>
            <View style={styles.folderPickerList}>
              {subjects.map((subject) => (
                <Pressable
                  key={`save-${subject.id}`}
                  style={[
                    styles.folderPickerItem,
                    recordingTargetFolderId === subject.id && styles.folderPickerItemActive,
                  ]}
                  onPress={() => setRecordingTargetFolderId(subject.id)}
                >
                  <Text style={styles.folderPickerText}>
                    {subject.icon} {subject.name}
                  </Text>
                </Pressable>
              ))}
            </View>
            <View style={styles.modalActions}>
              <Pressable style={[styles.modalButton, styles.modalCancel]} onPress={cancelRecordingSave}>
                <Text style={styles.modalButtonText}>취소(임시저장)</Text>
              </Pressable>
              <Pressable style={[styles.modalButton, styles.modalSave]} onPress={() => void saveRecordedDraft()}>
                <Text style={styles.modalButtonText}>저장</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={moveModalVisible} transparent animationType="fade" onRequestClose={closeMoveModal}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>파일 폴더 이동</Text>
            <Text style={styles.helper}>선택한 파일을 다른 폴더로 이동합니다.</Text>
            <Text style={styles.modalLabel}>대상 폴더</Text>
            <View style={styles.folderPickerList}>
              {subjects
                .filter((subject) => subject.id !== moveSourceFolderId)
                .map((subject) => (
                  <Pressable
                    key={`move-${subject.id}`}
                    style={[styles.folderPickerItem, moveTargetFolderId === subject.id && styles.folderPickerItemActive]}
                    onPress={() => setMoveTargetFolderId(subject.id)}
                  >
                    <Text style={styles.folderPickerText}>
                      {subject.icon} {subject.name}
                    </Text>
                  </Pressable>
                ))}
            </View>
            <View style={styles.modalActions}>
              <Pressable style={[styles.modalButton, styles.modalCancel]} onPress={closeMoveModal}>
                <Text style={styles.modalButtonText}>취소</Text>
              </Pressable>
              <Pressable
                style={[styles.modalButton, styles.modalSave, isBusy && styles.disabledButton]}
                onPress={() => void moveRecordingToFolder()}
                disabled={isBusy}
              >
                <Text style={styles.modalButtonText}>이동</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={uploadModalVisible} transparent animationType="fade" onRequestClose={() => setUploadModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>녹음 파일 추가</Text>
            <View style={styles.toggleRow}>
              <Pressable
                style={[styles.toggleButton, uploadMode === 'file' && styles.toggleButtonActive]}
                onPress={() => setUploadMode('file')}
              >
                <Text style={styles.toggleText}>음성 파일 업로드</Text>
              </Pressable>
              <Pressable
                style={[styles.toggleButton, uploadMode === 'link' && styles.toggleButtonActive]}
                onPress={() => setUploadMode('link')}
              >
                <Text style={styles.toggleText}>영상 링크</Text>
              </Pressable>
            </View>

            {uploadMode === 'file' ? (
              <>
                <Pressable style={styles.openButton} onPress={() => void pickRecordingFile()}>
                  <Text style={styles.openButtonText}>파일 선택</Text>
                </Pressable>
                <Text style={styles.helper}>{uploadName ? `선택: ${uploadName}` : '선택된 파일 없음'}</Text>
              </>
            ) : (
              <TextInput
                value={uploadVideoLink}
                onChangeText={setUploadVideoLink}
                style={styles.renameInput}
                placeholder="https://..."
                placeholderTextColor="#94A3B8"
                autoCapitalize="none"
                autoCorrect={false}
              />
            )}

            <TextInput
              value={uploadName}
              onChangeText={setUploadName}
              style={styles.renameInput}
              placeholder="저장 파일명(확장자 제외 가능)"
              placeholderTextColor="#94A3B8"
              autoCapitalize="none"
              autoCorrect={false}
            />

            <Text style={styles.modalLabel}>저장 폴더</Text>
            <View style={styles.folderPickerList}>
              {subjects.map((subject) => (
                <Pressable
                  key={`upload-${subject.id}`}
                  style={[styles.folderPickerItem, uploadTargetFolderId === subject.id && styles.folderPickerItemActive]}
                  onPress={() => setUploadTargetFolderId(subject.id)}
                >
                  <Text style={styles.folderPickerText}>
                    {subject.icon} {subject.name}
                  </Text>
                </Pressable>
              ))}
            </View>

            <View style={styles.modalActions}>
              <Pressable style={[styles.modalButton, styles.modalCancel]} onPress={() => setUploadModalVisible(false)}>
                <Text style={styles.modalButtonText}>취소</Text>
              </Pressable>
              <Pressable style={[styles.modalButton, styles.modalSave]} onPress={() => void saveUploadedRecording()}>
                <Text style={styles.modalButtonText}>저장</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
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
        style={[styles.toggleButton, mode === 'chat' && styles.toggleButtonActive]}
        onPress={() => onChange('chat')}
      >
        <Text style={styles.toggleText}>대화형 AI API</Text>
      </Pressable>
      <Pressable
        style={[styles.toggleButton, mode === 'api' && styles.toggleButtonActive]}
        onPress={() => onChange('api')}
      >
        <Text style={styles.toggleText}>API 자동</Text>
      </Pressable>
    </View>
  );
}

function getSubjectPaths(subjectId: string): SubjectPaths {
  const dir = new Directory(SUBJECTS_ROOT, subjectId);
  const recordingsDir = new Directory(dir, 'recordings');
  const transcriptsDir = new Directory(dir, 'transcripts');
  const translationsDir = new Directory(dir, 'translations');
  const summariesDir = new Directory(dir, 'summaries');
  return {
    dir,
    meta: new File(dir, 'meta.json'),
    recordingsDir,
    transcriptsDir,
    translationsDir,
    summariesDir,
    legacyRecording: new File(dir, 'recording.m4a'),
    legacyTranscript: new File(dir, 'transcript.txt'),
    legacyTranslation: new File(dir, 'translation.txt'),
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
  if (!paths.translationsDir.exists) {
    paths.translationsDir.create({ idempotent: true, intermediates: true });
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
      const isAudio = ['.m4a', '.mp3', '.wav', '.aac', '.webm', '.3gp', '.mp4', '.url'].some((ext) =>
        lowerName.endsWith(ext),
      );
      if (!isAudio) {
        continue;
      }

      const base = stripAudioExtension(entry.name);
      const transcriptFile = new File(paths.transcriptsDir, `${base}.txt`);
      const translationFile = new File(paths.translationsDir, `${base}.txt`);
      const summaryFile = new File(paths.summariesDir, `${base}.txt`);
      const updatedAt =
        Math.max(
          entry.modificationTime ?? 0,
          transcriptFile.modificationTime ?? 0,
          translationFile.modificationTime ?? 0,
          summaryFile.modificationTime ?? 0,
        ) || 0;

      items.push({
        id: entry.name,
        title: entry.name,
        recordingFile: entry,
        transcriptFile,
        translationFile,
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
        paths.legacyTranslation.modificationTime ?? 0,
        paths.legacySummary.modificationTime ?? 0,
      ) || 0;
    items.push({
      id: 'legacy-recording.m4a',
      title: 'recording.m4a',
      recordingFile: paths.legacyRecording,
      transcriptFile: paths.legacyTranscript,
      translationFile: paths.legacyTranslation,
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

function ensureTempRecordingsRoot() {
  if (!TEMP_RECORDINGS_ROOT.exists) {
    TEMP_RECORDINGS_ROOT.create({ idempotent: true, intermediates: true });
  }
}

function writeText(file: File, value: string) {
  if (file.exists) {
    file.delete();
  }
  file.create({ intermediates: true });
  file.write(value);
}

function sanitizeFileBaseName(value: string): string {
  return value.trim().replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_');
}

function normalizeFolderColor(value: string): string {
  const trimmed = value.trim();
  return /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(trimmed)
    ? trimmed
    : DEFAULT_FOLDER_COLOR;
}

function normalizeSubjectOrder(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return null;
}

function normalizeSubjectTag(value: string): SubjectTag {
  return value === 'general' || value === 'exam' ? value : 'major';
}

function removeDirectoryRecursive(directory: Directory) {
  if (!directory.exists) {
    return;
  }
  const entries = directory.list();
  for (const entry of entries) {
    if (entry instanceof Directory) {
      removeDirectoryRecursive(entry);
      continue;
    }
    if (entry instanceof File && entry.exists) {
      entry.delete();
    }
  }
  if (directory.exists) {
    directory.delete();
  }
}

function normalizeAuthUser(payload: any): AuthUserProfile | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const id = typeof payload.id === 'string' ? payload.id.trim() : '';
  const email = typeof payload.email === 'string' ? payload.email.trim() : '';
  const displayName = typeof payload.display_name === 'string' ? payload.display_name.trim() : '';
  if (!id || !email) {
    return null;
  }
  return {
    id,
    email,
    display_name: displayName || email.split('@')[0] || 'user',
  };
}

function firstQueryValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return typeof value[0] === 'string' ? value[0] : '';
  }
  return typeof value === 'string' ? value : '';
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function recordingMimeType(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.aac')) return 'audio/aac';
  if (lower.endsWith('.webm')) return 'audio/webm';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.3gp')) return 'video/3gpp';
  if (lower.endsWith('.url')) return 'text/plain';
  return 'audio/m4a';
}

async function runTasksWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
  onProgress?: (done: number, total: number) => void,
): Promise<T[]> {
  if (tasks.length === 0) {
    return [];
  }

  const workerCount = Math.max(1, Math.min(concurrency, tasks.length));
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;
  let done = 0;

  const worker = async () => {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= tasks.length) {
        return;
      }

      results[current] = await tasks[current]();
      done += 1;
      onProgress?.(done, tasks.length);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function cloudLookupKey(
  subjectId: string,
  kind: 'recording' | 'transcript' | 'translation' | 'summary',
  name: string,
): string {
  return `${subjectId}::${kind}::${name}`;
}

function toCloudFileMetaArray(rawMeta: unknown, fallbackNames: string[]): CloudFileMeta[] {
  const map = new Map<string, CloudFileMeta>();

  if (Array.isArray(rawMeta)) {
    for (const row of rawMeta) {
      if (!row || typeof row !== 'object') {
        continue;
      }
      const value = row as any;
      const name = typeof value.name === 'string' ? value.name.trim() : '';
      if (!name) {
        continue;
      }
      const md5 = typeof value.md5 === 'string' ? value.md5.trim().toLowerCase() : '';
      const sizeRaw = Number(value.size ?? 0);
      const updatedRaw = Number(value.updated_at ?? value.updatedAt ?? 0);
      map.set(name, {
        name,
        fileId: typeof value.file_id === 'string' ? value.file_id.trim() : typeof value.id === 'string' ? value.id.trim() : '',
        md5,
        size: Number.isFinite(sizeRaw) && sizeRaw > 0 ? Math.floor(sizeRaw) : 0,
        updatedAt: Number.isFinite(updatedRaw) && updatedRaw > 0 ? updatedRaw : 0,
      });
    }
  }

  for (const fallback of fallbackNames) {
    if (typeof fallback !== 'string') {
      continue;
    }
    const name = fallback.trim();
    if (!name || map.has(name)) {
      continue;
    }
    map.set(name, { name, fileId: '', md5: '', size: 0, updatedAt: 0 });
  }

  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeCloudSubjectSnapshots(raw: unknown): CloudSubjectSnapshot[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const rows: CloudSubjectSnapshot[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const value = entry as any;
    const subjectId = typeof value.subject_id === 'string' ? value.subject_id.trim() : '';
    if (!subjectId) {
      continue;
    }
    const subjectName = typeof value.subject_name === 'string' && value.subject_name.trim() ? value.subject_name.trim() : subjectId;
    const subjectTag = typeof value.subject_tag === 'string' ? value.subject_tag : '';
    const subjectIcon = typeof value.subject_icon === 'string' ? value.subject_icon : '';
    const subjectColor = typeof value.subject_color === 'string' ? value.subject_color : '';
    const subjectOrder = normalizeSubjectOrder(value.subject_order);

    const recordings = Array.isArray(value.recordings)
      ? value.recordings.filter((item: unknown): item is string => typeof item === 'string')
      : [];
    const transcripts = Array.isArray(value.transcripts)
      ? value.transcripts.filter((item: unknown): item is string => typeof item === 'string')
      : [];
    const translations = Array.isArray(value.translations)
      ? value.translations.filter((item: unknown): item is string => typeof item === 'string')
      : [];
    const summaries = Array.isArray(value.summaries)
      ? value.summaries.filter((item: unknown): item is string => typeof item === 'string')
      : [];

    rows.push({
      subjectId,
      subjectName,
      subjectTag,
      subjectIcon,
      subjectColor,
      subjectOrder,
      recordings: toCloudFileMetaArray(value.recordings_meta, recordings),
      transcripts: toCloudFileMetaArray(value.transcripts_meta, transcripts),
      translations: toCloudFileMetaArray(value.translations_meta, translations),
      summaries: toCloudFileMetaArray(value.summaries_meta, summaries),
    });
  }

  return rows;
}

function buildCloudMetaLookup(subjects: CloudSubjectSnapshot[]): Record<string, CloudFileMeta> {
  const lookup: Record<string, CloudFileMeta> = {};
  for (const subject of subjects) {
    for (const file of subject.recordings) {
      lookup[cloudLookupKey(subject.subjectId, 'recording', file.name)] = file;
    }
    for (const file of subject.transcripts) {
      lookup[cloudLookupKey(subject.subjectId, 'transcript', file.name)] = file;
    }
    for (const file of subject.translations) {
      lookup[cloudLookupKey(subject.subjectId, 'translation', file.name)] = file;
    }
    for (const file of subject.summaries) {
      lookup[cloudLookupKey(subject.subjectId, 'summary', file.name)] = file;
    }
  }
  return lookup;
}

async function loadLocalMd5Cache(): Promise<LocalMd5Cache> {
  if (!CLOUD_MD5_CACHE_FILE.exists) {
    return {};
  }
  try {
    const raw = await CLOUD_MD5_CACHE_FILE.text();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }
    const safe: LocalMd5Cache = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object') {
        continue;
      }
      const row = value as any;
      const md5 = typeof row.md5 === 'string' ? row.md5.trim().toLowerCase() : '';
      const size = Number(row.size ?? 0);
      const mtime = Number(row.mtime ?? 0);
      if (!md5 || !Number.isFinite(size) || !Number.isFinite(mtime)) {
        continue;
      }
      safe[key] = { md5, size: Math.floor(size), mtime };
    }
    return safe;
  } catch {
    return {};
  }
}

async function saveLocalMd5Cache(cache: LocalMd5Cache): Promise<void> {
  try {
    const entries = Object.entries(cache);
    const compact = entries.slice(Math.max(0, entries.length - 6000));
    const payload = Object.fromEntries(compact);
    writeText(CLOUD_MD5_CACHE_FILE, JSON.stringify(payload));
  } catch {
    // Hash cache write failure should not fail upload/restore.
  }
}

function getLocalFileSignature(file: File): { size: number; mtime: number } {
  try {
    const info = file.info();
    const sizeRaw = Number(info.size ?? file.size ?? 0);
    const mtimeRaw = Number(info.modificationTime ?? file.modificationTime ?? 0);
    return {
      size: Number.isFinite(sizeRaw) && sizeRaw > 0 ? Math.floor(sizeRaw) : 0,
      mtime: Number.isFinite(mtimeRaw) && mtimeRaw > 0 ? mtimeRaw : 0,
    };
  } catch {
    const sizeRaw = Number(file.size ?? 0);
    const mtimeRaw = Number(file.modificationTime ?? 0);
    return {
      size: Number.isFinite(sizeRaw) && sizeRaw > 0 ? Math.floor(sizeRaw) : 0,
      mtime: Number.isFinite(mtimeRaw) && mtimeRaw > 0 ? mtimeRaw : 0,
    };
  }
}

function getFileMd5Cached(file: File, cache: LocalMd5Cache): string {
  if (!file.exists) {
    return '';
  }
  const key = file.uri;
  const signature = getLocalFileSignature(file);
  const cached = cache[key];
  if (cached && cached.size === signature.size && cached.mtime === signature.mtime && cached.md5) {
    return cached.md5;
  }
  try {
    const md5Info = file.info({ md5: true });
    const md5 = typeof md5Info.md5 === 'string' ? md5Info.md5.trim().toLowerCase() : '';
    if (md5) {
      cache[key] = { size: signature.size, mtime: signature.mtime, md5 };
    }
    return md5;
  } catch {
    return '';
  }
}

function updateFileMd5Cache(file: File, md5: string, cache: LocalMd5Cache) {
  const normalized = (md5 || '').trim().toLowerCase();
  if (!normalized) {
    return;
  }
  const signature = getLocalFileSignature(file);
  cache[file.uri] = { size: signature.size, mtime: signature.mtime, md5: normalized };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadToFileWithAuth(url: string, destination: File, headers: Record<string, string>): Promise<void> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const payload = await readJsonSafely(response);
    throw new Error(getApiErrorMessage(payload, response, '파일 다운로드 실패', url));
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (destination.exists) {
    destination.delete();
  }
  destination.create({ intermediates: true, overwrite: true });
  destination.write(bytes);
}

async function readJsonSafely(response: Response): Promise<any> {
  const raw = await response.text();
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function normalizeApiBaseUrl(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }

  let normalized = trimmed.replace(/\/+$/, '');
  normalized = normalized.replace(/\/health$/i, '');
  normalized = normalized.replace(/\/api$/i, '');
  normalized = normalized.replace(/\/+$/, '');
  return normalized || fallback;
}

function compactRequestUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  try {
    const parsed = new URL(trimmed);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return trimmed;
  }
}

function toDriveWebUrl(value: string): string {
  const raw = value.trim();
  if (!raw) {
    return '';
  }
  const marker = 'drive://folder/';
  if (raw.startsWith(marker)) {
    const folderId = raw.slice(marker.length).trim();
    if (folderId) {
      return `https://drive.google.com/drive/folders/${folderId}`;
    }
  }
  return '';
}

function getApiErrorMessage(payload: any, response: Response, fallback: string, requestUrl?: string): string {
  const target = compactRequestUrl(requestUrl || response.url || '');
  const withTarget = (message: string) => (target ? `${message} (${response.status} @ ${target})` : `${message} (${response.status})`);

  if (typeof payload?.detail === 'string' && payload.detail.trim()) {
    return withTarget(payload.detail.trim());
  }
  if (typeof payload?.error === 'string' && payload.error.trim()) {
    return withTarget(payload.error.trim());
  }
  if (typeof payload?.raw === 'string' && payload.raw.trim()) {
    return withTarget(payload.raw.trim());
  }
  return withTarget(fallback);
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

function toTenLinePreview(value: string, fallback: string): string {
  if (!value.trim()) {
    return fallback;
  }
  const lines = value.split(/\r?\n/);
  if (lines.length <= 10) {
    return lines.join('\n');
  }
  return `${lines.slice(0, 10).join('\n')}\n...`;
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
  globalStatusCard: {
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderWidth: 1,
    borderColor: 'rgba(37,99,235,0.2)',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  sectionTitle: {
    color: '#1D4ED8',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 10,
  },
  sectionTitleInline: {
    flex: 1,
    color: '#1D4ED8',
    fontSize: 15,
    fontWeight: '700',
    marginLeft: 8,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
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
  cloudSyncRow: {
    marginTop: 10,
    flexDirection: 'row',
    gap: 8,
  },
  authRow: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  authText: {
    flex: 1,
    color: '#334155',
    fontSize: 12,
    fontWeight: '600',
  },
  authButton: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#93C5FD',
    backgroundColor: '#EEF6FF',
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  authButtonText: {
    color: '#1E3A8A',
    fontSize: 12,
    fontWeight: '800',
  },
  cloudSyncButton: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#93C5FD',
    backgroundColor: '#EEF6FF',
    paddingVertical: 10,
    alignItems: 'center',
  },
  cloudSyncButtonText: {
    color: '#1E3A8A',
    fontSize: 12,
    fontWeight: '800',
  },
  cloudSyncContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cloudSyncSpinner: {
    marginLeft: 8,
  },
  cloudArchiveButton: {
    marginTop: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#FCA5A5',
    backgroundColor: '#FFF1F2',
    paddingVertical: 10,
    alignItems: 'center',
  },
  cloudArchiveButtonText: {
    color: '#9F1239',
    fontSize: 12,
    fontWeight: '800',
  },
  cloudLocationRow: {
    marginTop: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#BFDBFE',
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 6,
  },
  cloudLocationText: {
    color: '#1E3A8A',
    fontSize: 12,
  },
  cloudLocationButton: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#93C5FD',
    backgroundColor: '#DBEAFE',
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  cloudLocationButtonText: {
    color: '#1E3A8A',
    fontSize: 12,
    fontWeight: '800',
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
  subjectOpenArea: {
    borderRadius: 10,
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
  subjectHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  folderIconBubble: {
    width: 30,
    height: 30,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  folderIconText: {
    fontSize: 16,
  },
  subjectMeta: {
    color: '#475569',
    marginTop: 3,
    fontSize: 12,
  },
  previewFileList: {
    marginTop: 6,
    gap: 2,
  },
  previewFileItem: {
    color: '#475569',
    fontSize: 12,
  },
  subjectActionRow: {
    marginTop: 9,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  subjectActionButton: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#93C5FD',
    backgroundColor: '#EEF6FF',
    paddingHorizontal: 11,
    paddingVertical: 5,
  },
  subjectActionText: {
    color: '#1E3A8A',
    fontSize: 12,
    fontWeight: '800',
  },
  subjectDeleteAction: {
    borderColor: '#FECACA',
    backgroundColor: '#FEE2E2',
  },
  subjectDeleteActionText: {
    color: '#B91C1C',
    fontSize: 12,
    fontWeight: '800',
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
  recordTimer: {
    fontSize: 40,
    fontWeight: '800',
    color: '#0F172A',
    letterSpacing: 1.2,
    textAlign: 'center',
    marginTop: 10,
  },
  renameButton: {
    marginTop: 10,
    alignSelf: 'flex-start',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#93C5FD',
    backgroundColor: '#EEF6FF',
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  renameButtonText: {
    color: '#1E3A8A',
    fontSize: 12,
    fontWeight: '800',
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
    gap: 8,
  },
  recordingMainArea: {
    gap: 2,
  },
  recordingActionRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  recordingMoveButton: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#93C5FD',
    backgroundColor: '#EEF6FF',
    paddingHorizontal: 11,
    paddingVertical: 5,
  },
  recordingMoveButtonText: {
    color: '#1E3A8A',
    fontSize: 12,
    fontWeight: '800',
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
  previewRow: {
    marginTop: 10,
    marginBottom: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  editChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#93C5FD',
    backgroundColor: '#EEF6FF',
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  editChipText: {
    color: '#1E3A8A',
    fontSize: 12,
    fontWeight: '700',
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
  pendingInfo: {
    color: '#334155',
    marginTop: 6,
    fontSize: 12,
  },
  loader: {
    marginTop: 10,
  },
  deleteButton: {
    marginTop: 12,
    backgroundColor: '#DC2626',
    borderRadius: 12,
    paddingVertical: 11,
    alignItems: 'center',
  },
  deleteButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  modalCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#BFDBFE',
    padding: 14,
  },
  editorModalCard: {
    maxHeight: '86%',
  },
  modalTitle: {
    color: '#0F172A',
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 10,
  },
  editorHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  editorHeaderButton: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#93C5FD',
    backgroundColor: '#EEF6FF',
    paddingHorizontal: 12,
    paddingVertical: 5,
    marginBottom: 10,
  },
  editorHeaderButtonText: {
    color: '#1E3A8A',
    fontSize: 12,
    fontWeight: '700',
  },
  modalLabel: {
    marginTop: 8,
    marginBottom: 6,
    color: '#334155',
    fontSize: 12,
    fontWeight: '700',
  },
  socialAuthRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 6,
  },
  socialAuthButton: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 10,
    borderWidth: 1,
    alignItems: 'center',
  },
  socialAuthButtonText: {
    fontSize: 12,
    fontWeight: '800',
  },
  socialKakao: {
    backgroundColor: '#FEE500',
    borderColor: '#E2C900',
  },
  socialGoogle: {
    backgroundColor: '#FFFFFF',
    borderColor: '#CBD5E1',
  },
  socialNaver: {
    backgroundColor: '#03C75A',
    borderColor: '#02A24A',
  },
  socialKakaoText: {
    color: '#3C1E1E',
  },
  socialGoogleText: {
    color: '#1F2937',
  },
  socialNaverText: {
    color: '#FFFFFF',
  },
  optionWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 6,
  },
  optionChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: '#F8FAFC',
  },
  optionChipActive: {
    borderColor: '#2563EB',
    backgroundColor: '#DBEAFE',
  },
  optionChipText: {
    fontSize: 16,
  },
  colorChip: {
    width: 26,
    height: 26,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#CBD5E1',
  },
  colorChipActive: {
    borderWidth: 3,
    borderColor: '#1D4ED8',
  },
  folderPickerList: {
    maxHeight: 160,
    gap: 6,
  },
  folderPickerItem: {
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: '#F8FAFC',
  },
  folderPickerItemActive: {
    borderColor: '#2563EB',
    backgroundColor: '#DBEAFE',
  },
  folderPickerText: {
    color: '#0F172A',
    fontSize: 13,
    fontWeight: '600',
  },
  modalInput: {
    height: 320,
    maxHeight: 420,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    color: '#0F172A',
    backgroundColor: '#F8FAFC',
    paddingHorizontal: 10,
    paddingVertical: 9,
    textAlignVertical: 'top',
  },
  viewerScroll: {
    maxHeight: 420,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    backgroundColor: '#F8FAFC',
  },
  viewerContent: {
    paddingHorizontal: 10,
    paddingVertical: 10,
  },
  viewerText: {
    color: '#0F172A',
    fontSize: 13,
    lineHeight: 21,
  },
  renameInput: {
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    color: '#0F172A',
    backgroundColor: '#F8FAFC',
    paddingHorizontal: 10,
    paddingVertical: 10,
    marginBottom: 4,
  },
  modalActions: {
    marginTop: 12,
    flexDirection: 'row',
    gap: 8,
  },
  modalButton: {
    flex: 1,
    borderRadius: 12,
    alignItems: 'center',
    paddingVertical: 10,
  },
  modalCancel: {
    backgroundColor: '#94A3B8',
  },
  modalSave: {
    backgroundColor: '#2563EB',
  },
  modalButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
  },
  fabContainer: {
    position: 'absolute',
    right: 20,
    bottom: 26,
    alignItems: 'flex-end',
  },
  fabMenu: {
    marginBottom: 10,
    gap: 8,
    alignItems: 'flex-end',
  },
  fabMenuItem: {
    backgroundColor: '#0F172A',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  fabMenuText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  fabButton: {
    width: 58,
    height: 58,
    borderRadius: 999,
    backgroundColor: '#1D4ED8',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#0F172A',
    shadowOpacity: 0.22,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 7,
  },
  fabButtonText: {
    color: '#FFFFFF',
    fontSize: 32,
    lineHeight: 34,
    fontWeight: '500',
  },
});

