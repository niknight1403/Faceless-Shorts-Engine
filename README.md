# Faceless-Shorts-Engine

## Android APK build

The GitHub Actions workflow **Android APK** creates an installable Android debug APK and a ZIP containing that APK. It uses Expo Prebuild and Gradle directly; no Expo account, EAS project ID, or `EXPO_TOKEN` is required.

- Run it manually from **Actions → Android APK → Run workflow**, or push a change under `apps/mobile/`.
- Download the `Faceless-Shorts-Android-APK` artifact from the successful run.
- The artifact contains both `Faceless-Shorts.apk` and `Faceless-Shorts-Android-APK.zip`.
- This is a debug-signed test build, not a Play Store release. A production release requires a managed signing key and release configuration.

## Initial administrator

Create or promote an organization administrator with a one-time bootstrap command:

```bash
BOOTSTRAP_ADMIN_EMAIL="admin@example.com" \
BOOTSTRAP_ADMIN_PASSWORD="<new-random-password>" \
pnpm admin:bootstrap
```

Use a newly generated password (at least 14 characters); do not reuse a password that has been pasted into chat, source code, shell history, or issue trackers. The script stores a salted scrypt hash, creates the default `Faceless Shorts` organization if needed, and assigns the account the organization-scoped `ADMIN` role. It never prints the password or hash.

This bootstrap only creates the database identity and membership. It does not yet provide a user-password login/session flow: the current video-job API still uses its separate server-to-server `API_ACCESS_TOKEN`. Never put that token in a mobile app.
