#!/usr/bin/env bash
# 交叉编译并打包 macOS (arm64/amd64) 与 Windows (amd64)。MyGo 走 purego，无需 cgo。
set -euo pipefail
VERSION="${VERSION:-dev}"
OUT="${OUT:-dist}"
rm -rf "$OUT" && mkdir -p "$OUT" && OUT="$(cd "$OUT" && pwd)"
build() { # goos goarch buntarget suffix
  local goos=$1 goarch=$2 bt=$3 name="agent-supervisor-$VERSION-$1-$2" ext=""
  [ "$goos" = windows ] && ext=".exe"
  local d="$OUT/$name"; mkdir -p "$d/opencode-plugin"
  bun build --compile --target="$bt" packages/cli/src/sv.ts --outfile "$d/sv$ext"
  bun build --compile --target="$bt" packages/hook/src/main.ts --outfile "$d/sv-hook$ext"
  cp packages/adapter-opencode/plugin/agent-supervisor.ts "$d/opencode-plugin/"
  cp README.md docs/usage.md config.example.yaml "$d/"
  if [ "$goos" = darwin ]; then
    local app="$d/Agent Supervisor.app"; mkdir -p "$app/Contents/MacOS"
    CGO_ENABLED=0 GOOS=$goos GOARCH=$goarch go -C ui build -trimpath -ldflags "-s -w" -o "$app/Contents/MacOS/sv-ui" ./cmd/sv-ui
    cat > "$app/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Agent Supervisor</string>
<key>CFBundleIdentifier</key><string>com.fan-chou.agent-supervisor</string>
<key>CFBundleExecutable</key><string>sv-ui</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${VERSION#v}</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PL
  else
    CGO_ENABLED=0 GOOS=$goos GOARCH=$goarch go -C ui build -trimpath -ldflags "-s -w -H windowsgui" -o "$d/sv-ui.exe" ./cmd/sv-ui
  fi
  (cd "$OUT" && zip -qry "$name.zip" "$name")
  rm -rf "$d"
}
build darwin arm64 bun-darwin-arm64
build darwin amd64 bun-darwin-x64
build windows amd64 bun-windows-x64
ls -la "$OUT"
