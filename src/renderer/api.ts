export interface EnvItem { id: string; label: string; light: 'green' | 'yellow' | 'red'; detail: string; help?: string }
export interface SavePoint { sha: string; message: string; date: string }
export interface ProjectStatus { path: string; name: string; isRepo: boolean; savePoints: SavePoint[]; tasks: { id: string; request: string; state: string }[] }

interface StudioApi {
  detectEnvironment(): Promise<EnvItem[]>;
  chooseProject(): Promise<ProjectStatus | null>;
  projectStatus(): Promise<ProjectStatus>;
  initProject(consent: boolean): Promise<ProjectStatus>;
}

declare global {
  interface Window { studio?: StudioApi }
}

export const studio = (): StudioApi => {
  if (!window.studio) throw new Error('请在 AI Solo Studio 桌面应用中打开此界面。');
  return window.studio;
};
