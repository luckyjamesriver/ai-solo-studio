export type LayerState = 'pass' | 'fail' | 'unknown' | 'na';
export interface Layer { state: LayerState; note?: string }
export type LayerKey = 'installed' | 'starts' | 'compatible' | 'loggedIn' | 'secured';
export interface HealthItem {
  id: 'git' | 'node' | 'npm' | 'codex';
  label: string;
  layers: Record<LayerKey, Layer>;
  overall: 'pass' | 'fail' | 'unknown';
  foundVia: 'path' | 'fallback' | null;
  location?: string;
  version?: string;
  advice?: string;
  help?: string;
}
export interface HealthReport {
  items: HealthItem[];
  limitations: string[];
  pathInfo: { processPath: string; supplementalDirs: string[] };
  project: { name: string } | null;
}
export interface SavePoint { sha: string; message: string; date: string }
export interface ProjectStatus { path: string; name: string; isRepo: boolean; uncommitted: number; savePoints: SavePoint[]; tasks: { id: string; request: string; state: string }[] }
export type OpenResult =
  | { kind: 'opened'; status: ProjectStatus }
  | { kind: 'needs_init'; name: string; path: string }
  | { kind: 'rejected'; reason: string }
  | { kind: 'cancelled' }
  | { kind: 'declined' };
export interface RecentProject { id: string; name: string; path: string; lastOpened: string; exists: boolean }
export interface DisclosureState {
  content: { version: number; services: { name: string; role: string }[]; when: string[]; never: string[] };
  accepted: { acceptedAt: string; services: string[] } | null;
}

interface StudioApi {
  detectEnvironment(): Promise<HealthReport>;
  chooseProject(): Promise<OpenResult>;
  recentProjects(): Promise<RecentProject[]>;
  openRecent(id: string): Promise<OpenResult>;
  projectStatus(): Promise<ProjectStatus>;
  initProject(consent: boolean): Promise<OpenResult>;
  getDisclosure(): Promise<DisclosureState>;
  acceptDisclosure(): Promise<DisclosureState>;
}

declare global {
  interface Window { studio?: StudioApi }
}

export const studio = (): StudioApi => {
  if (!window.studio) throw new Error('请在 AI Solo Studio 桌面应用中打开此界面。');
  return window.studio;
};
