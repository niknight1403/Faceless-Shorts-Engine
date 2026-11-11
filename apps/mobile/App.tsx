import { StatusBar } from "expo-status-bar";
import { SafeAreaView, StyleSheet, Text, View } from "react-native";

export default function App() {
  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <View style={styles.container}>
        <Text style={styles.eyebrow}>FACeless / STUDIO</Text>
        <Text style={styles.title}>Deine nächste Story.</Text>
        <Text style={styles.subtitle}>
          Erstelle, bearbeite und veröffentliche vertikale Videos an einem Ort.
        </Text>
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Dein Studio ist bereit</Text>
          <Text style={styles.panelCopy}>
            Projekte, Skripte, Voiceover und Renderings erscheinen hier.
          </Text>
          <Text style={styles.status}>FOUNDATION · CONNECTING SERVICES NEXT</Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#090B12" },
  container: { flex: 1, padding: 24, justifyContent: "center", gap: 16 },
  eyebrow: { color: "#8B9BB8", fontSize: 12, letterSpacing: 3, fontWeight: "700" },
  title: { color: "#F5F7FF", fontSize: 34, fontWeight: "800" },
  subtitle: { color: "#A8B1C5", fontSize: 16, lineHeight: 24, maxWidth: 340 },
  panel: { marginTop: 24, padding: 22, borderRadius: 20, backgroundColor: "#141A28", borderWidth: 1, borderColor: "#28334A", gap: 10 },
  panelTitle: { color: "#F5F7FF", fontSize: 18, fontWeight: "700" },
  panelCopy: { color: "#A8B1C5", fontSize: 14, lineHeight: 21 },
  status: { marginTop: 12, color: "#7EE0C3", fontSize: 10, letterSpacing: 1.2, fontWeight: "700" }
});
