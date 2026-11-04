// This controller retains presence only. A credential travels directly from the
// password input to the local request body, never through workspace state.
export function createCredentials(
  doc,
  request,
  { onChange = () => {}, onBusy = () => {} } = {},
) {
  const $ = (id) => doc.getElementById(id);
  const win = doc.defaultView;
  const dialog = $("meta-credentials-dialog");
  const input = $("meta-api-key");
  const form = $("meta-credentials-form");
  const openButton = $("meta-credentials-open");
  const skipButton = $("meta-credentials-skip");
  const saveButton = $("meta-credentials-save");
  const clearButton = $("meta-credentials-clear");
  const status = $("meta-credentials-status");
  const summary = $("meta-credentials-summary");
  let configured = false,
    busy = false,
    destroyed = false,
    epoch = 0;
  let activeRequest = null;
  let opener = null;

  function controls() {
    input.disabled = busy;
    saveButton.disabled = busy;
    clearButton.disabled = busy;
    form.setAttribute("aria-busy", String(busy));
    onBusy(busy);
  }
  function reflect(presence) {
    configured = presence.configured;
    summary.textContent = configured
      ? "Meta key configured · connection unverified"
      : "Offline · Meta key not configured";
    openButton.textContent = configured ? "Manage Meta key" : "Set up Meta key";
    skipButton.textContent = configured ? "Done" : "Continue offline";
    status.textContent = configured
      ? presence.source === "environment"
        ? "A server environment key is configured. Connection unverified; no Meta request was made."
        : "Key configured in local server memory. Connection unverified; no Meta request was made."
      : "No Meta key is configured. Local comparison, saved reports and playback remain available.";
  }
  function close({ restoreFocus = true } = {}) {
    input.value = "";
    if (dialog.open && typeof dialog.close === "function") dialog.close();
    dialog.removeAttribute("open");
    dialog.hidden = true;
    if (restoreFocus && opener?.isConnected && !destroyed) opener.focus();
    opener = null;
  }
  function open() {
    if (destroyed) return;
    input.value = "";
    opener = doc.activeElement;
    dialog.hidden = false;
    try {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    } catch {
      // Nonmodal fallback keeps every action keyboard reachable, including skip.
      dialog.setAttribute("open", "");
    }
    (busy ? skipButton : input).focus();
  }
  async function presence(response) {
    // Never parse or display a failed response, which could reflect a secret.
    if (!response.ok) throw new Error("credential request failed");
    const data = await response.json();
    if (
      typeof data?.configured !== "boolean" ||
      !["browser", "environment", "none"].includes(data.source) ||
      data.configured === (data.source === "none")
    )
      throw new Error("invalid credential presence");
    return { configured: data.configured, source: data.source };
  }
  function mutationFailure(statusCode) {
    // Status only: failed bodies and exception messages may reflect credentials.
    switch (statusCode) {
      case 422:
        return "The local server rejected the key format. Paste the key again using 1–4096 visible ASCII characters with no spaces. No connection test was made.";
      case 409:
        return "An active job must finish before changing the local Meta key. Try again after it finishes; no connection test was made.";
      case 403:
        return "The local server rejected this page's request. Reload the app from the local server address and try again; no connection test was made.";
      default:
        return "Could not change the local Meta key. Check the local server and try again; no connection test was made.";
    }
  }
  async function mutate(event) {
    event.preventDefault();
    if (destroyed || busy) {
      input.value = "";
      return;
    }
    const remove = event.currentTarget === clearButton;
    if (!remove) {
      // Only surrounding paste whitespace is removed; interior characters stay
      // intact and must meet the same visible-ASCII bound as the local server.
      input.value = input.value.trim();
      let validationMessage = "";
      if (!input.value)
        validationMessage = "Enter a Meta API key, or continue offline.";
      else if (input.value.length > 4096)
        validationMessage =
          "The key is too long. Paste a key with at most 4096 characters.";
      else if (/\s/.test(input.value))
        validationMessage =
          "The key contains spaces or other whitespace inside it. Paste the key again without interior whitespace.";
      else if (/[^\x21-\x7e]/.test(input.value))
        validationMessage =
          "The key must use visible ASCII characters only. Paste the original key again without hidden or non-ASCII characters.";
      if (validationMessage) {
        input.value = "";
        status.textContent = validationMessage;
        input.focus();
        return;
      }
    }
    const token = ++epoch;
    busy = true;
    status.textContent = remove
      ? "Clearing the local server key…"
      : "Saving to local server memory…";
    try {
      let pending;
      try {
        controls();
        activeRequest = new win.AbortController();
        // Do not cache this payload or retain the input in any closure/state.
        pending = request("/api/credentials/meta", {
          method: remove ? "DELETE" : "PUT",
          headers: {
            "Content-Type": "application/json",
            "x-signaltrace-request": "1",
          },
          ...(remove ? {} : { body: JSON.stringify({ api_key: input.value }) }),
          cache: "no-store",
          credentials: "same-origin",
          redirect: "error",
          signal: activeRequest.signal,
        });
      } finally {
        input.value = "";
      }
      const response = await pending;
      if (!response.ok) {
        if (!destroyed && token === epoch)
          status.textContent = mutationFailure(response.status);
        return;
      }
      const result = await presence(response);
      if (destroyed || token !== epoch) return;
      reflect(result);
      // Presence only; the callback refreshes local configuration, never models.
      await onChange(result);
    } catch {
      if (!destroyed && token === epoch) status.textContent = mutationFailure();
    } finally {
      if (destroyed || token === epoch) input.value = "";
      if (!destroyed && token === epoch) {
        busy = false;
        activeRequest = null;
        controls();
      }
    }
  }
  function cancel(event) {
    event?.preventDefault();
    close();
  }
  function closed() {
    input.value = "";
  }
  function fallbackEscape(event) {
    if (event.key === "Escape" && dialog.open) cancel(event);
  }
  function pagehide(event) {
    if (!event.persisted) {
      destroy();
      return;
    }
    // A back/forward-cache snapshot must not retain a filled password or request.
    epoch++;
    activeRequest?.abort();
    activeRequest = null;
    busy = false;
    close({ restoreFocus: false });
    controls();
  }
  function pageshow(event) {
    if (event.persisted && !destroyed) void init(true);
  }
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    epoch++;
    activeRequest?.abort();
    activeRequest = null;
    close({ restoreFocus: false });
    openButton.removeEventListener("click", open);
    skipButton.removeEventListener("click", cancel);
    form.removeEventListener("submit", mutate);
    clearButton.removeEventListener("click", mutate);
    dialog.removeEventListener("cancel", cancel);
    dialog.removeEventListener("close", closed);
    dialog.removeEventListener("keydown", fallbackEscape);
    win.removeEventListener("pagehide", pagehide);
    win.removeEventListener("pageshow", pageshow);
  }
  async function init(refresh = false) {
    if (destroyed) return;
    const token = ++epoch;
    try {
      const result = await presence(
        await request("/api/credentials/meta", {
          cache: "no-store",
          credentials: "same-origin",
          redirect: "error",
        }),
      );
      if (destroyed || token !== epoch) return;
      reflect(result);
      if (refresh) await onChange(result);
      if (!destroyed && token === epoch && !configured) open();
    } catch {
      if (destroyed || token !== epoch) return;
      summary.textContent = "Meta key status unavailable";
      status.textContent =
        "Could not read local key configuration. You can continue offline or retry setup.";
    }
  }
  openButton.addEventListener("click", open);
  skipButton.addEventListener("click", cancel);
  form.addEventListener("submit", mutate);
  clearButton.addEventListener("click", mutate);
  dialog.addEventListener("cancel", cancel);
  dialog.addEventListener("close", closed);
  dialog.addEventListener("keydown", fallbackEscape);
  win.addEventListener("pagehide", pagehide);
  win.addEventListener("pageshow", pageshow);
  return {
    init,
    destroy,
  };
}
