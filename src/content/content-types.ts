export interface BlogPostDocument {
  id: string;
  title: string;
  cover?: string[];
  tags: string[];
  players?: string[];
  renderMode: "markdown" | "wiki";
  wikiEntryId?: string;
  createdAt: string;
  updatedAt: string;
  markdown: string;
}

export interface BlogPostSummary extends Omit<BlogPostDocument, "markdown"> {
  file: string;
}

export interface WikiBlockDocument {
  type: string;
  [key: string]: unknown;
}

export interface WikiEntryDocument {
  id: string;
  category: string;
  displayName: string;
  summary: string;
  avatar?: string;
  aliasNames?: string[];
  playerIds?: string[];
  moduleIds?: string[];
  relatedEntryIds?: string[];
  relatedEntryAccess?: Array<{ entryId: string; playerIds: string[] }>;
  facts?: Array<{ label: string; value: string }>;
  tags?: string[];
  content: WikiBlockDocument[];
  createdAt: string;
  updatedAt: string;
}

export interface ContentStoreOptions {
  contentRootDir: string;
  uploadRootDir: string;
  publicUploadBaseUrl: string;
  maxUploadBytes: number;
  maxImportBytes: number;
}

export interface ImageUploadInput {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface ImageUploadResult {
  url: string;
  absolutePath: string;
  size: number;
  mimeType: string;
}

export interface ImportResult {
  blogPosts: number;
  wikiEntries: number;
  uploadedFiles: number;
  backupFile: string;
}

export interface ContentOverview {
  blogs: BlogPostSummary[];
  wikiEntries: Array<Record<string, unknown>>;
  players: Array<Record<string, unknown>>;
  modules: Array<Record<string, unknown>>;
}
