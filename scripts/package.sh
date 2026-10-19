#!/usr/bin/env bash
# 打包单程序发行版：后端（sv / sv-hook，bun --compile）内嵌进 sv-ui（MyGo 走 purego，无需 cgo，可交叉编译）。
# 产物（zip 内无多余目录）：macOS `Agent Supervisor.app` + README.md + usage.md；Windows `Agent Supervisor.exe` + README.md + usage.md。
set -euo pipefail
VERSION="${VERSION:-dev}"
OUT="${OUT:-dist}"
TARGETS="${TARGETS:-darwin/arm64 darwin/amd64 windows/amd64}"
rm -rf "$OUT" && mkdir -p "$OUT" && OUT="$(cd "$OUT" && pwd)"
EMB=ui/cmd/sv-ui/embedded
trap 'find "$EMB" -type f ! -name .gitignore -delete' EXIT
# OpenCode 插件预先打成自包含文件（发行版的 sv 无法在运行时读仓库源码）
bun build packages/adapter-opencode/plugin/agent-supervisor.ts --target=bun --format=esm --outfile "$EMB/agent-supervisor.ts"
cp config.example.yaml "$EMB/"
for t in $TARGETS; do
  goos=${t%/*} goarch=${t#*/}
  case $t in darwin/arm64) bt=bun-darwin-arm64;; darwin/amd64) bt=bun-darwin-x64;; windows/amd64) bt=bun-windows-x64;; *) echo "未知目标 $t"; exit 1;; esac
  name="agent-supervisor-${goos/darwin/macos}-$goarch"; d="$OUT/$name"; mkdir -p "$d"
  bun build --compile --target="$bt" packages/cli/src/sv.ts --outfile "$EMB/sv"
  bun build --compile --target="$bt" packages/hook/src/main.ts --outfile "$EMB/sv-hook"
  [ -f "$EMB/sv.exe" ] && mv "$EMB/sv.exe" "$EMB/sv"; [ -f "$EMB/sv-hook.exe" ] && mv "$EMB/sv-hook.exe" "$EMB/sv-hook"
  cp README.md docs/usage.md "$d/"
  if [ "$goos" = darwin ]; then
    app="$d/Agent Supervisor.app"; mkdir -p "$app/Contents/MacOS"
    CGO_ENABLED=0 GOOS=$goos GOARCH=$goarch go -C ui build -tags embedbackend -trimpath -ldflags "-s -w" -o "$app/Contents/MacOS/sv-ui" ./cmd/sv-ui
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
    CGO_ENABLED=0 GOOS=$goos GOARCH=$goarch go -C ui build -tags embedbackend -trimpath -ldflags "-s -w -H windowsgui" -o "$d/Agent Supervisor.exe" ./cmd/sv-ui
  fi
  (cd "$d" && zip -qry "$OUT/$name.zip" .)
  rm -rf "$d"
done
ls -la "$OUT"
