$ErrorActionPreference = 'Stop'
$sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$tools = Join-Path $sdk 'build-tools\36.1.0'
$androidJar = Join-Path $sdk 'platforms\android-34\android.jar'
$java = 'C:\Program Files\Android\Android Studio\jbr\bin'
$env:JAVA_HOME = Split-Path $java
$env:Path = "$java;$env:Path"
$root = $PSScriptRoot
$build = Join-Path $root 'build'
New-Item -ItemType Directory -Force (Join-Path $build 'classes'), (Join-Path $build 'dex') | Out-Null
& (Join-Path $java 'javac.exe') --release 8 -encoding UTF-8 -g:none -cp $androidJar -d (Join-Path $build 'classes') (Join-Path $root 'src\vn\genesense\app\MainActivity.java')
if ($LASTEXITCODE -ne 0) { throw 'Java compile failed' }
& (Join-Path $java 'jar.exe') cf (Join-Path $build 'classes.jar') -C (Join-Path $build 'classes') .
if ($LASTEXITCODE -ne 0) { throw 'JAR packaging failed' }
& (Join-Path $tools 'd8.bat') --min-api 23 --lib $androidJar --output (Join-Path $build 'dex') (Join-Path $build 'classes.jar')
if ($LASTEXITCODE -ne 0) { throw 'D8 failed' }
& (Join-Path $tools 'aapt2.exe') compile --dir (Join-Path $root 'res') -o (Join-Path $build 'resources.zip')
if ($LASTEXITCODE -ne 0) { throw 'Icon compilation failed' }
& (Join-Path $tools 'aapt2.exe') link (Join-Path $build 'resources.zip') -o (Join-Path $build 'unsigned.apk') --manifest (Join-Path $root 'AndroidManifest.xml') -I $androidJar --min-sdk-version 23 --target-sdk-version 34
if ($LASTEXITCODE -ne 0) { throw 'Android packaging failed' }
Push-Location (Join-Path $build 'dex')
try { & (Join-Path $tools 'aapt.exe') add (Join-Path $build 'unsigned.apk') 'classes.dex' }
finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw 'DEX packaging failed' }
& (Join-Path $tools 'zipalign.exe') -f 4 (Join-Path $build 'unsigned.apk') (Join-Path $build 'aligned.apk')
if ($LASTEXITCODE -ne 0) { throw 'Alignment failed' }
$key = Join-Path $build 'debug.keystore'
if (!(Test-Path $key)) {
    & (Join-Path $java 'keytool.exe') -genkeypair -keystore $key -storepass android -keypass android -alias androiddebugkey -dname 'CN=Android Debug,O=Android,C=US' -keyalg RSA -keysize 2048 -validity 10000
    if ($LASTEXITCODE -ne 0) { throw 'Signing key creation failed' }
}
& (Join-Path $tools 'apksigner.bat') sign --ks $key --ks-key-alias androiddebugkey --ks-pass pass:android --key-pass pass:android --out (Join-Path $root 'GeneSense-debug.apk') (Join-Path $build 'aligned.apk')
if ($LASTEXITCODE -ne 0) { throw 'Signing failed' }
& (Join-Path $tools 'apksigner.bat') verify --verbose (Join-Path $root 'GeneSense-debug.apk')
if ($LASTEXITCODE -ne 0) { throw 'APK verification failed' }
Get-Item (Join-Path $root 'GeneSense-debug.apk') | Select-Object FullName,Length
