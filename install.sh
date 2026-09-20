#!/usr/bin/env bash
set -Eeuo pipefail

readonly DEFAULT_REPOSITORY="https://github.com/23J1633/server-api"
readonly MIN_NODE_MAJOR=20

REPOSITORY="${A2S_REPOSITORY:-$DEFAULT_REPOSITORY}"
REF="${A2S_REF:-main}"
INSTALL_DIR="${A2S_INSTALL_DIR:-/opt/a2s-server}"
DATA_DIR="${A2S_SERVER_DATA_DIR:-/var/lib/a2s-server}"
ENV_DIR="${A2S_ENV_DIR:-/etc/a2s-server}"
ENV_FILE="${A2S_ENV_FILE:-${ENV_DIR}/a2s-server.env}"
SERVICE_NAME="${A2S_SERVICE_NAME:-a2s-server}"
SERVICE_USER="${A2S_SERVICE_USER:-a2s}"
SERVER_HOST="${A2S_SERVER_HOST:-127.0.0.1}"
SERVER_PORT="${A2S_SERVER_PORT:-50443}"
SERVER_NO_TLS="${A2S_SERVER_NO_TLS:-1}"
RECONFIGURE="${A2S_RECONFIGURE:-0}"
DRY_RUN=0
ACTION=install
PURGE=0
RUNTIME_DATA_DIR="$DATA_DIR"

log() { printf '[A2S] %s\n' "$*"; }
fail() { printf '[A2S] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: install.sh [--dry-run]
       install.sh --uninstall [--purge] [--dry-run]

Actions:
  --uninstall              Remove the service and application; keep data and keys
  --purge                  With --uninstall, also remove data, keys, and service user
  --dry-run                Print the selected plan without changing the server

Environment variables:
  A2S_REF                 Git branch or tag (default: main)
  A2S_INSTALL_DIR         Application directory (default: /opt/a2s-server)
  A2S_SERVER_DATA_DIR     Persistent data directory (default: /var/lib/a2s-server)
  A2S_SERVER_HOST         Listen address (default: 127.0.0.1)
  A2S_SERVER_PORT         Listen port (default: 50443)
  A2S_SERVER_NO_TLS       1 for reverse-proxy HTTP, 0 for config.json TLS (default: 1)
  A2S_RECONFIGURE         1 to rewrite the managed environment file
EOF
}

for argument in "$@"; do
  case "$argument" in
    --dry-run) DRY_RUN=1 ;;
    --uninstall) ACTION=uninstall ;;
    --purge) PURGE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown argument: $argument" ;;
  esac
done
[[ "$PURGE" == "0" || "$ACTION" == "uninstall" ]] || fail "--purge requires --uninstall"

validate_absolute_path() {
  local label="$1"
  local value="$2"
  [[ "$value" == /* ]] || fail "$label must be an absolute path: $value"
  [[ ! "$value" =~ [[:space:]] ]] || fail "$label must not contain whitespace"
  [[ "$value" != "/" && "$value" != "/opt" && "$value" != "/var" && "$value" != "/etc" && "$value" != "/usr" ]] \
    || fail "$label is too broad: $value"
}

validate_inputs() {
  [[ "$REPOSITORY" =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(\.git)?$ ]] \
    || fail "A2S_REPOSITORY must be an HTTPS GitHub repository"
  [[ "$REF" =~ ^[A-Za-z0-9._/-]+$ ]] || fail "A2S_REF contains unsupported characters"
  [[ "$SERVICE_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9_.@-]*$ ]] || fail "Invalid service name"
  [[ "$SERVICE_USER" =~ ^[a-z_][a-z0-9_-]*[$]?$ ]] || fail "Invalid service user"
  [[ "$SERVICE_USER" != "root" ]] || fail "A2S_SERVICE_USER must not be root"
  [[ "$SERVER_HOST" =~ ^[A-Za-z0-9:._-]+$ ]] || fail "Invalid listen address"
  [[ "$SERVER_PORT" =~ ^[0-9]+$ ]] && (( SERVER_PORT >= 1 && SERVER_PORT <= 65535 )) || fail "Invalid listen port"
  [[ "$SERVER_NO_TLS" == "0" || "$SERVER_NO_TLS" == "1" ]] || fail "A2S_SERVER_NO_TLS must be 0 or 1"
  validate_absolute_path A2S_INSTALL_DIR "$INSTALL_DIR"
  validate_absolute_path A2S_SERVER_DATA_DIR "$DATA_DIR"
  validate_absolute_path A2S_ENV_DIR "$ENV_DIR"
  validate_absolute_path A2S_ENV_FILE "$ENV_FILE"
  [[ "$ENV_FILE" == "$ENV_DIR"/* ]] || fail "A2S_ENV_FILE must be inside A2S_ENV_DIR"
  [[ "$INSTALL_DIR" != "$DATA_DIR" && "$INSTALL_DIR" != "$DATA_DIR"/* && "$DATA_DIR" != "$INSTALL_DIR"/* ]] \
    || fail "Application and persistent data directories must not overlap"
}

print_plan() {
  cat <<EOF
[A2S] Deployment plan
  repository : ${REPOSITORY}
  ref        : ${REF}
  app        : ${INSTALL_DIR}
  data       : ${DATA_DIR}
  env        : ${ENV_FILE}
  service    : ${SERVICE_NAME}
  user       : ${SERVICE_USER}
  listen     : ${SERVER_HOST}:${SERVER_PORT}
  no TLS     : ${SERVER_NO_TLS}
EOF
}

print_uninstall_plan() {
  cat <<EOF
[A2S] Uninstall plan
  app        : ${INSTALL_DIR}
  data       : ${DATA_DIR}
  env        : ${ENV_FILE}
  service    : ${SERVICE_NAME}
  purge data : ${PURGE}
EOF
}

print_banner() {
  cat <<'EOF'

     _      ____    ____
    / \    |___ \  / ___|
   / _ \     __) | \___ \
  / ___ \   / __/   ___) |
 /_/   \_\ |_____| |____/

EOF
}

install_base_tools() {
  if command -v curl >/dev/null 2>&1 && command -v tar >/dev/null 2>&1; then return; fi
  log "Installing curl and tar..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y
    DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates tar
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y curl ca-certificates tar
  elif command -v yum >/dev/null 2>&1; then
    yum install -y curl ca-certificates tar
  else
    fail "Install curl and tar first; this distribution is not supported automatically"
  fi
}

node_major() {
  command -v node >/dev/null 2>&1 || { printf '0'; return; }
  node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || printf '0'
}

install_node() {
  local setup
  setup="$(mktemp /tmp/a2s-nodesource.XXXXXX.sh)"
  trap 'rm -f "${setup:-}"' RETURN
  log "Installing Node.js 22..."
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_22.x -o "$setup"
    bash "$setup"
    DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x -o "$setup"
    bash "$setup"
    dnf install -y nodejs
  elif command -v yum >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x -o "$setup"
    bash "$setup"
    yum install -y nodejs
  else
    fail "Node.js 20+ is required; this distribution is not supported automatically"
  fi
  rm -f "$setup"
  trap - RETURN
}

ensure_runtime() {
  local major
  major="$(node_major)"
  if (( major < MIN_NODE_MAJOR )); then install_node; fi
  major="$(node_major)"
  (( major >= MIN_NODE_MAJOR )) || fail "Node.js 20+ installation failed"
  command -v npm >/dev/null 2>&1 || fail "npm is not available after Node.js installation"
  log "Runtime: Node.js $(node --version), npm $(npm --version)"
}

ensure_user_and_data() {
  install -d -m 0755 "$ENV_DIR"
  if ! getent group "$SERVICE_USER" >/dev/null 2>&1; then
    groupadd --system "$SERVICE_USER"
    printf '%s\n' "$SERVICE_USER" >"${ENV_DIR}/.service-group-created"
  fi
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --gid "$SERVICE_USER" --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
    printf '%s\n' "$SERVICE_USER" >"${ENV_DIR}/.service-user-created"
  fi
  install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR"
}

write_environment() {
  if [[ -f "$ENV_FILE" && "$RECONFIGURE" != "1" ]]; then
    chown root:"$SERVICE_USER" "$ENV_FILE"
    chmod 0640 "$ENV_FILE"
    log "Preserving existing environment file: $ENV_FILE"
    return
  fi
  local temporary="${ENV_FILE}.tmp.$$"
  umask 027
  cat >"$temporary" <<EOF
A2S_SERVER_DATA_DIR=${DATA_DIR}
A2S_SERVER_HOST=${SERVER_HOST}
A2S_SERVER_PORT=${SERVER_PORT}
A2S_SERVER_NO_TLS=${SERVER_NO_TLS}
NODE_ENV=production
EOF
  chmod 0640 "$temporary"
  chown root:"$SERVICE_USER" "$temporary"
  mv -f "$temporary" "$ENV_FILE"
  log "Wrote environment file: $ENV_FILE"
}

archive_url() {
  local clean slug
  clean="${REPOSITORY%.git}"
  slug="${clean#https://github.com/}"
  printf 'https://api.github.com/repos/%s/tarball/%s' "$slug" "$REF"
}

download_release() {
  local stage="$1"
  local archive="$2"
  log "Downloading ${REPOSITORY}@${REF}..."
  curl --fail --silent --show-error --location --retry 3 --retry-all-errors "$(archive_url)" -o "$archive"
  tar -xzf "$archive" --strip-components=1 -C "$stage"
  [[ -f "$stage/package.json" && -f "$stage/server.js" && -f "$stage/package-lock.json" ]] \
    || fail "Downloaded archive is not a valid server-api release"
}

install_release() {
  local parent stage archive previous had_previous=0
  parent="$(dirname "$INSTALL_DIR")"
  install -d -m 0755 "$parent"
  stage="$(mktemp -d "${parent}/.a2s-install.XXXXXX")"
  archive="${stage}.tar.gz"
  trap 'rm -rf -- "${stage:-}"; rm -f -- "${archive:-}"' RETURN

  download_release "$stage" "$archive"
  log "Installing production dependencies..."
  npm --prefix "$stage" ci --omit=dev --ignore-scripts --no-audit --no-fund
  chown -R root:root "$stage"

  previous="${INSTALL_DIR}.previous"
  systemctl stop "${SERVICE_NAME}.service" >/dev/null 2>&1 || true
  if [[ -d "$INSTALL_DIR" ]]; then
    rm -rf -- "$previous"
    mv "$INSTALL_DIR" "$previous"
    had_previous=1
  fi
  mv "$stage" "$INSTALL_DIR"
  rm -f "$archive"
  trap - RETURN

  if ! write_service_and_start; then
    log "New release failed; restoring the previous release..."
    systemctl stop "${SERVICE_NAME}.service" >/dev/null 2>&1 || true
    rm -rf -- "$INSTALL_DIR"
    if (( had_previous )); then
      mv "$previous" "$INSTALL_DIR"
      systemctl restart "${SERVICE_NAME}.service" >/dev/null 2>&1 || true
    else
      systemctl disable "${SERVICE_NAME}.service" >/dev/null 2>&1 || true
    fi
    fail "Deployment rolled back"
  fi
}

write_service_and_start() {
  local node_path unit temporary
  node_path="$(command -v node)"
  unit="/etc/systemd/system/${SERVICE_NAME}.service"
  temporary="${unit}.tmp.$$"
  cat >"$temporary" <<EOF
[Unit]
Description=A2S unified agent relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=${node_path} ${INSTALL_DIR}/server.js
Restart=always
RestartSec=3
TimeoutStopSec=10
UMask=0027
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=${RUNTIME_DATA_DIR}

[Install]
WantedBy=multi-user.target
EOF
  chmod 0644 "$temporary"
  mv -f "$temporary" "$unit"
  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}.service" >/dev/null
  systemctl restart "${SERVICE_NAME}.service"
  wait_for_health
}

environment_value() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 0
  sed -n "s/^${key}=//p" "$ENV_FILE" | tail -n 1
}

load_effective_environment() {
  local configured
  configured="$(environment_value A2S_SERVER_DATA_DIR)"
  [[ -n "$configured" ]] && RUNTIME_DATA_DIR="$configured"
  validate_absolute_path A2S_SERVER_DATA_DIR "$RUNTIME_DATA_DIR"
  install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$RUNTIME_DATA_DIR"
}

wait_for_health() {
  local port no_tls url attempt
  port="$(environment_value A2S_SERVER_PORT)"
  no_tls="$(environment_value A2S_SERVER_NO_TLS)"
  [[ "$port" =~ ^[0-9]+$ ]] || port="$SERVER_PORT"
  if [[ "$no_tls" == "1" ]]; then
    url="http://127.0.0.1:${port}/a2s-api/health"
  else
    url="https://127.0.0.1:${port}/a2s-api/health"
  fi
  for attempt in $(seq 1 30); do
    if curl --fail --silent --show-error --insecure --max-time 2 "$url" >/dev/null 2>&1; then
      log "Health check passed: $url"
      return 0
    fi
    sleep 1
  done
  systemctl status "${SERVICE_NAME}.service" --no-pager >&2 || true
  journalctl -u "${SERVICE_NAME}.service" -n 80 --no-pager >&2 || true
  return 1
}

raw_installer_url() {
  local clean slug
  clean="${REPOSITORY%.git}"
  slug="${clean#https://github.com/}"
  printf 'https://raw.githubusercontent.com/%s/%s/install.sh' "$slug" "$REF"
}

finish() {
  local port no_tls scheme admin_file admin_key installer_url
  port="$(environment_value A2S_SERVER_PORT)"
  no_tls="$(environment_value A2S_SERVER_NO_TLS)"
  [[ "$port" =~ ^[0-9]+$ ]] || port="$SERVER_PORT"
  scheme=https
  [[ "$no_tls" == "1" ]] && scheme=http
  admin_file="${RUNTIME_DATA_DIR}/admin-key.txt"
  admin_key="[not found; inspect service logs]"
  if [[ -r "$admin_file" ]]; then admin_key="$(tr -d '\r\n' <"$admin_file")"; fi
  installer_url="$(raw_installer_url)"
  print_banner
  cat <<EOF
[A2S] Deployment complete
  Console        : ${scheme}://<server>:${port}/
  Endpoint       : ${scheme}://<server>:${port}/a2s-api
  Admin key      : ${admin_key}
  Admin key file : ${admin_file}
  Status         : systemctl status ${SERVICE_NAME}
  Logs           : journalctl -u ${SERVICE_NAME} -f
  Upgrade        : curl -fsSL ${installer_url} | sudo bash
  Uninstall      : curl -fsSL ${installer_url} | sudo bash -s -- --uninstall
  Purge all data : curl -fsSL ${installer_url} | sudo bash -s -- --uninstall --purge
EOF
  if [[ "$SERVER_HOST" == "127.0.0.1" || "$SERVER_HOST" == "localhost" ]]; then
    log "The service listens on loopback. Put Nginx/Caddy/1Panel in front of it for HTTPS/WSS access."
  elif [[ "$no_tls" == "1" ]]; then
    log "WARNING: Plain HTTP is exposed. Use a TLS reverse proxy before sending device keys or session data."
  fi
}

uninstall_server() {
  local unit configured installer_url remove_user=0 remove_group=0
  unit="/etc/systemd/system/${SERVICE_NAME}.service"
  configured="$(environment_value A2S_SERVER_DATA_DIR)"
  [[ -n "$configured" ]] && RUNTIME_DATA_DIR="$configured"
  validate_absolute_path A2S_SERVER_DATA_DIR "$RUNTIME_DATA_DIR"
  installer_url="$(raw_installer_url)"

  systemctl disable --now "${SERVICE_NAME}.service" >/dev/null 2>&1 || true
  rm -f -- "$unit"
  systemctl daemon-reload
  systemctl reset-failed "${SERVICE_NAME}.service" >/dev/null 2>&1 || true
  rm -rf -- "$INSTALL_DIR" "${INSTALL_DIR}.previous"

  print_banner
  if (( PURGE )); then
    if [[ -f "${ENV_DIR}/.service-user-created" ]] && [[ "$(<"${ENV_DIR}/.service-user-created")" == "$SERVICE_USER" ]]; then remove_user=1; fi
    if [[ -f "${ENV_DIR}/.service-group-created" ]] && [[ "$(<"${ENV_DIR}/.service-group-created")" == "$SERVICE_USER" ]]; then remove_group=1; fi
    rm -rf -- "$RUNTIME_DATA_DIR"
    rm -f -- "$ENV_FILE"
    rm -f -- "${ENV_DIR}/.service-user-created" "${ENV_DIR}/.service-group-created"
    rmdir "$ENV_DIR" >/dev/null 2>&1 || true
    if (( remove_user )) && id "$SERVICE_USER" >/dev/null 2>&1; then userdel "$SERVICE_USER" >/dev/null 2>&1 || true; fi
    if (( remove_group )) && getent group "$SERVICE_USER" >/dev/null 2>&1; then groupdel "$SERVICE_USER" >/dev/null 2>&1 || true; fi
    cat <<EOF
[A2S] Uninstall complete
  Removed service : ${SERVICE_NAME}
  Removed app     : ${INSTALL_DIR}
  Removed data    : ${RUNTIME_DATA_DIR}
  Removed env     : ${ENV_FILE}
EOF
  else
    cat <<EOF
[A2S] Uninstall complete
  Removed service : ${SERVICE_NAME}
  Removed app     : ${INSTALL_DIR}
  Preserved data  : ${RUNTIME_DATA_DIR}
  Preserved keys  : ${RUNTIME_DATA_DIR}/admin-key.txt
  Preserved env   : ${ENV_FILE}
  Reinstall       : curl -fsSL ${installer_url} | sudo bash
  Purge all data  : curl -fsSL ${installer_url} | sudo bash -s -- --uninstall --purge
EOF
  fi
}

require_linux_root() {
  [[ "$(uname -s)" == "Linux" ]] || fail "This installer supports Linux only"
  (( EUID == 0 )) || fail "Run as root (for example: curl ... | sudo bash)"
  command -v systemctl >/dev/null 2>&1 || fail "systemd is required"
}

main() {
  validate_inputs
  if [[ "$ACTION" == "uninstall" ]]; then
    print_uninstall_plan
    if (( DRY_RUN )); then
      log "Dry run complete; no files were changed."
      return
    fi
    require_linux_root
    uninstall_server
    return
  fi
  print_plan
  if (( DRY_RUN )); then
    log "Dry run complete; no files were changed."
    return
  fi
  require_linux_root
  install_base_tools
  ensure_runtime
  ensure_user_and_data
  write_environment
  load_effective_environment
  install_release
  finish
}

if [[ "${A2S_INSTALLER_SOURCE_ONLY:-0}" != "1" ]]; then
  main "$@"
fi
