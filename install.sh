#!/bin/sh
set -e

APP_DIR="$HOME/.local/share/token-local-viewer"
BIN_DIR="$HOME/.local/bin"
DESKTOP="$HOME/Desktop"
OPENTOKEN="$BIN_DIR/opentoken"
REPO_RAW_BASE="${TOKEN_LOCAL_VIEWER_RAW_BASE:-https://raw.githubusercontent.com/sllhhming-png/token-local-viewer/main}"

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

echo "1/4 下载本地 token 扫描器..."
TMP="$OPENTOKEN.download.$$"
curl -fSL "https://scys.com/tokenrank/dl/$ASSET" -o "$TMP"
chmod +x "$TMP"
if [ "$OS" = "Darwin" ]; then
  /usr/bin/xattr -dr com.apple.quarantine "$TMP" >/dev/null 2>&1 || true
fi
mv "$TMP" "$OPENTOKEN"

echo "2/4 安装本地看板..."
curl -fSL "$REPO_RAW_BASE/app/server.py" -o "$APP_DIR/server.py"
curl -fSL "$REPO_RAW_BASE/app/index.html" -o "$APP_DIR/index.html"
chmod +x "$APP_DIR/server.py"

cat > "$BIN_DIR/token-local-viewer" <<'EOF'
#!/bin/sh
APP_DIR="$HOME/.local/share/token-local-viewer"
PY="$(command -v python3 || true)"
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
"$BIN_DIR/token-local-viewer"
