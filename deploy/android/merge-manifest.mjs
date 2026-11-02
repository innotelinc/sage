// Adds the permissions the app actually uses to the Capacitor-generated
// Android manifest. Runs after `npx cap add android` in CI; idempotent, so a
// re-run on an already-merged manifest changes nothing.
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2] || 'android/app/src/main/AndroidManifest.xml';
const permissions = [
  '<uses-permission android:name="android.permission.INTERNET" />',
  '<uses-permission android:name="android.permission.CAMERA" />',
  '<uses-permission android:name="android.permission.RECORD_AUDIO" />',
  '<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />',
  '<uses-feature android:name="android.hardware.camera" android:required="false" />',
  '<uses-feature android:name="android.hardware.microphone" android:required="false" />',
];

let xml = readFileSync(file, 'utf8');
let added = 0;
for (const line of permissions) {
  if (xml.includes(line)) continue;
  // The generated manifest opens with <manifest ...> and nothing else at that level.
  xml = xml.replace(/(<manifest\b[^>]*>)/, `$1\n    ${line}`);
  added += 1;
}
writeFileSync(file, xml);
console.log(`manifest: ${added} permission(s) added, ${permissions.length - added} already present`);

if (!xml.includes('android.permission.CAMERA')) {
  throw new Error('manifest merge failed: CAMERA permission missing');
}
