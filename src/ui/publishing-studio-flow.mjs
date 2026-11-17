function newIdempotencyKey() {
  return `studio-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

export class PublishingStudioFlow {
  constructor(request) {
    if (typeof request !== "function") throw new TypeError("request muss eine Funktion sein.");
    this.request = request;
    this.state = this.emptyState();
  }

  emptyState() {
    return {
      sourceJobId: null,
      connectionId: null,
      platform: null,
      metadata: {},
      previewUrl: null,
      previewLoaded: false,
      previewPlayed: false,
      reviewed: false,
      preflightJob: null,
      preflightRequestStarted: false,
      confirmationRequested: false,
      idempotencyKey: null,
    };
  }

  select({ sourceJobId, connectionId, platform, metadata, previewUrl }) {
    if (this.state.confirmationRequested) throw new Error("Eine Veröffentlichung wurde bereits angefordert; zuerst den aktuellen Status abgleichen.");
    if (this.state.preflightJob || this.state.preflightRequestStarted) throw new Error("Ein Preflight ist bereits angelegt oder wird abgeglichen; schließe diesen Auftrag zuerst ab.");
    this.state = {
      ...this.emptyState(),
      sourceJobId,
      connectionId,
      platform,
      metadata: structuredClone(metadata || {}),
      previewUrl,
      idempotencyKey: newIdempotencyKey(),
    };
    return this.snapshot();
  }

  snapshot() {
    return structuredClone(this.state);
  }

  clear() {
    if (this.state.confirmationRequested) throw new Error("Eine Veröffentlichung wurde bereits angefordert; zuerst den aktuellen Status abgleichen.");
    if (this.state.preflightJob || this.state.preflightRequestStarted) throw new Error("Ein Preflight ist bereits angelegt oder wird abgeglichen; schließe diesen Auftrag zuerst ab.");
    this.state = this.emptyState();
  }

  markPreviewLoaded() {
    this.state.previewLoaded = true;
  }

  markPreviewPlayed() {
    this.state.previewPlayed = true;
  }

  markReviewed(checked) {
    if (checked && (!this.state.previewLoaded || !this.state.previewPlayed)) {
      throw new Error("Lade die Vorschau und starte die Wiedergabe, bevor du die Prüfung bestätigst.");
    }
    this.state.reviewed = checked === true;
  }

  updateMetadata(metadata) {
    if (this.state.confirmationRequested) throw new Error("Nach der Veröffentlichungsbestätigung können Metadaten nicht mehr geändert werden.");
    if (this.state.preflightJob || this.state.preflightRequestStarted) throw new Error("Nach dem Preflight können Metadaten nicht geändert werden; prüfe zuerst den bestehenden Auftrag.");
    this.state.metadata = structuredClone(metadata || {});
    this.state.reviewed = false;
    this.state.preflightJob = null;
    this.state.preflightRequestStarted = false;
    this.state.idempotencyKey = newIdempotencyKey();
  }

  async createPreflight() {
    if (!this.state.sourceJobId || !this.state.connectionId || !this.state.platform) throw new Error("Wähle ein fertiges Video und ein verbundenes Zielkonto.");
    if (!this.state.previewLoaded || !this.state.previewPlayed || !this.state.reviewed) throw new Error("Die Videovorschau muss geladen, abgespielt und ausdrücklich geprüft sein.");
    if (this.state.preflightJob) return this.state.preflightJob;

    this.state.preflightRequestStarted = true;
    const response = await this.request(`/api/v1/shorts-jobs/${encodeURIComponent(this.state.sourceJobId)}/publish`, {
      method: "POST",
      headers: { "Idempotency-Key": this.state.idempotencyKey },
      body: { platform: this.state.platform, mode: "upload", connectionId: this.state.connectionId, metadata: this.state.metadata },
    });
    this.state.preflightJob = response.job;
    return response.job;
  }

  async confirmPublish({ confirmed = false } = {}) {
    if (!this.state.reviewed || !this.state.preflightJob?.id) throw new Error("Erstelle zuerst nach Sichtprüfung einen Publishing-Preflight.");
    if (confirmed !== true) throw new Error("Die Veröffentlichung benötigt eine separate, ausdrückliche Bestätigung.");
    if (this.state.confirmationRequested) throw new Error("Die Veröffentlichung wurde bereits angefordert; starte keinen zweiten Upload.");

    this.state.confirmationRequested = true;
    return this.request(`/api/v1/publishing-jobs/${encodeURIComponent(this.state.preflightJob.id)}/confirm`, {
      method: "POST",
      body: { confirmed: true },
    });
  }

  async getPublishingJob() {
    if (!this.state.preflightJob?.id) throw new Error("Es gibt noch keinen Publishing-Auftrag zum Abgleichen.");
    return this.request(`/api/v1/publishing-jobs/${encodeURIComponent(this.state.preflightJob.id)}`);
  }
}
