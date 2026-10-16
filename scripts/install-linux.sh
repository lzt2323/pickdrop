#!/bin/sh
# Keep the release and digest together: updates must use a verified release asset.
set -eu

fail() { printf '拾传安装失败：%s\n' "$*" >&2; exit 1; }

install_pickdrop() {
    destination=''
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --install-dir)
                [ "$#" -ge 2 ] && [ -n "$2" ] || fail '--install-dir 需要指定安装目录。'
                destination=$2
                case "$destination" in /*) ;; *) fail '安装目录必须为绝对路径。';; esac
                shift 2
                ;;
            --help|-h)
                printf '用法：sh install-linux.sh [--install-dir /安装目录]\n默认目录：$HOME/.local/bin\n'
                return
                ;;
            *) fail "未知参数：$1";;
        esac
    done
    if [ -z "$destination" ]; then
        [ -n "${HOME:-}" ] || fail 'HOME 未设置。'
        case "$HOME" in /*) ;; *) fail 'HOME 必须为绝对路径。';; esac
        destination="$HOME/.local/bin"
    fi
    [ "$(uname -s)" = Linux ] || fail '仅支持 Linux。'
    [ "$(uname -m)" = x86_64 ] || fail '当前仅提供 Linux x64 安装包。'
    for tool in curl tar sha256sum mktemp getconf awk; do
        command -v "$tool" >/dev/null 2>&1 || fail "缺少命令：$tool"
    done
    libc=$(getconf GNU_LIBC_VERSION 2>/dev/null) || fail '需要 glibc 2.35 或更新版本（不支持 Alpine/musl）。'
    printf '%s\n' "$libc" | awk '$1 == "glibc" {split($2,v,"."); if (v[1]>2 || (v[1]==2 && v[2]>=35)) ok=1} END {exit !ok}' || fail '需要 glibc 2.35 或更新版本。'
    version=0.6.0
    archive=PickDrop-0.6.0-Linux-x64-tui.tar.gz
    digest=4cc54fbfcbb62aa368ea54cdbe6fe2b60583111720b5e4b7773f0626a27a48ed
    target="$destination/pickdrop"
    [ ! -L "$target" ] || fail "$target 是符号链接，请先自行整理已有安装。"
    [ ! -e "$target" ] || [ -f "$target" ] || fail "$target 不是普通文件。"
    temporary=$(mktemp -d) || fail '无法创建下载目录。'
    staged=''
    trap 'rm -rf -- "$temporary"; if [ -n "$staged" ]; then rm -f -- "$staged"; fi' EXIT
    trap 'exit 1' HUP INT TERM
    printf '正在下载拾传 %s…\n' "$version"
    curl --fail --location --silent --show-error --connect-timeout 15 --max-time 180 --retry 2 \
        --proto '=https' --proto-redir '=https' \
        "https://github.com/lzt2323/pickdrop/releases/download/v$version/$archive" \
        --output "$temporary/$archive" || fail '下载失败，原安装未改动。'
    printf '%s  %s\n' "$digest" "$temporary/$archive" | sha256sum --check --status || fail 'SHA-256 校验失败，原安装未改动。'
    # Extract only the binary from the pinned, verified archive.
    tar -xzf "$temporary/$archive" -C "$temporary" pickdrop || fail '安装包解压失败。'
    [ -f "$temporary/pickdrop" ] && [ ! -L "$temporary/pickdrop" ] || fail '安装包中没有有效程序。'
    mkdir -p "$destination" || fail '无法创建安装目录。'
    staged=$(mktemp "$destination/.pickdrop-install.XXXXXX") || fail '无法创建安装临时文件。'
    cp "$temporary/pickdrop" "$staged" && chmod 755 "$staged" || fail '无法写入程序。'
    mv -fT "$staged" "$target" || fail '无法替换程序，原安装未改动。'
    staged=''
    printf '拾传 %s 已安装：%s\n聊天记录与文件未改动。\n' "$version" "$target"
    case ":${PATH:-}:" in
        *":$destination:"*) printf '运行 pickdrop 即可启动。\n';;
        *) printf '当前终端可直接运行："%s"\n如需使用 pickdrop 命令，请将 "%s" 加入 PATH。\n' "$target" "$destination";;
    esac
}

install_pickdrop "$@"
