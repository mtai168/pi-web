export function copyText(text: string): Promise<void> {
  let ta: HTMLTextAreaElement | null = null;
  let appended = false;
  try {
    if (typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function") {
      return navigator.clipboard.writeText(text);
    }
    ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    appended = true;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    // Older WebViews return undefined even on success; only an explicit
    // false means the copy did not occur.
    if (ok === false) return Promise.reject(new Error("document.execCommand('copy') returned false"));
    return Promise.resolve();
  } catch (error) {
    return Promise.reject(error);
  } finally {
    if (appended && ta !== null) {
      try {
        document.body.removeChild(ta);
      } catch {
        // Cleanup must not mask the copy outcome.
      }
    }
  }
}
