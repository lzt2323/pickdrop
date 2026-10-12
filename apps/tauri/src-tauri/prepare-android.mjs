// Reapply native Android integration after `tauri android init` regenerates files.
// Idempotent and safe on desktop builds where gen/android is absent.
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const base = new URL('./gen/android/', import.meta.url);
const manifest = fileURLToPath(new URL('app/src/main/AndroidManifest.xml', base));
if (existsSync(manifest)) {
  let xml = readFileSync(manifest, 'utf8');
  if (!xml.includes('android.intent.action.SEND_MULTIPLE')) {
    xml = xml.replace('</activity>', `<intent-filter>
                <action android:name="android.intent.action.SEND" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="*/*" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.SEND_MULTIPLE" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="*/*" />
            </intent-filter>
        </activity>`);
  }
  writeFileSync(manifest, xml);
  const gradle = fileURLToPath(new URL('app/build.gradle.kts', base));
  let source = readFileSync(gradle, 'utf8');
  source = source.replace(/compileSdk = \d+/,'compileSdk = 36').replace(/targetSdk = \d+/,'targetSdk = 36');
  if (!source.includes('// PickDrop ARM64 release')) {
    source = source.replace('defaultConfig {', 'defaultConfig {\n        // PickDrop ARM64 release\n        ndk { abiFilters += listOf("arm64-v8a") }');
  }
  writeFileSync(gradle, source);
  const projectGradle=fileURLToPath(new URL('build.gradle.kts',base));
  let project=readFileSync(projectGradle,'utf8');
  if(!project.includes('// PickDrop offline QR model')) {
    project+=`\n// PickDrop offline QR model: works without Google Play Services or model download.\nallprojects {\n    configurations.configureEach {\n        resolutionStrategy.dependencySubstitution {\n            substitute(module("com.google.android.gms:play-services-mlkit-barcode-scanning:18.1.0"))\n                .using(module("com.google.mlkit:barcode-scanning:17.3.0")).withoutArtifactSelectors()\n        }\n    }\n}\n`;
  }
  project=project.replace('substitute(module("com.google.android.gms:play-services-mlkit-barcode-scanning"))','substitute(module("com.google.android.gms:play-services-mlkit-barcode-scanning:18.1.0"))');
  project=project.replace('.using(module("com.google.mlkit:barcode-scanning:17.3.0"))\n','.using(module("com.google.mlkit:barcode-scanning:17.3.0")).withoutArtifactSelectors()\n');
  writeFileSync(projectGradle,project);
}
