import type { JSX as SolidJSX } from "@solidjs/web";
import type { SessionsDiffResult } from "../../../../../packages/gateway-protocol/src/index.js";
import type { ChatMessageGetResult } from "../../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { SessionFileDownload } from "../../../api/session-file-download.ts";
import type { SessionWorkspaceListResult } from "../../../api/types.ts";
import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import type { MarkdownFileLinkTarget } from "../../../components/markdown-file-links.ts";
import type { MarkdownGitHubContext } from "../../../components/markdown-render-options.ts";
import type { SessionLinkTarget } from "../../../components/markdown-session-links.ts";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import type { EmbedSandboxMode } from "../../../lib/chat/tool-display.ts";
import type { SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import type { ChatMediaPlaybackMode } from "./chat-media-playback.ts";
import type {
  AssistantAttachmentItem,
  ImageBlock,
  ImageRenderOptions,
  ArtifactDownloadResolver,
} from "./chat-message-media.ts";
import type { createSessionWorkspaceProps } from "./chat-session-workspace.ts";

type SessionWorkspaceView = ReturnType<typeof createSessionWorkspaceProps>;
type SessionWorkspaceOptionalKey =
  | "transcriptAttachments"
  | "presentation"
  | "folderView"
  | "navigation"
  | "mobileNavigation"
  | "onToggleMobileGroup"
  | "onMobileScroll"
  | "onSearchFocus"
  | "connected"
  | "directories"
  | "onToggleDirectory"
  | "onSearchOpenChange"
  | "onTreeVisibleChange"
  | "onSessionExpandedChange"
  | "onNavigationScroll"
  | "connectionEpoch"
  | "onDownloadFile"
  | "onOpenDiff";
export type SessionWorkspaceProps = Omit<SessionWorkspaceView, SessionWorkspaceOptionalKey> &
  Partial<Pick<SessionWorkspaceView, SessionWorkspaceOptionalKey>>;

export type SessionWorkspaceFilter = "all" | "changed" | "read" | "artifacts";

export type SessionWorkspaceTreeState = {
  expandedPaths: string[];
  searchOpen: boolean;
  sessionExpanded: boolean;
  treeVisible: boolean;
  treeScroll: number;
  sessionScroll: number;
};

/** Snapshot handed to the tabs owner; it never contains a reader or a draft. */
export type SessionWorkspaceNavigation = SessionWorkspaceTreeState & {
  browserPath: string;
  browserSearch: string;
  filter: SessionWorkspaceFilter;
};

export type SessionWorkspaceDirectory = {
  browser?: SessionWorkspaceListResult["browser"];
  loading: boolean;
  error: string | null;
};

type SessionWorkspaceMobileGroupKind = "changed" | "read" | "artifacts" | "workspace";

export type SessionWorkspaceMobileNavigation = {
  expandedGroups: Record<SessionWorkspaceMobileGroupKind, boolean>;
  scrollTop: number;
  locations: Record<string, { search: string; filter: SessionWorkspaceFilter; scrollTop: number }>;
};

export type SessionWorkspacePreview = {
  id: string;
  label: string;
  content: SidebarSelection;
  /** Only an explicit desktop preview is replaceable; retained tabs stay pinned. */
  pinned?: boolean;
  catalogNavigation?: SessionWorkspaceNavigation;
  catalogVisible?: boolean;
  readerDraft?: FileReaderDraftState;
  canonicalKey?: string;
  requestIds?: string[];
  navigation?: FileSidebarNavigation;
  navigationOrder?: number;
};

export type TranscriptAttachmentEntry = {
  key: string;
  label: string;
  mimeType?: string;
  options: ImageRenderOptions;
  onOpenSidebar: (content: SidebarContent) => void;
} & ({ kind: "image"; image: ImageBlock } | { kind: "attachment"; item: AssistantAttachmentItem });

export type TranscriptAttachments = {
  /** Producer deadlines, keyed exactly as the native bubble expiry resource. */
  pairingQrExpirations: readonly { messageKey: string; nextPairingQrExpiresAt: number }[];
  mediaOwner?: object;
  /** Reprojects the same loaded window; no history or media request. */
  refresh: () => TranscriptAttachments;
  entries: readonly TranscriptAttachmentEntry[];
  coverage: "complete" | "partial" | "unknown";
  loading: boolean;
  error?: string;
  omittedMedia: boolean;
};

export type MobileFileBack = { label: string; onBack: () => void };

export type SessionDiffScope =
  | { scope: "all" | "uncommitted" }
  | { scope: "commit"; commit: string };

export type SessionDiffLoader = (params: SessionDiffScope) => Promise<SessionsDiffResult>;

export type SessionDiffFileTextLoader = (path: string) => Promise<string | null>;

export type SessionDiffOwner = { agentId: string; sessionKey: string };

export type SessionDiffFileView = "reading" | "highlighted" | "plain" | "edit";

type SessionDiffMobilePageRequest = {
  key: "session-diff-sync";
  title: string;
  /** Invoke in the native page outlet; dispose on Back, retain only while hidden. */
  render: () => SolidJSX.Element;
};

export type SessionDiffProps = {
  onScrollPortRef?: (element: HTMLElement) => void | (() => void);
  /** Native host presentation, not the width of the panel. Unknown retains the native UI. */
  mobile?: boolean | null;
  active?: boolean;
  /** A new object requests a scope on the same native checkout, including on a retained tab. */
  scopeRequest?: { owner: SessionDiffOwner; scope: SessionDiffScope } | null;
  onResult?:
    | ((value: {
        owner: SessionDiffOwner | null;
        scope: SessionDiffScope;
        result: SessionsDiffResult;
      }) => void)
    | null;
  owner: SessionDiffOwner | null;
  execNode: string | null;
  loader: SessionDiffLoader | null;
  loadFileText: SessionDiffFileTextLoader | null;
  openFile: ((path: string) => void | Promise<SessionWorkspacePreview | undefined>) | null;
  revealFile: ((path: string) => void) | null;
  openFileView?: ((path: string, view: SessionDiffFileView) => void) | null;
  onOpenMobilePage?: ((page: SessionDiffMobilePageRequest, source: HTMLElement) => void) | null;
};

type SidebarFullMessageRequest = {
  sessionKey: string;
  agentId?: string;
  sessionId?: string;
  messageId: string;
  maxChars?: number;
};

export type SidebarFullMessageLoader = (
  request: SidebarFullMessageRequest,
) => Promise<Partial<ChatMessageGetResult> | null | undefined>;

type MarkdownSidebarContent = {
  kind: "markdown";
  file?: FilePreviewSource;
  content: string;
  rawText?: string | null;
  fileLinkSessionKey?: string;
  fileDownload?: {
    path: string;
    name: string;
    download: (signal: AbortSignal) => Promise<SessionFileDownload | null>;
  };
};

type CanvasSidebarContent = {
  kind: "canvas";
  docId: string;
  title?: string;
  entryUrl: string;
  preferredHeight?: number;
  /** Per-preview sandbox ceiling; keeps widget iframes below the global embed mode. */
  sandbox?: "strict" | "scripts";
  rawText?: string | null;
};

export type FilePreviewSource = {
  path: string;
  absolutePath?: string;
  root?: string;
  artifactId?: string;
  download: (signal: AbortSignal) => Promise<FileReaderDownload | null>;
};

type ImageSidebarContent = {
  file?: FilePreviewSource;
  kind: "image";
  title: string;
  src: string;
  mimeType?: string | null;
  rawText?: string | null;
};

type AttachmentSidebarSource = {
  src: string;
  playback?: ChatMediaPlaybackMode;
  authToken?: string | null;
  sizeBytes?: number;
  durationMs?: number;
  width?: number;
  height?: number;
};

export type AttachmentSidebarState =
  | { status: "pending" }
  | ({ status: "ready" } & AttachmentSidebarSource)
  | { status: "unavailable"; onRetry?: () => void }
  | { status: "error"; reason: string; onRetry?: () => void };

export type AttachmentSidebarRuntime = {
  sessionKey?: string;
  agentId?: string;
  policyKey?: string;
  connectionEpoch?: number;
  authToken?: string | null;
  resourceBasePath?: string;
  resolveArtifactDownload?: ArtifactDownloadResolver;
};

type AttachmentSidebarContent = Omit<AttachmentSidebarSource, "src"> & {
  kind: "attachment";
  file?: FilePreviewSource;
  attachmentKind?: "audio" | "video" | "document" | "image";
  title: string;
  /** Static sources only; expiring sources are resolved live through resolveSource. */
  src?: string;
  mimeType?: string | null;
  sourceIdentity?: string;
  voiceNote?: boolean;
  plainText?: boolean;
  renderActions?: () => SolidJSX.Element;
  /** Authorize and read fresh bytes for each explicit download. */
  download?: (signal: AbortSignal) => Promise<Blob | null>;
  resolveSource?: (
    onSourceChange: () => void,
    runtime: AttachmentSidebarRuntime,
  ) => AttachmentSidebarState;
  rawText?: string | null;
};

type SessionDiffSidebarContent = {
  kind: "session-diff";
  owner: SessionDiffOwner;
  load: SessionDiffLoader;
  /** Last accepted native Uncommitted result for this exact diff loader. */
  uncommitted?: SessionsDiffResult;
  /** Visible Environment demand shares this content's native diff loader. */
  requestUncommitted?: () => void;
  onResult?: SessionDiffProps["onResult"];
  loadFileText?: SessionDiffFileTextLoader;
  openFile?: (path: string) => void | Promise<SessionWorkspacePreview | undefined>;
  /** Native host/reader inputs, memoized by the caller for this retained content. */
  presentation?: Pick<
    SessionDiffProps,
    "mobile" | "active" | "openFileView" | "onOpenMobilePage" | "scopeRequest"
  >;
  rawText?: string | null;
};

type FileSaveOutcome =
  | { ok: true; hash: string }
  | { ok: false; code: "conflict" }
  | { ok: false; code: "error"; message: string };

type FileSidebarEdit = {
  hash: string;
  save: (params: { content: string; expectedHash: string }) => Promise<FileSaveOutcome>;
  /** `editable: false` means the latest content no longer qualifies for edit mode. */
  fetchLatest: () => Promise<{ content: string; hash: string; editable: boolean } | null>;
};

export type FileReaderView = "reading" | "highlighted" | "plain" | "edit";

/** Allocate once per explicit action, after the native open resolves its retained file. */
export type FileReaderViewRequest = {
  file: FileSidebarContent;
  view: FileReaderView;
};

export type FileSidebarNavigation =
  | { line: number; view?: FileReaderViewRequest }
  | { line?: number; view: FileReaderViewRequest };

export type SessionFileSource = { sessionKey: string; agentId?: string; path: string };

export type FileReaderDownload = SessionFileDownload | { blob: Blob; filename: string };

export type FileSidebarContent = {
  kind: "file";
  /** Empty for artifacts, which have an identity but no physical file path. */
  path: string;
  artifactId?: string;
  absolutePath?: string;
  name: string;
  content: string;
  download?: (signal: AbortSignal) => Promise<FileReaderDownload | null>;
  sessionFileSource?: SessionFileSource;
  /** Stable per-session identity used to retain an unsaved in-memory draft. */
  draftKey?: string;
  /** Captured display context; the draft key is opaque and never a UI label. */
  draftContext?: { sessionKey: string; sessionTitle: string; paneLabel?: string };
  root?: string | null;
  mimeType?: string;
  language?: string;
  line?: number | null;
  /** Explicit line/view request; ordinary tab selection retains its identity. */
  navigation?: FileSidebarNavigation;
  rawText?: string | null;
  edit?: FileSidebarEdit;
};

export type ToolOutputSidebarContent = {
  kind: "tool-output";
  card: ToolCard;
  sessionKey?: string;
  agentId?: string;
};

type McpAppSidebarContent = {
  kind: "mcp-app";
  title: string;
  launch: import("../../../components/mcp-app-launch.ts").McpAppOpenDetail;
  rawText?: null;
};

export type SidebarContent =
  | McpAppSidebarContent
  | ToolOutputSidebarContent
  | MarkdownSidebarContent
  | CanvasSidebarContent
  | ImageSidebarContent
  | AttachmentSidebarContent
  | FileSidebarContent
  | SessionDiffSidebarContent;

export type ChatDetailPanelContent = Exclude<SidebarContent, { kind: "tool-output" }>;

export type SidebarSelection = (
  | SidebarContent
  | { kind: "loading" }
  // Keep failed opens attached to their selected surface instead of falling back
  // to unrelated content.
  | { kind: "unavailable"; message: string }
) & {
  fileTab?: { id: string; label: string; disposition?: "pinned" | "preview"; intent?: "navigate" };
};

export type ChatDetailPanelProps = {
  onScrollPortRef?: (element: HTMLElement) => void | (() => void);
  panelPresentation?: "desktop" | "mobile";
  panelActive?: boolean;
  /** Supplied by the native shell; a narrow desktop panel is still desktop. */
  filePresentation?: "desktop" | "mobile";
  fileBack?: MobileFileBack | null;
  filePresented?: boolean;
  fileWorkspace?: FileReaderWorkspace | null;
  onFileInteraction?:
    | ((
        file: FileSidebarContent | ImageSidebarContent | AttachmentSidebarContent,
        interaction: FileReaderInteraction,
      ) => void)
    | null;
  onFileDraftChange?: ((draft: FileReaderDraftState | null) => void) | null;
  content: ChatDetailPanelContent | null;
  fileNavigation: FileSidebarNavigation | null;
  execNode: string | null;
  attachmentRuntime: AttachmentSidebarRuntime;
  basePath: string;
  canvasPluginSurfaceUrl: string | null;
  embedSandboxMode: EmbedSandboxMode;
  allowExternalEmbedUrls: boolean;
  githubContext: MarkdownGitHubContext;
  embedded: boolean;
  onOpenWorkspaceFile: ((target: MarkdownFileLinkTarget) => void) | null;
  onOpenSessionLink: ((target: SessionLinkTarget) => void) | null;
  onRevealInWorkspace: ((path: string) => void) | null;
  onOpenImage: ((item: ImageLightboxItem) => void) | null;
};

/** Navigation facts/operations supplied by the workspace/tab owner, never a reader-local stack. */
export type FileReaderWorkspace = {
  path: string;
  rootLabel: string;
  sourceLabel?: string;
  catalog: SessionWorkspaceProps;
  /** The tab owner switches the content mode of this same document tab. */
  showingFolder: boolean;
  onBrowsePath: (path: string) => void;
};

export type FileReaderInteraction = "selection" | "copy" | "link" | "edit";

/** Live reader facts and operations; the tabs owner decides whether to close. */
export type FileReaderDraftState = {
  file: FileSidebarContent;
  editing: boolean;
  dirty: boolean;
  saving: boolean;
  /** False on failure, concurrent edits, pending save, or retired selection. */
  save: () => Promise<boolean>;
  /** False while saving or after this selection has been retired. */
  discard: () => boolean;
};

export type ChatDetailPanel = SolidBridgeElement<ChatDetailPanelProps>;

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-detail-panel": ChatDetailPanel;
  }
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-chat-detail-panel": HTMLAttributes<
        HTMLElementTagNameMap["openclaw-chat-detail-panel"]
      > & {
        [Key in keyof ChatDetailPanelProps as `prop:${Key}`]?: ChatDetailPanelProps[Key];
      };
    }
  }
}
