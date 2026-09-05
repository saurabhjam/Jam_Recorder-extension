/**
 * Which projects the signed-in user may write to.
 *
 * Every project-scoped API path (`/v1/{projectName}/...`) needs one of these,
 * and a user can belong to several — so anything that writes has to let the
 * user say which, rather than guessing. Hardcoding a project name is what the
 * recordings API still does (`superadmin_personal`), and it is wrong for
 * anybody whose work lives somewhere else.
 *
 * The list is read from the stored user first. Falling back to the API matters
 * for accounts that signed in before `assignedProjects` was captured at login:
 * their stored user has no projects, and without the refetch they would see an
 * empty picker and be unable to start anything.
 */

import { STORAGE_KEYS } from '@/types';
import type { AssignedProject, AuthTokens, User } from '@/types';
import { MONITORING_STORAGE_KEYS } from '@/types/monitoring';
import { API_BASE_URL } from '@/config';

export interface ProjectOption {
  /** The project *name* — this is what goes in the URL path, not `projectId`. */
  name: string;
  projectId: number;
  projectRole: string;
  entryType: 'INTERNAL' | 'PERSONAL';
}

function toOptions(projects: Record<string, AssignedProject> | undefined): ProjectOption[] {
  if (!projects) return [];
  return (
    Object.entries(projects)
      .map(([name, details]) => ({
        name,
        projectId: details.projectId,
        projectRole: details.projectRole,
        entryType: details.entryType,
      }))
      // Stable, predictable order — the picker must not reshuffle between opens.
      .sort((a, b) => a.name.localeCompare(b.name))
  );
}

/**
 * Fetch the user record straight from the API.
 *
 * `?ids=` is what the portal itself sends; the endpoint answers with the
 * caller's own record. Some deployments wrap it in an array, so both shapes are
 * accepted rather than assuming one.
 */
async function fetchAssignedProjectsFromApi(): Promise<Record<string, AssignedProject> | null> {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.AUTH_TOKENS]);
  const token = (stored[STORAGE_KEYS.AUTH_TOKENS] as AuthTokens | undefined)?.accessToken;
  if (!token) return null;

  try {
    const res = await fetch(`${API_BASE_URL}/users?ids=`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const raw = (await res.json()) as
      | { assignedProjects?: Record<string, AssignedProject> }
      | Array<{ assignedProjects?: Record<string, AssignedProject> }>;
    const projects = Array.isArray(raw) ? raw[0]?.assignedProjects : raw?.assignedProjects;
    return projects ?? null;
  } catch {
    return null;
  }
}

/**
 * The user's projects, newest knowledge first.
 *
 * A successful refetch is written back onto the stored user so the next call —
 * and every other part of the extension that reads `AUTH_USER` — sees it too.
 */
export async function getAssignedProjects(): Promise<ProjectOption[]> {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.AUTH_USER]);
  const user = stored[STORAGE_KEYS.AUTH_USER] as User | undefined;

  const fromStorage = toOptions(user?.assignedProjects);
  if (fromStorage.length > 0) return fromStorage;

  const fetched = await fetchAssignedProjectsFromApi();
  if (!fetched) return [];

  if (user) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.AUTH_USER]: { ...user, assignedProjects: fetched },
    });
  }
  return toOptions(fetched);
}

/**
 * The project last chosen for monitoring, if it is still one they belong to.
 *
 * Monitoring's own key, deliberately not the shared `st_auth_project`: the
 * recording upload path writes a hardcoded `superadmin_personal` fallback into
 * that one, which would then show up as the monitoring project.
 */
export async function getSelectedProject(): Promise<string | null> {
  const stored = await chrome.storage.local.get([MONITORING_STORAGE_KEYS.PROJECT]);
  return (stored[MONITORING_STORAGE_KEYS.PROJECT] as string | undefined) ?? null;
}

/** Remember the chosen project for monitoring. */
export async function setSelectedProject(name: string): Promise<void> {
  await chrome.storage.local.set({ [MONITORING_STORAGE_KEYS.PROJECT]: name });
}

/**
 * Resolve a sensible default: the remembered project when it is still valid,
 * otherwise the first one the user belongs to.
 *
 * A remembered project the user has since been removed from must not be
 * offered — the API would refuse it with MONITORING_PROJECT_ACCESS_DENIED, and
 * the user would have no idea why.
 */
export async function resolveDefaultProject(options: ProjectOption[]): Promise<string | null> {
  if (options.length === 0) return null;
  const remembered = await getSelectedProject();
  if (remembered && options.some((option) => option.name === remembered)) return remembered;
  return options[0].name;
}
