// Adds the permissions and services the app actually uses to the
// Capacitor-generated Android manifest. Runs after `npx cap add android` in CI;
// idempotent, so a re-run on an already-merged manifest changes nothing.
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2] || 'android/app/src/main/AndroidManifest.xml';
const permissions = [
  '<uses-permission android:name="android.permission.INTERNET" />',
  '<uses-permission android:name="android.permission.CAMERA" />',
  '<uses-permission android:name="android.permission.RECORD_AUDIO" />',
  '<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />',
  // Watching the screen while another app is in front needs a foreground
  // service, and Android 14 only allows one of the mediaProjection type.
  '<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />',
  '<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION" />',
  '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />',
  '<uses-feature android:name="android.hardware.camera" android:required="false" />',
  '<uses-feature android:name="android.hardware.microphone" android:required="false" />',
];

const service =
  '<service android:name=".SageScreenService" android:exported="false" android:foregroundServiceType="mediaProjection" />';

let xml = readFileSync(file, 'utf8');
let added = 0;
for (const line of permissions) {
  if (xml.includes(line)) continue;
  // The generated manifest opens with <manifest ...> and nothing else at that level.
  xml = xml.replace(/(<manifest\b[^>]*>)/, `$1\n    ${line}`);
  added += 1;
}
if (!xml.includes(service)) {
  xml = xml.replace(/(<application\b[^>]*>)/, `$1\n        ${service}`);
  added += 1;
}
writeFileSync(file, xml);
console.log(`manifest: ${added} entry(s) added`);

for (const required of [
  'android.permission.CAMERA',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION',
  'android:foregroundServiceType="mediaProjection"',
]) {
  if (!xml.includes(required)) throw new Error(`manifest merge failed: ${required} missing`);
}
