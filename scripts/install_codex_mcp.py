#!/usr/bin/env python3
"""Install this checkout's MCP server and skill into the user's Codex home."""

from __future__ import annotations

import argparse
import copy
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import tomllib


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SERVER_NAME = "video-learning"
# Preserve host/tool policy when `codex mcp add` replaces an existing server.
SERVER_POLICY_KEYS = (
    "enabled", "required", "enabled_tools", "disabled_tools",
    "default_tools_approval_mode", "tools", "omit_tools_from", "name",
    "startup_readiness", "supports_parallel_tool_calls", "tool_input_schema_max_bytes",
)


def absolute_path(value: str | Path) -> Path:
    return Path(value).expanduser().resolve()


def positive_seconds(value: str) -> int:
    number = int(value)
    if number <= 0:
        raise argparse.ArgumentTypeError("timeout must be a positive number of seconds")
    return number


def executable(name: str) -> str:
    path = shutil.which(name)
    if path is None:
        raise RuntimeError(f"Required executable is missing from PATH: {name}")
    # Keep Homebrew's stable symlink rather than pinning a versioned Cellar path.
    return os.path.abspath(path)


def validate_dependencies(project_root: Path) -> dict[str, str]:
    binaries = {name: executable(name) for name in ("bun", "codex", "ffmpeg", "ffprobe")}
    package = json.loads((project_root / "package.json").read_text())
    missing = [name for name in package.get("dependencies", {}) if not (project_root / "node_modules" / name / "package.json").is_file()]
    if missing:
        raise RuntimeError("Run `bun install` in the project first; missing dependencies: " + ", ".join(missing))
    if not os.access(project_root / ".venv/bin/python", os.X_OK):
        raise RuntimeError("Project Python environment is missing; run `bash scripts/install_adapters.sh` first")
    if not (project_root / "src/cli.ts").is_file():
        raise RuntimeError("Project CLI is missing: src/cli.ts")
    if not (project_root / "skills/video-learning/SKILL.md").is_file():
        raise RuntimeError("Project skill is missing: skills/video-learning/SKILL.md")
    return binaries


def server_path(binaries: dict[str, str]) -> str:
    paths = [str(Path(binaries[name]).parent) for name in ("ffmpeg", "ffprobe")]
    paths.extend(("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"))
    return os.pathsep.join(dict.fromkeys(paths))


def backup_path(path: Path) -> Path:
    return path.with_name(f"{path.name}.backup-video-learning-{time.time_ns()}")


def write_private(path: Path, content: bytes) -> None:
    """Replace a config atomically, with private permissions from creation onward."""
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".video-learning-", delete=False) as handle:
        temporary = Path(handle.name)
        try:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
            handle.close()
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def toml_value(value: object) -> str:
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, list):
        return "[" + ", ".join(toml_value(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{ " + ", ".join(f"{json.dumps(key)} = {toml_value(item)}" for key, item in value.items()) + " }"
    raise RuntimeError("Unsupported value in existing MCP policy; configuration was not changed")


def set_timeouts(document: str, startup: int, tool: int, policies: dict | None = None) -> str:
    """Edit only the CLI-owned table; validate every other TOML value is unchanged."""
    expected = tomllib.loads(document)
    options = {**(policies or {}), "startup_timeout_sec": startup, "tool_timeout_sec": tool}
    expected["mcp_servers"][SERVER_NAME].update(options)
    header = re.compile(r'^\[mcp_servers\.(?:video-learning|"video-learning"|\'video-learning\')\]\s*(?:#.*)?$')
    lines = document.splitlines(keepends=True)
    for index, line in enumerate(lines):
        if not header.fullmatch(line.rstrip("\r\n")):
            continue
        end = index + 1
        while end < len(lines) and not re.match(r"^\s*\[", lines[end]):
            end += 1
        option_keys = "|".join(re.escape(key) for key in options)
        body = [item for item in lines[index + 1:end] if not re.match(rf'^\s*"?({option_keys})"?\s*=', item)]
        additions = [f"{key} = {toml_value(value)}\n" for key, value in options.items()]
        result = "".join(lines[:index + 1] + additions + body + lines[end:])
        try:
            if tomllib.loads(result) == expected:
                return result
        except tomllib.TOMLDecodeError:
            pass
    raise RuntimeError("Could not safely set timeouts and preserve policy in the Codex MCP configuration")


def without_server(config: dict) -> dict:
    result = copy.deepcopy(config)
    servers = result.get("mcp_servers", {})
    servers.pop(SERVER_NAME, None)
    if not servers:
        result.pop("mcp_servers", None)
    return result


def merge_server(document: str, server: dict) -> str:
    """Replace only this server's tables, preserving unrelated configuration text."""
    expected = tomllib.loads(document)
    expected.setdefault("mcp_servers", {})[SERVER_NAME] = server
    replacement = f"[mcp_servers.{SERVER_NAME}]\n" + "".join(
        f"{json.dumps(key)} = {toml_value(value)}\n" for key, value in server.items()
    )
    output = []
    skipping = False
    inserted = False
    for line in document.splitlines(keepends=True):
        stripped = line.strip()
        if stripped.startswith("["):
            try:
                header = tomllib.loads(stripped + "\n__installer_table_marker__ = true\n")
            except tomllib.TOMLDecodeError:
                header = None
            if header is not None:
                skipping = SERVER_NAME in header.get("mcp_servers", {})
                if skipping and not inserted:
                    output.append(replacement + "\n")
                    inserted = True
        if not skipping:
            output.append(line)
    if not inserted:
        if output and not output[-1].endswith("\n"):
            output.append("\n")
        output.append("\n" + replacement + "\n")
    result = "".join(output)
    try:
        if tomllib.loads(result) == expected:
            return result
    except tomllib.TOMLDecodeError:
        pass
    raise RuntimeError("Cannot safely replace this MCP table layout; original configuration was preserved")


def install_skill(source: Path, target: Path) -> Path | None:
    if target.is_symlink() or (target.exists() and not target.is_dir()):
        raise RuntimeError(f"Skill destination must be a regular directory: {target}")
    changed = target.exists() and any(
        not (target / item.relative_to(source)).is_file()
        or item.read_bytes() != (target / item.relative_to(source)).read_bytes()
        for item in source.rglob("*") if item.is_file()
    )
    # Keep backups outside skills/, where Codex would discover duplicate names.
    backup = backup_path(target.parent.parent / "skill-backups" / target.name) if changed else None
    if backup:
        backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(target, backup)
    # Preserve user-added files and every other installed skill.
    shutil.copytree(source, target, dirs_exist_ok=True)
    return backup


def install(args: argparse.Namespace, project_root: Path = PROJECT_ROOT) -> dict[str, Path | None]:
    project_root = absolute_path(project_root)
    binaries = validate_dependencies(project_root)
    workspace = absolute_path(args.workspace or project_root / ".video-learning-data")
    database = absolute_path(args.db or workspace / "video-learning.sqlite")
    codex_home = absolute_path(args.codex_home or os.environ.get("CODEX_HOME") or Path.home() / ".codex")
    config_path = codex_home / "config.toml"
    skill_target = codex_home / "skills" / SERVER_NAME
    if skill_target.is_symlink() or (skill_target.exists() and not skill_target.is_dir()):
        raise RuntimeError(f"Skill destination must be a regular directory: {skill_target}")
    original = config_path.read_bytes() if config_path.exists() else None
    original_config = tomllib.loads(original.decode()) if original is not None else {}
    codex_home.mkdir(parents=True, exist_ok=True)
    workspace.mkdir(parents=True, exist_ok=True)
    database.parent.mkdir(parents=True, exist_ok=True)
    config_backup = backup_path(config_path) if original is not None else None
    if config_backup:
        descriptor = os.open(config_backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(original)
    command_args = ["run", "--no-env-file", "--cwd", str(project_root), str(project_root / "src/cli.ts"), "mcp", "--workspace", str(workspace), "--db", str(database)]
    process_path = server_path(binaries)
    command = [binaries["codex"], "mcp", "add", SERVER_NAME, "--env", f"PATH={process_path}", "--", binaries["bun"], *command_args]
    try:
        # `codex mcp add` normalizes every MCP entry, dropping unrelated defaults
        # such as args = []. Let it generate only our entry in an isolated home.
        with tempfile.TemporaryDirectory(prefix="video-learning-codex-") as generated_home:
            result = subprocess.run(command, env={**os.environ, "CODEX_HOME": generated_home}, capture_output=True, text=True, timeout=60)
            if result.returncode:
                # CLI diagnostics can contain config values; never echo them here.
                raise RuntimeError(f"codex mcp add failed with exit code {result.returncode}")
            generated = (Path(generated_home) / "config.toml").read_text()
        previous_server = original_config.get("mcp_servers", {}).get(SERVER_NAME, {})
        policies = {key: previous_server[key] for key in SERVER_POLICY_KEYS if key in previous_server}
        generated = set_timeouts(generated, args.startup_timeout, args.tool_timeout, policies)
        server = tomllib.loads(generated)["mcp_servers"][SERVER_NAME]
        if server.get("command") != binaries["bun"] or server.get("args") != command_args or server.get("env") != {"PATH": process_path}:
            raise RuntimeError("Codex MCP configuration does not match the requested launch command")
        document = merge_server(original.decode() if original is not None else "", server)
        write_private(config_path, document.encode())
        skill_backup = install_skill(project_root / "skills/video-learning", skill_target)
    except BaseException:
        if original is None:
            config_path.unlink(missing_ok=True)
        else:
            write_private(config_path, original)
        raise
    return {"config": config_path, "config_backup": config_backup, "skill": skill_target, "skill_backup": skill_backup, "workspace": workspace, "db": database}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", help="Shared video workspace (default: PROJECT/.video-learning-data)")
    parser.add_argument("--db", help="SQLite database (default: WORKSPACE/video-learning.sqlite)")
    parser.add_argument("--codex-home", help="Codex home (default: CODEX_HOME or ~/.codex)")
    parser.add_argument("--startup-timeout", type=positive_seconds, default=30, metavar="SECONDS")
    parser.add_argument("--tool-timeout", type=positive_seconds, default=3600, metavar="SECONDS")
    args = parser.parse_args()
    try:
        installed = install(args)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        # TOML decoder errors can quote source text containing credentials.
        message = "Invalid configuration TOML; installation cancelled" if isinstance(error, tomllib.TOMLDecodeError) else str(error)
        print(f"Installation failed: {message}", file=sys.stderr)
        return 1
    print(f"Installed Codex MCP server: {SERVER_NAME}")
    for label, path in installed.items():
        if path is not None:
            print(f"{label}: {path}")
    print("Open a new Codex conversation (restart Codex if needed) to load the server and skill.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
