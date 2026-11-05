// A UUID is the only submission data stored in the tab. Never store environment
// values or repository credentials in browser storage.
const inMemory = new Map<string, string>();
export function getDeploymentSubmissionId(scope: string) {
  const key = `deployment-submission:${scope}`;
  let id = inMemory.get(key);
  try {
    id ??= window.sessionStorage.getItem(key) ?? undefined;
  } catch {
    /* Keep tab-memory retries when storage is unavailable. */
  }
  id ??= crypto.randomUUID();
  inMemory.set(key, id);
  try {
    window.sessionStorage.setItem(key, id);
  } catch {
    /* The in-memory identity still covers this page. */
  }
  return id;
}

export function clearDeploymentSubmissionId(scope: string) {
  const key = `deployment-submission:${scope}`;
  inMemory.delete(key);
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    /* Storage may be disabled by the browser. */
  }
}
