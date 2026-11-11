import { StatusBar } from "expo-status-bar";

declare const process: { env: { EXPO_PUBLIC_API_URL?: string } };
import { useCallback, useEffect, useState } from "react";
import * as SecureStore from "expo-secure-store";
import {
  ActivityIndicator, Alert, Linking, Pressable, RefreshControl, SafeAreaView,
  ScrollView, StyleSheet, Text, TextInput, View
} from "react-native";

const BUILD_API_URL = (process.env.EXPO_PUBLIC_API_URL ?? "").trim().replace(/\/+$/, "");
let API_URL = BUILD_API_URL;

/**
 * Accept full URLs as well as bare hosts. A bare host is assumed to be HTTPS unless it points at
 * localhost or a LAN address, which is how the self-hosted development backend is reached.
 */
function normalizeApiUrl(value: string) {
  const trimmed = value.trim().replace(/\\/+$/, "");
  if (!trimmed) return "";
  const candidate = /^https?:\\/\\//i.test(trimmed) ? trimmed : "https://" + trimmed;
  let parsed: URL;
  try { parsed = new URL(candidate); } catch { throw new Error("Ungültige Backend-Adresse."); }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Die Backend-Adresse darf keine Zugangsdaten, Query-Parameter oder Fragmente enthalten.");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\\[|\\]$/g, "");
  const octets = hostname.split(".").map(Number);
  const ipv4 = octets.length === 4 && octets.every(part => Number.isInteger(part) && part >= 0 && part <= 255);
  const privateIpv4 = ipv4 && (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 169 && octets[1] === 254) ||
    octets[0] === 127
  );
  const localHost = hostname === "localhost" || hostname === "::1" || privateIpv4;
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && localHost)) {
    throw new Error("Externe Backend-Adressen müssen HTTPS verwenden. HTTP ist nur für lokale/private Entwicklungsserver erlaubt.");
  }
  return parsed.origin;
}

type Organization = { id: string; name: string; slug: string; role: string };
type Asset = { id: string; kind: string; mimeType: string; sizeBytes: string | null; downloadUrl?: string | null };
type VideoJob = {
  id: string; topic: string; language: string; status: string; progress: number;
  errorCode?: string | null; errorMessage?: string | null; createdAt: string; assets: Asset[];
};
type Project = { id: string; name: string; description?: string | null; organizationId: string; jobs: VideoJob[] };
type AdminOverview = { role: string; counts: { projects: number; jobs: number; completedJobs: number; failedJobs: number } };
type ProviderEntry = string | { id?: string; provider?: string; model?: string; name?: string };
type ProviderStatus = { freeOnly: boolean; llm: ProviderEntry[]; tts: ProviderEntry[]; visuals: ProviderEntry[] };

async function api<T>(path: string, token?: string, init: RequestInit = {}): Promise<T> {
  if (!API_URL) throw new Error("Backend-Adresse fehlt. EXPO_PUBLIC_API_URL muss beim Android-Build als HTTPS-Adresse gesetzt sein.");
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (token) headers.set("authorization", "Bearer " + token);
  const response = await fetch(API_URL + path, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "API request failed (" + response.status + ")");
  return body as T;
}

function statusLabel(status: string) {
  return ({
    QUEUED: "In Warteschlange", PLANNING: "Planung", GENERATING_SCRIPT: "Skript",
    GENERATING_VOICE: "Voiceover", GENERATING_VISUALS: "Visuals",
    RENDERING: "Rendering", VALIDATING: "Qualitätsprüfung",
    AWAITING_APPROVAL: "Freigabe", PUBLISHING: "Veröffentlichung",
    COMPLETED: "Fertig", FAILED: "Fehlgeschlagen", CANCELLED: "Abgebrochen"
  } as Record<string, string>)[status] ?? status;
}

export default function App() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState("");
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [admin, setAdmin] = useState<AdminOverview | null>(null);
  const [providerStatus, setProviderStatus] = useState<ProviderStatus | null>(null);
  const [selectedProject, setSelectedProject] = useState("");
  const [projectName, setProjectName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sessionChecking, setSessionChecking] = useState(true);
  const [error, setError] = useState("");
  const [apiDraft, setApiDraft] = useState(BUILD_API_URL);
  const [editingApi, setEditingApi] = useState(!BUILD_API_URL);

  const loadDashboard = useCallback(async (sessionToken: string, orgs: Organization[]) => {
    setLoading(true); setError("");
    try {
      const result = await api<{ projects: Project[] }>("/v1/projects", sessionToken);
      setProjects(result.projects);
      setSelectedProject(current => result.projects.some(p => p.id === current) ? current : (result.projects[0]?.id ?? ""));
      try { setProviderStatus(await api<ProviderStatus>("/v1/providers", sessionToken)); }
      catch { setProviderStatus(null); }
      const adminOrg = orgs.find(org => org.role === "ADMIN" || org.role === "OWNER");
      if (adminOrg) {
        try {
          const overview = await api<AdminOverview>("/v1/admin/overview", sessionToken, {
            headers: { "x-organization-id": adminOrg.id }
          });
          setAdmin(overview);
        } catch { setAdmin(null); }
      } else setAdmin(null);
    } catch (e) { setError(e instanceof Error ? e.message : "Dashboard konnte nicht geladen werden"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    let active = true;
    const restoreSession = async () => {
      try {
        const savedApi = await SecureStore.getItemAsync("faceless.api");
        if (savedApi) {
          API_URL = normalizeApiUrl(savedApi) || BUILD_API_URL;
          if (active) setApiDraft(API_URL);
        }
        const savedToken = await SecureStore.getItemAsync("faceless.session");
        if (!savedToken) return;
        const current = await api<{ user: { email: string }; organizations: Organization[] }>("/v1/auth/me", savedToken);
        if (!active) return;
        setToken(savedToken);
        setUserEmail(current.user.email);
        setOrganizations(current.organizations);
        await loadDashboard(savedToken, current.organizations);
      } catch {
        await SecureStore.deleteItemAsync("faceless.session").catch(() => undefined);
      } finally {
        if (active) setSessionChecking(false);
      }
    };
    void restoreSession();
    return () => { active = false; };
  }, [loadDashboard]);

  const saveApi = async () => {
    let next = "";
    try { next = normalizeApiUrl(apiDraft); }
    catch (e) { setError(e instanceof Error ? e.message : "Backend-Adresse ist ungültig."); return; }
    if (!next) { setError("Bitte eine Backend-Adresse eingeben, zum Beispiel https://api.deine-domain.de"); return; }
    API_URL = next;
    setApiDraft(next);
    setError("");
    setEditingApi(false);
    await SecureStore.setItemAsync("faceless.api", next).catch(() => undefined);
  };

  const signIn = async () => {
    if (!email.trim() || !password) { setError("Bitte E-Mail und Passwort eingeben."); return; }
    setBusy(true); setError("");
    try {
      const result = await api<{ accessToken: string; user: { email: string }; organizations: Organization[] }>("/v1/auth/login", undefined, {
        method: "POST", body: JSON.stringify({ email: email.trim(), password })
      });
      await SecureStore.setItemAsync("faceless.session", result.accessToken);
      setToken(result.accessToken); setUserEmail(result.user.email); setOrganizations(result.organizations);
      setPassword("");
      await loadDashboard(result.accessToken, result.organizations);
    } catch (e) { setError(e instanceof Error ? e.message : "Anmeldung fehlgeschlagen"); }
    finally { setBusy(false); }
  };

  const refresh = async () => { if (token) await loadDashboard(token, organizations); };

  // Keep active renders current without requiring the user to pull-to-refresh.
  useEffect(() => {
    const activeStatuses = new Set([
      "QUEUED", "PLANNING", "GENERATING_SCRIPT", "GENERATING_VOICE",
      "GENERATING_VISUALS", "RENDERING", "VALIDATING", "AWAITING_APPROVAL", "PUBLISHING"
    ]);
    const hasActiveJobs = projects.some(project =>
      project.jobs.some(job => activeStatuses.has(job.status))
    );
    if (!token || !hasActiveJobs) return;

    const timer = setInterval(() => {
      void loadDashboard(token, organizations);
    }, 12000);
    return () => clearInterval(timer);
  }, [token, projects, organizations, loadDashboard]);

  const createProject = async () => {
    const organization = organizations.find(org => ["OWNER", "ADMIN", "EDITOR"].includes(org.role));
    if (!token || !organization || projectName.trim().length < 2) {
      setError("Projektname und Schreibzugriff auf eine Organisation sind erforderlich."); return;
    }
    setBusy(true); setError("");
    try {
      const result = await api<{ project: Project }>("/v1/projects", token, {
        method: "POST",
        body: JSON.stringify({ organizationId: organization.id, name: projectName.trim(), description: projectDescription.trim() })
      });
      setProjectName(""); setProjectDescription("");
      await loadDashboard(token, organizations);
      setSelectedProject(result.project.id);
      Alert.alert("Projekt erstellt", "Dein neues Projekt ist bereit.");
    } catch (e) { setError(e instanceof Error ? e.message : "Projekt konnte nicht erstellt werden"); }
    finally { setBusy(false); }
  };

  const createJob = async () => {
    if (!token || !selectedProject || !topic.trim()) { setError("Projekt und Videothema sind erforderlich."); return; }
    setBusy(true); setError("");
    try {
      await api("/v1/video-jobs", token, {
        method: "POST",
        body: JSON.stringify({
          projectId: selectedProject, topic: topic.trim(), language: "de",
          targetDurationSeconds: 45, targetPlatforms: ["youtube_shorts", "tiktok", "instagram"]
        })
      });
      setTopic("");
      await loadDashboard(token, organizations);
      Alert.alert("Video eingeplant", "Der Render-Auftrag wurde an die Worker-Warteschlange übergeben.");
    } catch (e) { setError(e instanceof Error ? e.message : "Video konnte nicht gestartet werden"); }
    finally { setBusy(false); }
  };

  const signOut = async () => {
    if (token) { try { await api("/v1/auth/logout", token, { method: "POST" }); } catch { /* local sign-out still clears the session */ } }
    await SecureStore.deleteItemAsync("faceless.session").catch(() => undefined);
    setToken(null); setProjects([]); setOrganizations([]); setAdmin(null); setUserEmail(""); setPassword("");
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      {sessionChecking ? (
        <View style={styles.loginWrap}><ActivityIndicator color="#78E2C0" size="large" /><Text style={styles.hint}>Sitzung wird sicher wiederhergestellt …</Text></View>
      ) : !token ? (
        <View style={styles.loginWrap}>
          <Text style={styles.eyebrow}>FACELESS / STUDIO</Text>
          <Text style={styles.title}>Deine Story.{"\n"}Dein Studio.</Text>
          <Text style={styles.subtitle}>Melde dich an, verwalte Projekte und starte deine Short-Video-Produktion.</Text>
          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Willkommen zurück</Text>
            <Text style={styles.label}>E-MAIL</Text>
            <TextInput value={email} onChangeText={setEmail} placeholder="name@beispiel.de" placeholderTextColor="#66738D" autoCapitalize="none" keyboardType="email-address" autoComplete="email" style={styles.input} />
            <Text style={styles.label}>PASSWORT</Text>
            <TextInput value={password} onChangeText={setPassword} placeholder="Dein Passwort" placeholderTextColor="#66738D" secureTextEntry autoComplete="current-password" onSubmitEditing={signIn} style={styles.input} />
            {!!error && <Text style={styles.error}>{error}</Text>}
            <Pressable style={[styles.primaryButton, busy && styles.disabled]} onPress={signIn} disabled={busy}>
              {busy ? <ActivityIndicator color="#08110F" /> : <Text style={styles.primaryText}>Sicher anmelden</Text>}
            </Pressable>
            {editingApi ? (
              <View>
                <Text style={styles.label}>BACKEND-ADRESSE</Text>
                <TextInput value={apiDraft} onChangeText={setApiDraft} placeholder="https://api.deine-domain.de" placeholderTextColor="#66738D" autoCapitalize="none" autoCorrect={false} keyboardType="url" onSubmitEditing={saveApi} style={styles.input} />
                <Pressable style={styles.primaryButton} onPress={saveApi}>
                  <Text style={styles.primaryText}>Backend speichern</Text>
                </Pressable>
                <Text style={styles.hint}>Die Adresse der Faceless-Shorts-API, erreichbar von diesem Gerät. Sitzung wird verschlüsselt auf diesem Gerät gespeichert.</Text>
              </View>
            ) : (
              <Pressable onPress={() => setEditingApi(true)}>
                <Text style={styles.hint}>Backend: {API_URL || "nicht konfiguriert"} · Server ändern · Sitzung wird verschlüsselt auf diesem Gerät gespeichert.</Text>
              </Pressable>
            )}
          </View>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} tintColor="#78E2C0" />}>
          <View style={styles.header}>
            <View>
              <Text style={styles.eyebrow}>FACELESS / COMMAND</Text>
              <Text style={styles.title}>Studio</Text>
              <Text style={styles.subtitle}>{userEmail}</Text>
            </View>
            <Pressable onPress={signOut} style={styles.ghostButton}><Text style={styles.ghostText}>Abmelden</Text></Pressable>
          </View>
          {providerStatus && (
            <View style={styles.panel}>
              <Text style={styles.panelTitle}>Free Route Hunter</Text>
              <Text style={styles.hint}>{providerStatus.freeOnly ? "Free-only Routing aktiv" : "Provider-Konfiguration prüfen"}</Text>
              <ProviderLine label="LLM" routes={providerStatus.llm} />
              <ProviderLine label="TTS" routes={providerStatus.tts} />
              <ProviderLine label="VISUALS" routes={providerStatus.visuals} />
            </View>
          )}
          {admin && (
            <View style={styles.panel}>
              <Text style={styles.panelTitle}>Admin-Übersicht</Text>
              <Text style={styles.hint}>Rolle: {admin.role}</Text>
              <View style={styles.metrics}>
                <Metric value={admin.counts.projects} label="Projekte" />
                <Metric value={admin.counts.jobs} label="Videos" />
                <Metric value={admin.counts.completedJobs} label="Fertig" />
                <Metric value={admin.counts.failedJobs} label="Fehler" />
              </View>
            </View>
          )}
          <View style={styles.sectionHead}><Text style={styles.sectionTitle}>Neues Projekt</Text><Text style={styles.hint}>Organisation: {organizations.find(org => ["OWNER", "ADMIN", "EDITOR"].includes(org.role))?.name ?? "Keine Schreibberechtigung"}</Text></View>
          <View style={styles.panel}>
            <TextInput value={projectName} onChangeText={setProjectName} placeholder="Projektname" placeholderTextColor="#66738D" style={styles.input} maxLength={80} />
            <TextInput value={projectDescription} onChangeText={setProjectDescription} placeholder="Beschreibung (optional)" placeholderTextColor="#66738D" style={styles.input} maxLength={500} />
            <Pressable style={[styles.primaryButton, (busy || !organizations.some(org => ["OWNER", "ADMIN", "EDITOR"].includes(org.role))) && styles.disabled]} onPress={createProject} disabled={busy || !organizations.some(org => ["OWNER", "ADMIN", "EDITOR"].includes(org.role))}>
              <Text style={styles.primaryText}>Projekt anlegen</Text>
            </Pressable>
          </View>
          <View style={styles.sectionHead}><Text style={styles.sectionTitle}>Neues Video</Text><Text style={styles.hint}>45 Sekunden · Hochformat</Text></View>
          <View style={styles.panel}>
            <Text style={styles.label}>PROJEKT</Text>
            {projects.length ? (
              <View style={styles.projectPicker}>
                {projects.map(project => (
                  <Pressable key={project.id} onPress={() => setSelectedProject(project.id)} style={[styles.projectChip, selectedProject === project.id && styles.projectChipActive]}>
                    <Text style={[styles.projectChipText, selectedProject === project.id && styles.projectChipTextActive]}>{project.name}</Text>
                  </Pressable>
                ))}
              </View>
            ) : <Text style={styles.hint}>Noch keine Projekte für deine Organisation vorhanden.</Text>}
            <Text style={styles.label}>VIDEOTHEMA</Text>
            <TextInput value={topic} onChangeText={setTopic} placeholder="z. B. 5 KI-Tools für Selbstständige" placeholderTextColor="#66738D" style={[styles.input, styles.topicInput]} multiline />
            {!!error && <Text style={styles.error}>{error}</Text>}
            <Pressable style={[styles.primaryButton, (busy || !projects.length) && styles.disabled]} onPress={createJob} disabled={busy || !projects.length}>
              {busy ? <ActivityIndicator color="#08110F" /> : <Text style={styles.primaryText}>Video-Produktion starten</Text>}
            </Pressable>
          </View>
          <View style={styles.sectionHead}><Text style={styles.sectionTitle}>Deine Projekte</Text><Pressable onPress={refresh}><Text style={styles.link}>Aktualisieren ↻</Text></Pressable></View>
          {projects.map(project => (
            <View key={project.id} style={styles.projectCard}>
              <Text style={styles.projectName}>{project.name}</Text>
              {!!project.description && <Text style={styles.hint}>{project.description}</Text>}
              {project.jobs.length ? project.jobs.map(job => (
                <View key={job.id} style={styles.jobRow}>
                  <View style={styles.jobInfo}>
                    <Text style={styles.jobTitle} numberOfLines={2}>{job.topic}</Text>
                    <Text style={styles.hint}>{statusLabel(job.status)} · {new Date(job.createdAt).toLocaleDateString("de-DE")}</Text>
                    {!!job.errorCode && <Text style={styles.error}>{job.errorCode}</Text>}
                    {job.assets.filter(asset => asset.kind === "VIDEO" && asset.downloadUrl).map(asset => (
                      <Pressable key={asset.id} onPress={() => void Linking.openURL(API_URL + asset.downloadUrl)}>
                        <Text style={styles.link}>MP4 öffnen / herunterladen ↗</Text>
                      </Pressable>
                    ))}
                  </View>
                  <Text style={[styles.progress, job.status === "COMPLETED" ? styles.success : job.status === "FAILED" ? styles.failure : null]}>{job.progress}%</Text>
                </View>
              )) : <Text style={styles.hint}>Noch keine Video-Aufträge.</Text>}
            </View>
          ))}
          <Text style={styles.footer}>FREE ROUTE HUNTER · LLM / TTS / RENDER PIPELINE</Text>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function Metric({ value, label }: { value: number; label: string }) {
  return <View style={styles.metric}><Text style={styles.metricValue}>{value}</Text><Text style={styles.hint}>{label}</Text></View>;
}

function ProviderLine({ label, routes }: { label: string; routes: ProviderEntry[] }) {
  const names = routes.map(route => typeof route === "string" ? route : route.id ?? route.provider ?? route.model ?? route.name ?? "Route");
  return (
    <View style={styles.providerLine}>
      <Text style={styles.providerLabel}>{label}</Text>
      <Text style={styles.providerValue}>{names.length ? names.join(" · ") : "Noch keine Route gemeldet"}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#090B12" },
  loginWrap: { flex: 1, justifyContent: "center", padding: 24, gap: 16 },
  content: { padding: 20, paddingBottom: 44, gap: 16 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  eyebrow: { color: "#8B9BB8", fontSize: 11, letterSpacing: 2.6, fontWeight: "800" },
  title: { color: "#F5F7FF", fontSize: 36, fontWeight: "800", marginTop: 8 },
  subtitle: { color: "#A8B1C5", fontSize: 14, lineHeight: 21, marginTop: 6 },
  panel: { padding: 18, borderRadius: 18, backgroundColor: "#141A28", borderWidth: 1, borderColor: "#28334A", gap: 12 },
  panelTitle: { color: "#F5F7FF", fontSize: 18, fontWeight: "700" },
  label: { color: "#8492AD", fontSize: 10, fontWeight: "800", letterSpacing: 1.5, marginTop: 4 },
  input: { backgroundColor: "#0C1220", borderColor: "#2B3851", borderWidth: 1, borderRadius: 11, paddingHorizontal: 14, paddingVertical: 13, color: "#F5F7FF", fontSize: 14 },
  topicInput: { minHeight: 76, textAlignVertical: "top" },
  primaryButton: { backgroundColor: "#78E2C0", borderRadius: 11, padding: 15, alignItems: "center", marginTop: 4 },
  primaryText: { color: "#08110F", fontWeight: "800", fontSize: 14 },
  disabled: { opacity: 0.55 },
  hint: { color: "#8190AA", fontSize: 11, lineHeight: 17 },
  error: { color: "#FF8C9A", fontSize: 12, lineHeight: 18 },
  ghostButton: { borderColor: "#35415A", borderWidth: 1, borderRadius: 10, paddingVertical: 9, paddingHorizontal: 12 },
  ghostText: { color: "#C5CEE0", fontSize: 12, fontWeight: "700" },
  sectionHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 6 },
  sectionTitle: { color: "#F5F7FF", fontSize: 19, fontWeight: "800" },
  link: { color: "#78E2C0", fontSize: 12, fontWeight: "700" },
  metrics: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  providerLine: { borderTopWidth: 1, borderTopColor: "#253149", paddingTop: 8, gap: 3 },
  providerLabel: { color: "#78E2C0", fontSize: 10, fontWeight: "800", letterSpacing: 1.2 },
  providerValue: { color: "#C5CEE0", fontSize: 11, lineHeight: 17 },
  metric: { flex: 1, backgroundColor: "#0C1220", borderRadius: 10, padding: 10, gap: 4 },
  metricValue: { color: "#F5F7FF", fontSize: 22, fontWeight: "800" },
  projectPicker: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  projectChip: { borderWidth: 1, borderColor: "#35415A", borderRadius: 20, paddingHorizontal: 12, paddingVertical: 8 },
  projectChipActive: { borderColor: "#78E2C0", backgroundColor: "#17352F" },
  projectChipText: { color: "#A8B1C5", fontSize: 12 },
  projectChipTextActive: { color: "#9BF0D7", fontWeight: "700" },
  projectCard: { padding: 16, borderRadius: 16, backgroundColor: "#111827", borderColor: "#253149", borderWidth: 1, gap: 10 },
  projectName: { color: "#F5F7FF", fontSize: 16, fontWeight: "800" },
  jobRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderTopWidth: 1, borderTopColor: "#253149", paddingTop: 10, gap: 10 },
  jobInfo: { flex: 1, gap: 4 },
  jobTitle: { color: "#E5EAF5", fontSize: 13, fontWeight: "600" },
  progress: { color: "#B7C4DC", fontSize: 13, fontWeight: "800" },
  success: { color: "#78E2C0" },
  failure: { color: "#FF8C9A" },
  footer: { color: "#52617D", fontSize: 9, letterSpacing: 1.3, textAlign: "center", marginTop: 12 }
});
