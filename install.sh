#!/bin/sh
set -e

APP_DIR="$HOME/.local/share/token-local-viewer"
BIN_DIR="$HOME/.local/bin"
DESKTOP="$HOME/Desktop"
OPENTOKEN="$BIN_DIR/opentoken"
LAUNCH_AGENT_DIR="$HOME/Library/LaunchAgents"
LAUNCH_AGENT="$LAUNCH_AGENT_DIR/com.sllhhming.token-local-viewer.plist"
REPO_RAW_BASE="${TOKEN_LOCAL_VIEWER_RAW_BASE:-https://cdn.jsdelivr.net/gh/sllhhming-png/token-local-viewer@v0.2.1}"
CURL_OPTS="--retry 3 --connect-timeout 20 --speed-time 20 --speed-limit 1024 -fL"

mkdir -p "$APP_DIR" "$BIN_DIR"

OS="$(uname)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin)
    ASSET="opentoken"
    ;;
  Linux)
    case "$ARCH" in
      x86_64|amd64)
        ASSET="opentoken-linux"
        ;;
      aarch64|arm64)
        ASSET="opentoken-linux-arm64"
        ;;
      *)
        echo "暂不支持这个 Linux 架构: $ARCH"
        exit 1
        ;;
    esac
    ;;
  *)
    echo "暂只支持 macOS / Linux"
    exit 1
    ;;
esac

if [ -x "$OPENTOKEN" ]; then
  echo "1/4 已检测到本地 token 扫描器，直接复用。"
else
  echo "1/4 下载本地 token 扫描器，首次安装可能需要 1-5 分钟..."
  TMP="$OPENTOKEN.download.$$"
  curl $CURL_OPTS "https://scys.com/tokenrank/dl/$ASSET" -o "$TMP"
  chmod +x "$TMP"
  if [ "$OS" = "Darwin" ]; then
    /usr/bin/xattr -dr com.apple.quarantine "$TMP" >/dev/null 2>&1 || true
  fi
  mv "$TMP" "$OPENTOKEN"
fi

echo "2/4 安装本地看板..."
curl $CURL_OPTS "$REPO_RAW_BASE/app/server.py" -o "$APP_DIR/server.py"
curl $CURL_OPTS "$REPO_RAW_BASE/app/index.html" -o "$APP_DIR/index.html"
curl $CURL_OPTS "$REPO_RAW_BASE/app/accurate-scan.js" -o "$APP_DIR/accurate-scan.js"
curl $CURL_OPTS "$REPO_RAW_BASE/app/claude-scan.js" -o "$APP_DIR/claude-scan.js"
chmod +x "$APP_DIR/server.py"

cat > "$BIN_DIR/token-local-viewer" <<'EOF'
#!/bin/sh
APP_DIR="$HOME/.local/share/token-local-viewer"
PY=""
for CANDIDATE in \
  "$PYTHON" \
  "$(command -v python3 2>/dev/null)" \
  /usr/bin/python3 \
  /opt/homebrew/bin/python3 \
  /usr/local/bin/python3 \
  /Library/Frameworks/Python.framework/Versions/Current/bin/python3
do
  if [ -n "$CANDIDATE" ] && [ -x "$CANDIDATE" ]; then
    PY="$CANDIDATE"
    break
  fi
done
if [ -z "$PY" ]; then
  echo "需要 python3。macOS 可先安装 Xcode Command Line Tools。"
  exit 1
fi
cd "$APP_DIR" || exit 1
exec "$PY" server.py
EOF
chmod +x "$BIN_DIR/token-local-viewer"

echo "3/4 生成桌面启动文件..."
cat > "$DESKTOP/打开本地Token看板.command" <<'EOF'
#!/bin/sh
exec "$HOME/.local/bin/token-local-viewer"
EOF
chmod +x "$DESKTOP/打开本地Token看板.command"

echo "4/4 完成。现在会打开本地 Token 看板；以后双击桌面的「打开本地Token看板.command」即可。"
: > /tmp/token-local-viewer.log
: > /tmp/token-local-viewer.err.log
if [ "$OS" = "Darwin" ]; then
  mkdir -p "$LAUNCH_AGENT_DIR"
  cat > "$LAUNCH_AGENT" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.sllhhming.token-local-viewer</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BIN_DIR/token-local-viewer</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/token-local-viewer.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/token-local-viewer.err.log</string>
</dict>
</plist>
EOF
  launchctl bootout "gui/$(id -u)/com.sllhhming.token-local-viewer" >/dev/null 2>&1 || true
  pkill -f "$APP_DIR/server.py" >/dev/null 2>&1 || true
  sleep 1
  launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENT" >/dev/null 2>&1 || true
  launchctl kickstart -k "gui/$(id -u)/com.sllhhming.token-local-viewer" >/dev/null 2>&1 || true
else
  pkill -f "$APP_DIR/server.py" >/dev/null 2>&1 || true
  sleep 1
  nohup "$BIN_DIR/token-local-viewer" >/tmp/token-local-viewer.log 2>&1 &
fi
sleep 3
cat /tmp/token-local-viewer.log 2>/dev/null || true
cat /tmp/token-local-viewer.err.log 2>/dev/null || true
VIEWER_URL="$(grep -Eo 'http://127\.0\.0\.1:[0-9]+/' /tmp/token-local-viewer.log 2>/dev/null | tail -n 1 || true)"
if [ -z "$VIEWER_URL" ]; then
  VIEWER_URL="http://127.0.0.1:3899/"
fi
if [ "$OS" = "Darwin" ]; then
  open "$VIEWER_URL" >/dev/null 2>&1 || true
fi
echo "如果浏览器没有自动打开，请访问 $VIEWER_URL ，或双击桌面的「打开本地Token看板.command」。"
