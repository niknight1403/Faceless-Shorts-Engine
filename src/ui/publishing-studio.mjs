import { PublishingStudioFlow } from "./publishing-studio-flow.mjs";

const byId = id => document.getElementById(id);
const authPanel = byId("auth-panel");
const authForm = byId("auth-form");
const authMessage = byId("auth-message");
const workspace = byId("workspace");
const apiKeyInput = byId("api-key");
const sourceSelect = byId("source-job");
const accountSelect = byId("target-account");
const video = byId("video-preview");
const placeholder = byId("video-placeholder");
const reviewCheckbox = byId("reviewed");
const createButton = byId("create-preflight");
const workflowMessage = byId("workflow-message");
const preflightResult = byId("preflight-result");
const approvalPanel = byId("approval-panel");
const approvalSummary = byId("approval-summary");
const finalApproval = byId("final-approval");
const confirmButton = byId("confirm-publish");
const statusButton = byId("refresh-publishing-job");
const approvalMessage = byId("approval-message");
const youtubeFields = byId("youtube-fields");
const tiktokFields = byId("tiktok-fields");

let apiKey = "";
let shorts = [];
let connections = [];
let stageBusy = false;
let confirmBusy = false;
let statusBusy = false;

async function request(path, { method = "GET", headers = {}, body } = {}) {
  const requestHeaders = new Headers(headers);
  if (apiKey) requestHeaders.set("Authorization", `Bearer ${apiKey}`);
  if (body !== undefined) requestHeaders.set("Content-Type", "application/json");
  const response = await fetch(path, {
    method,
    headers: requestHeaders,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: "no-store",
    credentials: "same-origin",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error?.message || `Lokale Anfrage fehlgeschlagen (HTTP ${response.status}).`);
  return payload;
}

const flow = new PublishingStudioFlow(request);

function setMessage(node, message, kind = "") {
  node.textContent = message;
  if (kind) node.dataset.kind = kind;
  else delete node.dataset.kind;
}

function option(label, value = "") {
  const item = document.createElement("option");
  item.value = value;
  item.textContent = label;
  return item;
}

function currentSelection() {
  return {
    source: shorts.find(job => job.id === sourceSelect.value) || null,
    connection: connections.find(connection => connection.id === accountSelect.value) || null,
  };
}

function currentMetadata(platform) {
  if (platform === "youtube") {
    return {
      title: byId("youtube-title").value.trim(),
      description: byId("youtube-description").value,
      privacyStatus: byId("youtube-privacy").value,
      containsSyntheticMedia: byId("youtube-ai").checked,
    };
  }
  return { caption: byId("tiktok-caption").value.trim() };
}

function setMetadataVisibility(platform) {
  youtubeFields.hidden = platform !== "youtube";
  tiktokFields.hidden = platform !== "tiktok";
  byId("platform-label").textContent = platform ? (platform === "youtube" ? "YouTube · Upload" : "TikTok · Inbox") : "—";
  byId("metadata-note").textContent = platform
    ? "Jede Änderung der Angaben setzt die Sichtprüfung zurück. Direct Post ist hier nicht verfügbar."
    : "Wähle ein Zielkonto, um die passenden Angaben zu sehen. Jede Metadatenänderung setzt die Sichtprüfung zurück.";
}

function updateControls() {
  const state = flow.snapshot();
  const selected = currentSelection();
  const locked = Boolean(state.preflightJob || state.preflightRequestStarted || state.confirmationRequested);
  sourceSelect.disabled = locked;
  accountSelect.disabled = locked;
  for (const input of [byId("youtube-title"), byId("youtube-description"), byId("youtube-privacy"), byId("youtube-ai"), byId("tiktok-caption")]) input.disabled = locked;
  reviewCheckbox.disabled = !(state.previewLoaded && state.previewPlayed) || locked && !state.preflightJob;
  createButton.disabled = !selected.source || !selected.connection || !state.reviewed || Boolean(state.preflightJob) || stageBusy;
  createButton.textContent = state.preflightRequestStarted ? "Preflight erneut abgleichen" : "Vorschau geprüft — Preflight erstellen";
  approvalPanel.hidden = !state.preflightJob;
  finalApproval.disabled = !state.preflightJob || !state.reviewed || state.confirmationRequested;
  confirmButton.disabled = !state.preflightJob || !state.reviewed || !finalApproval.checked || confirmBusy || state.confirmationRequested;
  statusButton.disabled = !state.preflightJob || statusBusy || confirmBusy;
  byId("sign-out").disabled = locked;
  byId("reload-data").disabled = locked;
}

function clearPreview() {
  video.pause();
  video.removeAttribute("src");
  video.load();
  placeholder.hidden = false;
  byId("preview-state").textContent = "Noch kein Video gewählt";
  reviewCheckbox.checked = false;
  reviewCheckbox.disabled = true;
}

function refreshFlowSelection() {
  const { source, connection } = currentSelection();
  if (!source || !connection) {
    try { flow.clear(); } catch (error) { setMessage(workflowMessage, error.message, "error"); }
    clearPreview();
    setMetadataVisibility(null);
    updateControls();
    return;
  }

  try {
    const metadata = currentMetadata(connection.platform);
    flow.select({
      sourceJobId: source.id,
      connectionId: connection.id,
      platform: connection.platform,
      metadata,
      previewUrl: source.output.downloadUrl,
    });
    video.src = source.output.downloadUrl;
    video.load();
    placeholder.hidden = true;
    byId("preview-state").textContent = "Lade lokale Vorschau …";
    reviewCheckbox.checked = false;
    reviewCheckbox.disabled = true;
    setMetadataVisibility(connection.platform);
    preflightResult.hidden = true;
    approvalPanel.hidden = true;
    setMessage(workflowMessage, "Wähle Wiedergabe und prüfe anschließend Bild, Schnitt, Ton sowie die angezeigten Angaben.");
  } catch (error) {
    setMessage(workflowMessage, error.message, "error");
  }
  updateControls();
}

function updateMetadata() {
  const { connection } = currentSelection();
  if (!connection) return;
  try {
    flow.updateMetadata(currentMetadata(connection.platform));
    reviewCheckbox.checked = false;
    preflightResult.hidden = true;
    approvalPanel.hidden = true;
    setMessage(workflowMessage, "Metadaten geändert. Prüfe Vorschau und Angaben erneut.");
  } catch (error) {
    setMessage(workflowMessage, error.message, "error");
  }
  updateControls();
}

async function loadData() {
  setMessage(workflowMessage, "Lade fertige Videos und verbundene Konten …");
  const [shortResponse, connectionResponse] = await Promise.all([
    request("/api/v1/shorts-jobs"),
    request("/api/v1/connections"),
  ]);
  shorts = (shortResponse.jobs || []).filter(job => job.status === "completed" && job.output?.downloadUrl);
  connections = connectionResponse.connections || [];

  sourceSelect.replaceChildren(option(shorts.length ? "Video auswählen …" : "Keine fertigen Videos vorhanden"));
  for (const job of shorts) sourceSelect.append(option(`${job.topic || "Short"} · ${job.id.slice(0, 8)}`, job.id));
  accountSelect.replaceChildren(option(connections.length ? "Zielkonto auswählen …" : "Keine verbundenen Konten vorhanden"));
  for (const connection of connections) {
    const platform = connection.platform === "youtube" ? "YouTube" : "TikTok";
    const label = connection.displayName || connection.accountId || connection.id;
    accountSelect.append(option(`${platform} · ${label}`, connection.id));
  }
  clearPreview();
  setMessage(workflowMessage, `Geladen: ${shorts.length} fertige Videos und ${connections.length} verbundene Konten.`);
  setMessage(authMessage, "Lokale Verbindung hergestellt.", "success");
  refreshFlowSelection();
}

authForm.addEventListener("submit", async event => {
  event.preventDefault();
  apiKey = apiKeyInput.value.trim();
  if (!apiKey) return;
  byId("auth-form").querySelector("button[type=submit]").disabled = true;
  setMessage(authMessage, "Prüfe lokalen Zugriff …");
  try {
    await loadData();
    authPanel.hidden = true;
    workspace.hidden = false;
    apiKeyInput.value = "";
    setMessage(authMessage, "");
  } catch (error) {
    apiKey = "";
    setMessage(authMessage, error.message, "error");
  } finally {
    byId("auth-form").querySelector("button[type=submit]").disabled = false;
  }
});

byId("sign-out").addEventListener("click", () => {
  apiKey = "";
  shorts = [];
  connections = [];
  sourceSelect.replaceChildren(option("Lade fertige Videos …"));
  accountSelect.replaceChildren(option("Lade Accounts …"));
  try { flow.clear(); } catch { /* Nach einer finalen Anfrage bleibt die Seite bis zur Abmeldung schreibgeschützt. */ }
  clearPreview();
  workspace.hidden = true;
  authPanel.hidden = false;
  apiKeyInput.value = "";
  setMessage(authMessage, "Abgemeldet. Der Schlüssel wurde aus dem Seitenspeicher entfernt.");
});

byId("reload-data").addEventListener("click", () => loadData().catch(error => setMessage(workflowMessage, error.message, "error")));
sourceSelect.addEventListener("change", refreshFlowSelection);
accountSelect.addEventListener("change", refreshFlowSelection);
for (const input of [byId("youtube-title"), byId("youtube-description"), byId("youtube-privacy"), byId("youtube-ai"), byId("tiktok-caption")]) {
  input.addEventListener("input", updateMetadata);
  input.addEventListener("change", updateMetadata);
}

video.addEventListener("loadeddata", () => {
  flow.markPreviewLoaded();
  byId("preview-state").textContent = "Vorschau geladen · Wiedergabe erforderlich";
  reviewCheckbox.disabled = !flow.snapshot().previewPlayed;
  updateControls();
});
video.addEventListener("playing", () => {
  flow.markPreviewPlayed();
  byId("preview-state").textContent = "Vorschau wird wiedergegeben";
  reviewCheckbox.disabled = !flow.snapshot().previewLoaded;
  updateControls();
});
reviewCheckbox.addEventListener("change", () => {
  try {
    flow.markReviewed(reviewCheckbox.checked);
    setMessage(workflowMessage, reviewCheckbox.checked ? "Sichtprüfung festgehalten. Der lokale Preflight kann jetzt erstellt werden." : "Sichtprüfung zurückgesetzt.");
  } catch (error) {
    reviewCheckbox.checked = false;
    setMessage(workflowMessage, error.message, "error");
  }
  updateControls();
});

createButton.addEventListener("click", async () => {
  stageBusy = true;
  setMessage(workflowMessage, "Erstelle lokalen Preflight. Es wird noch nichts hochgeladen.");
  updateControls();
  try {
    const job = await flow.createPreflight();
    preflightResult.hidden = false;
    preflightResult.textContent = `Preflight ${job.id} · ${job.status} · ${job.platform === "youtube" ? "YouTube" : "TikTok Inbox"}. Es wurde noch kein Plattform-Upload gestartet.`;
    const { source, connection } = currentSelection();
    approvalSummary.textContent = `Video: ${source?.topic || job.sourceJobId} · Zielkonto: ${connection?.displayName || connection?.accountId || connection?.id} · Preflight-ID: ${job.id}`;
    finalApproval.checked = false;
    setMessage(workflowMessage, "Preflight erfolgreich. Ein Upload beginnt erst nach der separaten Bestätigung unten.", "success");
    setMessage(approvalMessage, "");
  } catch (error) {
    setMessage(workflowMessage, `${error.message} Ein erneuter Versuch verwendet denselben Idempotency-Key.`, "error");
  } finally {
    stageBusy = false;
    updateControls();
  }
});

finalApproval.addEventListener("change", updateControls);
confirmButton.addEventListener("click", async () => {
  if (!finalApproval.checked) return;
  confirmBusy = true;
  setMessage(approvalMessage, "Freigabe wird übermittelt. Bei unklarer Antwort nicht erneut klicken; zuerst den Jobstatus abgleichen.");
  updateControls();
  try {
    const response = await flow.confirmPublish({ confirmed: finalApproval.checked });
    const job = response.job;
    setMessage(approvalMessage, `Freigabe angenommen · Status ${job.status} · Job ${job.id}. Der Upload läuft asynchron; prüfe den Jobstatus, bevor du einen weiteren Auftrag startest.`, "success");
  } catch (error) {
    setMessage(approvalMessage, `${error.message} Starte keinen zweiten Upload, bis der Jobstatus abgeglichen wurde.`, "error");
  } finally {
    confirmBusy = false;
    updateControls();
  }
});

statusButton.addEventListener("click", async () => {
  statusBusy = true;
  updateControls();
  setMessage(approvalMessage, "Lese den gespeicherten lokalen Jobstatus. Es wird kein Plattformaufruf gestartet.");
  try {
    const { job } = await flow.getPublishingJob();
    const details = job.statusMessage ? ` · ${job.statusMessage}` : "";
    setMessage(approvalMessage, `Job ${job.id} · Status ${job.status}${details}`, "success");
  } catch (error) {
    setMessage(approvalMessage, `Statusabgleich fehlgeschlagen: ${error.message}`, "error");
  } finally {
    statusBusy = false;
    updateControls();
  }
});
